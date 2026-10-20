// "Anyone with the link can view" for one file.
//
// A link is one `files_share_links` doc with a random token. The token is the only secret: a visitor
// needs no account and no membership. So every read checks the file again, with a fixed number of exact
// reads and no folder walk: the file's own stored state and its restricted scope node. While a job
// changes a folder above, a file it has not reached yet keeps its old state, and its link works until
// the job writes the file. A change of the scope node itself ends every link of its area at once.
//
// The helpers that delete links when a file's access changes live in `files_share_links_db.ts`, so the
// file lifecycle modules can import them without importing this module.

import type { RegisteredQuery } from "convex/server";
import { getConvexSize, v, type Value } from "convex/values";
import { doc } from "convex-helpers/validators";
import { internal } from "./_generated/api.js";
import type { Doc, Id, TableNames } from "./_generated/dataModel.js";
import { action, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { access_control_db_filter_readable_file_nodes } from "./access_control.ts";
import { files_merge_contiguous_chunks } from "./files_nodes.ts";
import { files_nodes_db_has_plugin_binding } from "./files_nodes_db.ts";
import { files_nodes_db_get_tree_reader } from "./files_tree_db.ts";
import { files_share_links_MAX_PER_WORKSPACE } from "./files_share_links_db.ts";
import { r2 } from "./r2_client.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_resolve_read_target,
} from "../server/files-saved-placement.ts";
import { files_saved_content_db_text_chunks } from "../server/files-saved-content.ts";
import { files_share_links_db_is_selected } from "../server/files-share-links.ts";
import {
	files_editable_text_shape_of,
	files_get_signed_download_serving,
	files_is_inline_media_content_type,
	files_parse_content_type,
} from "../shared/files.ts";
import { files_media_parse_src } from "../shared/files-media.ts";
import {
	files_share_rich_text_finish,
	files_share_rich_text_MAX_MEDIA,
	files_share_rich_text_prepare,
	type files_share_rich_text_Prepared,
	type files_share_rich_text_MediaKind,
} from "../shared/files-share-rich-text.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * A link token is 32 random bytes as lowercase hex.
 */
const TOKEN_REGEX = /^[0-9a-f]{64}$/;

/**
 * A public revision is a SHA-256 digest as lowercase hex.
 */
const REVISION_REGEX = /^[0-9a-f]{64}$/;

/**
 * How long a signed URL works. Turning the link off does not stop a URL that was already signed.
 */
const SIGNED_URL_TTL_SECONDS = 15 * 60;

/**
 * Part of every public revision. Change it when the public content format changes, so open pages
 * load the new format.
 */
const SHARE_FORMAT_VERSION = 1;

// Read limits of one public view. Convex fails a query past 16 MiB of reads, 32,000 docs, or 4,096 index
// ranges. The view stays well below them, so a large file gives a clean "unavailable" instead.
const MAX_VIEW_READ_CALLS = 1_500;
const MAX_VIEW_READ_DOCS = 16_000;
const MAX_VIEW_READ_BYTES = 8 * 1024 * 1024;

/**
 * The largest doc Convex stores. Each read first keeps this much room below the byte limit.
 */
const MAX_DOC_BYTES = 1024 * 1024;

/**
 * Largest public view. Below Convex's limits for one value and one query result.
 */
const MAX_VIEW_BYTES = 1_000_000;

/**
 * Most service accounts one grant list can name. Sharing allows 50 people and accounts per file. Keep it
 * equal to the limit in `access_control_db_set_service_account_grant`.
 */
const MAX_GRANT_PRINCIPALS = 50;

/**
 * Whether the organization and workspace exist and no deletion has started. Reads 4 docs.
 */
async function db_is_workspace_live(
	ctx: QueryCtx | MutationCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const organization = await ctx.db.get("organizations", args.organizationId);
	const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
	// A deletion request exists before the purge starts, so it hides the file first. Look up this
	// organization's request and this workspace's request exactly. A request for another workspace of
	// the same organization must not hide this file.
	const organizationDeletion = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", undefined),
		)
		.first();
	const workspaceDeletion = await ctx.db
		.query("data_deletion_requests")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.first();
	return (
		organization !== null &&
		workspace !== null &&
		workspace.organizationId === args.organizationId &&
		workspace.pluginDataPurgeStartedAt === undefined &&
		organizationDeletion === null &&
		workspaceDeletion === null
	);
}

