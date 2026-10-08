import {
	paginationOptsValidator,
	paginationResultValidator,
	type PaginationResult,
	type RegisteredQuery,
} from "convex/server";
import { compareValues, v, type Infer, type Value } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalQuery, query, type QueryCtx, type MutationCtx } from "./_generated/server.js";
import app_convex_schema, {
	files_pending_target_validator,
	files_pending_parent_validator,
	files_metadata_search_plan_validator,
	ai_chat_workspaces_source_validator,
} from "./schema.ts";
import { ai_chat_workspaces_db_authorize_file_scope } from "./ai_chat_workspaces.ts";
import { files_db_resolve_scope } from "./files_scopes.ts";
import { files_db_authorize_file_read } from "./files_volume_access.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { files_metadata_db_query_saved_plan } from "./files_metadata.ts";
import { files_db_get_visible_node_by_path } from "../server/files.ts";
import { files_visible_resolve_db_create } from "../server/files-visible-resolve.ts";
import {
	files_pending_overlay_LIST_STREAM_MAX_PAGE,
	files_pending_overlay_list_over_budget,
	files_pending_overlay_window_ranges,
} from "../server/files-pending-overlay.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import {
	path_tree_prefix_upper_bound,
	server_convex_get_user_fallback_to_anonymous,
	server_path_normalize,
	string_prefix_upper_bound,
} from "../server/server-utils.ts";
import {
	files_ANCESTOR_FIELD_COUNT,
	files_derive_tree_path_for_file_node,
	files_pending_update_content_is_stale,
	files_pending_update_has_pending_chunks,
	type files_PendingTarget,
	type files_PendingParent,
	type files_VisibleEntry,
} from "../shared/files.ts";
import { organizations_is_global_organization_id } from "../shared/organizations.ts";
import { path_name_of } from "../shared/paths.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// The page cap and the split guard of `list_private_folder_children`. The worst row is a saved node
// moved into the folder that is its own restricted scope: it reads the node and runs a fresh access
// check. For a member whose read comes from their second role, with an old plugin grant too, that is
// 10 index ranges (measured in the cost test under `list_private_folder_children`). floor(3,000 / 10)
// is 300. Keep 250 for a margin.
const PRIVATE_FOLDER_PAGE_MAX_ITEMS = 250;

// Outside the owner's overlay, the read filter of an agent stream checks access on this many rows at
// a time.
const STREAM_ACCESS_CHUNK = 25;

// The hidden folders one subtree stream call reads under the listing folder.
const STREAM_HIDDEN_FOLDERS_MAX = 1_000;

const listing_args = {
	folderPath: v.string(),
	mode: v.union(v.literal("children"), v.literal("subtree"), v.literal("recent")),
	numItems: v.number(),
	cursor: paginationOptsValidator.fields.cursor,
	order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
	kind: v.optional(doc(app_convex_schema, "files_nodes").fields.kind),
	lowercaseExtension: v.optional(v.string()),
	minDepth: v.optional(v.number()),
	maxDepth: v.optional(v.number()),
	pathQuery: v.optional(v.string()),
	orderBy: v.optional(v.union(v.literal("name"), v.literal("updatedAt"))),
};

const internal_listing_args = v.object({
	...listing_args,
	agentSource: v.optional(ai_chat_workspaces_source_validator),
	organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
	visibilityUserId: v.id("users"),
	serviceAccountId: v.optional(v.id("access_control_service_accounts")),
	overlayUserId: v.optional(v.id("users")),
	// Transfer discovery must refuse an incomplete folder instead of hiding unreadable children.
	requireComplete: v.optional(v.boolean()),
});

/**
 * Reuse parent and permission reads within one query, leaving room for its own work.
 */
export async function files_visible_db_create_reader(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		readLimit?: number;
		/** Review preparation may read children before applying these exact parent deletes. */
		reviewedArchiveIds?: ReadonlySet<Id<"files_pending_updates">>;
	},
) {
	// A draft move into a folder the user can no longer read resolves at its saved place, so a path
	// never names that folder.
	const core = files_visible_resolve_db_create(ctx.db, { ...args, canReadDestination: can_read });

	const membership = await core.read(() =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_user_organization_workspace_active", (q) =>
				q
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("active", true),
			)
			.first(),
	);

	const readableByScope = new Map<string, Promise<boolean>>();
	async function can_read(node: Doc<"files_nodes"> | null) {
		if (!membership) return false;
		const key = node?.restrictedScopeNodeId ?? "workspace";
		let readable = readableByScope.get(key);
		if (!readable) {
			readable = access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.userId },
				membership,
				permission: "content.read",
				fileNode: node ?? undefined,
			}).then((result) => !result._nay);
			readableByScope.set(key, readable);
		}
		return await readable;
	}

	async function parent_aliases(parent: files_PendingParent) {
		const parents = [parent];
		if (parent.kind === "saved") {
			const receipt = await core.read(() =>
				ctx.db
					.query("files_pending_node_publish_receipts")
					.withIndex("by_savedNode", (q) => q.eq("savedNodeId", parent.id))
					.unique(),
			);
			if (receipt?.userId === args.userId) parents.push({ kind: "private", id: receipt.privateNodeId });
		}
		return parents;
	}

	/**
	 * The one visible child of `parent` at `path` (the parent's path plus the child's name).
	 */
	async function find_child(parent: files_PendingParent, path: string) {
		const name = path_name_of(path);
		const candidates = new Map<string, files_PendingTarget>();
		if (parent.kind !== "private") {
			const parentId = parent.kind === "root" ? "root" : parent.id;
			const saved = await core.read(() =>
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("parentId", parentId)
							.eq("archiveOperationId", null)
							.eq("name", name),
					)
					.first(),
			);
			if (saved) candidates.set(saved._id, { kind: "saved", id: saved._id });
		}

		for (const alias of await parent_aliases(parent)) {
			const privateNode = await core.read(() =>
				ctx.db
					.query("files_pending_nodes")
					.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("userId", args.userId)
							.eq("parent.kind", alias.kind)
							.eq("parent.id", alias.kind === "root" ? undefined : alias.id)
							.eq("state", "active")
							.eq("name", name),
					)
					.first(),
			);
			if (privateNode) candidates.set(privateNode._id, { kind: "private", id: privateNode._id });
			const move = await core.findSavedMove(alias, name);
			if (move) candidates.set(move.target.id, move.target);
		}

		let current: Awaited<ReturnType<typeof core.resolve>> = null;
		for (const target of candidates.values()) {
			const result = await core.resolve(target);
			if (result?.entry.path !== path) continue;
			if (current) return null;
			current = result;
		}
		return current;
	}

	async function find_path(path: string) {
		const segments = server_path_normalize(path).split("/").filter(Boolean);
		let parent: files_PendingParent = { kind: "root" };
		let current: Awaited<ReturnType<typeof core.resolve>> = null;

		for (let index = 0; index < segments.length; index++) {
			current = await find_child(parent, `/${segments.slice(0, index + 1).join("/")}`);
			if (!current || (index < segments.length - 1 && current.entry.node.kind !== "folder")) return null;
			parent =
				current.entry.kind === "saved"
					? { kind: "saved", id: current.entry.node._id }
					: { kind: "private", id: current.entry.node._id };
		}

		return current;
	}

	return {
		active: membership !== null,
		get exhausted() {
			return core.exhausted;
		},
		read: core.read,
		resolve: core.resolve,
		findPath: find_path,
		findChild: find_child,
		parentAliases: parent_aliases,
		canRead: can_read,
		async resolveTarget(target: files_PendingTarget) {
			if (!membership) return null;
			const result = await core.resolve(target);
			return result && (await can_read(result.accessNode)) ? result.entry : null;
		},
		async resolvePath(path: string) {
			if (!membership) return null;
			const result = await find_path(path);
			return result && (await can_read(result.accessNode)) ? result.entry : null;
		},
	};
}

/**
 * Whether a private node is still preparing: it has no create intent yet, or it is a text file whose
 * content is not sealed yet.
 */
export function files_visible_is_preparing(
	update: Pick<Doc<"files_pending_updates">, "createIntent" | "content"> | null | undefined,
) {
	const intent = update?.createIntent;
	return !intent || (intent.kind === "text" && !update?.content);
}

const entry_validator = v.object({
	target: files_pending_target_validator,
	path: v.string(),
	name: v.string(),
	kind: doc(app_convex_schema, "files_nodes").fields.kind,
	updatedAt: v.number(),
	updatedBy: doc(app_convex_schema, "files_nodes").fields.updatedBy,
	contentType: doc(app_convex_schema, "files_nodes").fields.contentType,
	preparing: v.boolean(),
});

const listing_result = v_result({
	_yay: v.object({
		items: v.array(entry_validator),
		continueCursor: v.union(v.string(), v.null()),
		isDone: v.boolean(),
	}),
});