/**
 * Whether a link may trust a stored restricted scope. A live link's scope is null, or a live
 * restricted root with no plugin binding. `dead` means the scope node stopped being a root, which
 * ended its links, so a new link waits for the scope op. `bound` means a plugin decides who reads the
 * area. Reads at most 5 docs. Never cache the answer: a turn-on and a bind at the same moment must
 * read the same binding docs, so one of them retries.
 */
async function db_check_scope(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		restrictedScopeNodeId: Id<"files_nodes"> | null;
	},
) {
	if (args.restrictedScopeNodeId === null) {
		return "ok" as const;
	}

	const scopeNode = await files_saved_placement_db_get_node(ctx.db, args.restrictedScopeNodeId);
	if (
		!scopeNode ||
		scopeNode.organizationId !== args.organizationId ||
		scopeNode.workspaceId !== args.workspaceId ||
		scopeNode.restrictedScopeNodeId !== scopeNode._id
	) {
		return "dead" as const;
	}
	if (await files_nodes_db_has_plugin_binding(ctx, scopeNode._id)) {
		return "bound" as const;
	}

	return "ok" as const;
}

/**
 * The node's asset when it belongs to the node's tenant and its upload has finished. Reads 1 doc.
 */
async function db_get_finished_asset(ctx: QueryCtx | MutationCtx, node: Doc<"files_nodes">) {
	const asset = node.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
	if (
		!asset ||
		asset.organizationId !== node.organizationId ||
		asset.workspaceId !== node.workspaceId ||
		asset.r2Key === undefined ||
		asset.unfinalizedExpiresAt !== undefined
	) {
		return null;
	}

	return { ...asset, r2Key: asset.r2Key };
}

/**
 * Whether the stored text shape matches the content type. The public reader shows editable text only
 * through its committed text. A stored blob with a text type has no such text, so it cannot be shared.
 */
function has_shareable_text_shape(node: Doc<"files_nodes">) {
	const textShape = files_editable_text_shape_of(node.contentType);
	return node.textKind === null ? textShape === null : textShape?.rootKind === node.textKind;
}

/**
 * Check that a file may be shown through a public link right now.
 *
 * The caller has already loaded the node in this workspace. The `_nay` messages explain a refused
 * turn-on to a manager. The public view must answer all of them with the same generic "unavailable".
 */
export async function files_share_links_db_check_live_file(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		node: Doc<"files_nodes">;
	},
) {
	const { node } = args;
	if (node.kind !== "file") {
		return Result({ _nay: { message: "Only a file can have a public link" } });
	}
	if (node.archiveOperationId !== null) {
		return Result({ _nay: { message: "This file is archived" } });
	}

	if (!(await db_is_workspace_live(ctx, args))) {
		return Result({ _nay: { message: "This workspace is being deleted" } });
	}

	const scope = await db_check_scope(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		restrictedScopeNodeId: node.restrictedScopeNodeId,
	});
	if (scope === "dead") {
		return Result({ _nay: { message: "Wait until the access change of a folder above finishes" } });
	}
	if (scope === "bound") {
		return Result({ _nay: { message: "A plugin decides who can read this file, so it cannot have a public link" } });
	}

	const asset = await db_get_finished_asset(ctx, node);
	if (!asset) {
		return Result({ _nay: { message: "Wait until this file finishes uploading" } });
	}

	if (!has_shareable_text_shape(node)) {
		return Result({ _nay: { message: "This type of file cannot have a public link" } });
	}

	return Result({ _yay: { asset } });
}

/**
 * The public view spent its read limits. The view must stop from deep inside nested read helpers, so it
 * throws. This module always catches it and answers "unavailable". It never leaves this module.
 */
class ShareViewBudgetError extends Error {}

/**
 * What one public view has read so far.
 */
type ViewReads = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	calls: number;
	docs: number;
	bytes: number;
};

/**
 * Count planned reads before they run. Keep room for one more doc of the largest size per planned doc,
 * so the reads cannot pass the byte limit.
 */
function reads_reserve(args: { reads: ViewReads; calls: number; docs: number }) {
	const { reads, calls, docs } = args;

	if (
		reads.calls + calls > MAX_VIEW_READ_CALLS ||
		reads.docs + docs > MAX_VIEW_READ_DOCS ||
		reads.bytes + docs * MAX_DOC_BYTES > MAX_VIEW_READ_BYTES
	) {
		throw new ShareViewBudgetError("Public view read budget spent");
	}

	reads.calls += calls;
	reads.docs += docs;
}

/**
 * Add a doc's size after the read. `getConvexSize` is an estimate, so `reads_sync` later takes the real
 * numbers from Convex. The extra 128 bytes per doc are a safety margin for what the estimate leaves
 * out, the same margin as the review unit budget in files_pending_update_runs.ts.
 */
function reads_count(reads: ViewReads, doc: Value | null) {
	if (doc !== null) {
		reads.bytes += getConvexSize(doc) + 128;
	}
}

/**
 * Take the real read numbers from Convex. They include reads inside helpers that the view counts only
 * by their planned size.
 */
async function reads_sync(ctx: QueryCtx, reads: ViewReads) {
	const metrics = await ctx.meta.getTransactionMetrics();
	reads.calls = Math.max(reads.calls, metrics.databaseQueries.used);
	reads.docs = Math.max(reads.docs, metrics.documentsRead.used);
	reads.bytes = Math.max(reads.bytes, metrics.bytesRead.used);
}

async function reads_get<TableName extends TableNames>(args: {
	ctx: QueryCtx;
	reads: ViewReads;
	table: TableName;
	id: Id<TableName>;
}) {
	const { ctx, reads, table, id } = args;

	reads_reserve({ reads, calls: 1, docs: 1 });
	const doc = await ctx.db.get(table, id);
	reads_count(reads, doc);
	return doc;
}

async function reads_get_node(args: { ctx: QueryCtx; reads: ViewReads; id: Id<"files_nodes"> }) {
	// A reserved node adds one cohort and one candidate read.
	reads_reserve({ reads: args.reads, calls: 3, docs: 3 });
	const node = await files_saved_placement_db_get_node(args.ctx.db, args.id);
	reads_count(args.reads, node);
	return node;
}

/**
 * Read the docs of one index range. Count each doc before Convex reads it.
 */
async function* reads_iterate<T extends Value>(reads: ViewReads, docs: AsyncIterable<T>) {
	reads_reserve({ reads, calls: 1, docs: 1 });
	for await (const doc of docs) {
		reads_count(reads, doc);
		yield doc;
		reads_reserve({ reads, calls: 0, docs: 1 });
	}
}

/**
 * The service accounts with `permission` on one exact open file. Null past the sharing cap.
 */
async function db_read_file_service_accounts(args: {
	ctx: QueryCtx;
	reads: ViewReads;
	nodeId: Id<"files_nodes">;
	permission: "content.read" | "content.write";
}) {
	const { ctx, reads } = args;

	const accountIds = new Set<Id<"access_control_service_accounts">>();
	let grantCount = 0;
	for await (const grant of reads_iterate(
		reads,
		ctx.db
			.query("access_control_permission_grants")
			.withIndex("by_organization_workspace_resource_public_permission", (q) =>
				q
					.eq("organizationId", reads.organizationId)
					.eq("workspaceId", reads.workspaceId)
					.eq("resourceKind", "file")
					.eq("resourceId", String(args.nodeId))
					.eq("principalKind", "service_account")
					.eq("permission", args.permission),
			),
	)) {
		grantCount += 1;
		if (grantCount > MAX_GRANT_PRINCIPALS) {
			return null;
		}
		if (grant.serviceAccountId) {
			accountIds.add(grant.serviceAccountId);
		}
	}

	return accountIds;
}

/**
 * Whether a service account is live in this workspace, and whether it reads every open file.
 */