async function db_list(ctx: QueryCtx, args: Infer<typeof internal_listing_args>) {
	const organizationId = args.organizationId;
	const fileScope = files_db_resolve_scope(ctx, args.workspaceId);
	const authorized = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
	if (authorized._nay) return Result({ _yay: { items: [], continueCursor: null, isDone: true } });
	const folderPath = server_path_normalize(args.folderPath);
	const limit = Math.max(1, Math.min(50, Math.floor(args.numItems)));

	const ownerScope =
		args.overlayUserId === args.visibilityUserId &&
		args.serviceAccountId === undefined &&
		!organizations_is_global_organization_id(organizationId) &&
		fileScope.kind === "workspace";

	const reader = ownerScope
		? await files_visible_db_create_reader(ctx, {
				organizationId,
				workspaceId: fileScope.workspaceId,
				userId: args.visibilityUserId,
			})
		: null;

	if (reader && !reader.active) return Result({ _yay: { items: [], continueCursor: null, isDone: true } });

	const rootEntry =
		folderPath === "/"
			? null
			: reader
				? (await reader.findPath(folderPath))?.entry
				: await files_db_get_visible_node_by_path(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						path: folderPath,
					});

	if (reader?.exhausted) return Result({ _nay: { message: "Listing is too broad. Narrow the folder or filters." } });

	if (folderPath !== "/" && (!rootEntry || ("node" in rootEntry ? rootEntry.node.kind : rootEntry.kind) !== "folder")) {
		return Result({ _yay: { items: [], continueCursor: null, isDone: true } });
	}

	const rootTarget: files_PendingParent =
		rootEntry === null || rootEntry === undefined
			? { kind: "root" }
			: "node" in rootEntry
				? rootEntry.kind === "private"
					? { kind: "private", id: rootEntry.node._id }
					: { kind: "saved", id: rootEntry.node._id }
				: { kind: "saved", id: rootEntry._id };

	const timeOrder = args.mode === "recent" || args.orderBy === "updatedAt";
	const order = args.order ?? (timeOrder ? "desc" : "asc");

	const scope = JSON.stringify([
		args.organizationId,
		args.workspaceId,
		args.visibilityUserId,
		args.serviceAccountId,
		args.overlayUserId,
		folderPath,
		rootTarget,
		args.mode,
		order,
		args.orderBy,
		args.kind,
		args.lowercaseExtension,
		args.minDepth,
		args.maxDepth,
		args.pathQuery,
		args.requireComplete,
	]);

	const parentSchema = z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("root") }),
		z.object({
			kind: z.literal("saved"),
			id: z.custom<Id<"files_nodes">>(
				(value) => typeof value === "string" && ctx.db.normalizeId("files_nodes", value) !== null,
			),
		}),
		z.object({
			kind: z.literal("private"),
			id: z.custom<Id<"files_pending_nodes">>(
				(value) => typeof value === "string" && ctx.db.normalizeId("files_pending_nodes", value) !== null,
			),
		}),
	]);

	const streamSchema = z.object({
		kind: z.enum(["saved", "private", "moved"]),
		parent: parentSchema,
		cursor: z.string().nullable(),
		done: z.boolean(),
	});

	const frameSchema = z.object({ parent: parentSchema, path: z.string(), streams: z.array(streamSchema).max(5) });
	type Stream = z.infer<typeof streamSchema>;
	type Frame = z.infer<typeof frameSchema>;

	async function create_frame(parent: files_PendingParent, path: string): Promise<Frame> {
		const streams: Stream[] = [];
		if (timeOrder || parent.kind !== "private") streams.push({ kind: "saved", parent, cursor: null, done: false });
		if (reader) {
			if (timeOrder) streams.push({ kind: "private", parent, cursor: null, done: false });
			else
				for (const alias of await reader.parentAliases(parent)) {
					streams.push(
						{ kind: "private", parent: alias, cursor: null, done: false },
						{ kind: "moved", parent: alias, cursor: null, done: false },
					);
				}
		}
		return { parent, path, streams };
	}

	let frames: Frame[];
	if (args.cursor !== null) {
		let raw: unknown;
		try {
			raw = JSON.parse(args.cursor);
		} catch {
			return Result({
				_nay: { message: "cursor is invalid; rerun the original command to get a fresh Next page cursor." },
			});
		}
		const parsed = z.object({ scope: z.literal(scope), frames: z.array(frameSchema).min(1).max(256) }).safeParse(raw);
		if (!parsed.success)
			return Result({
				_nay: {
					message: "cursor does not match this listing; rerun the original command to get a fresh Next page cursor.",
				},
			});
		frames = parsed.data.frames;
	} else frames = [await create_frame(rootTarget, folderPath)];

	const depth = (path: string) => path.split("/").filter(Boolean).length;
	const baseDepth = depth(folderPath);
	const in_scope = (path: string) => folderPath === "/" || path.startsWith(`${folderPath}/`);

	const to_item = (entry: files_VisibleEntry): Infer<typeof entry_validator> => {
		const intent = entry.kind === "private" ? entry.pendingUpdate.createIntent : null;
		const replacement = entry.kind === "saved" ? entry.pendingUpdate?.pendingReplacement : undefined;
		return {
			target: entry.kind === "saved" ? { kind: "saved", id: entry.node._id } : { kind: "private", id: entry.node._id },
			path: entry.path,
			name: path_name_of(entry.path),
			kind: entry.node.kind,
			updatedAt: entry.kind === "private" ? entry.pendingUpdate.updatedAt : entry.node.updatedAt,
			updatedBy: entry.kind === "private" ? entry.node.userId : entry.node.updatedBy,
			contentType:
				entry.kind === "saved"
					? (replacement?.contentType ?? entry.node.contentType)
					: intent && intent.kind !== "folder"
						? intent.contentType
						: null,
			preparing: entry.kind === "private" && files_visible_is_preparing(entry.pendingUpdate),
		};
	};

	const matches = (entry: Infer<typeof entry_validator>) => {
		if (!in_scope(entry.path)) return false;
		const relativeDepth = depth(entry.path) - baseDepth;
		if (args.minDepth !== undefined && relativeDepth < args.minDepth) return false;
		if (args.maxDepth !== undefined && relativeDepth > args.maxDepth) return false;
		if (args.kind !== undefined && entry.kind !== args.kind) return false;
		if (
			args.lowercaseExtension !== undefined &&
			(entry.kind !== "file" || entry.name.split(".").slice(1).at(-1)?.toLowerCase() !== args.lowercaseExtension)
		)
			return false;
		return args.pathQuery === undefined || entry.path.toLowerCase().includes(args.pathQuery.toLowerCase());
	};

	type Head = { item: Infer<typeof entry_validator>; readable: boolean; nextCursor: string; done: boolean };
	const heads = new Map<Stream, Head>();
	let scanned = 0;
	let progressed = false;

	async function peek(stream: Stream, frame: Frame) {
		if (heads.has(stream)) return heads.get(stream)!;
		while (!stream.done && scanned < 100 && !reader?.exhausted) {
			scanned++;
			const page = (await ctx.runQuery(internal.files_visible.internal_page, {
				agentSource: args.agentSource,
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				visibilityUserId: args.visibilityUserId,
				kind: stream.kind,
				parent: stream.parent,
				cursor: stream.cursor,
				timeOrder,
				order,
			})) as files_visible_internal_page_Result;
			const { target, savedNode, cursor, done } = page;
			const resolved = target && reader ? await reader.resolve(target) : null;
			// Keep this candidate for the next page when its ancestry used the remaining reads.
			if (reader?.exhausted) break;
			let entry: files_VisibleEntry | null = reader
				? (resolved?.entry ?? null)
				: savedNode
					? { kind: "saved", node: savedNode, pendingUpdate: null, path: savedNode.path }
					: null;
			// Renamed saved children come from the destination-name index so name order stays correct.
			if (entry?.kind === "saved" && !timeOrder && stream.kind === "saved" && entry.pendingUpdate?.pendingMove)
				entry = null;
			const entryParentPath = entry?.path.slice(0, entry.path.lastIndexOf("/")) || "/";
			if (entry && in_scope(entry.path) && (args.mode === "recent" || entryParentPath === frame.path)) {
				let readable: boolean;
				if (reader && resolved) readable = await reader.canRead(resolved.accessNode);
				else {
					const nodes = savedNode ? [savedNode] : [];
					readable =
						(
							await access_control_db_filter_readable_file_nodes(ctx, {
								organizationId: args.organizationId,
								workspaceId: args.workspaceId,
								userId: args.visibilityUserId,
								serviceAccountId: args.serviceAccountId,
								nodes,
							})
						).length > 0;
				}
				const head = { item: to_item(entry), readable, nextCursor: cursor, done };
				heads.set(stream, head);
				return head;
			}
			stream.cursor = cursor;
			stream.done = done;
			progressed = true;
		}
		return null;
	}

	const items: Infer<typeof entry_validator>[] = [];

	while (frames.length > 0 && items.length < limit && scanned < 100 && !reader?.exhausted) {
		const frame = frames[frames.length - 1]!;
		let picked: { stream: Stream; head: Head } | null = null;
		let incomplete = false;
		for (const stream of frame.streams) {
			const head = await peek(stream, frame);
			if (!head && !stream.done) {
				incomplete = true;
				break;
			}
			if (!head) continue;
			const comparison = picked
				? timeOrder
					? head.item.updatedAt - picked.head.item.updatedAt ||
						(head.item.target.id < picked.head.item.target.id ? -1 : 1)
					: compareValues(head.item.name, picked.head.item.name)
				: 0;
			if (!picked || (order === "desc" ? comparison > 0 : comparison < 0)) picked = { stream, head };
		}
		if (incomplete) break;
		if (!picked) {
			frames.pop();
			progressed = true;
			continue;
		}
		const item = picked.head.item;
		if (args.requireComplete && !picked.head.readable) return Result({ _nay: { message: "Permission denied" } });
		const nextFrame =
			args.mode === "subtree" &&
			item.kind === "folder" &&
			(args.maxDepth === undefined || depth(item.path) - baseDepth < args.maxDepth)
				? await create_frame(item.target, item.path)
				: null;
		if (reader?.exhausted) break;
		picked.stream.cursor = picked.head.nextCursor;
		picked.stream.done = picked.head.done;
		heads.delete(picked.stream);
		progressed = true;
		if (picked.head.readable && matches(item)) items.push(item);
		if (nextFrame) frames.push(nextFrame);
	}

	if (reader?.exhausted && !progressed)
		return Result({ _nay: { message: "Listing is too broad. Narrow the folder or filters." } });

	return Result({
		_yay: {
			items,
			continueCursor: frames.length === 0 ? null : JSON.stringify({ scope, frames }),
			isDone: frames.length === 0,
		},
	});
}

export const internal_page = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		visibilityUserId: v.id("users"),
		kind: v.union(v.literal("saved"), v.literal("private"), v.literal("moved")),
		parent: files_pending_parent_validator,
		cursor: paginationOptsValidator.fields.cursor,
		timeOrder: v.boolean(),
		order: v.union(v.literal("asc"), v.literal("desc")),
	},
	returns: v.object({
		target: v.union(files_pending_target_validator, v.null()),
		savedNode: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
		cursor: v.string(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const fileScope = files_db_resolve_scope(ctx, args.workspaceId);
		const tenantScope =
			!organizations_is_global_organization_id(args.organizationId) && fileScope.kind === "workspace"
				? { organizationId: args.organizationId, workspaceId: fileScope.workspaceId }
				: null;
		if (fileScope.kind === "volume") {
			// A volume has saved entries only, even if a cursor asks for a private stream.
			if (args.kind !== "saved" || args.parent.kind === "private")
				return { target: null, savedNode: null, cursor: args.cursor ?? "", done: true };
			const authorized = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
			if (authorized._nay) return { target: null, savedNode: null, cursor: args.cursor ?? "", done: true };
		}
		const stream = args;
		const timeOrder = args.timeOrder;
		const order = args.order;

		let target: files_PendingTarget | null = null;
		let savedNode: Doc<"files_nodes"> | null = null;
		let cursor: string;
		let done: boolean;

		if (stream.kind === "saved") {
			const parentId = stream.parent.kind === "saved" ? stream.parent.id : "root";

			const savedQuery = timeOrder
				? ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_archiveOperation_updatedAt", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("archiveOperationId", null),
						)
				: ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("parentId", parentId)
								.eq("archiveOperationId", null),
						);

			const page = await savedQuery.order(order).paginate({ cursor: stream.cursor, numItems: 1 });
			savedNode = page.page[0] ?? null;
			target = savedNode ? { kind: "saved", id: savedNode._id } : null;
			cursor = page.continueCursor;
			done = page.isDone;
		} else if (stream.kind === "private" && !timeOrder) {
			if (!tenantScope) return { target: null, savedNode: null, cursor: args.cursor ?? "", done: true };
			const parent = stream.parent;

			const page = await ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", tenantScope.organizationId)
						.eq("workspaceId", tenantScope.workspaceId)
						.eq("userId", args.visibilityUserId)
						.eq("parent.kind", parent.kind)
						.eq("parent.id", parent.kind === "root" ? undefined : parent.id)
						.eq("state", "active"),
				)
				.order(order)
				.paginate({ cursor: stream.cursor, numItems: 1 });

			target = page.page[0] ? { kind: "private", id: page.page[0]._id } : null;
			cursor = page.continueCursor;
			done = page.isDone;
		} else {
			if (!tenantScope) return { target: null, savedNode: null, cursor: args.cursor ?? "", done: true };
			const parent = stream.parent;

			const pendingQuery = timeOrder
				? ctx.db.query("files_pending_updates").withIndex("by_organization_workspace_user_targetKind_updatedAt", (q) =>
						q
							.eq("organizationId", tenantScope.organizationId)
							.eq("workspaceId", tenantScope.workspaceId)
							.eq("userId", args.visibilityUserId)
							.eq("target.kind", "private"),
					)
				: ctx.db.query("files_pending_updates").withIndex("by_org_ws_user_pendingMove_destParent_destName", (q) =>
						q
							.eq("organizationId", tenantScope.organizationId)
							.eq("workspaceId", tenantScope.workspaceId)
							.eq("userId", args.visibilityUserId)
							.eq("pendingMove.destParent.kind", parent.kind)
							.eq("pendingMove.destParent.id", parent.kind === "root" ? undefined : parent.id),
					);

			const page = await pendingQuery.order(order).paginate({ cursor: stream.cursor, numItems: 1 });
			target = page.page[0]?.target ?? null;
			// Private replacement claims already appear in the private-node stream.
			if (!timeOrder && target?.kind === "private") target = null;
			cursor = page.continueCursor;
			done = page.isDone;
		}

		return { target, savedNode, cursor, done };
	},
});