async function db_read_service_account_access(args: {
	ctx: QueryCtx;
	reads: ViewReads;
	accountId: Id<"access_control_service_accounts">;
}) {
	const { ctx, reads, accountId } = args;

	const account = await reads_get({ ctx, reads, table: "access_control_service_accounts", id: accountId });
	if (
		!account ||
		account.revokedAt !== null ||
		account.organizationId !== reads.organizationId ||
		account.workspaceId !== reads.workspaceId
	) {
		return { live: false, readsWorkspace: false };
	}

	reads_reserve({ reads, calls: 1, docs: 1 });
	const workspaceGrant = await ctx.db
		.query("access_control_permission_grants")
		.withIndex("by_organization_workspace_resource_serviceAccount_permission", (q) =>
			q
				.eq("organizationId", reads.organizationId)
				.eq("workspaceId", reads.workspaceId)
				.eq("resourceKind", "workspace")
				.eq("resourceId", reads.workspaceId)
				.eq("principalKind", "service_account")
				.eq("serviceAccountId", accountId)
				.eq("permission", "content.read"),
		)
		.first();
	reads_count(reads, workspaceGrant);
	return { live: true, readsWorkspace: workspaceGrant !== null };
}

/**
 * The saved file that one image or video names, when it is an image or video file of the shared
 * file's workspace. Null otherwise.
 */
async function db_read_media_node(args: {
	ctx: QueryCtx;
	reads: ViewReads;
	item: { kind: files_share_rich_text_MediaKind; src: string };
}) {
	const { ctx, reads, item } = args;

	const parsed = files_media_parse_src(item.src);
	let mediaNodeId: Id<"files_nodes"> | null = null;
	if (parsed.kind === "file") {
		mediaNodeId = ctx.db.normalizeId("files_nodes", parsed.fileNodeId);
	}
	// A draft reference shows only through the saved file it was published as, never through the draft.
	else if (parsed.kind === "private") {
		const privateNodeId = ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId);
		if (privateNodeId) {
			reads_reserve({ reads, calls: 1, docs: 1 });
			const resolved = await files_saved_placement_db_resolve_read_target(ctx.db, {
				organizationId: reads.organizationId,
				workspaceId: reads.workspaceId,
				target: { kind: "private", id: privateNodeId },
			});
			mediaNodeId = resolved?.kind === "saved" ? resolved.id : null;
		}
	}
	if (!mediaNodeId) {
		return null;
	}

	const mediaNode = await reads_get_node({ ctx, reads, id: mediaNodeId });
	if (
		!mediaNode ||
		mediaNode.kind !== "file" ||
		mediaNode.organizationId !== reads.organizationId ||
		mediaNode.workspaceId !== reads.workspaceId ||
		mediaNode.archiveOperationId !== null ||
		// Only an image or video that a signed URL may serve inline. An image needs an image file, and a
		// video needs a video file.
		!files_is_inline_media_content_type(mediaNode.contentType) ||
		!mediaNode.contentType?.startsWith(`${item.kind}/`)
	) {
		return null;
	}

	return mediaNode;
}

/**
 * The finished asset of a media file that the shared file's visitors may see, or null.
 *
 * The media file must show to the same people as the shared file, so it needs the same stored restricted
 * scope. The shared file's scope check then answers for the media file too. In an open scope, a service
 * account can hold write access to the shared file alone. It could add an image it cannot read and
 * publish it through the link. So every such account must be live and able to read the media file.
 */
async function db_check_media_node(args: {
	ctx: QueryCtx;
	reads: ViewReads;
	mediaNode: Doc<"files_nodes">;
	restrictedScopeNodeId: Id<"files_nodes"> | null;
	readFileWriters: () => Promise<Set<Id<"access_control_service_accounts">> | null>;
	accountAccess: Map<Id<"access_control_service_accounts">, { live: boolean; readsWorkspace: boolean }>;
}) {
	const { ctx, reads } = args;

	if (args.mediaNode.restrictedScopeNodeId !== args.restrictedScopeNodeId) {
		return null;
	}

	if (args.restrictedScopeNodeId === null) {
		const writerAccountIds = await args.readFileWriters();
		if (!writerAccountIds) {
			return null;
		}

		if (writerAccountIds.size > 0) {
			const readerAccountIds = await db_read_file_service_accounts({
				ctx,
				reads,
				nodeId: args.mediaNode._id,
				permission: "content.read",
			});
			if (!readerAccountIds) {
				return null;
			}

			for (const accountId of writerAccountIds) {
				let access = args.accountAccess.get(accountId);
				if (!access) {
					access = await db_read_service_account_access({ ctx, reads, accountId });
					args.accountAccess.set(accountId, access);
				}
				// Never skip a revoked or missing account. Its write grant stays, so the media stays hidden.
				if (!access.live || !(access.readsWorkspace || readerAccountIds.has(accountId))) {
					return null;
				}
			}
		}
	}

	reads_reserve({ reads, calls: 1, docs: 1 });
	return await db_get_finished_asset(ctx, args.mediaNode);
}

/**
 * Prepare the public view of a link: every live check, the safe content, the media map, and the
 * revision. Returns null when the link cannot show anything now.
 *
 * Throws `ShareViewBudgetError` when the shared file itself cannot be checked within the read limits.
 */
async function db_prepare_share_link_view(ctx: QueryCtx, token: string) {
	// The shared file
	const linkReads = { calls: 1, docs: 1, bytes: 0 };
	const link = await ctx.db
		.query("files_share_links")
		.withIndex("by_token", (q) => q.eq("token", token))
		.first();
	if (!link || !(await files_share_links_db_is_selected(ctx.db, link))) {
		return null;
	}

	const reads: ViewReads = {
		...linkReads,
		organizationId: link.organizationId,
		workspaceId: link.workspaceId,
	};
	reads_count(reads, link);

	const node = await reads_get_node({ ctx, reads, id: link.nodeId });
	if (
		!node ||
		node.kind !== "file" ||
		node.organizationId !== link.organizationId ||
		node.workspaceId !== link.workspaceId ||
		node.archiveOperationId !== null ||
		!has_shareable_text_shape(node)
	) {
		return null;
	}

	const { restrictedScopeNodeId } = link;
	reads_reserve({ reads, calls: 5, docs: 5 });
	if (node.restrictedScopeNodeId !== restrictedScopeNodeId || (await db_check_scope(ctx, link)) !== "ok") {
		return null;
	}

	reads_reserve({ reads, calls: 5, docs: 5 });
	const asset = await db_get_finished_asset(ctx, node);
	if (!asset || !(await db_is_workspace_live(ctx, link))) {
		return null;
	}

	// The saved text. Read only the committed chunks: never a draft, and never the live Yjs head, which
	// can be ahead of the saved text.
	const chunks: Array<Extract<Doc<"files_text_chunks">, { sourceKind: "committed" }>> = [];
	let prepared: files_share_rich_text_Prepared | null = null;
	if (node.textKind !== null) {
		for await (const chunk of reads_iterate(
			reads,
			files_saved_content_db_text_chunks(ctx.db, {
				organizationId: link.organizationId,
				workspaceId: link.workspaceId,
				nodeId: node._id,
			}),
		)) {
			if (chunk.sourceKind === "committed") {
				chunks.push(chunk);
			}
		}

		// An empty file stores no chunk. Missing chunks of a non-empty file, or a gap, show nothing.
		const text = chunks.length > 0 ? files_merge_contiguous_chunks(chunks) : asset.size === 0 ? "" : null;
		if (text === null) {
			return null;
		}

		const preparedResult = files_share_rich_text_prepare({ text, textKind: node.textKind });
		if (preparedResult._nay) {
			return null;
		}
		prepared = preparedResult._yay;
	}
	await reads_sync(ctx, reads);

	// The files the images and videos name. Once the read limits are near, stop checking media: the rest
	// show as unavailable, and the shared file still shows.
	const media = prepared?.media ?? [];
	let mediaBudgetSpent = false;
	const mediaNodes: Array<Doc<"files_nodes"> | null> = [];
	for (const item of media) {
		let mediaNode: Doc<"files_nodes"> | null = null;
		if (!mediaBudgetSpent) {
			try {
				mediaNode = await db_read_media_node({ ctx, reads, item });
			} catch (error) {
				if (!(error instanceof ShareViewBudgetError)) {
					throw error;
				}
				mediaBudgetSpent = true;
			}
		}
		mediaNodes.push(mediaNode);
	}
	await reads_sync(ctx, reads);

	// Each media file needs the shared file's scope and a finished asset, and every narrow writer must read it.
	let fileWriterAccountIds: Set<Id<"access_control_service_accounts">> | null | undefined;
	const accountAccess = new Map<Id<"access_control_service_accounts">, { live: boolean; readsWorkspace: boolean }>();
	const mediaAssets: Array<Awaited<ReturnType<typeof db_get_finished_asset>>> = [];
	for (const mediaNode of mediaNodes) {
		let mediaAsset: Awaited<ReturnType<typeof db_get_finished_asset>> = null;
		if (mediaNode && !mediaBudgetSpent) {
			try {
				mediaAsset = await db_check_media_node({
					ctx,
					reads,
					mediaNode,
					restrictedScopeNodeId,
					readFileWriters: async () => {
						fileWriterAccountIds ??= await db_read_file_service_accounts({
							ctx,
							reads,
							nodeId: node._id,
							permission: "content.write",
						});
						return fileWriterAccountIds;
					},
					accountAccess,
				});
				await reads_sync(ctx, reads);
			} catch (error) {
				if (!(error instanceof ShareViewBudgetError)) {
					throw error;
				}
				mediaAsset = null;
				mediaBudgetSpent = true;
			}
		}
		mediaAssets.push(mediaAsset);
	}

	const content = prepared
		? files_share_rich_text_finish({ prepared, isMediaAvailable: (index) => mediaAssets[index] !== null })
		: { kind: "binary" as const };

	// The revision changes with the saved text, the file and its settings, and each media file. A visitor
	// sees only its hash, never the IDs inside it.
	const revision = await crypto_sha256_hex(
		JSON.stringify([
			SHARE_FORMAT_VERSION,
			link._id,
			[asset._id, asset.r2Key, asset.size],
			[node.name, node.contentType, node.textKind, node.collaborationEnabled],
			chunks.map((chunk) => [chunk._id, chunk.chunkIndex, chunk.yjsSequence ?? null]),
			media.map((item, index) => {
				const mediaNode = mediaNodes[index];
				const mediaAsset = mediaAssets[index];
				return [
					item.kind,
					item.src,
					mediaNode && mediaAsset
						? [mediaNode._id, mediaNode.contentType, mediaAsset._id, mediaAsset.r2Key, mediaAsset.size]
						: null,
				];
			}),
		]),
	);

	const view = {
		name: node.name,
		textKind: node.textKind,
		contentType: node.contentType,
		size: asset.size,
		content,
		// The plain-text fallback shows no media, so it describes none.
		media:
			content.kind === "rich_text"
				? media.map((item, index) =>
						mediaAssets[index] !== null
							? { index, available: true as const, kind: item.kind }
							: { index, available: false as const },
					)
				: [],
		revision,
	};
	if (getConvexSize(view) > MAX_VIEW_BYTES) {
		return null;
	}

	return { view, asset, mediaNodes, mediaAssets };
}