type files_visible_internal_page_Result =
	typeof internal_page extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const visible_entry_validator = v.union(
	v.object({
		kind: v.literal("saved"),
		node: doc(app_convex_schema, "files_nodes"),
		pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		path: v.string(),
	}),
	v.object({
		kind: v.literal("private"),
		node: doc(app_convex_schema, "files_pending_nodes"),
		pendingUpdate: doc(app_convex_schema, "files_pending_updates"),
		path: v.string(),
	}),
	v.null(),
);

export const internal_get_by_path = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		path: v.string(),
	},
	returns: visible_entry_validator,
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return null;
		}
		const reader = await files_visible_db_create_reader(ctx, args);
		const entry = await reader.resolvePath(args.path);
		if (reader.exhausted) throw convex_error({ message: "This path needs too many reads. Use a shorter folder path." });
		return entry;
	},
});

export const internal_get_by_target = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: files_pending_target_validator,
	},
	returns: visible_entry_validator,
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return null;
		}
		const reader = await files_visible_db_create_reader(ctx, args);
		const entry = await reader.resolveTarget(args.target);
		if (reader.exhausted) throw convex_error({ message: "This path needs too many reads. Use a shorter folder path." });
		return entry;
	},
});

/**
 * A chat keeps folder identity across moves and private publication, with current read access.
 */
export const internal_get_directory_path = internalQuery({
	args: {
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: files_pending_target_validator,
	},
	returns: v.union(v.object({ target: files_pending_target_validator, path: v.string() }), v.null()),
	handler: async (ctx, args) => {
		if (args.agentSource) {
			const authorized = await ai_chat_workspaces_db_authorize_file_scope(ctx, {
				...args,
				agentSource: args.agentSource,
			});
			if (authorized._nay) return null;
		}
		let target = args.target;
		if (target.kind === "private") {
			const node = await ctx.db.get("files_pending_nodes", target.id);
			if (
				!node ||
				node.organizationId !== args.organizationId ||
				node.workspaceId !== args.workspaceId ||
				node.userId !== args.userId ||
				node.state === "discarded"
			)
				return null;
			if (node.state === "published") {
				const receipt = await ctx.db
					.query("files_pending_node_publish_receipts")
					.withIndex("by_privateNode", (q) => q.eq("privateNodeId", node._id))
					.unique();
				if (!receipt) {
					const message = "Published private node has no receipt";
					const data = { privateNodeId: node._id };
					console.error(message, data);
					throw should_never_happen(message, data);
				}
				target = { kind: "saved", id: receipt.savedNodeId };
			}
		}
		const reader = await files_visible_db_create_reader(ctx, { ...args, readLimit: 4096 });
		const entry = await reader.resolveTarget(target);
		if (reader.exhausted) throw convex_error({ message: "Folder path lookup exceeded its read limit." });
		return entry?.node.kind === "folder" ? { target, path: entry.path } : null;
	},
});

export const internal_list = internalQuery({
	args: {
		...internal_listing_args.fields,
	},
	returns: listing_result,
	handler: async (ctx, args) => {
		return await db_list(ctx, args);
	},
});

export type files_visible_internal_list_Result =
	typeof internal_list extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// Agent streams: each query reads one index stream of an agent listing. `files_pending_overlay_list`
// merges them into one page.

/**
 * Where a stream goes on. `rangeStart` starts a new index range (a subtree stream restarts after a
 * hidden folder), `cursor` is the Convex cursor inside that range, and `lastKey` is the index key of
 * the last decided row: the next call reads the same page again and skips the rows up to it.
 */
const stream_position_validator = v.object({
	rangeStart: v.union(v.string(), v.null()),
	cursor: v.union(v.string(), v.null()),
	lastKey: v.union(v.array(v.any()), v.null()),
});

type StreamPosition = Infer<typeof stream_position_validator>;

const moved_in_validator = v.object({ savedNodeId: v.id("files_nodes"), ownerTreePath: v.string() });

const stream_args = v.object({
	agentSource: v.optional(ai_chat_workspaces_source_validator),
	organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
	workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
	visibilityUserId: v.id("users"),
	serviceAccountId: v.optional(v.id("access_control_service_accounts")),
	overlayUserId: v.optional(v.id("users")),
	// Transfer discovery must refuse an incomplete folder instead of hiding unreadable children.
	requireComplete: v.optional(v.boolean()),
	folderPath: v.string(),
	numItems: v.number(),
	position: stream_position_validator,
});

/**
 * The stream args without the page: name search streams page with a plain search cursor.
 */
type StreamOpenArgs = Omit<Infer<typeof stream_args>, "numItems" | "position">;

const stream_filter_args = {
	kind: v.optional(doc(app_convex_schema, "files_nodes").fields.kind),
	lowercaseExtension: v.optional(v.string()),
};

/**
 * The metadata value a `meta search` row matched.
 */
const metadata_match_validator = v.object({
	fieldPath: v.string(),
	metadataKind: v.string(),
	sourceKind: v.union(v.literal("committed"), v.literal("pending")),
	valueKind: v.union(
		v.literal("none"),
		v.literal("string"),
		v.literal("number"),
		v.literal("boolean"),
		v.literal("maybe_date"),
	),
	stringValue: v.optional(v.string()),
	numberValue: v.optional(v.number()),
	booleanValue: v.optional(v.boolean()),
});

const stream_row_validator = v.object({
	/**
	 * The merge key: the name, the update time, or the owner's tree path.
	 */
	key: v.array(v.any()),
	/**
	 * Null for a moved-in folder row that only opens a nested stream.
	 */
	item: v.union(entry_validator, v.null()),
	movedIn: v.optional(moved_in_validator),
	match: v.optional(metadata_match_validator),
	/**
	 * Where the stream goes on when the merge stops after this row.
	 */
	position: stream_position_validator,
});

const stream_result = v_result({
	_yay: v.object({
		/**
		 * The listing root this call resolved. The merge refuses a cursor whose root changed.
		 */
		root: v.union(files_pending_parent_validator, v.null()),
		rows: v.array(stream_row_validator),
		/**
		 * The merge key of the last decided row. Rows up to it are decided.
		 */
		frontier: v.union(v.array(v.any()), v.null()),
		position: stream_position_validator,
		done: v.boolean(),
		decided: v.number(),
		/**
		 * True when the call stopped on the read budget. The merge then keeps the page size.
		 */
		overBudget: v.boolean(),
	}),
});

type StreamDecision = {
	item: Infer<typeof entry_validator> | null;
	movedIn?: Infer<typeof moved_in_validator>;
	match?: Infer<typeof metadata_match_validator>;
};

function stream_done(root: files_PendingParent | null) {
	return Result({
		_yay: {
			root,
			rows: [],
			frontier: null,
			position: { rangeStart: null, cursor: null, lastKey: null },
			done: true,
			decided: 0,
			overBudget: false,
		},
	});
}

/**
 * The one gate of every agent stream: `files_db_authorize_file_read`, then under `ownerScope` the
 * owner's reader with an active membership. Hides and places are read only under `ownerScope`;
 * outside it a stream reads saved rows with the read filter. Transfer discovery has no
 * `agentSource`, so the gate does not rely on it.
 *
 * Also resolves the listing root. Returns null when the caller may not read here or the root is not
 * a folder.
 */
async function db_stream_open(ctx: QueryCtx, args: StreamOpenArgs & { readLimit?: number }) {
	const authorized = await files_db_authorize_file_read(ctx, { ...args, userId: args.visibilityUserId });
	if (authorized._nay) return Result({ _yay: null });

	const organizationId = args.organizationId;
	const fileScope = files_db_resolve_scope(ctx, args.workspaceId);
	// The owner's overlay in a workspace. `tenant` is set only then, with the reader.
	const ownerScope =
		args.overlayUserId === args.visibilityUserId &&
		args.serviceAccountId === undefined &&
		!organizations_is_global_organization_id(organizationId) &&
		fileScope.kind === "workspace";
	const tenant = ownerScope ? { organizationId, workspaceId: fileScope.workspaceId } : null;
	const reader = tenant
		? await files_visible_db_create_reader(ctx, {
				...tenant,
				userId: args.visibilityUserId,
				readLimit: args.readLimit,
			})
		: null;
	if (reader && !reader.active) return Result({ _yay: null });

	const folderPath = server_path_normalize(args.folderPath);
	let root: { parent: files_PendingParent; savedNode: Doc<"files_nodes"> | null; path: string };
	if (folderPath === "/") root = { parent: { kind: "root" }, savedNode: null, path: "/" };
	else if (reader) {
		const entry = (await reader.findPath(folderPath))?.entry;
		if (reader.exhausted) return Result({ _nay: { message: "Listing is too broad. Narrow the folder or filters." } });
		if (entry?.node.kind !== "folder") return Result({ _yay: null });
		root =
			entry.kind === "saved"
				? { parent: { kind: "saved", id: entry.node._id }, savedNode: entry.node, path: entry.path }
				: { parent: { kind: "private", id: entry.node._id }, savedNode: null, path: entry.path };
	} else {
		const node = await files_db_get_visible_node_by_path(ctx, { ...args, path: folderPath });
		if (node?.kind !== "folder") return Result({ _yay: null });
		root = { parent: { kind: "saved", id: node._id }, savedNode: node, path: node.path };
	}

	return Result({
		_yay: { reader, tenant, root, treePath: files_derive_tree_path_for_file_node(root.path, "folder") },
	});
}

function stream_page_size(numItems: number) {
	return Math.max(1, Math.min(files_pending_overlay_LIST_STREAM_MAX_PAGE, Math.floor(numItems)));
}

/**
 * The page rows after `lastKey`: the call reads its page again and skips rows it already decided.
 * `key` is every index field after the equal ones, then `_creationTime` and `_id`.
 */
function stream_rows_after<T>(args: {
	page: T[];
	lastKey: Value[] | null;
	order: "asc" | "desc";
	indexKey: (row: T) => Value[];
}) {
	const { lastKey } = args;
	if (lastKey === null) return args.page;
	return args.page.filter((row) => compareValues(args.indexKey(row), lastKey) * (args.order === "asc" ? 1 : -1) > 0);
}

/**
 * Decide stream rows one by one under the listing read budget, and say where the stream goes on.
 * Always decides at least one row, so every call makes progress.
 *
 * `decide` returns the row to show, null to drop it, "denied" when access drops it, or "stop" when
 * the reader ran out before this row.
 */