/**
 * The public page of a link. Anyone with the token may call this, with or without an account.
 */
export const get_share_link_view = query({
	args: { token: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			name: doc(app_convex_schema, "files_nodes").fields.name,
			textKind: doc(app_convex_schema, "files_nodes").fields.textKind,
			contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
			size: v.number(),
			content: v.union(
				v.object({ kind: v.literal("rich_text"), json: v.string() }),
				v.object({ kind: v.literal("plain_text"), text: v.string(), formattingFallback: v.boolean() }),
				v.object({ kind: v.literal("binary") }),
			),
			media: v.array(
				v.union(
					v.object({
						index: v.number(),
						available: v.literal(true),
						kind: v.union(v.literal("image"), v.literal("video")),
					}),
					v.object({ index: v.number(), available: v.literal(false) }),
				),
			),
			revision: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		// The token is the only authority, so this never reads `ctx.auth`. Every refusal is null, not
		// "Unauthenticated": a visitor sees one generic message, and a wrong token looks the same as a
		// link that was turned off.
		if (!TOKEN_REGEX.test(args.token)) {
			return null;
		}

		try {
			return (await db_prepare_share_link_view(ctx, args.token))?.view ?? null;
		} catch (error) {
			if (error instanceof ShareViewBudgetError) {
				return null;
			}
			throw error;
		}
	},
});