async function db_stream_decide<T>(
	ctx: QueryCtx,
	args: {
		root: files_PendingParent;
		requireComplete: boolean | undefined;
		order: "asc" | "desc";
		position: StreamPosition;
		page: PaginationResult<T>;
		/**
		 * The page rows after `lastKey`, maybe cut short of the page end.
		 */
		rows: T[];
		cut: boolean;
		indexKey: (row: T) => Value[];
		mergeKey: (row: T) => Value[];
		decide: (row: T) => Promise<StreamDecision | null | "denied" | "stop">;
		/**
		 * Subtree streams: where a new range starts after a row under a hidden folder.
		 */
		restartAfter?: (row: T) => string | null;
	},
) {
	const rows: Infer<typeof stream_row_validator>[] = [];
	let last: T | null = null;
	let decided = 0;
	let restart: string | null = null;
	let overBudget = false;

	for (const row of args.rows) {
		if (decided > 0 && files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics())) {
			overBudget = true;
			break;
		}
		const decision = await args.decide(row);
		if (decision === "stop") {
			if (decided === 0) return Result({ _nay: { message: "Listing is too broad. Narrow the folder or filters." } });
			overBudget = true;
			break;
		}
		if (decision === "denied" && args.requireComplete) return Result({ _nay: { message: "Permission denied" } });
		decided++;
		last = row;
		if (decision === null || decision === "denied") restart = args.restartAfter?.(row) ?? null;
		else {
			restart = null;
			rows.push({
				key: args.mergeKey(row),
				...decision,
				position: { ...args.position, lastKey: args.indexKey(row) },
			});
		}
	}

	const complete = decided === args.rows.length && !args.cut;
	const done = complete && args.page.isDone;
	const position: StreamPosition =
		!done && restart !== null
			? { rangeStart: restart, cursor: null, lastKey: null }
			: complete
				? {
						rangeStart: args.position.rangeStart,
						cursor: args.page.continueCursor,
						// Rows added before `lastKey`, or a smaller page, can end the page before `lastKey`.
						// Keep it, so the next page still skips the rows already shown.
						lastKey: args.rows.length === 0 ? args.position.lastKey : null,
					}
				: { ...args.position, lastKey: args.indexKey(last!) };
	const frontierRow = last ?? args.page.page.at(-1) ?? null;

	return Result({
		_yay: {
			root: args.root,
			rows,
			frontier: frontierRow === null ? null : args.mergeKey(frontierRow),
			position,
			done,
			decided,
			overBudget,
		},
	});
}

/**
 * Whether the user's hides remove a saved row of the page, from one window of hides with keys from
 * `first` to `last` on `index`. The window holds one hide per hidden row of the page, plus hides of
 * rows the stream skips: the user's own drafts, and rows a kind or extension filter skips when the
 * index has no such field.
 *
 * The window reads at most `limit` hides. Past it, each row reads its own hide when it is decided, so
 * a filter that skips many hidden rows cannot make this read unbounded.
 */
async function db_stream_hide_window(
	ctx: QueryCtx,
	args: {
		index:
			| "by_org_ws_user_parent_name"
			| "by_org_ws_user_parent_updatedAt"
			| "by_org_ws_user_treePath"
			| "by_org_ws_user_kind_treePath"
			| "by_org_ws_user_kind_ext_treePath";
		eq: Array<[field: string, value: Value]>;
		fields: string[];
		first: Value[];
		last: Value[];
		order: "asc" | "desc";
		userId: Id<"users">;
		limit: number;
	},
) {
	const hidden = new Set<Id<"files_nodes">>();
	for (const range of files_pending_overlay_window_ranges(args)) {
		const hides = await ctx.db
			.query("files_pending_hides")
			.withIndex(args.index, (q) => {
				// The window helper names the fields, so the typed range builder cannot check them.
				let builder: any = q;
				for (const [field, value] of [...args.eq, ...range.eq]) builder = builder.eq(field, value);
				if (range.lower)
					builder = range.lower.inclusive
						? builder.gte(range.lower.field, range.lower.value)
						: builder.gt(range.lower.field, range.lower.value);
				if (range.upper)
					builder = range.upper.inclusive
						? builder.lte(range.upper.field, range.upper.value)
						: builder.lt(range.upper.field, range.upper.value);
				return builder;
			})
			.take(args.limit + 1 - hidden.size);
		if (hidden.size + hides.length > args.limit)
			return async (savedNodeId: Id<"files_nodes">) =>
				(await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", savedNodeId).eq("userId", args.userId))
					.unique()) !== null;
		for (const hide of hides) hidden.add(hide.savedNodeId);
	}
	return async (savedNodeId: Id<"files_nodes">) => hidden.has(savedNodeId);
}

/**
 * Access for saved stream rows: the owner's reader per row, or outside the overlay the read filter
 * on chunks of rows.
 */
function db_stream_saved_access(
	ctx: QueryCtx,
	args: StreamOpenArgs,
	reader: Awaited<ReturnType<typeof files_visible_db_create_reader>> | null,
	rows: Doc<"files_nodes">[],
) {
	if (reader) return (node: Doc<"files_nodes">) => reader.canRead(node);
	const readable = new Map<Id<"files_nodes">, boolean>();
	return async (node: Doc<"files_nodes">) => {
		if (!readable.has(node._id)) {
			const start = rows.indexOf(node);
			const chunk = rows.slice(start, start + STREAM_ACCESS_CHUNK);
			const kept = await access_control_db_filter_readable_file_nodes(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.visibilityUserId,
				serviceAccountId: args.serviceAccountId,
				nodes: chunk,
			});
			for (const chunkNode of chunk) readable.set(chunkNode._id, kept.includes(chunkNode));
		}
		return readable.get(node._id)!;
	};
}

/**
 * A saved row as an entry. Under the overlay a pending replacement gives the content type, as in
 * `to_item` (one point read per row).
 */
async function db_stream_saved_item(
	ctx: QueryCtx,
	args: { node: Doc<"files_nodes">; path: string; overlayUserId: Id<"users"> | null },
): Promise<StreamDecision> {
	const { node, path, overlayUserId } = args;
	const proposal = overlayUserId
		? await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", overlayUserId).eq("target.kind", "saved").eq("target.id", node._id),
				)
				.unique()
		: null;
	return {
		item: {
			target: { kind: "saved", id: node._id },
			path,
			name: path_name_of(path),
			kind: node.kind,
			updatedAt: node.updatedAt,
			updatedBy: node.updatedBy,
			contentType: proposal?.pendingReplacement?.contentType ?? node.contentType,
			preparing: false,
		},
	};
}

/**
 * Whether the user may still read every move destination a place's path goes through. The place
 * stores them, but access can change after it was written. If the user cannot read one, listings
 * leave the place out, so its path never names that folder.
 *
 * Null when a destination is gone or archived: the overlay jobs that fix the place can lag.
 */
async function db_place_destinations_readable(
	ctx: QueryCtx,
	reader: Awaited<ReturnType<typeof files_visible_db_create_reader>>,
	place: Doc<"files_pending_places">,
) {
	for (const nodeId of place.destinationAccessNodeIds) {
		const node = await ctx.db.get("files_nodes", nodeId);
		if (!node || node.archiveOperationId !== null) return null;
		if (!(await reader.canRead(node))) return false;
	}
	return true;
}

/**
 * A place row as an entry. Every place checks access on its `accessNodeId`, like
 * `list_private_folder_children`, and on its destinations, since the row shows its path; the
 * proposal gives the content type and `preparing`.
 */
async function db_stream_place_item(
	ctx: QueryCtx,
	reader: Awaited<ReturnType<typeof files_visible_db_create_reader>>,
	place: Doc<"files_pending_places">,
): Promise<StreamDecision | null | "denied"> {
	// A null `accessNodeId` is a private node at the root. An archived access node hides the row:
	// the overlay jobs that fix the place can lag after an archive.
	const accessNode = place.accessNodeId ? await ctx.db.get("files_nodes", place.accessNodeId) : null;
	if (place.accessNodeId !== null && (!accessNode || accessNode.archiveOperationId !== null)) return null;
	if (!(await reader.canRead(accessNode))) return "denied";
	const destinationsReadable = await db_place_destinations_readable(ctx, reader, place);
	if (destinationsReadable === null) return null;
	if (!destinationsReadable) return "denied";

	const proposal = await ctx.db.get("files_pending_updates", place.pendingUpdateId);
	const path = place.kind === "folder" ? place.ownerTreePath.slice(0, -1) : place.ownerTreePath;
	if (place.target.kind === "saved") {
		// For a moved saved node the access node is the node itself.
		if (!accessNode) return null;
		return {
			item: {
				target: place.target,
				path,
				name: place.name,
				kind: place.kind,
				updatedAt: place.updatedAt,
				updatedBy: accessNode.updatedBy,
				contentType: proposal?.pendingReplacement?.contentType ?? accessNode.contentType,
				preparing: false,
			},
			...(place.kind === "folder"
				? { movedIn: { savedNodeId: place.target.id, ownerTreePath: place.ownerTreePath } }
				: {}),
		};
	}
	const intent = proposal?.createIntent;
	return {
		item: {
			target: place.target,
			path,
			name: place.name,
			kind: place.kind,
			updatedAt: place.updatedAt,
			updatedBy: place.userId,
			contentType: intent && intent.kind !== "folder" ? intent.contentType : null,
			preparing: files_visible_is_preparing(proposal),
		},
	};
}

/**
 * The user's visible places under one folder of the user's tree, with the stream filter on the index.
 */
function db_stream_places_under(
	ctx: QueryCtx,
	args: {
		tenant: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> };
		visibilityUserId: Id<"users">;
		treePath: string;
		kind?: Doc<"files_pending_places">["kind"];
		lowercaseExtension?: string;
	},
) {
	const upper = path_tree_prefix_upper_bound(args.treePath);
	const places = ctx.db.query("files_pending_places");
	return args.lowercaseExtension !== undefined
		? places.withIndex("by_org_ws_user_visible_kind_ext_ownerTreePath", (q) =>
				q
					.eq("organizationId", args.tenant.organizationId)
					.eq("workspaceId", args.tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true)
					.eq("kind", "file")
					.eq("lowercaseExtension", args.lowercaseExtension!)
					.gt("ownerTreePath", args.treePath)
					.lt("ownerTreePath", upper),
			)
		: args.kind !== undefined
			? places.withIndex("by_org_ws_user_visible_kind_ownerTreePath", (q) =>
					q
						.eq("organizationId", args.tenant.organizationId)
						.eq("workspaceId", args.tenant.workspaceId)
						.eq("userId", args.visibilityUserId)
						.eq("isVisible", true)
						.eq("kind", args.kind!)
						.gt("ownerTreePath", args.treePath)
						.lt("ownerTreePath", upper),
				)
			: places.withIndex("by_org_ws_user_visible_ownerTreePath", (q) =>
					q
						.eq("organizationId", args.tenant.organizationId)
						.eq("workspaceId", args.tenant.workspaceId)
						.eq("userId", args.visibilityUserId)
						.eq("isVisible", true)
						.gt("ownerTreePath", args.treePath)
						.lt("ownerTreePath", upper),
				);
}

/**
 * Saved children of the listing folder, in name or update order. The user's hides in the page come
 * from one exact window.
 */
export const internal_list_children_saved = internalQuery({
	args: {
		...stream_args.fields,
		...stream_filter_args,
		orderBy: v.union(v.literal("name"), v.literal("updatedAt")),
		order: v.union(v.literal("asc"), v.literal("desc")),
	},
	returns: stream_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, args);
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, root } = opened._yay;
		if (root.parent.kind === "private") return stream_done(root.parent);

		const parentId = root.parent.kind === "saved" ? root.parent.id : "root";
		const byTime = args.orderBy === "updatedAt";
		const nodes = ctx.db.query("files_nodes");
		const query = byTime
			? nodes.withIndex("by_organization_workspace_parent_archiveOperation_updatedAt", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("parentId", parentId)
						.eq("archiveOperationId", null),
				)
			: args.lowercaseExtension !== undefined
				? nodes.withIndex("by_org_ws_parent_archive_kind_ext_name", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("parentId", parentId)
							.eq("archiveOperationId", null)
							.eq("kind", "file")
							.eq("lowercaseExtension", args.lowercaseExtension!),
					)
				: args.kind !== undefined
					? nodes.withIndex("by_organization_workspace_parent_archiveOperation_kind_name", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("parentId", parentId)
								.eq("archiveOperationId", null)
								.eq("kind", args.kind!),
						)
					: nodes.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
							q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("parentId", parentId)
								.eq("archiveOperationId", null),
						);
		const page = await query
			.order(args.order)
			.paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });

		const indexKey = (node: Doc<"files_nodes">) =>
			byTime ? [node.updatedAt, node._creationTime, node._id] : [node.name, node._creationTime, node._id];
		const rows = stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: args.order, indexKey });
		const is_hidden =
			reader && rows.length > 0
				? await db_stream_hide_window(ctx, {
						index: byTime ? "by_org_ws_user_parent_updatedAt" : "by_org_ws_user_parent_name",
						eq: [
							["organizationId", args.organizationId],
							["workspaceId", args.workspaceId],
							["userId", args.visibilityUserId],
							["parentId", parentId],
						],
						fields: byTime ? ["updatedAt", "nodeCreationTime"] : ["name"],
						first: byTime ? [rows[0]!.updatedAt, rows[0]!._creationTime] : [rows[0]!.name],
						last: byTime ? [rows.at(-1)!.updatedAt, rows.at(-1)!._creationTime] : [rows.at(-1)!.name],
						order: args.order,
						userId: args.visibilityUserId,
						limit: rows.length,
					})
				: null;
		const can_read = db_stream_saved_access(ctx, args, reader, rows);
		const parentPath = root.path === "/" ? "" : root.path;

		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: args.order,
			position: args.position,
			page,
			rows,
			cut: false,
			indexKey,
			mergeKey: (node) => (byTime ? [node.updatedAt] : [node.name]),
			decide: async (node) => {
				if (is_hidden && (await is_hidden(node._id))) return null;
				if (!(await can_read(node))) return "denied";
				return await db_stream_saved_item(ctx, {
					node,
					path: `${parentPath}/${node.name}`,
					overlayUserId: reader ? args.visibilityUserId : null,
				});
			},
		});
	},
});

export type files_visible_stream_Result =
	typeof internal_list_children_saved extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The user's places in the listing folder, in name or update order. The index has no kind, so a
 * filter drops rows here; they are the user's own drafts.
 */
export const internal_list_children_places = internalQuery({
	args: {
		...stream_args.fields,
		...stream_filter_args,
		orderBy: v.union(v.literal("name"), v.literal("updatedAt")),
		order: v.union(v.literal("asc"), v.literal("desc")),
	},
	returns: stream_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, args);
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, tenant, root } = opened._yay;
		if (!reader || !tenant) return stream_done(root.parent);

		const parent = root.parent;
		const byTime = args.orderBy === "updatedAt";
		const page = await ctx.db
			.query("files_pending_places")
			.withIndex(byTime ? "by_org_ws_user_visible_parent_updatedAt" : "by_org_ws_user_visible_parent_name", (q) =>
				q
					.eq("organizationId", tenant.organizationId)
					.eq("workspaceId", tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true)
					.eq("parent.kind", parent.kind)
					.eq("parent.id", parent.kind === "root" ? undefined : parent.id),
			)
			.order(args.order)
			.paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });

		const indexKey = (place: Doc<"files_pending_places">) =>
			byTime ? [place.updatedAt, place._creationTime, place._id] : [place.name, place._creationTime, place._id];
		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: args.order,
			position: args.position,
			page,
			rows: stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: args.order, indexKey }),
			cut: false,
			indexKey,
			mergeKey: (place) => (byTime ? [place.updatedAt] : [place.name]),
			decide: async (place) => {
				if (
					(args.kind !== undefined && place.kind !== args.kind) ||
					(args.lowercaseExtension !== undefined &&
						(place.kind !== "file" || place.lowercaseExtension !== args.lowercaseExtension))
				)
					return null;
				const decision = await db_stream_place_item(ctx, reader, place);
				// A children listing does not walk into moved-in folders.
				return decision && decision !== "denied" ? { item: decision.item } : decision;
			},
		});
	},
});

/**
 * Saved rows under the listing folder in tree path order, or with `movedIn` under one saved folder
 * the user moved under the listing folder (the moved-in folder), with its saved path rewritten to the
 * user's path. Asc only with the overlay; desc is for saved-only listings (no hides).
 */
export const internal_list_subtree_saved = internalQuery({
	args: {
		...stream_args.fields,
		...stream_filter_args,
		order: v.union(v.literal("asc"), v.literal("desc")),
		movedIn: v.optional(moved_in_validator),
	},
	returns: stream_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, args);
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, tenant, root } = opened._yay;
		if (reader && args.order === "desc") {
			const message = "Subtree streams with drafts read in path order only";
			const data = { folderPath: args.folderPath };
			console.error(message, data);
			throw should_never_happen(message, data);
		}

		// `savedTreePath` is the range in saved space, `ownerTreePath` the same folder in the user's paths.
		let savedTreePath: string;
		let ownerTreePath: string;
		if (args.movedIn) {
			if (!reader) return stream_done(root.parent);
			const movedIn = args.movedIn;
			// Check the moved-in folder's place every call: another chat of the user can change it between
			// calls.
			const place = await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q.eq("target.kind", "saved").eq("target.id", movedIn.savedNodeId).eq("userId", args.visibilityUserId),
				)
				.unique();
			const node = await ctx.db.get("files_nodes", movedIn.savedNodeId);
			if (
				!place?.isVisible ||
				place.organizationId !== args.organizationId ||
				place.workspaceId !== args.workspaceId ||
				place.ownerTreePath !== movedIn.ownerTreePath ||
				!place.ownerTreePath.startsWith(opened._yay.treePath) ||
				node?.kind !== "folder" ||
				node.archiveOperationId !== null ||
				// The rows below are checked on their own, but their paths would name the destination.
				(await db_place_destinations_readable(ctx, reader, place)) !== true
			)
				return stream_done(root.parent);
			savedTreePath = node.treePath;
			ownerTreePath = place.ownerTreePath;
		} else {
			if (root.parent.kind === "private") return stream_done(root.parent);
			savedTreePath = root.savedNode?.treePath ?? "/";
			ownerTreePath = opened._yay.treePath;
		}

		// Clamp `rangeStart` into the range after `savedTreePath`. `lastKey` only skips rows of this range, so it
		// needs no clamp.
		const upper = path_tree_prefix_upper_bound(savedTreePath);
		const rangeStart = args.position.rangeStart;
		if (rangeStart !== null && compareValues(rangeStart, upper) >= 0) return stream_done(root.parent);
		const start = rangeStart !== null && compareValues(rangeStart, savedTreePath) > 0 ? rangeStart : null;

		const nodes = ctx.db.query("files_nodes");
		const query =
			args.lowercaseExtension !== undefined
				? nodes.withIndex("by_organization_workspace_archive_kind_lowercaseExtension_tree", (q) => {
						const eq = q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("archiveOperationId", null)
							.eq("kind", "file")
							.eq("lowercaseExtension", args.lowercaseExtension!);
						return (start === null ? eq.gt("treePath", savedTreePath) : eq.gte("treePath", start)).lt(
							"treePath",
							upper,
						);
					})
				: args.kind !== undefined
					? nodes.withIndex("by_organization_workspace_archiveOperation_kind_treePath", (q) => {
							const eq = q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("archiveOperationId", null)
								.eq("kind", args.kind!);
							return (start === null ? eq.gt("treePath", savedTreePath) : eq.gte("treePath", start)).lt(
								"treePath",
								upper,
							);
						})
					: nodes.withIndex("by_organization_workspace_archiveOperation_treePath", (q) => {
							const eq = q
								.eq("organizationId", args.organizationId)
								.eq("workspaceId", args.workspaceId)
								.eq("archiveOperationId", null);
							return (start === null ? eq.gt("treePath", savedTreePath) : eq.gte("treePath", start)).lt(
								"treePath",
								upper,
							);
						});
		const page = await query
			.order(args.order)
			.paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });

		const indexKey = (node: Doc<"files_nodes">) => [node.treePath, node._creationTime, node._id];
		let rows = stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: args.order, indexKey });
		let cut = false;

		// Saved rows the user's drafts remove: hides of the rows, and rows under a hidden folder.
		let is_hidden: ((savedNodeId: Id<"files_nodes">) => Promise<boolean>) | null = null;
		const hiddenFolders = new Set<string>();
		if (reader && tenant && rows.length > 0) {
			const first = rows[0]!.treePath;
			const last = rows.at(-1)!.treePath;

			// Hidden folders inside the page, at most 1,000. When the read is full, decide rows
			// only up to the last folder read.
			const folders = await ctx.db
				.query("files_pending_hides")
				.withIndex("by_org_ws_user_kind_treePath", (q) =>
					q
						.eq("organizationId", tenant.organizationId)
						.eq("workspaceId", tenant.workspaceId)
						.eq("userId", args.visibilityUserId)
						.eq("kind", "folder")
						.gte("treePath", first)
						.lte("treePath", last),
				)
				.take(STREAM_HIDDEN_FOLDERS_MAX);
			for (const folder of folders) hiddenFolders.add(folder.treePath);
			if (folders.length === STREAM_HIDDEN_FOLDERS_MAX) {
				const end = folders.at(-1)!.treePath;
				const kept = rows.filter((row) => compareValues(row.treePath, end) <= 0);
				cut = kept.length < rows.length;
				rows = kept;
			}

			// A hidden folder that starts before the page and holds a page row also holds the first row,
			// so check only the first row's ancestors inside the range. The moved-in folder itself and the
			// folders above the listing folder are outside it, so a moved-in root never hides its own rows.
			for (
				let index = first.indexOf("/", savedTreePath.length);
				index !== -1 && index < first.length - 1;
				index = first.indexOf("/", index + 1)
			) {
				const ancestor = first.slice(0, index + 1);
				const hide = await ctx.db
					.query("files_pending_hides")
					.withIndex("by_org_ws_user_kind_treePath", (q) =>
						q
							.eq("organizationId", tenant.organizationId)
							.eq("workspaceId", tenant.workspaceId)
							.eq("userId", args.visibilityUserId)
							.eq("kind", "folder")
							.eq("treePath", ancestor),
					)
					.first();
				if (hide) hiddenFolders.add(ancestor);
			}

			// The hide window on the hide index that matches the filter.
			const filter: Array<[string, Value]> =
				args.lowercaseExtension !== undefined
					? [
							["kind", "file"],
							["lowercaseExtension", args.lowercaseExtension],
						]
					: args.kind !== undefined
						? [["kind", args.kind]]
						: [];
			is_hidden = await db_stream_hide_window(ctx, {
				index:
					args.lowercaseExtension !== undefined
						? "by_org_ws_user_kind_ext_treePath"
						: args.kind !== undefined
							? "by_org_ws_user_kind_treePath"
							: "by_org_ws_user_treePath",
				eq: [
					["organizationId", args.organizationId],
					["workspaceId", args.workspaceId],
					["userId", args.visibilityUserId],
					...filter,
				],
				fields: ["treePath"],
				first: [first],
				last: [rows.at(-1)!.treePath],
				order: "asc",
				userId: args.visibilityUserId,
				limit: rows.length,
			});
		}

		// The outermost hidden folder that holds this row, if any.
		const hidden_folder_of = (treePath: string) => {
			for (
				let index = treePath.indexOf("/", savedTreePath.length);
				index !== -1 && index < treePath.length - 1;
				index = treePath.indexOf("/", index + 1)
			) {
				if (hiddenFolders.has(treePath.slice(0, index + 1))) return treePath.slice(0, index + 1);
			}
			return null;
		};
		const owner_tree_path = (node: Doc<"files_nodes">) => ownerTreePath + node.treePath.slice(savedTreePath.length);
		const can_read = db_stream_saved_access(ctx, args, reader, rows);

		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: args.order,
			position: args.position,
			page,
			rows,
			cut,
			indexKey,
			mergeKey: (node) => [owner_tree_path(node)],
			decide: async (node) => {
				if (hidden_folder_of(node.treePath) !== null || (is_hidden && (await is_hidden(node._id)))) return null;
				if (!(await can_read(node))) return "denied";
				const treePath = owner_tree_path(node);
				return await db_stream_saved_item(ctx, {
					node,
					path: node.kind === "folder" ? treePath.slice(0, -1) : treePath,
					overlayUserId: reader ? args.visibilityUserId : null,
				});
			},
			restartAfter: (node) => {
				const folder = hidden_folder_of(node.treePath);
				return folder === null ? null : path_tree_prefix_upper_bound(folder);
			},
		});
	},
});