/**
 * What a visitor may ask a signed URL for: the shared file itself, or one media of the page by its
 * index. The visitor never names a node, an asset, or a file name.
 */
const download_target_validator = v.union(
	v.object({ kind: v.literal("file") }),
	v.object({ kind: v.literal("embed"), index: v.number() }),
);

/**
 * The link doc of a token, for the rate limit. Reads 1 doc.
 */
export const get_share_link_id = internalQuery({
	args: { token: v.string() },
	returns: v.union(v.id("files_share_links"), v.null()),
	handler: async (ctx, args) => {
		const link = await ctx.db
			.query("files_share_links")
			.withIndex("by_token", (q) => q.eq("token", args.token))
			.first();
		return link?._id ?? null;
	},
});

type get_share_link_id_Result =
	typeof get_share_link_id extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Prepare the R2 keys and response headers for signed URLs of a link.
 *
 * Runs every check of the public view and prepares the whole page, even when the visitor asks for a
 * few targets, so the revision is the one the page shows. A different revision is `stale`.
 */
export const prepare_share_link_download = internalQuery({
	args: { token: v.string(), revision: v.string(), targets: v.array(download_target_validator) },
	returns: v.union(
		v.object({ status: v.literal("unavailable") }),
		v.object({ status: v.literal("stale") }),
		v.object({
			status: v.literal("ready"),
			revision: v.string(),
			items: v.array(
				v.object({
					target: download_target_validator,
					r2Key: v.string(),
					responseContentType: v.string(),
					responseContentDisposition: v.string(),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const unavailable = { status: "unavailable" as const };

		let prepared: Awaited<ReturnType<typeof db_prepare_share_link_view>>;
		try {
			prepared = await db_prepare_share_link_view(ctx, args.token);
		} catch (error) {
			if (error instanceof ShareViewBudgetError) {
				return unavailable;
			}
			throw error;
		}
		if (!prepared) {
			return unavailable;
		}

		const { view } = prepared;
		if (view.revision !== args.revision) {
			return { status: "stale" as const };
		}

		const items = [];
		for (const target of args.targets) {
			if (target.kind === "file") {
				// Text shows only as the page's safe content. The raw saved text is never downloaded.
				if (view.textKind !== null) {
					return unavailable;
				}

				items.push({
					target,
					r2Key: prepared.asset.r2Key,
					...files_get_signed_download_serving({ contentType: view.contentType, fileName: view.name }),
				});
				continue;
			}

			const mediaNode = prepared.mediaNodes.at(target.index);
			const mediaAsset = prepared.mediaAssets.at(target.index);
			const mediaItem = view.media.at(target.index);
			if (!mediaNode || !mediaAsset || !mediaItem?.available) {
				return unavailable;
			}

			// The signed URL carries the file name, and a media file's own name can be private. So name it
			// by its type only, like `image.png`. The view allows only image and video types that parse.
			const essence = files_parse_content_type(mediaNode.contentType ?? "")?.essence ?? mediaItem.kind;
			items.push({
				target,
				r2Key: mediaAsset.r2Key,
				...files_get_signed_download_serving({
					contentType: mediaNode.contentType,
					fileName: essence.replace("/", "."),
				}),
			});
		}

		return { status: "ready" as const, revision: view.revision, items };
	},
});

type prepare_share_link_download_Result =
	typeof prepare_share_link_download extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Signed URLs for the shared file or the media of its page. Anyone with the token may call this.
 *
 * Every refusal has the same message, like the view's null. `stale` means the page changed: the
 * visitor waits for the new revision instead of asking again with the old one.
 */
export const create_share_link_download_urls = action({
	args: { token: v.string(), revision: v.string(), targets: v.array(download_target_validator) },
	returns: v_result({
		_yay: v.union(
			v.object({
				status: v.literal("ready"),
				revision: v.string(),
				urls: v.array(v.object({ target: download_target_validator, url: v.string(), expiresAt: v.number() })),
			}),
			v.object({ status: v.literal("stale") }),
		),
		_nay: { data: v.object({ retryAfterMs: v.number() }) },
	}),
	handler: async (ctx, args) => {
		const notFound = Result({ _nay: { message: "Not found" } });

		const targetKeys = new Set(args.targets.map((target) => (target.kind === "file" ? "file" : target.index)));
		// A page shows at most `files_share_rich_text_MAX_MEDIA` media. A page with media is text, which
		// has no file target, so one call never needs more targets than that.
		if (
			!TOKEN_REGEX.test(args.token) ||
			!REVISION_REGEX.test(args.revision) ||
			args.targets.length === 0 ||
			args.targets.length > files_share_rich_text_MAX_MEDIA ||
			targetKeys.size !== args.targets.length ||
			args.targets.some(
				(target) =>
					target.kind === "embed" &&
					!(Number.isInteger(target.index) && target.index >= 0 && target.index < files_share_rich_text_MAX_MEDIA),
			)
		) {
			return notFound;
		}

		const linkId = (await ctx.runQuery(internal.files_share_links.get_share_link_id, {
			token: args.token,
		})) as get_share_link_id_Result;
		if (!linkId) {
			return notFound;
		}

		// Charge before the full preparation, which is the costly part. Key by the link doc, so the rate
		// limit state never holds the token.
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "files_share_link_download",
			key: linkId,
			count: args.targets.length,
		});
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message, data: { retryAfterMs: rateLimit.retryAfterMs } } });
		}

		const prepared = (await ctx.runQuery(internal.files_share_links.prepare_share_link_download, {
			token: args.token,
			revision: args.revision,
			targets: args.targets,
		})) as prepare_share_link_download_Result;
		if (prepared.status === "unavailable") {
			return notFound;
		}
		if (prepared.status === "stale") {
			return Result({ _yay: { status: "stale" as const } });
		}

		// Take the time before signing, so the page never trusts a URL longer than it works.
		const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
		const urls = await Promise.all(
			prepared.items.map(async (item) => ({
				target: item.target,
				url: await r2.getUrl(item.r2Key, {
					expiresIn: SIGNED_URL_TTL_SECONDS,
					responseContentType: item.responseContentType,
					responseContentDisposition: item.responseContentDisposition,
				}),
				expiresAt,
			})),
		);

		return Result({ _yay: { status: "ready" as const, revision: prepared.revision, urls } });
	},
});