/**
 * The user's places under the listing folder in the user's tree path order. A moved-in saved folder
 * also opens a nested saved stream.
 */
export const internal_list_subtree_places = internalQuery({
	args: { ...stream_args.fields, ...stream_filter_args },
	returns: stream_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, args);
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, tenant, root, treePath } = opened._yay;
		if (!reader || !tenant) return stream_done(root.parent);

		const page = await db_stream_places_under(ctx, { ...args, tenant, treePath }).paginate({
			cursor: args.position.cursor,
			numItems: stream_page_size(args.numItems),
		});
		const indexKey = (place: Doc<"files_pending_places">) => [place.ownerTreePath, place._creationTime, place._id];
		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: "asc",
			position: args.position,
			page,
			rows: stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: "asc", indexKey }),
			cut: false,
			indexKey,
			mergeKey: (place) => [place.ownerTreePath],
			decide: (place) => db_stream_place_item(ctx, reader, place),
		});
	},
});

/**
 * Saved folders the user moved under the listing folder, for a filtered subtree whose rows leave
 * folders out (`-type f`, `--extension`). Each row only opens a nested saved stream; the user's
 * private folders hold places only.
 */
export const internal_list_subtree_moved_in_folders = internalQuery({
	args: {
		...stream_args.fields,
		/**
		 * Skip folders whose saved node is already under the listing folder. Name and metadata
		 * searches read those rows in their main stream, so a nested stream would keep none of them.
		 */
		outsideOnly: v.optional(v.boolean()),
	},
	returns: stream_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, args);
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, tenant, root, treePath } = opened._yay;
		if (!reader || !tenant) return stream_done(root.parent);

		const page = await db_stream_places_under(ctx, { ...args, tenant, treePath, kind: "folder" }).paginate({
			cursor: args.position.cursor,
			numItems: stream_page_size(args.numItems),
		});
		const indexKey = (place: Doc<"files_pending_places">) => [place.ownerTreePath, place._creationTime, place._id];
		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: "asc",
			position: args.position,
			page,
			rows: stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: "asc", indexKey }),
			cut: false,
			indexKey,
			mergeKey: (place) => [place.ownerTreePath],
			// The nested stream checks access on every row it shows. A folder whose destination the user
			// cannot read opens none: its rows would all be dropped, so the stream would only scan.
			decide: async (place) => {
				if (place.target.kind !== "saved") return null;
				if ((await db_place_destinations_readable(ctx, reader, place)) !== true) return null;
				if (args.outsideOnly && root.savedNode) {
					const node = await ctx.db.get("files_nodes", place.target.id);
					if (node?.treePath.startsWith(root.savedNode.treePath)) return null;
				}
				return { item: null, movedIn: { savedNodeId: place.target.id, ownerTreePath: place.ownerTreePath } };
			},
		});
	},
});

/**
 * Saved rows of the whole workspace by update time, for `ls -t` with no path. Each row reads the
 * user's hide (one point read), then the user's reader for hidden ancestors and the path (cached per
 * folder).
 */
export const internal_list_recent_saved = internalQuery({
	args: { ...stream_args.fields, order: v.union(v.literal("asc"), v.literal("desc")) },
	returns: stream_result,
	handler: async (ctx, args) => {
		// Leave the reader most of the listing read budget; it stops a call before it runs out.
		const opened = await db_stream_open(ctx, { ...args, folderPath: "/", readLimit: 2_000 });
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, root } = opened._yay;

		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_updatedAt", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("archiveOperationId", null),
			)
			.order(args.order)
			.paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });
		const indexKey = (node: Doc<"files_nodes">) => [node.updatedAt, node._creationTime, node._id];
		const rows = stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: args.order, indexKey });
		const can_read = db_stream_saved_access(ctx, args, null, rows);

		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: args.order,
			position: args.position,
			page,
			rows,
			cut: false,
			indexKey,
			mergeKey: (node) => [node.updatedAt],
			decide: async (node) => {
				if (!reader) {
					if (!(await can_read(node))) return "denied";
					return await db_stream_saved_item(ctx, { node, path: node.path, overlayUserId: null });
				}
				const hide = await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", node._id).eq("userId", args.visibilityUserId))
					.unique();
				if (hide) return null;
				const resolved = await reader.resolve({ kind: "saved", id: node._id });
				if (reader.exhausted) return "stop";
				if (resolved?.entry.kind !== "saved") return null;
				if (!(await reader.canRead(resolved.accessNode))) return "denied";
				return await db_stream_saved_item(ctx, {
					node,
					path: resolved.entry.path,
					overlayUserId: args.visibilityUserId,
				});
			},
		});
	},
});

/**
 * The user's places of the whole workspace by update time, for `ls -t` with no path.
 */
export const internal_list_recent_places = internalQuery({
	args: { ...stream_args.fields, order: v.union(v.literal("asc"), v.literal("desc")) },
	returns: stream_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, { ...args, folderPath: "/" });
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, tenant, root } = opened._yay;
		if (!reader || !tenant) return stream_done(root.parent);

		const page = await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_user_visible_updatedAt", (q) =>
				q
					.eq("organizationId", tenant.organizationId)
					.eq("workspaceId", tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true),
			)
			.order(args.order)
			.paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });
		const indexKey = (place: Doc<"files_pending_places">) => [place.updatedAt, place._creationTime, place._id];
		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: args.order,
			position: args.position,
			page,
			rows: stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: args.order, indexKey }),
			cut: false,
			indexKey,
			mergeKey: (place) => [place.updatedAt],
			decide: async (place) => {
				const decision = await db_stream_place_item(ctx, reader, place);
				return decision && decision !== "denied" ? { item: decision.item } : decision;
			},
		});
	},
});

// Name search streams for `find -name`. Text search returns rows in relevance order with no key to
// stop at inside a page, so a page that runs out of reads returns `retrySmaller` and the merge asks
// again with half the page.

const search_name_args = {
	...stream_args.omit("numItems", "position").fields,
	query: v.string(),
	kind: stream_filter_args.kind,
	numItems: v.number(),
	cursor: v.union(v.string(), v.null()),
};

const search_name_result = v_result({
	_yay: v.object({
		items: v.array(entry_validator),
		continueCursor: v.string(),
		isDone: v.boolean(),
		/**
		 * The search rows of this page before drops. The merge adds them up to tell when a search hit
		 * the 1,024 rows Convex returns at most.
		 */
		scanned: v.number(),
		retrySmaller: v.boolean(),
		/**
		 * A moved-in folder too deep for the `ancestor<depth>` filter.
		 */
		tooDeep: v.boolean(),
	}),
});

const search_name_done = {
	items: [] as Infer<typeof entry_validator>[],
	continueCursor: "",
	isDone: true,
	scanned: 0,
	retrySmaller: false,
	tooDeep: false,
};

/**
 * Name search reads at most 100 rows per page, as content search does.
 */
function search_name_page_size(numItems: number) {
	return Math.max(1, Math.min(100, Math.floor(numItems)));
}

/**
 * Saved nodes whose name matches. With a folder, the `ancestor<depth>` filter keeps nodes under it;
 * with `movedIn`, nodes under one saved folder the user moved into the folder by a draft.
 *
 * Under the overlay every row reads the user's hide and resolves the user's path with the reader,
 * like `ls -t` with no path; a draft can move a row out of the folder, so the path is checked too.
 */
export const internal_search_name_saved = internalQuery({
	args: { ...search_name_args, movedIn: v.optional(moved_in_validator) },
	returns: search_name_result,
	handler: async (ctx, args) => {
		// Leave the reader most of the read budget, like `ls -t` with no path.
		const opened = await db_stream_open(ctx, { ...args, readLimit: 2_000 });
		if (opened._nay) return opened;
		if (!opened._yay) return Result({ _yay: search_name_done });
		const { reader, root } = opened._yay;

		// The saved folder whose `ancestor<depth>` filter scopes the search.
		let scope = root.savedNode;
		if (args.movedIn) {
			if (!reader) return Result({ _yay: search_name_done });
			scope = await ctx.db.get("files_nodes", args.movedIn.savedNodeId);
			if (scope?.kind !== "folder" || scope.archiveOperationId !== null) return Result({ _yay: search_name_done });
		} else if (root.parent.kind === "private") return Result({ _yay: search_name_done });
		// A node keeps only its top 12 ancestors, so a deeper folder cannot scope a name search.
		if (scope && scope.pathDepth > files_ANCESTOR_FIELD_COUNT) {
			if (args.movedIn) return Result({ _yay: { ...search_name_done, tooDeep: true } });
			return Result({ _nay: { message: "This folder is too deep to search inside. Search a folder higher up." } });
		}

		type AncestorField = Extract<keyof Doc<"files_nodes">, `ancestor${number}`>;
		const page = await ctx.db
			.query("files_nodes")
			.withSearchIndex("search_name", (q) => {
				const active = q
					.search("name", args.query)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("archiveOperationId", null);
				const kinded = args.kind ? active.eq("kind", args.kind) : active;
				// A node is under the folder exactly when its ancestor at the folder's depth is the folder.
				return scope ? kinded.eq(`ancestor${scope.pathDepth}` as AncestorField, scope._id) : kinded;
			})
			.paginate({ cursor: args.cursor, numItems: search_name_page_size(args.numItems) });

		// Rows under the listing folder in saved space come from the main search, not a moved-in one.
		const listingFolder = args.movedIn ? root.savedNode : null;
		const under = args.movedIn ? args.movedIn.ownerTreePath : opened._yay.treePath;
		// In a moved-in folder, a row must sit at its saved path inside that folder. A row under a
		// folder the user moved or renamed again comes from that folder's own search.
		const movedFolder = args.movedIn ? scope : null;
		const can_read = db_stream_saved_access(ctx, args, reader, page.page);
		const retry = Result({ _yay: { ...search_name_done, isDone: false, retrySmaller: true } });
		const items: Infer<typeof entry_validator>[] = [];
		for (const [index, node] of page.page.entries()) {
			if (index > 0 && files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics())) return retry;
			if (!reader) {
				if (!(await can_read(node))) continue;
				const decision = await db_stream_saved_item(ctx, { node, path: node.path, overlayUserId: null });
				items.push(decision.item!);
				continue;
			}
			if (listingFolder && node[`ancestor${listingFolder.pathDepth}` as AncestorField] === listingFolder._id) continue;
			const hide = await ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", node._id).eq("userId", args.visibilityUserId))
				.unique();
			if (hide) continue;
			const resolved = await reader.resolve({ kind: "saved", id: node._id });
			if (reader.exhausted) return retry;
			if (resolved?.entry.kind !== "saved" || !resolved.entry.path.startsWith(under)) continue;
			if (movedFolder && resolved.entry.path !== under + node.path.slice(movedFolder.treePath.length)) continue;
			if (!(await reader.canRead(resolved.accessNode))) continue;
			const decision = await db_stream_saved_item(ctx, {
				node,
				path: resolved.entry.path,
				overlayUserId: args.visibilityUserId,
			});
			items.push(decision.item!);
		}

		return Result({
			_yay: {
				items,
				continueCursor: page.continueCursor,
				isDone: page.isDone,
				scanned: page.page.length,
				retrySmaller: false,
				tooDeep: false,
			},
		});
	},
});

/**
 * The user's places whose name matches. The places search has no folder filter, so a folder is
 * checked per row, on the user's top 1,024 matching places.
 */
export const internal_search_name_places = internalQuery({
	args: search_name_args,
	returns: search_name_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, args);
		if (opened._nay) return opened;
		if (!opened._yay) return Result({ _yay: search_name_done });
		const { reader, tenant, treePath } = opened._yay;
		if (!reader || !tenant) return Result({ _yay: search_name_done });

		const page = await ctx.db
			.query("files_pending_places")
			.withSearchIndex("search_name", (q) => {
				const visible = q
					.search("name", args.query)
					.eq("organizationId", tenant.organizationId)
					.eq("workspaceId", tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true);
				return args.kind ? visible.eq("kind", args.kind) : visible;
			})
			.paginate({ cursor: args.cursor, numItems: search_name_page_size(args.numItems) });

		const items: Infer<typeof entry_validator>[] = [];
		for (const [index, place] of page.page.entries()) {
			if (index > 0 && files_pending_overlay_list_over_budget(await ctx.meta.getTransactionMetrics()))
				return Result({ _yay: { ...search_name_done, isDone: false, retrySmaller: true } });
			if (!place.ownerTreePath.startsWith(treePath) || place.ownerTreePath === treePath) continue;
			const decision = await db_stream_place_item(ctx, reader, place);
			if (decision && decision !== "denied" && decision.item) items.push(decision.item);
		}

		return Result({
			_yay: {
				items,
				continueCursor: page.continueCursor,
				isDone: page.isDone,
				scanned: page.page.length,
				retrySmaller: false,
				tooDeep: false,
			},
		});
	},
});

export type files_visible_search_name_Result =
	typeof internal_search_name_saved extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// `meta search` streams. `exists` and `eq` read the folder's range of a value index; `prefix` and
// `range` read a value range of the whole workspace, and a row outside the folder is dropped.

function metadata_match(
	doc: Pick<
		Doc<"files_pending_place_fields">,
		"docKind" | "fieldPath" | "valueKind" | "stringValue" | "numberValue" | "booleanValue"
	>,
	sourceKind: "committed" | "pending",
): Infer<typeof metadata_match_validator> {
	const base = {
		fieldPath: doc.fieldPath,
		metadataKind: doc.fieldPath.slice(0, doc.fieldPath.indexOf(".")),
		sourceKind,
	};
	if (doc.docKind === "field") return { ...base, valueKind: "none" };
	switch (doc.valueKind) {
		case "string":
			return { ...base, valueKind: "string", stringValue: doc.stringValue };
		case "boolean":
			return { ...base, valueKind: "boolean", booleanValue: doc.booleanValue };
		case "number":
		case "maybe_date":
			return { ...base, valueKind: doc.valueKind, numberValue: doc.numberValue };
		default:
			throw should_never_happen("metadataDoc.valueKind is not set", { fieldPath: doc.fieldPath });
	}
}

/**
 * Whether one metadata doc matches a plan, for docs read by proposal instead of by a plan's index.
 */
function metadata_plan_matches(
	plan: Infer<typeof files_metadata_search_plan_validator>,
	doc: Pick<Doc<"files_metadata_docs">, "docKind" | "valueKind" | "stringValue" | "numberValue" | "booleanValue">,
) {
	switch (plan.op) {
		case "exists":
			return doc.docKind === "field";
		case "eq":
			return (
				doc.docKind === "value" &&
				(typeof plan.value === "string"
					? doc.valueKind === "string" && doc.stringValue === plan.value
					: typeof plan.value === "number"
						? doc.valueKind === "number" && doc.numberValue === plan.value
						: doc.valueKind === "boolean" && doc.booleanValue === plan.value)
			);
		case "prefix":
			return doc.docKind === "value" && doc.valueKind === "string" && (doc.stringValue ?? "").startsWith(plan.value);
		case "range": {
			if (doc.docKind !== "value" || doc.valueKind !== plan.valueKind || doc.numberValue === undefined) return false;
			const value = doc.numberValue;
			return (
				(plan.gte == null || value >= plan.gte) &&
				(plan.gt == null || value > plan.gt) &&
				(plan.lte == null || value <= plan.lte) &&
				(plan.lt == null || value < plan.lt)
			);
		}
	}
}

/**
 * Whether the user's draft of a saved file has current text. The file's frontmatter then comes from
 * the draft, not from the saved text, as in `files_search_db_create_reader`.
 */
function metadata_pending_text_is_current(proposal: Doc<"files_pending_updates"> | null, node: Doc<"files_nodes">) {
	return (
		proposal !== null &&
		!proposal.preparation &&
		files_pending_update_has_pending_chunks(proposal) &&
		!files_pending_update_content_is_stale(proposal, node)
	);
}

/**
 * The index key of a metadata row after the equal fields, then `_creationTime` and `_id`.
 */
function metadata_index_key(
	plan: Infer<typeof files_metadata_search_plan_validator>,
	row: { stringValue?: string; numberValue?: number; _creationTime: number; _id: string },
	treePath: string,
): Value[] {
	if (plan.op === "prefix") return [row.stringValue!, treePath, row._creationTime, row._id];
	if (plan.op === "range") return [row.numberValue!, treePath, row._creationTime, row._id];
	return [treePath, row._creationTime, row._id];
}

/**
 * The user's place fields of one plan, under `treePath` when it is set.
 */
function db_stream_place_fields(
	ctx: QueryCtx,
	args: {
		tenant: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> };
		visibilityUserId: Id<"users">;
		plan: Infer<typeof files_metadata_search_plan_validator>;
		treePath: string | null;
	},
) {
	const { plan, treePath } = args;
	const fields = ctx.db.query("files_pending_place_fields");
	const upper = treePath === null ? null : path_tree_prefix_upper_bound(treePath);
	switch (plan.op) {
		case "exists":
			return fields.withIndex("by_org_ws_user_visible_docKind_field_tree", (q) => {
				const base = q
					.eq("organizationId", args.tenant.organizationId)
					.eq("workspaceId", args.tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true)
					.eq("docKind", "field")
					.eq("fieldPath", plan.fieldPath);
				return treePath === null ? base : base.gte("ownerTreePath", treePath).lt("ownerTreePath", upper!);
			});

		case "eq": {
			const value = plan.value;
			if (typeof value === "string")
				return fields.withIndex("by_org_ws_user_visible_docKind_field_string_tree", (q) => {
					const base = q
						.eq("organizationId", args.tenant.organizationId)
						.eq("workspaceId", args.tenant.workspaceId)
						.eq("userId", args.visibilityUserId)
						.eq("isVisible", true)
						.eq("docKind", "value")
						.eq("fieldPath", plan.fieldPath)
						.eq("valueKind", "string")
						.eq("stringValue", value);
					return treePath === null ? base : base.gte("ownerTreePath", treePath).lt("ownerTreePath", upper!);
				});
			if (typeof value === "number")
				return fields.withIndex("by_org_ws_user_visible_docKind_field_number_tree", (q) => {
					const base = q
						.eq("organizationId", args.tenant.organizationId)
						.eq("workspaceId", args.tenant.workspaceId)
						.eq("userId", args.visibilityUserId)
						.eq("isVisible", true)
						.eq("docKind", "value")
						.eq("fieldPath", plan.fieldPath)
						.eq("valueKind", "number")
						.eq("numberValue", value);
					return treePath === null ? base : base.gte("ownerTreePath", treePath).lt("ownerTreePath", upper!);
				});
			return fields.withIndex("by_org_ws_user_visible_docKind_field_boolean_tree", (q) => {
				const base = q
					.eq("organizationId", args.tenant.organizationId)
					.eq("workspaceId", args.tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true)
					.eq("docKind", "value")
					.eq("fieldPath", plan.fieldPath)
					.eq("valueKind", "boolean")
					.eq("booleanValue", value);
				return treePath === null ? base : base.gte("ownerTreePath", treePath).lt("ownerTreePath", upper!);
			});
		}

		case "prefix":
			return fields.withIndex("by_org_ws_user_visible_docKind_field_string_tree", (q) => {
				const base = q
					.eq("organizationId", args.tenant.organizationId)
					.eq("workspaceId", args.tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true)
					.eq("docKind", "value")
					.eq("fieldPath", plan.fieldPath)
					.eq("valueKind", "string")
					.gte("stringValue", plan.value);
				const upperBound = string_prefix_upper_bound(plan.value);
				return upperBound === null ? base : base.lt("stringValue", upperBound);
			});

		case "range":
			// maybe_date docs keep their epoch milliseconds in numberValue, apart by valueKind.
			return fields.withIndex("by_org_ws_user_visible_docKind_field_number_tree", (q) => {
				const base = q
					.eq("organizationId", args.tenant.organizationId)
					.eq("workspaceId", args.tenant.workspaceId)
					.eq("userId", args.visibilityUserId)
					.eq("isVisible", true)
					.eq("docKind", "value")
					.eq("fieldPath", plan.fieldPath)
					.eq("valueKind", plan.valueKind);
				if (plan.gte != null) {
					const lower = base.gte("numberValue", plan.gte);
					if (plan.lte != null) return lower.lte("numberValue", plan.lte);
					if (plan.lt != null) return lower.lt("numberValue", plan.lt);
					return lower;
				}
				if (plan.gt != null) {
					const lower = base.gt("numberValue", plan.gt);
					if (plan.lte != null) return lower.lte("numberValue", plan.lte);
					if (plan.lt != null) return lower.lt("numberValue", plan.lt);
					return lower;
				}
				if (plan.lte != null) return base.lte("numberValue", plan.lte);
				if (plan.lt != null) return base.lt("numberValue", plan.lt);
				return base;
			});
	}
}

/**
 * Committed metadata rows of saved nodes, or with `movedIn` the rows under one saved folder the user
 * moved into the listing folder by a draft (`exists` and `eq` only: `prefix` and `range` read the
 * whole workspace, so they already meet those rows).
 *
 * Under the overlay every row reads the user's hide and resolves the user's path with the reader,
 * like `ls -t` with no path. A saved row shows its committed metadata, also while the user has a
 * content edit on it; drafts come from place fields.
 */