/**
 * List the public links of one workspace, one item for each linked file the caller may read. The Files
 * tree marks these files, and the `file.link:public` search filter lists them.
 *
 * It never returns the token. Only a manager of the file gets it, from `get_node_share_state`. The
 * browser takes names and paths from its own tree rows.
 */
export const list_workspace_links = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.union(
		v.null(),
		v.array(
			v.object({
				nodeId: doc(app_convex_schema, "files_share_links").fields.nodeId,
				createdBy: doc(app_convex_schema, "files_share_links").fields.createdBy,
				createdAt: doc(app_convex_schema, "files_share_links").fields.createdAt,
			}),
		),
	),
	handler: async (ctx, args) => {
		// Answer the same members as the Files tree, including one who was only given single files.
		const reader = await files_nodes_db_get_tree_reader(ctx, { membershipId: args.membershipId });
		if (!reader) {
			return null;
		}
		const { userAuth, membership } = reader;

		// `set_node_share_link` keeps at most this many links in a workspace.
		const stored = await ctx.db
			.query("files_share_links")
			.withIndex("by_organization_workspace_node", (q) =>
				q.eq("organizationId", membership.organizationId).eq("workspaceId", membership.workspaceId),
			)
			.take(files_share_links_MAX_PER_WORKSPACE);
		const links = (
			await Promise.all(
				stored.map(async (link) => ((await files_share_links_db_is_selected(ctx.db, link)) ? link : null)),
			)
		).filter((link) => link !== null);

		// The link doc keeps the file's restricted scope. The hooks that change a file's scope delete its
		// link in the same write, so the scope is current. The check still reads each node for its added
		// people.
		const readable = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			subject: { kind: "user", userId: userAuth.id, plugin: null },
			nodes: links.map((link) => ({
				_id: link.nodeId,
				restrictedScopeNodeId: link.restrictedScopeNodeId,
				createdBy: link.createdBy,
				createdAt: link.createdAt,
			})),
		});

		return readable.map((link) => ({ nodeId: link._id, createdBy: link.createdBy, createdAt: link.createdAt }));
	},
});