export const internal_search_metadata_saved = internalQuery({
	args: { ...stream_args.fields, plan: files_metadata_search_plan_validator, movedIn: v.optional(moved_in_validator) },
	returns: stream_result,
	handler: async (ctx, args) => {
		// Leave the reader most of the read budget, like `ls -t` with no path.
		const opened = await db_stream_open(ctx, { ...args, readLimit: 2_000 });
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, root } = opened._yay;
		const { plan } = args;
		const byTree = plan.op === "exists" || plan.op === "eq";

		// The saved folder whose range `exists` and `eq` read.
		let rangeFolder = root.savedNode;
		if (args.movedIn) {
			if (!reader || !byTree) return stream_done(root.parent);
			rangeFolder = await ctx.db.get("files_nodes", args.movedIn.savedNodeId);
			if (rangeFolder?.kind !== "folder" || rangeFolder.archiveOperationId !== null) return stream_done(root.parent);
		} else if (byTree && root.parent.kind === "private") return stream_done(root.parent);

		const page = await files_metadata_db_query_saved_plan(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			plan,
			treePathPrefix: byTree ? (rangeFolder?.treePath ?? null) : null,
		}).paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });

		const indexKey = (doc: Doc<"files_metadata_docs">) => metadata_index_key(plan, doc, doc.treePath);
		// Rows under the listing folder in saved space come from the main stream, not a moved-in one.
		const listingFolder = args.movedIn ? root.savedNode : null;
		const under = args.movedIn ? args.movedIn.ownerTreePath : opened._yay.treePath;
		// In a moved-in folder, a row must sit at its saved path inside that folder. A row under a
		// folder the user moved or renamed again comes from that folder's own stream.
		const movedFolder = args.movedIn ? rangeFolder : null;
		// `exists` and `eq` merge by the user's path, like the place stream and `ls -R`. A moved-in folder
		// keyed by its saved path sorts outside the listing, so its stream would stay open to the end
		// and many of them would overflow the cursor.
		const savedTreePath = rangeFolder?.treePath ?? "/";
		const mergeKey = (doc: Doc<"files_metadata_docs">) =>
			byTree ? metadata_index_key(plan, doc, under + doc.treePath.slice(savedTreePath.length)) : indexKey(doc);
		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: "asc",
			position: args.position,
			page,
			rows: stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: "asc", indexKey }),
			cut: false,
			indexKey,
			mergeKey,
			decide: async (doc) => {
				if (doc.sourceKind !== "committed") return null;
				const node = await ctx.db.get("files_nodes", doc.fileNodeId);
				if (!node || node.archiveOperationId !== null) return null;
				const match = metadata_match(doc, "committed");
				if (!reader) {
					if (!`${node.path}/`.startsWith(under)) return null;
					const readable = await access_control_db_filter_readable_file_nodes(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.visibilityUserId,
						serviceAccountId: args.serviceAccountId,
						nodes: [node],
					});
					if (readable.length === 0) return "denied";
					return { ...(await db_stream_saved_item(ctx, { node, path: node.path, overlayUserId: null })), match };
				}
				if (listingFolder && doc.treePath.startsWith(listingFolder.treePath)) return null;
				const hide = await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", node._id).eq("userId", args.visibilityUserId))
					.unique();
				if (hide) return null;
				const resolved = await reader.resolve({ kind: "saved", id: node._id });
				if (reader.exhausted) return "stop";
				// A draft can move a row out of the folder.
				if (resolved?.entry.kind !== "saved" || !`${resolved.entry.path}/`.startsWith(under)) return null;
				if (movedFolder && `${resolved.entry.path}/` !== under + `${node.path}/`.slice(movedFolder.treePath.length))
					return null;
				if (!(await reader.canRead(resolved.accessNode))) return "denied";
				if (doc.fieldPath.startsWith("frontmatter.")) {
					const proposal = await ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", args.visibilityUserId).eq("target.kind", "saved").eq("target.id", node._id),
						)
						.unique();
					// The pending stream shows the frontmatter of the user's text draft instead.
					if (metadata_pending_text_is_current(proposal, node)) return null;
				}
				const decision = await db_stream_saved_item(ctx, {
					node,
					path: resolved.entry.path,
					overlayUserId: args.visibilityUserId,
				});
				return { ...decision, match };
			},
		});
	},
});

/**
 * Frontmatter of the user's text drafts of saved files. Frontmatter follows the text, so while a
 * draft's text is current its pending docs stand in for the committed ones. Reads the user's
 * proposals on saved files, so its cost is the user's own drafts; the folder is checked per row.
 * Pending `metadata.*` docs belong to private drafts only, which place fields cover.
 */
export const internal_search_metadata_pending = internalQuery({
	args: { ...stream_args.fields, plan: files_metadata_search_plan_validator },
	returns: stream_result,
	handler: async (ctx, args) => {
		// Leave the reader most of the read budget, like `ls -t` with no path.
		const opened = await db_stream_open(ctx, { ...args, readLimit: 2_000 });
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, tenant, root, treePath } = opened._yay;
		const { plan } = args;
		if (!reader || !tenant || !plan.fieldPath.startsWith("frontmatter.")) return stream_done(root.parent);

		const page = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", args.visibilityUserId).eq("target.kind", "saved"))
			.paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });
		const indexKey = (proposal: Doc<"files_pending_updates">) => [
			proposal.target.id,
			proposal._creationTime,
			proposal._id,
		];
		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: "asc",
			position: args.position,
			page,
			rows: stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: "asc", indexKey }),
			cut: false,
			indexKey,
			mergeKey: indexKey,
			decide: async (proposal) => {
				if (
					proposal.target.kind !== "saved" ||
					proposal.organizationId !== tenant.organizationId ||
					proposal.workspaceId !== tenant.workspaceId
				)
					return null;
				const node = await ctx.db.get("files_nodes", proposal.target.id);
				if (!node || node.archiveOperationId !== null || !metadata_pending_text_is_current(proposal, node)) return null;
				const docs = await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_fieldPath", (q) =>
						q.eq("pendingUpdateId", proposal._id).eq("fieldPath", plan.fieldPath),
					)
					.collect();
				const doc = docs.find(
					(pending) =>
						pending.sourceKind === "pending" &&
						pending.proposalRevision === proposal.revision &&
						metadata_plan_matches(plan, pending),
				);
				if (!doc) return null;
				const resolved = await reader.resolve({ kind: "saved", id: node._id });
				if (reader.exhausted) return "stop";
				if (resolved?.entry.kind !== "saved" || !`${resolved.entry.path}/`.startsWith(treePath)) return null;
				if (!(await reader.canRead(resolved.accessNode))) return "denied";
				const decision = await db_stream_saved_item(ctx, {
					node,
					path: resolved.entry.path,
					overlayUserId: args.visibilityUserId,
				});
				return { ...decision, match: metadata_match(doc, "pending") };
			},
		});
	},
});

/**
 * The user's place fields: metadata of drafts at their place. A field doc copies its place, and the
 * place fields job can lag, so a copy that no longer matches its place (or its `fieldsVersion`) is
 * dropped. Access is checked on every row, like other place streams.
 */
export const internal_search_metadata_places = internalQuery({
	args: { ...stream_args.fields, plan: files_metadata_search_plan_validator },
	returns: stream_result,
	handler: async (ctx, args) => {
		const opened = await db_stream_open(ctx, args);
		if (opened._nay) return opened;
		if (!opened._yay) return stream_done(null);
		const { reader, tenant, root, treePath } = opened._yay;
		if (!reader || !tenant) return stream_done(root.parent);
		const { plan } = args;
		const byTree = plan.op === "exists" || plan.op === "eq";

		const page = await db_stream_place_fields(ctx, {
			tenant,
			visibilityUserId: args.visibilityUserId,
			plan,
			treePath: byTree ? treePath : null,
		}).paginate({ cursor: args.position.cursor, numItems: stream_page_size(args.numItems) });

		const indexKey = (field: Doc<"files_pending_place_fields">) => metadata_index_key(plan, field, field.ownerTreePath);
		return await db_stream_decide(ctx, {
			root: root.parent,
			requireComplete: args.requireComplete,
			order: "asc",
			position: args.position,
			page,
			rows: stream_rows_after({ page: page.page, lastKey: args.position.lastKey, order: "asc", indexKey }),
			cut: false,
			indexKey,
			mergeKey: indexKey,
			decide: async (field) => {
				if (!field.ownerTreePath.startsWith(treePath)) return null;
				const place = await ctx.db.get("files_pending_places", field.placeId);
				if (
					!place?.isVisible ||
					place.fieldsVersion !== field.fieldsVersion ||
					place.ownerTreePath !== field.ownerTreePath ||
					place.accessNodeId !== field.accessNodeId
				)
					return null;
				const decision = await db_stream_place_item(ctx, reader, place);
				if (!decision || decision === "denied") return decision;
				// A moved saved file's fields copy its committed docs. Its frontmatter comes from the
				// pending stream while the user's text draft is current.
				if (place.target.kind === "saved" && field.fieldPath.startsWith("frontmatter.")) {
					const node = await ctx.db.get("files_nodes", place.target.id);
					const proposal = await ctx.db.get("files_pending_updates", place.pendingUpdateId);
					if (node && metadata_pending_text_is_current(proposal, node)) return null;
				}
				return {
					item: decision.item,
					match: metadata_match(field, place.target.kind === "saved" ? "committed" : "pending"),
				};
			},
		});
	},
});

export const get_path = query({
	args: { membershipId: v.id("organizations_workspaces_users"), target: files_pending_target_validator },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		const reader = await files_visible_db_create_reader(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
		});
		const entry = await reader.resolveTarget(args.target);
		if (reader.exhausted) throw convex_error({ message: "This path needs too many reads. Use a shorter folder path." });
		return entry?.path ?? null;
	},
});

/**
 * The children of one of the caller's draft (private) folders, for the draft folder view: one page
 * of the caller's `files_pending_places` in this folder, in raw name order with folders mixed in.
 * Rows are private nodes and saved nodes the caller's drafts move here.
 *
 * Each row checks access on its `accessNodeId`. A row the caller cannot read any more is left out,
 * so a page can be short.
 */
export const list_private_folder_children = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		folderId: v.id("files_pending_nodes"),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			target: files_pending_target_validator,
			name: v.string(),
			kind: doc(app_convex_schema, "files_pending_places").fields.kind,
			preparing: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const refused = { page: [], isDone: true, continueCursor: "" };

		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return refused;

		const folder = await ctx.db.get("files_pending_nodes", args.folderId);
		if (
			!folder ||
			folder.userId !== userAuth.id ||
			folder.organizationId !== membership.organizationId ||
			folder.workspaceId !== membership.workspaceId ||
			folder.state !== "active" ||
			folder.kind !== "folder"
		)
			return refused;

		const reader = await files_visible_db_create_reader(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
		});
		if (!reader.active) return refused;

		const result = await ctx.db
			.query("files_pending_places")
			.withIndex("by_org_ws_user_visible_parent_name", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", userAuth.id)
					.eq("isVisible", true)
					.eq("parent.kind", "private")
					.eq("parent.id", args.folderId),
			)
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, PRIVATE_FOLDER_PAGE_MAX_ITEMS),
			});

		// Split before any per-row read, like `tree_page_needs_split` in `files_nodes.ts`: a reactive
		// rerun has no row cap, so a page can grow far past `numItems`.
		if (result.splitCursor && (result.page.length > PRIVATE_FOLDER_PAGE_MAX_ITEMS || result.pageStatus)) {
			return {
				page: [],
				isDone: result.isDone,
				continueCursor: result.continueCursor,
				splitCursor: result.splitCursor,
				pageStatus: "SplitRequired" as const,
			};
		}

		const rows = await Promise.all(
			result.page.map(async (place) => {
				// A null `accessNodeId` is a private node at the root: the workspace scope decides. An archived
				// access node hides the row, like the old reader: the overlay jobs that fix the place can
				// lag after an archive.
				const accessNode = place.accessNodeId ? await ctx.db.get("files_nodes", place.accessNodeId) : null;
				if (
					(place.accessNodeId !== null && (!accessNode || accessNode.archiveOperationId !== null)) ||
					!(await reader.canRead(accessNode))
				)
					return null;

				const proposal =
					place.target.kind === "private" ? await ctx.db.get("files_pending_updates", place.pendingUpdateId) : null;
				return {
					target: place.target,
					name: place.name,
					kind: place.kind,
					preparing: place.target.kind === "private" && files_visible_is_preparing(proposal),
				};
			}),
		);
		return { ...result, page: rows.filter((row) => row !== null) };
	},
});
