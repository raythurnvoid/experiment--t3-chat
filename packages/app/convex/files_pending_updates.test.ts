import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "./_generated/api.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { billing_PRODUCTS, billing_get_recurring_credits_cents } from "../shared/billing.ts";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import {
	files_nodes_content_db_publish_private_node,
	files_nodes_db_insert_file_content_docs,
} from "./files_nodes_content.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import { files_media_dependencies_db_create, files_media_dependencies_db_seal } from "./files_media_dependencies.ts";
import { files_nodes_db_get_content_version } from "./files_nodes.ts";
import {
	files_pending_updates_db_drop_content_for_node,
	files_pending_updates_db_mark_content_for_rebase,
	files_pending_updates_action_prepare_content,
	files_pending_updates_db_commit_prepared_content,
	files_pending_updates_db_retire_prepared_content,
} from "./files_pending_updates.ts";

const test = baseTest;
import { billing_event } from "../server/billing.ts";
import { r2_confirmed_object_delete, r2_create_asset_key } from "./r2_client.ts";
import {
	files_db_load_pending_update_yjs_state_bytes,
	files_db_get_pending_update,
	files_db_patch_pending_update,
	files_db_insert_pending_update,
	files_default_text_shape_for_name,
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_get_utf8_byte_size,
	files_PENDING_UPDATE_STALE_BASE_MESSAGE,
	files_YJS_DOC_KEYS,
} from "../shared/files.ts";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
} from "../shared/files-metadata.ts";
import { Doc as YDoc, XmlElement as YXmlElement, encodeStateAsUpdate, encodeStateAsUpdateV2 } from "yjs";
import { files_sort_text_key } from "../shared/files-sort.ts";

// Wrap the shared markdown serializer in a delegating mock so focused tests can make one call
// fail with the real producer's cause-carrying `_nay` shape. A crafted Y.Doc cannot force that
// failure: y-prosemirror drops elements it cannot convert instead of throwing.
const { filesYjsDocGetMarkdownMock } = vi.hoisted(() => {
	return {
		filesYjsDocGetMarkdownMock: vi.fn(),
	};
});

vi.mock("../shared/files-tiptap.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shared/files-tiptap.ts")>();
	filesYjsDocGetMarkdownMock.mockImplementation(actual.files_yjs_doc_get_text);
	return {
		...actual,
		files_yjs_doc_get_text: filesYjsDocGetMarkdownMock,
	};
});

let enqueueActionSpy: MockInstance;
const r2Objects = new Map<string, string | ArrayBuffer>();
// Keep the automatic presence timeout from firing during these tests; convex-test
// scheduled functions can otherwise race past the active transaction and leak an unhandled rejection.
const presenceHeartbeatIntervalMs = 60 * 60 * 1000;

beforeEach(() => {
	r2Objects.clear();
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		r2Objects.delete(key);
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	// Serve signed upload PUTs into the same r2Objects map, so tests can create files
	// through the real private-create and Save doors instead of seeding docs.
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "pending-update-test-upload-key",
		url: `https://r2.test/upload?key=${encodeURIComponent(customKey ?? "pending-update-test-upload-key")}`,
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) {
					r2Objects.set(key, body);
				} else if (body instanceof Uint8Array) {
					r2Objects.set(key, files_u8_to_array_buffer(body));
				} else {
					return new Response(null, { status: 400 });
				}
				return new Response(null, { status: 200 });
			}
			if (!urlString.startsWith("https://r2.test/object?key=")) {
				return new Response(null, { status: 404 });
			}

			const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
			const body = r2Objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
	// Keep pending-edit tests off the real billing workpool while still letting
	// focused cases assert whether a file-save event was enqueued.
	enqueueActionSpy = vi
		.spyOn(Workpool.prototype, "enqueueAction")
		.mockResolvedValue("work_pending_update_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function seed_billing_snapshot_for_user(ctx: MutationCtx, userId: Id<"users">) {
	// The shared membership fixture puts every seeded user on a paying plan. Move this one to
	// `Free`, which is what every caller here is asking for.
	await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Free" });
}

async function seed_file_with_markdown(args: {
	ctx: MutationCtx;
	path: string;
	name: string;
	markdown: string;
	/** The node's document shape; defaults to the rich text `.md` fixture shape. */
	rootKind?: "rich_text" | "plain_text";
	membership?: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		membershipId: Id<"organizations_workspaces_users">;
	};
}) {
	const { ctx, path, name, markdown } = args;
	const rootKind = args.rootKind ?? "rich_text";
	const membership = args.membership ?? (await test_mocks_fill_db_with.membership(ctx));
	const { userId, organizationId, workspaceId, membershipId } = membership;
	await seed_billing_snapshot_for_user(ctx, userId);

	const baseYjsDoc = new YDoc();
	const baseYjsDocFromMarkdown = files_yjs_doc_update_from_text({
		rootKind,
		mut_yjsDoc: baseYjsDoc,
		text: markdown,
	});
	if (baseYjsDocFromMarkdown._nay) {
		throw new Error("Failed to seed base Yjs doc from markdown");
	}

	const baseMarkdownResult = files_yjs_doc_get_text({
		rootKind,
		yjsDoc: baseYjsDoc,
	});
	if (baseMarkdownResult._nay) {
		throw new Error("Failed to seed base markdown from Yjs doc");
	}

	const now = Date.now();
	const markdownAssetId = await ctx.db.insert("files_r2_assets", {
		organizationId,
		workspaceId,
		kind: "content",
		r2Bucket: "test-bucket",
		size: files_get_utf8_byte_size(baseMarkdownResult._yay),
		createdBy: userId,
		updatedAt: now,
	});
	const markdownAssetKey = r2_create_asset_key({ organizationId, workspaceId, assetId: markdownAssetId });
	await ctx.db.patch("files_r2_assets", markdownAssetId, {
		r2Key: markdownAssetKey,
	});
	r2Objects.set(markdownAssetKey, baseMarkdownResult._yay);

	const yjsSnapshotUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc));
	const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
		organizationId,
		workspaceId,
		kind: "yjs_snapshot",
		r2Bucket: "test-bucket",
		size: yjsSnapshotUpdate.byteLength,
		createdBy: userId,
		updatedAt: now,
	});
	const yjsSnapshotAssetKey = r2_create_asset_key({ organizationId, workspaceId, assetId: yjsSnapshotAssetId });
	await ctx.db.patch("files_r2_assets", yjsSnapshotAssetId, {
		r2Key: yjsSnapshotAssetKey,
	});
	r2Objects.set(yjsSnapshotAssetKey, yjsSnapshotUpdate);

	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId,
		workspaceId,
		path,
		treePath: path,
		pathDepth: path === "/" ? 0 : path.split("/").filter(Boolean).length,
		name,
		sortName: files_sort_text_key(name),
		kind: "file",
		lowercaseExtension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : null,
		contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
		assetId: markdownAssetId,
		contentByteSize: null,
		parentId: files_ROOT_ID,
		createdBy: userId,
		updatedBy: userId,
		updatedAt: now,
		archiveOperationId: null,
		textKind: rootKind,
		collaborationEnabled: true,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		statsId: null,
		contentTooLargeByteSize: null,
		contentShapeMismatchAt: null,
		contentYjsStateTooLargeByteSize: null,
		contentFrontmatterTooLargeFieldCount: null,
		contentFrontmatterTooLargeIndexDocumentCount: null,
		restrictedScopeNodeId: null,
		isRestrictedScopeRoot: false,
		writePolicy: null,
	});

	const snapshotId = await ctx.db.insert("files_yjs_snapshots", {
		organizationId: organizationId,
		workspaceId: workspaceId,
		fileNodeId: nodeId,
		sequence: 0,
		assetId: yjsSnapshotAssetId,
		createdBy: userId,
		updatedBy: String(userId),
		updatedAt: now,
	});

	const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
		organizationId: organizationId,
		workspaceId: workspaceId,
		fileNodeId: nodeId,
		lastSequence: 0,
		unmaterializedUpdateCount: 0,
		unmaterializedUpdateBytes: 0,
		lineageGeneration: 0,
	});

	await ctx.db.patch("files_nodes", nodeId, {
		yjsSnapshotId: snapshotId,
		yjsLastSequenceId: lastSequenceId,
	});

	return {
		organizationId,
		workspaceId,
		membershipId,
		userId,
		nodeId,
		baseMarkdown: baseMarkdownResult._yay,
	};
}

async function seed_folder_node(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	parentId?: Id<"files_nodes">;
	path: string;
	name: string;
}) {
	const now = Date.now();
	return await args.ctx.db.insert("files_nodes", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		path: args.path,
		treePath: `${args.path}/`,
		pathDepth: args.path.split("/").filter(Boolean).length,
		lowercaseExtension: null,
		name: args.name,
		sortName: files_sort_text_key(args.name),
		kind: "folder",
		parentId: args.parentId ?? files_ROOT_ID,
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: now,
		contentType: null,
		assetId: null,
		contentByteSize: null,
		textKind: null,
		collaborationEnabled: null,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		statsId: null,
		contentTooLargeByteSize: null,
		contentShapeMismatchAt: null,
		contentYjsStateTooLargeByteSize: null,
		contentFrontmatterTooLargeFieldCount: null,
		contentFrontmatterTooLargeIndexDocumentCount: null,
		restrictedScopeNodeId: null,
		isRestrictedScopeRoot: false,
		writePolicy: null,

		archiveOperationId: null,
	});
}

/**
 * Insert one committed Markdown + plain-text chunk pair covering the whole markdown, so
 * committed chunk reads and denormalized-path assertions have real docs to work with.
 */
async function seed_committed_chunks_for_file(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
	path: string;
	markdown: string;
}) {
	const textChunkId = await args.ctx.db.insert("files_text_chunks", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sourceKind: "committed",
		yjsSequence: 0,
		chunkIndex: 0,
		textChunk: args.markdown,
		startIndex: 0,
		endIndex: args.markdown.length,
		lineStart: 1,
		lineEnd: args.markdown.split("\n").length,
		chunkFlags: 0,
	});
	const plainTextChunkId = await args.ctx.db.insert("files_plain_text_chunks", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		fileNodeId: args.nodeId,
		sourceKind: "committed",
		yjsSequence: 0,
		textChunkId,
		path: args.path,
		chunkIndex: 0,
		plainTextChunk: args.markdown,
		textChunk: args.markdown,
		startIndex: 0,
		endIndex: args.markdown.length,
		lineStart: 1,
		lineEnd: args.markdown.split("\n").length,
		chunkFlags: 0,
		hasChunkAbove: false,
		hasChunkBelow: false,
	});

	return { textChunkId, plainTextChunkId };
}

let seed_signed_in_file_user_counter = 0;

async function seed_signed_in_file_with_markdown(
	args: Omit<Parameters<typeof seed_file_with_markdown>[0], "membership">,
) {
	const userId = await args.ctx.db.insert("users", {
		clerkUserId: `clerk_pending_update_test_${seed_signed_in_file_user_counter++}`,
	});
	const membership = await test_mocks_fill_db_with.membership(args.ctx, {
		userId,
	});
	return await seed_file_with_markdown({
		...args,
		membership,
	});
}

/**
 * Seed a text file with collaboration off: a content asset, committed chunks, and no Yjs docs.
 * The name decides the shape (`.md` rich text, `.txt` plain text). The same seed as the fixture
 * in `files_nodes.test.ts`, on a mutation ctx instead of the test harness. The owner is a
 * Clerk-backed user so its saves bill through the workpool the tests spy on; an anonymous user's
 * events take another path.
 */
async function seed_non_collaborative_file(ctx: MutationCtx, path: string, text: string) {
	const clerkUserId = await ctx.db.insert("users", {
		clerkUserId: `clerk_pending_update_test_${seed_signed_in_file_user_counter++}`,
	});
	const { userId, organizationId, workspaceId, membershipId } = await test_mocks_fill_db_with.membership(ctx, {
		userId: clerkUserId,
	});
	const now = Date.now();
	const name = path.split("/").filter(Boolean).at(-1);
	if (!name) throw new Error("Expected a root-level file path");
	const { rootKind, contentType } = files_default_text_shape_for_name(name);

	const assetId = await ctx.db.insert("files_r2_assets", {
		organizationId,
		workspaceId,
		kind: "content_snapshot",
		r2Bucket: "test-bucket",
		r2Key: `content-snapshot${path}`,
		size: files_get_utf8_byte_size(text),
		createdBy: userId,
		updatedAt: now,
	});
	const nodeId = await ctx.db.insert("files_nodes", {
		organizationId,
		workspaceId,
		parentId: files_ROOT_ID,
		path,
		treePath: path,
		pathDepth: 1,
		lowercaseExtension: name.split(".").at(-1) ?? null,
		name,
		sortName: files_sort_text_key(name),
		kind: "file",
		contentType,
		assetId,
		contentByteSize: null,
		createdBy: userId,
		updatedBy: userId,
		updatedAt: now,
		textKind: null,
		collaborationEnabled: null,
		yjsSnapshotId: null,
		yjsLastSequenceId: null,
		statsId: null,
		contentTooLargeByteSize: null,
		contentShapeMismatchAt: null,
		contentYjsStateTooLargeByteSize: null,
		contentFrontmatterTooLargeFieldCount: null,
		contentFrontmatterTooLargeIndexDocumentCount: null,
		restrictedScopeNodeId: null,
		isRestrictedScopeRoot: false,
		writePolicy: null,

		archiveOperationId: null,
	});
	await files_nodes_db_insert_file_content_docs(ctx, {
		organizationId,
		workspaceId,
		nodeId,
		path,
		contentType,
		rootKind,
		textContent: text,
		readOnly: false,
		nonCollaborative: true,
		userId,
		now,
	});

	return { organizationId, workspaceId, membershipId, userId, nodeId, assetId };
}

/**
 * Save `text` on a file with collaboration off through the member save door. Returns the node's
 * new content asset id.
 */
async function save_as_member(
	t: ReturnType<typeof test_convex>,
	seeded: Awaited<ReturnType<typeof seed_non_collaborative_file>>,
	text: string,
) {
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});
	const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
		membershipId: seeded.membershipId,
		nodeId: seeded.nodeId,
		text,
	});
	if (saved._nay) {
		throw new Error(saved._nay.message);
	}
	const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
	if (!node?.assetId || node.assetId === seeded.assetId) {
		throw new Error("Expected the member save to move the node to a new content asset");
	}
	return node.assetId;
}

/**
 * The committed text of a file, read back from its committed chunks in order.
 */
async function read_committed_text(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
}) {
	const chunks = await args.ctx.db
		.query("files_text_chunks")
		.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("sourceKind", "committed")
				.eq("fileNodeId", args.nodeId),
		)
		.collect();
	return chunks.map((chunk) => chunk.textChunk).join("");
}

async function read_file_yjs_snapshot_update(args: {
	ctx: MutationCtx;
	fileNode: { yjsSnapshotId: Id<"files_yjs_snapshots"> | null };
}) {
	if (!args.fileNode.yjsSnapshotId) {
		throw new Error("fileNode.yjsSnapshotId is not set while reading Yjs snapshot");
	}

	const snapshot = await args.ctx.db.get("files_yjs_snapshots", args.fileNode.yjsSnapshotId);
	if (!snapshot) {
		throw new Error("fileNode.yjsSnapshotId points to a missing files_yjs_snapshots doc while reading Yjs snapshot");
	}

	const snapshotAsset = await args.ctx.db.get("files_r2_assets", snapshot.assetId);
	if (!snapshotAsset?.r2Key) {
		throw new Error("snapshot.assetId points to a missing files_r2_assets doc while reading Yjs snapshot");
	}

	const yjsSnapshotUpdate = r2Objects.get(snapshotAsset.r2Key);
	if (!(yjsSnapshotUpdate instanceof ArrayBuffer)) {
		throw new Error("Expected test R2 object for Yjs snapshot");
	}

	return {
		snapshot,
		yjsSnapshotUpdate,
	};
}

async function read_file_markdown_from_yjs(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
	/** The node's document shape; defaults to the rich text `.md` fixture shape. */
	rootKind?: "rich_text" | "plain_text";
}) {
	const { ctx, organizationId, workspaceId, nodeId } = args;
	const fileNode = await ctx.db.get("files_nodes", nodeId);
	if (!fileNode) {
		throw new Error("nodeId points to a missing files_nodes doc while reading markdown from Yjs");
	}
	const { snapshot, yjsSnapshotUpdate } = await read_file_yjs_snapshot_update({ ctx, fileNode });

	const updates = await ctx.db
		.query("files_yjs_updates")
		.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
			q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", fileNode._id),
		)
		.order("asc")
		.collect();

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate, {
		additionalIncrementalArrayBufferUpdates: updates
			.filter((update) => update.sequence > snapshot.sequence)
			.map((update) => update.update),
	});

	const markdown = files_yjs_doc_get_text({ rootKind: args.rootKind ?? "rich_text", yjsDoc });
	if (markdown._nay) {
		throw new Error("Failed to read markdown from Yjs");
	}

	return markdown._yay;
}

function normalize_pending_update_markdown(markdown: string) {
	const yjsDoc = new YDoc();
	const updateMarkdownResult = files_yjs_doc_update_from_text({
		rootKind: "rich_text",
		mut_yjsDoc: yjsDoc,
		text: markdown,
	});
	if (updateMarkdownResult._nay) {
		throw new Error("Failed to normalize pending update markdown");
	}

	const normalizedMarkdown = files_yjs_doc_get_text({ rootKind: "rich_text", yjsDoc });
	if (normalizedMarkdown._nay) {
		throw new Error("Failed to read normalized pending update markdown");
	}

	return normalizedMarkdown._yay;
}

async function read_file_yjs_state(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
}) {
	const { ctx, organizationId, workspaceId, nodeId } = args;
	const fileNode = await ctx.db.get("files_nodes", nodeId);
	if (!fileNode) {
		throw new Error("nodeId points to a missing files_nodes doc while reading Yjs state");
	}
	if (!fileNode.yjsSnapshotId) {
		throw new Error("fileNode.yjsSnapshotId is not set while reading Yjs state");
	}
	if (!fileNode.yjsLastSequenceId) {
		throw new Error("fileNode.yjsLastSequenceId is not set while reading Yjs state");
	}

	const [{ snapshot, yjsSnapshotUpdate }, lastSequenceDoc, updates] = await Promise.all([
		read_file_yjs_snapshot_update({ ctx, fileNode }),
		ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", organizationId).eq("workspaceId", workspaceId).eq("fileNodeId", fileNode._id),
			)
			.order("asc")
			.collect(),
	]);
	if (!lastSequenceDoc) {
		throw new Error(
			"fileNode.yjsLastSequenceId points to a missing files_yjs_docs_last_sequences doc while reading Yjs state",
		);
	}

	const yjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate, {
		additionalIncrementalArrayBufferUpdates: updates
			.filter((update) => update.sequence > snapshot.sequence)
			.map((update) => update.update),
	});

	return {
		yjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		yjsSequence: lastSequenceDoc.lastSequence,
	};
}

async function build_file_diff_update_from_snapshot(args: {
	ctx: MutationCtx;
	nodeId: Id<"files_nodes">;
	markdown: string;
}) {
	const { ctx, nodeId, markdown } = args;
	const fileNode = await ctx.db.get("files_nodes", nodeId);
	if (!fileNode) {
		throw new Error("nodeId points to a missing files_nodes doc while preparing diff update from snapshot");
	}
	const { yjsSnapshotUpdate } = await read_file_yjs_snapshot_update({ ctx, fileNode });

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsSnapshotUpdate);
	const targetYjsDoc = files_yjs_doc_clone({
		yjsDoc: baseYjsDoc,
	});
	const targetYjsDocFromMarkdown = files_yjs_doc_update_from_text({
		rootKind: "rich_text",
		mut_yjsDoc: targetYjsDoc,
		text: markdown,
	});
	if (targetYjsDocFromMarkdown._nay) {
		throw new Error("Failed to build target Yjs doc while preparing diff update from snapshot");
	}

	const diffUpdate = files_yjs_compute_diff_update_from_yjs_doc({
		yjsDoc: targetYjsDoc,
		yjsBeforeDoc: baseYjsDoc,
	});
	if (!diffUpdate) {
		throw new Error("Missing diff update while preparing diff update from snapshot");
	}

	return files_u8_to_array_buffer(diffUpdate);
}

async function read_pending_row_state_bytes(args: {
	ctx: MutationCtx;
	pendingUpdate: Pick<Doc<"files_pending_updates">, "content">;
}) {
	const { ctx, pendingUpdate } = args;
	if (!pendingUpdate.content) {
		throw new Error("Expected pending update row with Yjs content");
	}

	const load = async (stateId: Id<"files_pending_update_yjs_states">) => {
		const stateDoc = await ctx.db.get("files_pending_update_yjs_states", stateId);
		if (!stateDoc) {
			throw new Error("Pending row points to a missing files_pending_update_yjs_states doc");
		}
		const bytes = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc });
		if (bytes._nay) {
			throw new Error(bytes._nay.message);
		}
		// Return ArrayBuffers: `t.run` serializes the return value as a Convex value, and
		// Convex bytes are ArrayBuffers, not Uint8Arrays.
		return files_u8_to_array_buffer(bytes._yay);
	};

	return {
		baseBytes: await load(pendingUpdate.content.baseStateId),
		stagedBytes: await load(pendingUpdate.content.stagedStateId),
		unstagedBytes: await load(pendingUpdate.content.unstagedStateId),
	};
}

async function read_pending_row_markdown_state(args: {
	ctx: MutationCtx;
	rootKind?: "plain_text" | "rich_text";
	pendingUpdate: Pick<Doc<"files_pending_updates">, "content">;
}) {
	const { baseBytes, stagedBytes, unstagedBytes } = await read_pending_row_state_bytes(args);

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(baseBytes);
	const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(stagedBytes);
	const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(unstagedBytes);

	const rootKind = args.rootKind ?? "rich_text";
	const baseMarkdown = files_yjs_doc_get_text({ rootKind, yjsDoc: baseYjsDoc });
	const stagedMarkdown = files_yjs_doc_get_text({ rootKind, yjsDoc: stagedBranchYjsDoc });
	const unstagedMarkdown = files_yjs_doc_get_text({ rootKind, yjsDoc: unstagedBranchYjsDoc });

	if (baseMarkdown._nay || stagedMarkdown._nay || unstagedMarkdown._nay) {
		throw new Error("Failed to reconstruct pending doc markdown");
	}

	return {
		baseMarkdown: baseMarkdown._yay,
		stagedMarkdown: stagedMarkdown._yay,
		unstagedMarkdown: unstagedMarkdown._yay,
	};
}

async function read_pending_update_expiry_check(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
}) {
	return await args.ctx.db
		.query("files_pending_update_expiry_checks")
		.withIndex("by_organization_workspace_user", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
		)
		.unique();
}

/**
 * Move the clock to the draft's `expiresAt` and run the owner's expiry check, as its scheduled job
 * would. The owner has no heartbeat in these tests, so the check does not keep the draft for activity.
 */
async function expire_pending_update_for_test(
	t: ReturnType<typeof test_convex>,
	pendingUpdateId: Id<"files_pending_updates">,
) {
	const draft = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!draft) throw new Error("Expected a draft");
	vi.setSystemTime(draft.expiresAt);
	await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
		organizationId: draft.organizationId,
		workspaceId: draft.workspaceId,
		userId: draft.userId,
	});
}

async function list_pending_update_text_chunks(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
}) {
	return await args.ctx.db
		.query("files_text_chunks")
		.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
}

async function list_pending_update_plain_text_chunks(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
}) {
	return await args.ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
}

async function read_pending_update_row(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
}) {
	return await args.ctx.db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_target", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("target.kind", "saved")
				.eq("target.id", args.nodeId),
		)
		.first();
}

async function read_pending_update_last_sequence_saved_doc(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
}) {
	return await args.ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_organization_workspace_user_fileNode", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("userId", args.userId)
				.eq("fileNodeId", args.nodeId),
		)
		.first();
}

async function seed_chat_thread(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
}) {
	return await args.ctx.db.insert("ai_chat_threads", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		clientGeneratedId: crypto.randomUUID(),
		title: null,
		archived: false,
		runtime: "aisdk_5",
		createdBy: args.userId,
		updatedBy: args.userId,
		updatedAt: Date.now(),
	});
}

async function upsert_file_pending_update_internal_for_test(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
	pendingUpdateId?: Id<"files_pending_updates">;
	stagedMarkdown?: string;
	unstagedMarkdown: string;
	copiedFrom?: { nodeId: Id<"files_nodes">; path: string };
	threadId?: Id<"ai_chat_threads">;
}) {
	// Mirror the agent flow: stage the texts under a server-side batch, then run the finishing
	// action that carries only ids. Retire the batch on a staging refusal so every helper call
	// stays independent of the previous one.
	const batch = await args.t.mutation(
		internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
		{
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			target: { kind: "saved", id: args.nodeId },
		},
	);
	if (batch._nay) {
		return batch;
	}
	const operationBatchId = batch._yay.operationBatchId;
	const retire = async () => {
		await args.t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId,
		});
	};

	if (args.stagedMarkdown !== undefined) {
		const staged = await args.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId,
			role: "staged",
			text: args.stagedMarkdown,
		});
		if (staged._nay) {
			await retire();
			return staged;
		}
	}
	const unstaged = await args.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		operationBatchId,
		role: "unstaged",
		text: args.unstagedMarkdown,
	});
	if (unstaged._nay) {
		await retire();
		return unstaged;
	}

	return await args.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		target: { kind: "saved", id: args.nodeId },
		operationBatchId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		...(args.copiedFrom
			? { copiedFrom: { target: { kind: "saved" as const, id: args.copiedFrom.nodeId }, path: args.copiedFrom.path } }
			: {}),
		...(args.threadId ? { threadId: args.threadId } : {}),
	});
}

type TestConvexIdentity = ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;

async function set_pending_test_read_only(
	asUser: TestConvexIdentity,
	membershipId: Id<"organizations_workspaces_users">,
	nodeId: Id<"files_nodes">,
) {
	const result = await asUser.mutation(api.files_nodes.set_node_write_policy, {
		writePolicy: { mode: "read_only" },
		membershipId,
		nodeId,
	});
	if (result._nay) {
		throw new Error(result._nay.message);
	}
}

async function set_pending_test_writable(
	asUser: TestConvexIdentity,
	membershipId: Id<"organizations_workspaces_users">,
	nodeId: Id<"files_nodes">,
) {
	const result = await asUser.mutation(api.files_nodes.set_node_write_policy, {
		writePolicy: null,
		membershipId,
		nodeId,
	});
	if (result._nay) {
		throw new Error(result._nay.message);
	}
}

async function upsert_file_pending_update_public_for_test(
	asIdentity: TestConvexIdentity,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		nodeId: Id<"files_nodes">;
		pendingUpdateId?: Id<"files_pending_updates">;
		reviewedRevision?: number;
		stagedMarkdown?: string;
		unstagedMarkdown: string;
	},
) {
	// Mirror the client flow: one batch, one bounded text per staging call, then the finishing
	// action that carries only ids. A staging refusal already retired the batch server-side.
	const batch = await asIdentity.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
		membershipId: args.membershipId,
		target: { kind: "saved", id: args.nodeId },
	});
	if (batch._nay) {
		return batch;
	}
	const operationBatchId = batch._yay.operationBatchId;

	if (args.stagedMarkdown !== undefined) {
		const staged = await asIdentity.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: args.membershipId,
			operationBatchId,
			role: "staged",
			text: args.stagedMarkdown,
		});
		if (staged._nay) {
			return staged;
		}
	}
	const unstaged = await asIdentity.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
		membershipId: args.membershipId,
		operationBatchId,
		role: "unstaged",
		text: args.unstagedMarkdown,
	});
	if (unstaged._nay) {
		return unstaged;
	}

	return await asIdentity.action(api.ai_chat.upsert_file_pending_update, {
		membershipId: args.membershipId,
		target: { kind: "saved", id: args.nodeId },
		operationBatchId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		...(args.reviewedRevision !== undefined ? { reviewedRevision: args.reviewedRevision } : {}),
	});
}

async function persist_file_pending_update_rebased_state_for_test(
	asIdentity: TestConvexIdentity,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		nodeId: Id<"files_nodes">;
		pendingUpdateId?: Id<"files_pending_updates">;
		baseYjsSequence: number;
		baseYjsUpdate: ArrayBuffer;
		stagedBranchYjsUpdate: ArrayBuffer;
		unstagedBranchYjsUpdate: ArrayBuffer;
	},
) {
	// Mirror the client rebase flow: stage and seal the three input states page by page under one
	// batch, then run the finishing action that carries only ids. A refusal at any staging step
	// already retired the batch server-side, so return it directly.
	const batch = await asIdentity.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
		membershipId: args.membershipId,
		target: { kind: "saved", id: args.nodeId },
	});
	if (batch._nay) {
		return batch;
	}
	const operationBatchId = batch._yay.operationBatchId;

	const inputs = [
		{ role: "base" as const, update: args.baseYjsUpdate },
		{ role: "staged" as const, update: args.stagedBranchYjsUpdate },
		{ role: "unstaged" as const, update: args.unstagedBranchYjsUpdate },
	];
	for (const input of inputs) {
		const bytes = new Uint8Array(input.update);
		for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
			const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
			const staged = await asIdentity.mutation(api.files_pending_updates.stage_file_pending_update_state_page, {
				membershipId: args.membershipId,
				operationBatchId,
				role: input.role,
				pageIndex,
				bytes: files_u8_to_array_buffer(bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES)),
			});
			if (staged._nay) {
				return staged;
			}
		}

		const sealed = await asIdentity.mutation(api.files_pending_updates.seal_file_pending_update_state, {
			membershipId: args.membershipId,
			operationBatchId,
			role: input.role,
			expectedTotalBytes: input.update.byteLength,
		});
		if (sealed._nay) {
			return sealed;
		}
	}

	return await asIdentity.action(api.ai_chat.persist_file_pending_update_rebased_state, {
		membershipId: args.membershipId,
		target: { kind: "saved", id: args.nodeId },
		operationBatchId,
		...(args.pendingUpdateId ? { pendingUpdateId: args.pendingUpdateId } : {}),
		baseYjsSequence: args.baseYjsSequence,
	});
}

/**
 * Stage and seal a three-role input family through the internal staging mutations, for tests
 * that drive a commit mutation directly. Throws on any refusal: these tests assume valid inputs
 * and assert the commit's own guards.
 */
async function stage_and_seal_input_family_for_test(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
	baseYjsUpdate: ArrayBuffer;
	stagedBranchYjsUpdate: ArrayBuffer;
	unstagedBranchYjsUpdate: ArrayBuffer;
}) {
	const batch = await args.t.mutation(
		internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
		{
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			target: { kind: "saved", id: args.nodeId },
		},
	);
	if (batch._nay) {
		throw new Error(batch._nay.message);
	}
	const operationBatchId = batch._yay.operationBatchId;

	const sealedByRole = new Map<
		"base" | "staged" | "unstaged",
		{ stateId: Id<"files_pending_update_yjs_states">; digest: string }
	>();
	const inputs = [
		{ role: "base" as const, update: args.baseYjsUpdate },
		{ role: "staged" as const, update: args.stagedBranchYjsUpdate },
		{ role: "unstaged" as const, update: args.unstagedBranchYjsUpdate },
	];
	for (const input of inputs) {
		const bytes = new Uint8Array(input.update);
		for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
			const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
			const staged = await args.t.mutation(
				internal.files_pending_updates.stage_file_pending_update_state_page_internal,
				{
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					operationBatchId,
					phase: "input",
					role: input.role,
					pageIndex,
					bytes: files_u8_to_array_buffer(bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES)),
				},
			);
			if (staged._nay) {
				throw new Error(staged._nay.message);
			}
		}

		const sealed = await args.t.mutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId,
			phase: "input",
			role: input.role,
			expectedTotalBytes: input.update.byteLength,
		});
		if (sealed._nay) {
			throw new Error(sealed._nay.message);
		}
		sealedByRole.set(input.role, { stateId: sealed._yay.stateId, digest: sealed._yay.digest });
	}

	return {
		operationBatchId,
		base: sealedByRole.get("base")!,
		staged: sealedByRole.get("staged")!,
		unstaged: sealedByRole.get("unstaged")!,
	};
}

async function upsert_file_pending_move_for_test(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
	destParentId: Id<"files_nodes"> | typeof files_ROOT_ID;
	destName: string;
	replace?: boolean;
	threadId?: Id<"ai_chat_threads">;
}) {
	return await args.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		target: { kind: "saved", id: args.nodeId },
		destParent: args.destParentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: args.destParentId },
		destName: args.destName,
		replace: args.replace,
		...(args.threadId ? { threadId: args.threadId } : {}),
	});
}

async function upsert_file_pending_archive_for_test(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	nodeId: Id<"files_nodes">;
	threadId?: Id<"ai_chat_threads">;
}) {
	return await args.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		target: { kind: "saved", id: args.nodeId },
		...(args.threadId ? { threadId: args.threadId } : {}),
	});
}

/**
 * Stage and seal one output family under a server-side batch, for tests that drive the upsert
 * commit directly. Every role holds the same empty-doc update: these tests assert the commit's
 * base check, not the branch bytes.
 */
async function seal_output_family_for_test(
	t: ReturnType<typeof test_convex>,
	seeded: Awaited<ReturnType<typeof seed_non_collaborative_file>>,
) {
	const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		organizationId: seeded.organizationId,
		workspaceId: seeded.workspaceId,
		userId: seeded.userId,
		target: { kind: "saved", id: seeded.nodeId },
	});
	if (batch._nay) {
		throw new Error(batch._nay.message);
	}
	const operationBatchId = batch._yay.operationBatchId;
	const stateUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(new YDoc()));

	const sealedByRole = new Map<
		"base" | "staged" | "unstaged",
		{ stateId: Id<"files_pending_update_yjs_states">; digest: string }
	>();
	for (const role of ["base", "staged", "unstaged"] as const) {
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId,
			phase: "output",
			role,
			pageIndex: 0,
			bytes: stateUpdate,
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}
		const sealed = await t.mutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId,
			phase: "output",
			role,
			expectedTotalBytes: stateUpdate.byteLength,
		});
		if (sealed._nay) {
			throw new Error(sealed._nay.message);
		}
		sealedByRole.set(role, { stateId: sealed._yay.stateId, digest: sealed._yay.digest });
	}

	return {
		operationBatchId,
		base: sealedByRole.get("base")!,
		staged: sealedByRole.get("staged")!,
		unstaged: sealedByRole.get("unstaged")!,
	};
}

async function reviewed_pending_for_test(
	t: ReturnType<typeof test_convex>,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		target: { kind: "saved"; id: Id<"files_nodes"> };
		pendingUpdateId?: Id<"files_pending_updates">;
	},
) {
	const pendingUpdate = await t.run(async (ctx) => {
		const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
		if (!membership) throw new Error("Expected a test membership");
		return await files_db_get_pending_update(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			target: args.target,
		});
	});
	if (!pendingUpdate && !args.pendingUpdateId) throw new Error("Expected a proposal to review");
	return {
		pendingUpdateId: args.pendingUpdateId ?? pendingUpdate!._id,
		reviewedRevision: pendingUpdate?.revision ?? 1,
	};
}

async function read_pending_review_state_for_test(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => ({
		nodes: await ctx.db.query("files_nodes").collect(),
		proposals: await ctx.db.query("files_pending_updates").collect(),
		states: await ctx.db.query("files_pending_update_yjs_states").collect(),
		chunks: await ctx.db.query("files_text_chunks").collect(),
	}));
}

async function create_private_text_for_test(
	args: {
		path?: string;
		staged?: string;
		unstaged?: string;
		preparing?: boolean;
		collaborative?: boolean;
		metadata?: { key: string; value: string | number | boolean }[];
		threadId?: Id<"ai_chat_threads">;
	} = {},
	workspace?: { t: ReturnType<typeof test_convex>; membershipId: Id<"organizations_workspaces_users"> },
) {
	const t = workspace?.t ?? test_convex();
	const scope = await t.run(async (ctx) => {
		if (workspace) {
			const membership = await ctx.db.get("organizations_workspaces_users", workspace.membershipId);
			if (!membership) throw new Error("Expected a test membership");
			return { ...membership, membershipId: membership._id };
		}
		const userId = await ctx.db.insert("users", { clerkUserId: `clerk_private_${seed_signed_in_file_user_counter++}` });
		const membership = await test_mocks_fill_db_with.membership(ctx, { userId });
		await seed_billing_snapshot_for_user(ctx, userId);
		return membership;
	});
	const path = args.path ?? "/draft.txt";
	const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		userId: scope.userId,
		path,
		kind: "file",
		threadId: args.threadId,
	});
	if (created._nay) throw new Error(created._nay.message);
	const { target, pendingUpdateId, operationBatchId } = created._yay;
	if (target.kind !== "private" || !pendingUpdateId || !operationBatchId)
		throw new Error("Expected a new private text draft");
	if (args.collaborative === false || args.metadata) {
		await t.run(async (ctx) => {
			const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
			if (proposal?.createIntent?.kind !== "text") throw new Error("Expected a text create intent");
			await ctx.db.patch("files_pending_updates", pendingUpdateId, {
				createIntent: {
					...proposal.createIntent,
					...(args.collaborative === false ? { collaborationEnabled: false } : {}),
					...(args.metadata ? { metadata: args.metadata } : {}),
				},
			});
		});
	}
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId, name: "Draft Owner" });
	if (!args.preparing) {
		for (const [role, text] of [
			["staged", args.staged ?? ""],
			["unstaged", args.unstaged ?? args.staged ?? ""],
		] as const) {
			const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: scope.userId,
				operationBatchId,
				role,
				text,
			});
			if (staged._nay) throw new Error(staged._nay.message);
		}
		const ready = await asUser.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
			target,
			pendingUpdateId,
			operationBatchId,
		});
		if (ready._nay) throw new Error(ready._nay.message);
	}
	const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!proposal) throw new Error("Expected the private proposal");
	return { t, ...scope, asUser, target, pendingUpdateId, operationBatchId, proposal, path };
}

async function run_agent_move_for_test(
	draft: Pick<
		Awaited<ReturnType<typeof create_private_text_for_test>>,
		"t" | "asUser" | "membershipId" | "organizationId" | "workspaceId" | "userId"
	>,
	args: {
		target: Doc<"files_pending_updates">["target"];
		destName: string;
		threadId: Id<"ai_chat_threads">;
		replace?: boolean;
	},
) {
	const started = await draft.t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: draft.membershipId,
		sourceWorkspace: "current",
		destinationWorkspace: "current",
		threadId: args.threadId,
		requestId: crypto.randomUUID(),
		kind: "move",
		sources: [args.target],
		targetParent: { kind: "root" },
		targetPath: "/",
		targetName: args.destName,
		missingParentNames: [],
		conflictPolicy: {
			file: args.replace === false ? "error" : "replace",
			folder: args.replace === false ? "error" : "replace_empty",
		},
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	for (let step = 0; step < 20; step++) {
		const view = await draft.asUser.query(api.files_transfer.get, { membershipId: draft.membershipId, runId });
		if (!view) throw new Error("Expected the transfer");
		if (view.activity.status !== "queued" && view.activity.status !== "running") return view;
		await draft.t.mutation(internal.files_transfer.advance, { runId });
	}
	throw new Error("Move did not finish");
}

async function save_pending_review_for_test(
	draft: Pick<Awaited<ReturnType<typeof create_private_text_for_test>>, "t" | "asUser" | "membershipId">,
	proposals: Doc<"files_pending_updates">[],
) {
	const started = await draft.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: draft.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: proposals.length,
		items: proposals.map((proposal) => ({
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: proposal.content?.unstagedStateId ?? null,
		})),
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	expect(
		await draft.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: draft.membershipId, runId }),
	).toEqual({ _yay: null });
	await draft.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
	for (let step = 0; step < 20; step++) {
		await draft.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await draft.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step === "finished")
			return await draft.asUser.query(api.files_pending_update_runs.get, { membershipId: draft.membershipId, runId });
		const unit = await draft.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
				.first(),
		);
		// A blocked unit settles in this advance, and the next advance finishes the run.
		if (!unit) continue;
		await draft.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
	}
	throw new Error("Save did not finish");
}

describe("files_pending_updates_action_prepare_content", () => {
	test.each([true, false])(
		"prepares all private content without changing S, with collaboration %s",
		async (collaborative) => {
			const draft = await create_private_text_for_test({
				staged: "selected line\n",
				unstaged: "all lines\n",
				collaborative,
			});
			const originalStates = await draft.t.run((ctx) =>
				read_pending_row_state_bytes({ ctx, pendingUpdate: draft.proposal }),
			);
			const prepared = await draft.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: draft.userId,
					membershipId: draft.membershipId,
					target: draft.target,
					pendingUpdateId: draft.pendingUpdateId,
					reviewedRevision: draft.proposal.revision,
					selectedContentStateId: draft.proposal.content!.unstagedStateId,
					reviewedPrivateParentIds: [],
				}),
			);
			if (prepared._nay) throw new Error(prepared._nay.message);
			expect(prepared._yay.kind).toBe("private");
			expect(JSON.stringify(prepared._yay).length).toBeLessThan(5000);
			expect(await draft.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId))).toEqual(
				draft.proposal,
			);
			expect(await draft.t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: draft.proposal }))).toEqual(
				originalStates,
			);
			expect(await draft.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
			const saved = await draft.t.mutation(internal.files_pending_updates.commit_prepared_content, {
				userId: draft.userId,
				prepared: prepared._yay,
			});
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved private file");
			const nodeId = saved._yay.target.id;
			expect(await draft.t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId }))).toBe("all lines\n");
			expect(await draft.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId))).toBeNull();
		},
	);

	test.each([true, false])(
		"prepares all saved content without request auth, with collaboration %s",
		async (collaborative) => {
			const t = test_convex();
			const seeded = collaborative
				? await t.run((ctx) =>
						seed_signed_in_file_with_markdown({
							ctx,
							path: "/all.txt",
							name: "all.txt",
							markdown: "base\n",
							rootKind: "plain_text",
						}),
					)
				: await t.run((ctx) => seed_non_collaborative_file(ctx, "/all.txt", "base\n"));
			const upserted = await upsert_file_pending_update_internal_for_test({
				t,
				...seeded,
				stagedMarkdown: "selected\n",
				unstagedMarkdown: "all\n",
			});
			if (upserted._nay) throw new Error(upserted._nay.message);
			const target = { kind: "saved" as const, id: seeded.nodeId };
			const pending = await t.run((ctx) => files_db_get_pending_update(ctx, { ...seeded, target }));
			if (!pending?.content) throw new Error("Expected pending content");
			const prepared = await t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: seeded.userId,
					membershipId: seeded.membershipId,
					target,
					pendingUpdateId: pending._id,
					reviewedRevision: pending.revision,
					selectedContentStateId: pending.content!.unstagedStateId,
					reviewedPrivateParentIds: [],
				}),
			);
			if (prepared._nay) throw new Error(prepared._nay.message);
			expect(prepared._yay.kind).toBe(collaborative ? "saved_yjs" : "saved_asset");
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
			const saved = await t.mutation(internal.files_pending_updates.commit_prepared_content, {
				userId: seeded.userId,
				prepared: prepared._yay,
			});
			if (saved._nay) throw new Error(saved._nay.message);
			expect(
				await t.run((ctx) =>
					collaborative
						? read_file_markdown_from_yjs({ ctx, ...seeded, rootKind: "plain_text" })
						: read_committed_text({ ctx, ...seeded }),
				),
			).toBe("all\n");
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
		},
	);

	test("keeps the payer chosen during preparation when organization billing changes", async () => {
		const draft = await create_private_text_for_test({ staged: "saved\n" });
		const prepared = await draft.t.action((ctx) =>
			files_pending_updates_action_prepare_content(ctx, {
				userId: draft.userId,
				membershipId: draft.membershipId,
				target: draft.target,
				pendingUpdateId: draft.pendingUpdateId,
				reviewedRevision: draft.proposal.revision,
				selectedContentStateId: draft.proposal.content!.stagedStateId,
				reviewedPrivateParentIds: [],
			}),
		);
		if (prepared._nay) throw new Error(prepared._nay.message);
		expect(prepared._yay.billedUserId).toBe(draft.userId);
		await draft.t.run(async (ctx) => {
			const ownerUserId = await ctx.db.insert("users", { clerkUserId: "new_owner_without_credits" });
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId: draft.userId,
				role: "admin",
				now: Date.now(),
			});
			await ctx.db.patch("organizations", draft.organizationId, {
				default: false,
				billingMode: "organization_owner",
				ownerUserId,
			});
		});
		const saved = await draft.t.mutation(internal.files_pending_updates.commit_prepared_content, {
			userId: draft.userId,
			prepared: prepared._yay,
		});
		expect(saved._nay).toBeUndefined();
		expect(saved._yay?.target.kind).toBe("saved");
	});

	test.each([false, true])(
		"publishes a reviewed private parent and child atomically, stale child %s",
		async (staleChild) => {
			const draft = await create_private_text_for_test({ path: "/parent/child.txt", staged: "saved\n" });
			const parent = await draft.t.run(async (ctx) => {
				const node = (await ctx.db.query("files_pending_nodes").collect()).find((node) => node.kind === "folder");
				if (!node) throw new Error("Expected a private parent");
				const proposal = await files_db_get_pending_update(ctx, {
					...draft,
					target: { kind: "private", id: node._id },
				});
				if (!proposal) throw new Error("Expected the parent proposal");
				return { node, proposal };
			});
			const refused = await draft.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: draft.userId,
					membershipId: draft.membershipId,
					target: draft.target,
					pendingUpdateId: draft.pendingUpdateId,
					reviewedRevision: draft.proposal.revision,
					selectedContentStateId: draft.proposal.content!.stagedStateId,
					reviewedPrivateParentIds: [],
				}),
			);
			expect(refused._nay?.message).toContain("parent");
			const preparedParent = await draft.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: draft.userId,
					membershipId: draft.membershipId,
					target: { kind: "private", id: parent.node._id },
					pendingUpdateId: parent.proposal._id,
					reviewedRevision: parent.proposal.revision,
					selectedContentStateId: null,
					reviewedPrivateParentIds: [],
				}),
			);
			const preparedChild = await draft.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					userId: draft.userId,
					membershipId: draft.membershipId,
					target: draft.target,
					pendingUpdateId: draft.pendingUpdateId,
					reviewedRevision: draft.proposal.revision,
					selectedContentStateId: draft.proposal.content!.stagedStateId,
					reviewedPrivateParentIds: [parent.node._id],
				}),
			);
			if (preparedParent._nay || preparedChild._nay)
				throw new Error(preparedParent._nay?.message ?? preparedChild._nay?.message);
			if (staleChild)
				await draft.t.run((ctx) =>
					ctx.db.patch("files_pending_updates", draft.pendingUpdateId, { revision: draft.proposal.revision + 1 }),
				);
			const commit = draft.t.run(async (ctx) => {
				for (const prepared of [preparedParent._yay, preparedChild._yay]) {
					const saved = await files_pending_updates_db_commit_prepared_content(ctx, { userId: draft.userId, prepared });
					if (saved._nay) throw new Error(saved._nay.message);
					await files_pending_updates_db_retire_prepared_content(ctx, prepared);
				}
			});
			if (staleChild) {
				await expect(commit).rejects.toThrow("This file changed. Read it again.");
				expect(await draft.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
				expect(await draft.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
				expect(await draft.t.run((ctx) => ctx.db.get("files_pending_nodes", parent.node._id))).toEqual(parent.node);
			} else {
				await commit;
				expect(
					(await draft.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort(),
				).toEqual(["/parent", "/parent/child.txt"]);
				expect(await draft.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
			}
		},
	);
});

describe("private pending text", () => {
	test.each(["save", "discard", "rm"] as const)("keeps a moved private file private until %s", async (outcome) => {
		const draft = await create_private_text_for_test({ staged: "source content\n" });
		const { t, asUser, membershipId, target, pendingUpdateId } = draft;
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
		const states = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: draft.proposal }));
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target,
			destParent: { kind: "root" },
			destName: "moved.txt",
			threadId,
		});
		expect(moved).toMatchObject({
			_yay: { fromPath: "/draft.txt", destPath: "/moved.txt", appliedImmediately: true },
		});
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!proposal) throw new Error("Expected the moved private proposal");
		expect(proposal).toMatchObject({ target, threadIds: [threadId], revision: draft.proposal.revision + 1 });
		expect(proposal.pendingMove).toBeUndefined();
		expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: proposal }))).toEqual(states);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		const reviewed = { membershipId, target, pendingUpdateId, reviewedRevision: proposal.revision };
		if (outcome === "save") {
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, reviewed);
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the moved file to save");
			const nodeId = saved._yay.target.id;
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({ path: "/moved.txt" });
			expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId }))).toBe("source content\n");
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toBeNull();
		} else {
			if (outcome === "discard") {
				expect(
					(await asUser.mutation(api.files_pending_updates.discard_file_pending_update, reviewed))._nay,
				).toBeUndefined();
			} else {
				expect(
					await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
						organizationId: draft.organizationId,
						workspaceId: draft.workspaceId,
						userId: draft.userId,
						target,
						threadId,
					}),
				).toMatchObject({ _yay: { outcome: "cancelled_added_file", fromPath: "/moved.txt" } });
			}
			expect(
				await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
			).toBeNull();
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toMatchObject([
				{ _id: target.id, state: "discarded" },
			]);
		}
	});

	test.each(
		(
			[
				{ sourceKind: "saved", destinationKind: "saved" },
				{ sourceKind: "private", destinationKind: "saved" },
				{ sourceKind: "saved", destinationKind: "private" },
				{ sourceKind: "private", destinationKind: "private" },
			] as const
		).flatMap((pair) => (["single", "review"] as const).map((saveMode) => ({ ...pair, saveMode }))),
	)(
		"agent transfer replaces a $destinationKind destination from a $sourceKind source with $saveMode Save",
		async ({ sourceKind, destinationKind, saveMode }) => {
			const draft = await create_private_text_for_test({ path: "/destination.txt", staged: "destination\n" });
			const { t, asUser, membershipId } = draft;
			const scope = {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId: draft.userId,
			};
			if (destinationKind === "saved") {
				const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target: draft.target,
					pendingUpdateId: draft.pendingUpdateId,
					reviewedRevision: draft.proposal.revision,
				});
				if (saved._nay) throw new Error(saved._nay.message);
			}
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				path: "/source.txt",
				kind: "file",
			});
			if (created._nay || !created._yay.operationBatchId || !created._yay.pendingUpdateId)
				throw new Error("Expected a new private source");
			const { operationBatchId, pendingUpdateId } = created._yay;
			let sourceTarget: Doc<"files_pending_updates">["target"] = created._yay.target;
			for (const role of ["staged", "unstaged"] as const) {
				const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId,
					role,
					text: "source\n",
				});
				if (staged._nay) throw new Error(staged._nay.message);
			}
			const ready = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target: sourceTarget,
				operationBatchId,
				pendingUpdateId,
			});
			if (ready._nay) throw new Error(ready._nay.message);
			if (sourceKind === "saved") {
				const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
				if (!proposal) throw new Error("Expected the source proposal");
				const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				});
				if (saved._nay) throw new Error(saved._nay.message);
				sourceTarget = saved._yay.target;
			}
			const savedBefore = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...scope }));
			const started = await t.mutation(internal.files_transfer.start_for_agent, {
				membershipId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				threadId,
				requestId: "private-replacement",
				kind: "move",
				sources: [sourceTarget],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: "destination.txt",
				missingParentNames: [],
				conflictPolicy: { file: "replace", folder: "merge" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			for (let step = 0; step < 20; step += 1) {
				const view = await asUser.query(api.files_transfer.get, { membershipId, runId });
				if (!view) throw new Error("Expected the transfer");
				if (view.activity.status !== "queued" && view.activity.status !== "running") break;
				await t.mutation(internal.files_transfer.advance, { runId });
			}
			const finished = await asUser.query(api.files_transfer.get, { membershipId, runId });
			expect(finished?.activity, finished?.activity.errorMessage ?? "Expected a completed move").toMatchObject({
				status: "succeeded",
				progress: { completed: 1, failed: 0 },
			});
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
			expect(
				await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target: sourceTarget }),
			).toMatchObject({ entry: { path: "/destination.txt" } });
			const visible = await asUser.query(api.files_visible.list, {
				membershipId,
				folderPath: "/",
				mode: "children",
				numItems: 10,
				cursor: null,
			});
			expect(visible._yay?.items.map(({ target, path }) => ({ target, path }))).toEqual([
				{ target: sourceTarget, path: "/destination.txt" },
			]);
			const proposal = await t.run((ctx) => files_db_get_pending_update(ctx, { ...scope, target: sourceTarget }));
			if (!proposal) throw new Error("Expected the moved proposal");
			const read = await t.query(internal.files_nodes.read_file_content_from_chunks, {
				...scope,
				overlayUserId: scope.userId,
				path: "/destination.txt",
				mode: { kind: "full", maxBytes: 1000 },
			});
			expect(read?.content).toBe("source\n");
			let nodeId: Id<"files_nodes">;
			if (saveMode === "review") {
				const saved = await save_pending_review_for_test(draft, [proposal]);
				expect(saved?.activity, saved?.activity.errorMessage ?? "Expected Save to finish").toMatchObject({
					status: "succeeded",
					progress: { completed: 1 },
				});
				const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
				const source = nodes.find((node) => node.archiveOperationId === null && node.path === "/destination.txt");
				if (!source) throw new Error("Expected the saved source");
				nodeId = source._id;
			} else if (sourceTarget.kind === "saved") {
				const saved = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				expect(saved._nay).toBeUndefined();
				nodeId = sourceTarget.id;
			} else {
				const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				expect(saved._nay).toBeUndefined();
				if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the moved file to save");
				nodeId = saved._yay.target.id;
			}
			expect(await t.run((ctx) => read_committed_text({ ctx, ...scope, nodeId }))).toBe("source\n");
			const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(
				nodes.filter((node) => node.archiveOperationId === null).map((node) => ({ id: node._id, path: node.path })),
			).toEqual([{ id: nodeId, path: "/destination.txt" }]);
			if (destinationKind === "saved") expect(nodes.filter((node) => node.archiveOperationId !== null)).toHaveLength(1);
		},
	);

	test.each(["discard", "expiry", "move away"] as const)(
		"keeps the saved occupant after private replacement %s",
		async (outcome) => {
			const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
			const { t, asUser, membershipId } = draft;
			const occupantId = await test_create_saved_text_file(t, {
				membershipId,
				path: "/destination.txt",
				textContent: "destination\n",
			});
			const savedBefore = await t.run((ctx) => ctx.db.get("files_nodes", occupantId));
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
			expect(
				(await run_agent_move_for_test(draft, { target: draft.target, destName: "destination.txt", threadId })).activity
					.status,
			).toBe("succeeded");
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
			if (!proposal) throw new Error("Expected the replacement proposal");
			expect(proposal.pendingMove?.replacesTarget).toEqual({ kind: "saved", id: occupantId });
			if (outcome === "move away") {
				expect(
					(await run_agent_move_for_test(draft, { target: draft.target, destName: "away.txt", threadId })).activity
						.status,
				).toBe("succeeded");
				const moved = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
				if (!moved) throw new Error("Expected the moved draft");
				expect(moved.pendingMove).toBeUndefined();
				const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target: draft.target,
					pendingUpdateId: moved._id,
					reviewedRevision: moved.revision,
				});
				expect(saved._nay).toBeUndefined();
			} else if (outcome === "discard") {
				expect(
					(
						await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
							membershipId,
							target: draft.target,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			} else {
				vi.useFakeTimers();
				try {
					await expire_pending_update_for_test(t, proposal._id);
				} finally {
					vi.useRealTimers();
				}
			}
			expect(await t.run((ctx) => ctx.db.get("files_nodes", occupantId))).toEqual(savedBefore);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId: occupantId }))).toBe("destination\n");
			const visible = await asUser.query(api.files_visible.list, {
				membershipId,
				folderPath: "/",
				mode: "children",
				numItems: 10,
				cursor: null,
			});
			expect(visible._yay?.items.find((item) => item.path === "/destination.txt")?.target).toEqual({
				kind: "saved",
				id: occupantId,
			});
			if (outcome !== "move away") {
				expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", draft.target.id))).toMatchObject({
					state: "discarded",
				});
				expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([savedBefore]);
			}
		},
	);

	test.each(
		(["version", "new occupant", "read-only", "access"] as const).flatMap((change) =>
			(["single", "review"] as const).map((saveMode) => ({ change, saveMode })),
		),
	)("refuses private replacement after saved $change changes with $saveMode Save", async ({ change, saveMode }) => {
		const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
		const { t, asUser, membershipId } = draft;
		const occupantId = await test_create_saved_text_file(t, {
			membershipId,
			path: "/destination.txt",
			textContent: "destination\n",
		});
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
		expect(
			(await run_agent_move_for_test(draft, { target: draft.target, destName: "destination.txt", threadId })).activity
				.status,
		).toBe("succeeded");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
		if (!proposal) throw new Error("Expected the replacement proposal");
		if (change === "version") {
			const doc = new YDoc();
			doc.getText(files_YJS_DOC_KEYS.plainText).insert(0, "saved edit\n");
			const pointers = await test_get_file_yjs_pointers(t, occupantId);
			const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId,
				nodeId: occupantId,
				expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(doc)),
				sessionId: "replacement-change",
			});
			doc.destroy();
			expect(pushed._nay).toBeUndefined();
		} else if (change === "new occupant") {
			expect(
				(await asUser.mutation(api.files_nodes.rename_node, { membershipId, nodeId: occupantId, path: "old.txt" }))
					._nay,
			).toBeUndefined();
			const created = await asUser.action(api.files_nodes_content.create_text_node, {
				membershipId,
				parentId: files_ROOT_ID,
				path: "destination.txt",
			});
			expect(created._nay).toBeUndefined();
		} else if (change === "read-only") {
			await set_pending_test_read_only(asUser, membershipId, occupantId);
		} else {
			await t.run(async (ctx) => {
				const ownerId = await ctx.db.insert("users", { clerkUserId: "replacement-new-owner" });
				await ctx.db.patch("organizations", draft.organizationId, { ownerUserId: ownerId });
				await access_control_db_ensure_role_assignment(ctx, { ...draft, role: "member", now: Date.now() });
				await ctx.db.patch("files_nodes", occupantId, { restrictedScopeNodeId: occupantId });
			});
		}
		const savedBefore = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const receiptsBefore = await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		const savedText = await t.run((ctx) =>
			read_file_markdown_from_yjs({ ctx, ...draft, nodeId: occupantId, rootKind: "plain_text" }),
		);
		if (change === "version") expect(savedText).toContain("saved edit\n");
		if (saveMode === "single") {
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId,
				target: draft.target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			expect(saved._nay).toBeDefined();
		} else {
			const saved = await save_pending_review_for_test(draft, [proposal]);
			expect(saved?.activity.status).not.toBe("succeeded");
		}
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual(receiptsBefore);
		expect(
			await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...draft, nodeId: occupantId, rootKind: "plain_text" })),
		).toBe(savedText);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(proposal);
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", draft.target.id))).toMatchObject({
			state: "active",
			name: "destination.txt",
		});
	});

	test("requires the saved occupant's other-chat proposal in the private replacement review", async () => {
		const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
		const { t, asUser, membershipId } = draft;
		const occupantId = await test_create_saved_text_file(t, {
			membershipId,
			path: "/destination.txt",
			textContent: "destination\n",
		});
		const [sourceThread, occupantThread] = await t.run((ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...draft }), seed_chat_thread({ ctx, ...draft })]),
		);
		expect(
			(
				await upsert_file_pending_update_internal_for_test({
					...draft,
					nodeId: occupantId,
					unstagedMarkdown: "other chat\n",
					threadId: occupantThread,
				})
			)._nay,
		).toBeUndefined();
		const occupantProposal = await t.run((ctx) =>
			files_db_get_pending_update(ctx, { ...draft, target: { kind: "saved", id: occupantId } }),
		);
		if (!occupantProposal) throw new Error("Expected the occupant's content proposal");
		expect(
			(
				await run_agent_move_for_test(draft, {
					target: draft.target,
					destName: "destination.txt",
					threadId: sourceThread,
				})
			).activity.status,
		).toBe("succeeded");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
		if (!proposal) throw new Error("Expected the replacement proposal");
		expect(proposal.threadIds).toEqual(expect.arrayContaining([sourceThread, occupantThread]));
		expect(proposal.threadIds).toHaveLength(2);
		const savedBefore = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(
			(
				await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target: draft.target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay?.name,
		).toBe("needs_review");
		const incomplete = await save_pending_review_for_test(draft, [proposal]);
		// The blocked unit holds `needs_review`; the Activity only says that changes still need review.
		expect(incomplete?.activity).toMatchObject({ status: "failed", errorMessage: "Some changes still need review." });
		expect(incomplete?.run.needsReviewIds).toEqual([occupantProposal._id]);
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", occupantProposal._id))).toEqual(occupantProposal);
		const saved = await save_pending_review_for_test(draft, [proposal, occupantProposal]);
		expect(saved?.activity, saved?.activity.errorMessage ?? "Expected replacement Save").toMatchObject({
			status: "succeeded",
			progress: { completed: 2 },
		});
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const output = nodes.find((node) => node.archiveOperationId === null && node.path === "/destination.txt");
		if (!output) throw new Error("Expected the published private source");
		expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId: output._id }))).toBe("source\n");
		expect(nodes.find((node) => node._id === occupantId)?.archiveOperationId).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", occupantProposal._id))).toBeNull();
	});

	test("keeps same-name root Move claims inside their workspace", async () => {
		vi.useFakeTimers();
		const source = await create_private_text_for_test({ path: "/source.txt", staged: "first workspace\n" });
		const { t, asUser } = source;
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: source.membershipId,
			target: source.target,
			pendingUpdateId: source.pendingUpdateId,
			reviewedRevision: source.proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		const workspace = await asUser.mutation(api.organizations.create_workspace, {
			organizationId: source.organizationId,
			name: "other-claims",
			description: "",
		});
		if (workspace._nay) throw new Error(workspace._nay.message);
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", workspace._yay.workspaceId).eq("userId", source.userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected the other workspace membership");
		const otherId = await test_create_saved_text_file(t, {
			membershipId: membership._id,
			path: "/destination.txt",
			textContent: "second workspace\n",
		});
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...source }));
		expect(
			(await run_agent_move_for_test(source, { target: saved._yay.target, destName: "destination.txt", threadId }))
				.activity.status,
		).toBe("succeeded");
		const visible = await asUser.query(api.files_visible.list, {
			membershipId: membership._id,
			folderPath: "/",
			mode: "children",
			numItems: 10,
			cursor: null,
		});
		expect(visible._yay?.items.map(({ target, path }) => ({ target, path }))).toEqual([
			{ target: { kind: "saved", id: otherId }, path: "/destination.txt" },
		]);
		const read = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: source.userId,
			overlayUserId: source.userId,
			path: "/destination.txt",
			mode: { kind: "full", maxBytes: 1000 },
		});
		expect(read?.content).toBe("second workspace\n");
	});

	test.each(
		(["private", "saved"] as const).flatMap((sourceKind) =>
			(["single", "review"] as const).map((saveMode) => ({ sourceKind, saveMode })),
		),
	)(
		"keeps the saved replacement claim and all contributors through a private chain from a $sourceKind source with $saveMode Save",
		async ({ sourceKind, saveMode }) => {
			const occupant = await create_private_text_for_test({ path: "/middle.txt", staged: "middle\n" });
			const { t, asUser, membershipId } = occupant;
			const savedId = await test_create_saved_text_file(t, {
				membershipId,
				path: "/destination.txt",
				textContent: "saved\n",
			});
			const [firstThread, secondThread] = await t.run((ctx) =>
				Promise.all([seed_chat_thread({ ctx, ...occupant }), seed_chat_thread({ ctx, ...occupant })]),
			);
			const source = await create_private_text_for_test(
				{ path: "/source.json", staged: '{"source":true}\n', threadId: secondThread },
				{ t, membershipId },
			);
			const sourceStates = source.proposal.content;
			const sourceCreate = source.proposal.createIntent;
			let sourceTarget: Doc<"files_pending_updates">["target"] = source.target;
			if (sourceKind === "saved") {
				const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: source.pendingUpdateId,
					reviewedRevision: source.proposal.revision,
				});
				if (saved._nay) throw new Error(saved._nay.message);
				sourceTarget = saved._yay.target;
			}
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(
				(
					await run_agent_move_for_test(occupant, {
						target: occupant.target,
						destName: "destination.txt",
						threadId: firstThread,
					})
				).activity.status,
			).toBe("succeeded");
			const occupantProposal = await t.run((ctx) => ctx.db.get("files_pending_updates", occupant.pendingUpdateId));
			expect(
				(
					await run_agent_move_for_test(source, {
						target: sourceTarget,
						destName: "destination.txt",
						threadId: secondThread,
					})
				).activity.status,
			).toBe("succeeded");
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", occupant.target.id))).toMatchObject({
				state: "discarded",
			});
			const proposal = await t.run((ctx) => files_db_get_pending_update(ctx, { ...source, target: sourceTarget }));
			if (!proposal) throw new Error("Expected the surviving source proposal");
			if (sourceTarget.kind === "private")
				expect(proposal).toMatchObject({ content: sourceStates, createIntent: sourceCreate });
			expect(proposal).toMatchObject({
				pendingMove: {
					replacesTarget: { kind: "saved", id: savedId },
					replacesContentVersion: occupantProposal?.pendingMove?.replacesContentVersion,
				},
			});
			expect(proposal.threadIds).toEqual(expect.arrayContaining([firstThread, secondThread]));
			expect(proposal.threadIds).toHaveLength(2);
			// The discarded occupant's proposal stays until cleanup. It must not mask the surviving source.
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", occupant.pendingUpdateId))).toEqual(
				occupantProposal,
			);
			const visible = await asUser.query(api.files_visible.list, {
				membershipId,
				folderPath: "/",
				mode: "children",
				numItems: 10,
				cursor: null,
			});
			expect(visible._yay?.items.map(({ target, path }) => ({ target, path }))).toEqual([
				{ target: sourceTarget, path: "/destination.txt" },
			]);
			const read = await t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: source.organizationId,
				workspaceId: source.workspaceId,
				userId: source.userId,
				overlayUserId: source.userId,
				path: "/destination.txt",
				mode: { kind: "full", maxBytes: 1000 },
			});
			expect(read?.content).toBe('{"source":true}\n');
			if (saveMode === "single" && sourceTarget.kind === "saved") {
				const saved = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
					membershipId,
					target: sourceTarget,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				expect(saved._nay).toBeUndefined();
			} else if (saveMode === "single") {
				expect(
					(
						await asUser.action(api.files_pending_updates.save_file_pending_update, {
							membershipId,
							target: sourceTarget,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			} else {
				expect((await save_pending_review_for_test(source, [proposal]))?.activity.status).toBe("succeeded");
			}
			const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const output = nodes.find((node) => node.archiveOperationId === null);
			if (!output || sourceCreate?.kind !== "text") throw new Error("Expected the saved source text");
			if (sourceTarget.kind === "saved") expect(output._id).toBe(sourceTarget.id);
			expect(output).toMatchObject({
				path: "/destination.txt",
				contentType: sourceCreate.contentType,
				textKind: "plain_text",
			});
			expect(await t.run((ctx) => read_committed_text({ ctx, ...source, nodeId: output._id }))).toBe(
				'{"source":true}\n',
			);
			expect(nodes.find((node) => node._id === savedId)?.archiveOperationId).not.toBeNull();
			expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", source.target.id))).toMatchObject({
				state: "published",
			});
		},
	);

	test.each(["preparing", "no replace", "folder"] as const)(
		"does not retire a private Move occupant on %s refusal",
		async (reason) => {
			const draft = await create_private_text_for_test({ path: "/source.txt", staged: "source\n" });
			const { t, membershipId } = draft;
			const occupant =
				reason === "folder"
					? await t.mutation(internal.files_nodes.create_private_node_by_path, {
							organizationId: draft.organizationId,
							workspaceId: draft.workspaceId,
							userId: draft.userId,
							path: "/destination.txt",
							kind: "folder",
						})
					: null;
			if (occupant?._nay) throw new Error(occupant._nay.message);
			if (reason !== "folder")
				await create_private_text_for_test(
					{ path: "/destination.txt", staged: "destination\n", preparing: reason === "preparing" },
					{ t, membershipId },
				);
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
			const before = await read_pending_review_state_for_test(t);
			const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			const moved = await run_agent_move_for_test(draft, {
				target: draft.target,
				destName: "destination.txt",
				threadId,
				replace: reason !== "no replace",
			});
			expect(moved.activity.status).not.toBe("succeeded");
			expect(await read_pending_review_state_for_test(t)).toEqual(before);
			expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual(nodes);
		},
	);

	test.each(
		(
			[
				{ sourceKind: "private", destinationKind: "saved" },
				{ sourceKind: "private", destinationKind: "private" },
				{ sourceKind: "saved", destinationKind: "private" },
			] as const
		).flatMap((pair) =>
			(["empty", "private child", "pending move"] as const).flatMap((contents) =>
				(contents === "empty" ? (["single", "review"] as const) : (["review"] as const)).map((saveMode) => ({
					...pair,
					contents,
					saveMode,
				})),
			),
		),
	)(
		"Move replaces a $destinationKind folder from a $sourceKind folder only when empty: $contents with $saveMode Save",
		async ({ sourceKind, destinationKind, contents, saveMode }) => {
			vi.useFakeTimers();
			const t = test_convex({ transactionLimits: {} });
			const scope = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "folder-move-owner" });
				return await test_mocks_fill_db_with.membership(ctx, { userId });
			});
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: scope.userId });
			const fixture = { t, asUser, ...scope };
			const targets: Doc<"files_pending_updates">["target"][] = [];
			for (const [path, kind] of [
				["/source", sourceKind],
				["/destination", destinationKind],
			] as const) {
				const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: scope.userId,
					path,
					kind: "folder",
				});
				if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder");
				let target = created._yay.target;
				if (kind === "saved") {
					const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
					const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
						membershipId: scope.membershipId,
						target,
						pendingUpdateId: proposal!._id,
						reviewedRevision: proposal!.revision,
					});
					if (saved._nay) throw new Error(saved._nay.message);
					target = saved._yay.target;
				}
				targets.push(target);
			}
			const [source, destination] = targets as [
				Doc<"files_pending_updates">["target"],
				Doc<"files_pending_updates">["target"],
			];
			if (contents === "private child") {
				const child = await t.mutation(internal.files_nodes.create_private_node_by_path, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: scope.userId,
					path: "/destination/child",
					kind: "folder",
				});
				expect(child._nay).toBeUndefined();
			} else if (contents === "pending move") {
				const childId = await test_create_saved_text_file(t, {
					membershipId: scope.membershipId,
					path: "/child.txt",
					textContent: "child\n",
				});
				const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: scope.userId,
					target: { kind: "saved", id: childId },
					destParent: destination,
					destName: "child.txt",
				});
				expect(moved._nay).toBeUndefined();
			}
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...scope }));
			const before = await read_pending_review_state_for_test(t);
			const privateBefore = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
			const moved = await run_agent_move_for_test(fixture, { target: source, destName: "destination", threadId });
			if (contents !== "empty") {
				expect(moved.activity.status).not.toBe("succeeded");
				expect(await read_pending_review_state_for_test(t)).toEqual(before);
				expect(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual(privateBefore);
				return;
			}
			expect(moved.activity, moved.activity.errorMessage ?? "Expected folder Move").toMatchObject({
				status: "succeeded",
			});
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before.nodes);
			const proposal = await t.run((ctx) => files_db_get_pending_update(ctx, { ...scope, target: source }));
			if (!proposal) throw new Error("Expected the moved folder proposal");
			if (saveMode === "review") {
				const saved = await save_pending_review_for_test(fixture, [proposal]);
				expect(saved?.activity, saved?.activity.errorMessage ?? "Expected folder Save").toMatchObject({
					status: "succeeded",
				});
			} else if (source.kind === "private") {
				expect(
					(
						await asUser.action(api.files_pending_updates.save_file_pending_update, {
							membershipId: scope.membershipId,
							target: source,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			} else {
				expect(
					(
						await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
							membershipId: scope.membershipId,
							target: source,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay,
				).toBeUndefined();
			}
			const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(nodes.filter((node) => node.archiveOperationId === null)).toMatchObject([
				{ name: "destination", kind: "folder" },
			]);
			if (destination.kind === "saved")
				expect(nodes.find((node) => node._id === destination.id)?.archiveOperationId).not.toBeNull();
		},
	);

	test.each(["single", "review"] as const)(
		"keeps a late saved child when a private folder replacement uses %s Save",
		async (saveMode) => {
			const draft = await create_private_text_for_test({ path: "/unrelated.txt", staged: "unrelated\n" });
			const { t, asUser, membershipId } = draft;
			const source = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId: draft.userId,
				path: "/source",
				kind: "folder",
			});
			if (source._nay || !source._yay.pendingUpdateId) throw new Error("Expected a private source folder");
			const sourceTarget = source._yay.target;
			const destination = await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId,
				parentId: files_ROOT_ID,
				path: "destination",
			});
			if (destination._nay) throw new Error(destination._nay.message);
			const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
			expect(
				(await run_agent_move_for_test(draft, { target: sourceTarget, destName: "destination", threadId })).activity
					.status,
			).toBe("succeeded");
			const child = await asUser.action(api.files_nodes_content.create_text_node, {
				membershipId,
				parentId: destination._yay.nodeId,
				path: "late.md",
			});
			expect(child._nay).toBeUndefined();
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", source._yay.pendingUpdateId!));
			if (!proposal) throw new Error("Expected the replacement proposal");
			if (saveMode === "single") {
				expect(
					(
						await asUser.action(api.files_pending_updates.save_file_pending_update, {
							membershipId,
							target: sourceTarget,
							pendingUpdateId: proposal._id,
							reviewedRevision: proposal.revision,
						})
					)._nay?.message,
				).toBe("Directory not empty");
			} else {
				expect((await save_pending_review_for_test(draft, [proposal]))?.activity.status).toBe("failed");
			}
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(proposal);
		},
	);

	test("partial Save replaces the saved occupant once and keeps the source's remaining content", async () => {
		const draft = await create_private_text_for_test({
			path: "/source.txt",
			staged: "accepted\n",
			unstaged: "remaining\n",
		});
		const { t, asUser, membershipId } = draft;
		const occupantId = await test_create_saved_text_file(t, {
			membershipId,
			path: "/destination.txt",
			textContent: "destination\n",
		});
		const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...draft }));
		expect(
			(await run_agent_move_for_test(draft, { target: draft.target, destName: "destination.txt", threadId })).activity
				.status,
		).toBe("succeeded");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
		if (!proposal) throw new Error("Expected the replacement proposal");
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target: draft.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved private source");
		const target = saved._yay.target;
		const remaining = await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id));
		expect(remaining).toMatchObject({ target, content: { base: { kind: "yjs", sequence: 0 } }, threadIds: [threadId] });
		expect(remaining?.pendingMove).toBeUndefined();
		expect(remaining?.createIntent).toBeUndefined();
		expect(await t.run((ctx) => read_committed_text({ ctx, ...draft, nodeId: target.id }))).toBe("accepted\n");
		const oldOccupant = await t.run((ctx) => ctx.db.get("files_nodes", occupantId));
		expect(oldOccupant?.archiveOperationId).not.toBeNull();
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId,
					target,
					pendingUpdateId: proposal._id,
					reviewedRevision: remaining!.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", occupantId))).toEqual(oldOccupant);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", target.id))).toMatchObject({
			archiveOperationId: null,
			path: "/destination.txt",
		});
	});

	test.each(["/metadata.txt", "/metadata.md"])("indexes captured metadata separately from text in %s", async (path) => {
		const draft = await create_private_text_for_test({
			path,
			unstaged: "---\nstatus: proposed\n---\nBody\n",
			metadata: [{ key: "status", value: "captured" }],
		});
		const docs = await draft.t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
		const values = docs.filter((doc) => doc.docKind === "value");
		expect(values.map((doc) => ({ fieldPath: doc.fieldPath, stringValue: doc.stringValue }))).toEqual(
			path.endsWith(".md")
				? [
						{ fieldPath: "metadata.status", stringValue: "captured" },
						{ fieldPath: "frontmatter.status", stringValue: "proposed" },
					]
				: [{ fieldPath: "metadata.status", stringValue: "captured" }],
		);
		for (const doc of docs)
			expect(doc).toMatchObject({
				sourceKind: "pending",
				target: draft.target,
				pendingUpdateId: draft.pendingUpdateId,
				proposalRevision: draft.proposal.revision,
			});
	});

	test("keeps another member out and allows the owner to discard after losing read access", async () => {
		const draft = await create_private_text_for_test({ unstaged: "private content\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const other = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_private_other" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId,
				active: true,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			await asOther.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: other.membershipId,
				target,
			}),
		).toBeNull();
		expect(
			await asOther.query(api.files_pending_updates.list_files_pending_updates, {
				membershipId: other.membershipId,
				paginationOpts: { numItems: 5, cursor: null },
			}),
		).toMatchObject({ page: [], isDone: true });
		expect(
			(
				await asOther.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: other.membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay?.name,
		).toBe("not_found");
		await t.run(async (ctx) => {
			await ctx.db.patch("organizations", draft.organizationId, { ownerUserId: other.userId });
		});
		expect(await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target })).toBeNull();
		expect(
			await asUser.query(api.files_visible.list, {
				membershipId,
				folderPath: "/",
				mode: "children",
				numItems: 5,
				cursor: null,
			}),
		).toMatchObject({ _yay: { items: [] } });
		expect(
			(
				await asUser.query(api.files_pending_updates.list_files_pending_updates, {
					membershipId,
					paginationOpts: { numItems: 5, cursor: null },
				})
			).page,
		).toEqual([{ kind: "restricted", target, pendingUpdateId, revision: proposal.revision }]);
		expect(
			(
				await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({
			state: "discarded",
			creationGeneration: 2,
		});
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test.each(["../outside.txt", "a/b.txt", ""])("refuses the invalid draft name %s", async (destName) => {
		const draft = await create_private_text_for_test();
		const before = await read_pending_review_state_for_test(draft.t);
		const moved = await draft.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target: draft.target,
			destParent: { kind: "root" },
			destName,
		});
		expect(moved._nay).toBeDefined();
		expect(await read_pending_review_state_for_test(draft.t)).toEqual(before);
		expect(
			await draft.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: draft.membershipId,
				target: draft.target,
			}),
		).toMatchObject({ entry: { path: "/draft.txt" } });
	});

	test("lists a preparing draft and refuses ordinary content work", async () => {
		const draft = await create_private_text_for_test({ preparing: true });
		const { t, asUser, membershipId, target, pendingUpdateId } = draft;
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({
			entry: { kind: "private", path: "/draft.txt", pendingUpdate: { _id: pendingUpdateId } },
			readiness: "preparing",
			canAccept: false,
		});
		expect(
			await asUser.query(api.files_visible.list, {
				membershipId,
				folderPath: "/",
				mode: "children",
				numItems: 5,
				cursor: null,
			}),
		).toMatchObject({ _yay: { items: [{ target: { kind: "private" }, path: "/draft.txt", preparing: true }] } });
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId,
			target,
		});
		expect(batch._nay).toBeDefined();
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target,
			destParent: { kind: "root" },
			destName: "other.txt",
		});
		expect(moved._nay?.name).toBe("preparing");
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: draft.proposal.revision,
		});
		expect(saved._nay?.message).toContain("preparing");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_yjs_states").collect())).toEqual([]);
	});

	test.each([
		{ path: "/empty.txt", collaborative: true },
		{ path: "/empty.txt", collaborative: false },
		{ path: "/empty.md", collaborative: true },
		{ path: "/empty.md", collaborative: false },
	])("publishes a sealed empty $path draft with collaboration $collaborative", async ({ path, collaborative }) => {
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = await create_private_text_for_test({
			path,
			collaborative,
		});
		expect(proposal.content?.base).toEqual({ kind: "new" });
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		expect(saved._yay.target.kind).toBe("saved");
		const savedTarget = saved._yay.target;
		if (savedTarget.kind !== "saved") throw new Error("Expected a saved target");
		const node = await t.run((ctx) => ctx.db.get("files_nodes", savedTarget.id));
		expect(node).toMatchObject({ path, collaborationEnabled: collaborative });
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toBeNull();

		// The old private target still resolves after Save. It now points at the saved file, which
		// remembers the private node it came from, so old links keep working.
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({
			entry: { kind: "saved", node: { _id: node!._id, publishedFromPrivateNodeId: target.id }, pendingUpdate: null },
		});
		expect(await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toMatchObject([
			{ privateNodeId: target.id, savedNodeId: node!._id },
		]);
		const nodeHold = await t.run((ctx) =>
			ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "node").eq("resource.id", target.id))
				.first(),
		);
		expect(nodeHold?.settlement).toMatchObject({ kind: "saved", savedNodeId: node!._id });
	});

	test("keeps the same proposal and exact remaining states after its first partial Save", async () => {
		const draft = await create_private_text_for_test({ staged: "accepted\n", unstaged: "proposed\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const before = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: proposal }));
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		if (saved._yay.target.kind !== "saved") throw new Error("Expected the published target");
		const savedTarget = saved._yay.target;
		const remaining = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!remaining) throw new Error("Expected the same remaining proposal");
		expect(remaining).toMatchObject({
			_id: pendingUpdateId,
			target: savedTarget,
			revision: proposal.revision + 1,
			content: { base: { kind: "yjs", sequence: 0, lineageGeneration: 0 } },
		});
		expect(remaining.createIntent).toBeUndefined();
		const after = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: remaining }));
		expect(after.baseBytes).toEqual(before.stagedBytes);
		expect(after.stagedBytes).toEqual(before.stagedBytes);
		expect(after.unstagedBytes).toEqual(before.unstagedBytes);
		expect(
			await t.run((ctx) =>
				read_file_markdown_from_yjs({
					ctx,
					organizationId: draft.organizationId,
					workspaceId: draft.workspaceId,
					nodeId: savedTarget.id,
					rootKind: "plain_text",
				}),
			),
		).toBe("accepted\n");
		const stale = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		expect(stale._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toEqual(remaining);
	});

	test("allows Save but refuses more draft bytes when private storage is full", async () => {
		const draft = await create_private_text_for_test({ staged: "accepted\n", unstaged: "remaining\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		await t.run(async (ctx) => {
			for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
				const id = await quotas_db_ensure(ctx, {
					organizationId: draft.organizationId,
					workspaceId: draft.workspaceId,
					userId: draft.userId,
					quotaName,
					now: Date.now(),
				});
				await ctx.db.patch("quotas", id, { maxCount: 0 });
			}
		});
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId,
			target,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const added = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "more bytes",
		});
		expect(added._nay?.name).toBe("storage_full");
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: batch._yay.operationBatchId,
		});
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		expect(saved._yay.target.kind).toBe("saved");
	});

	test("refuses an old review after the owner renames the draft", async () => {
		const draft = await create_private_text_for_test({ staged: "text\n" });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: draft.organizationId,
			workspaceId: draft.workspaceId,
			userId: draft.userId,
			target,
			destParent: { kind: "root" },
			destName: "renamed.txt",
		});
		expect(moved._nay).toBeUndefined();
		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId,
			target,
			pendingUpdateId,
			reviewedRevision: proposal.revision,
		});
		expect(saved._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({ entry: { path: "/renamed.txt" } });
	});
});

describe("pending Copy disclosure", () => {
	test("text copied over a saved file keeps destination sharing", async () => {
		const t = test_convex();
		const source = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/source.md", name: "source.md", markdown: "# Source" }),
		);
		const destination = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/destination.md",
				name: "destination.md",
				markdown: "# Destination",
				membership: source,
			}),
		);
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			...destination,
			unstagedMarkdown: "# Source",
			copiedFrom: { nodeId: source.nodeId, path: "/source.md" },
		});
		if (proposed._nay) throw new Error(proposed._nay.message);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: source.userId });
		const args = { membershipId: source.membershipId, target: { kind: "saved" as const, id: destination.nodeId } };
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, args);
		expect(view?.entry.pendingUpdate?.content).toBeDefined();
		expect(view?.entry.pendingUpdate?.pendingReplacement).toBeUndefined();
		expect(view?.copyDestination).toEqual({ personal: false, replacement: true, folderPath: "/" });
	});
});

describe.each(["saved", "private"] as const)("%s Copy action replies", (kind) => {
	test.each(["prepare", "upsert", "upsert-refresh", "rebase", "rebase-refresh"] as const)(
		"omits source proof from %s and keeps the exact stored proposal",
		async (operation) => {
			const t = test_convex();
			const source = await t.run((ctx) =>
				seed_file_with_markdown({ ctx, path: "/source.md", name: "source.md", markdown: "# Source" }),
			);
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: source.userId });
			const scope = { organizationId: source.organizationId, workspaceId: source.workspaceId, userId: source.userId };
			let target: Doc<"files_pending_updates">["target"];
			if (kind === "private") {
				const threadId = await t.run((ctx) => seed_chat_thread({ ctx, ...scope }));
				const started = await t.mutation(internal.files_transfer.start_for_agent, {
					membershipId: source.membershipId,
					threadId,
					requestId: "action-redaction",
					sourceWorkspace: "current",
					destinationWorkspace: "current",
					kind: "copy",
					expectedSourceCount: 1,
					sources: [{ kind: "saved", id: source.nodeId }],
					targetParent: { kind: "root" },
					targetPath: "/",
					targetName: "destination.md",
					missingParentNames: [],
					conflictPolicy: { file: "error", folder: "error" },
				});
				if (started._nay) throw new Error(started._nay.message);
				const runId = started._yay.runId;
				expect(
					await t.mutation(internal.files_transfer.seal_for_agent, {
						membershipId: source.membershipId,
						threadId,
						runId,
					}),
				).toEqual({ _yay: null });
				for (let step = 0; step < 30; step++) {
					await t.mutation(internal.files_transfer.advance, { runId });
					const item = await t.run((ctx) =>
						ctx.db
							.query("files_transfer_items")
							.withIndex("by_run_order", (q) => q.eq("runId", runId))
							.first(),
					);
					if (item?.workId && item.state === "copying") {
						await t.action(internal.files_nodes_content.copy_transfer_file, {
							itemId: item._id,
							attempt: item.attempt,
						});
						await t.mutation(internal.files_transfer.handle_copy_complete, {
							workId: item.workId,
							context: { itemId: item._id, attempt: item.attempt },
							result: { kind: "success", returnValue: null },
						});
					}
					const run = await asUser.query(api.files_transfer.get, { membershipId: source.membershipId, runId });
					if (run?.activity.status === "succeeded") break;
				}
				const item = await t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_order", (q) => q.eq("runId", runId))
						.first(),
				);
				if (item?.state !== "completed" || item.outputTarget?.kind !== "private")
					throw new Error("Expected a copied private file");
				target = item.outputTarget;
			} else {
				const destination = await t.run((ctx) =>
					seed_file_with_markdown({
						ctx,
						path: "/destination.md",
						name: "destination.md",
						markdown: "# Destination",
						membership: source,
					}),
				);
				target = { kind: "saved", id: destination.nodeId };
				const copied = await upsert_file_pending_update_internal_for_test({
					t,
					...destination,
					unstagedMarkdown: "# Source",
					copiedFrom: { nodeId: source.nodeId, path: "/source.md" },
				});
				if (copied._nay) throw new Error(copied._nay.message);
			}
			const args = { membershipId: source.membershipId, target };
			const visible = await asUser.query(api.files_pending_updates.get_file_pending_update, args);
			if (!visible?.content) throw new Error("Expected copied text");
			expect(visible.copiedFrom?.path).toBe("/source.md");
			const before = await t.run((ctx) => ctx.db.get("files_pending_updates", visible._id));
			if (!before?.content) throw new Error("Expected the stored Copy");
			expect(
				await asUser.mutation(api.files_nodes.rename_node, {
					membershipId: source.membershipId,
					nodeId: source.nodeId,
					path: "renamed.md",
				}),
			).toEqual({ _yay: null });
			let returned: Doc<"files_pending_updates"> | null;
			if (operation === "prepare") {
				const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
					...args,
					pendingUpdateId: before._id,
				});
				if (result._nay) throw new Error(result._nay.message);
				returned = result._yay.pendingUpdate;
			} else {
				const writing = await asUser.mutation(
					api.files_pending_updates.create_file_pending_update_operation_batch,
					args,
				);
				if (writing._nay) throw new Error(writing._nay.message);
				const operationBatchId = writing._yay.operationBatchId;
				if (operation === "upsert" || operation === "upsert-refresh") {
					expect(
						await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
							membershipId: source.membershipId,
							operationBatchId,
							role: "unstaged",
							text: operation === "upsert" ? "# Source\n\nReview edit" : "# Source",
						}),
					).toEqual({ _yay: null });
					const result = await asUser.action(api.files_pending_updates.upsert_file_pending_update, {
						...args,
						operationBatchId,
						pendingUpdateId: before._id,
						reviewedRevision: before.revision,
					});
					if (result._nay) throw new Error(result._nay.message);
					returned = result._yay.pendingUpdate;
				} else {
					const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: before }));
					if (operation === "rebase") {
						const branch = files_yjs_doc_create_from_array_buffer_update(bytes.unstagedBytes);
						expect(
							files_yjs_doc_update_from_text({
								rootKind: "rich_text",
								mut_yjsDoc: branch,
								text: "# Source\n\nReview edit",
							})._nay,
						).toBeUndefined();
						bytes.unstagedBytes = files_u8_to_array_buffer(encodeStateAsUpdate(branch));
						branch.destroy();
					}
					for (const [role, update] of [
						["base", bytes.baseBytes],
						["staged", bytes.stagedBytes],
						["unstaged", bytes.unstagedBytes],
					] as const) {
						expect(
							(
								await asUser.mutation(api.files_pending_updates.stage_file_pending_update_state_page, {
									membershipId: source.membershipId,
									operationBatchId,
									role,
									pageIndex: 0,
									bytes: update,
								})
							)._nay,
						).toBeUndefined();
						expect(
							(
								await asUser.mutation(api.files_pending_updates.seal_file_pending_update_state, {
									membershipId: source.membershipId,
									operationBatchId,
									role,
									expectedTotalBytes: update.byteLength,
								})
							)._nay,
						).toBeUndefined();
					}
					const result = await asUser.action(api.files_pending_updates.persist_file_pending_update_rebased_state, {
						...args,
						operationBatchId,
						pendingUpdateId: before._id,
						reviewedRevision: before.revision,
						baseYjsSequence: before.content.base.kind === "yjs" ? before.content.base.sequence : 0,
					});
					if (result._nay) throw new Error(result._nay.message);
					returned = result._yay.pendingUpdate;
				}
			}
			const stored = await t.run((ctx) => ctx.db.get("files_pending_updates", before._id));
			expect(stored?.copiedFrom).toEqual(before.copiedFrom);
			expect(returned?._id).toBe(before._id);
			expect(returned?.copiedFrom).toBeUndefined();
			expect(returned).toEqual({ ...stored, copiedFrom: undefined });
			if (operation === "upsert" || operation === "rebase") {
				const text = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: stored! }));
				expect(text.unstagedMarkdown).toContain("Review edit");
			}
		},
	);
});

describe("copied-parent text Save", () => {
	test.each(["plain", "rich_text", "asset"] as const)("publishes %s through Save-only preparation", async (kind) => {
		const f = await create_private_text_for_test();
		const scope = { organizationId: f.organizationId, workspaceId: f.workspaceId, userId: f.userId };
		const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/source" });
		if (source._nay) throw new Error(source._nay.message);
		await set_pending_test_read_only(f.asUser, f.membershipId, source._yay.nodeId);
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.membershipId,
			clientGeneratedId: "copied-parent-text",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.membershipId,
			threadId: thread._yay.threadId,
			requestId: "copied-parent-text",
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [{ kind: "saved", id: source._yay.nodeId }],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "copied",
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 20; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			if ((await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId)))?.status === "succeeded") break;
		}
		expect(await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId))).toMatchObject({
			status: "succeeded",
		});
		const child = await create_private_text_for_test(
			{
				path: kind === "plain" ? "/copied/child.txt" : "/copied/child.md",
				staged: "Saved child",
				collaborative: kind !== "asset",
			},
			{ t: f.t, membershipId: f.membershipId },
		);
		const parent = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_nodes")
				.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
					q
						.eq("organizationId", f.organizationId)
						.eq("workspaceId", f.workspaceId)
						.eq("userId", f.userId)
						.eq("parent.kind", "root")
						.eq("parent.id", undefined)
						.eq("state", "active")
						.eq("name", "copied"),
				)
				.unique(),
		);
		if (!parent) throw new Error("Expected the copied parent");
		const proposal = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", parent._id))
				.unique(),
		);
		if (!proposal) throw new Error("Expected the parent proposal");
		expect(
			(
				await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId: f.membershipId,
					target: proposal.target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.membershipId,
				target: child.target,
			}),
		).toMatchObject({ canEdit: false, canAccept: true });
		expect(
			(
				await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
					membershipId: f.membershipId,
					target: child.target,
				})
			)._nay,
		).toBeDefined();
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.membershipId,
			target: child.target,
			pendingUpdateId: child.pendingUpdateId,
			reviewedRevision: child.proposal.revision,
		});
		expect(saved._nay).toBeUndefined();
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved child");
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", saved._yay.target.id as Id<"files_nodes">))).toMatchObject({
			path: child.path,
			collaborationEnabled: kind !== "asset",
			textKind: kind === "plain" ? "plain_text" : "rich_text",
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child.pendingUpdateId))).toBeNull();
	});
});

describe("prepared Save media proof", () => {
	test("an asset Save with nothing staged validates media without changing the proposal or file", async () => {
		vi.useFakeTimers();
		const f = await create_private_text_for_test({ path: "/noop-proof.md", staged: "# Before", collaborative: false });
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.membershipId,
			target: f.target,
			pendingUpdateId: f.proposal._id,
			reviewedRevision: f.proposal.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved file");
		const target = saved._yay.target;
		const edited = await upsert_file_pending_update_public_for_test(f.asUser, {
			membershipId: f.membershipId,
			nodeId: target.id,
			stagedMarkdown: "# Before",
			unstagedMarkdown: "# After",
		});
		if (edited._nay || !edited._yay.pendingUpdate) throw new Error("Expected the pending edit");
		const proposal = edited._yay.pendingUpdate;
		await f.t.run(async (ctx) => {
			const created = await files_media_dependencies_db_create(ctx, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.userId,
				owner: { kind: "proposal", pendingUpdateId: proposal._id },
				expectedCount: 0,
			});
			if (created._nay) throw new Error(created._nay.message);
			expect(await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 })).toEqual({
				_yay: null,
			});
			await files_db_patch_pending_update(ctx, proposal._id, { mediaDependencySetId: created._yay });
		});
		const before = await f.t.run(async (ctx) => ({
			proposal: await ctx.db.get("files_pending_updates", proposal._id),
			file: await ctx.db.get("files_nodes", target.id),
		}));
		const savesBefore = file_save_events().length;
		expect(
			(
				await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId: f.membershipId,
					target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.t.run(async (ctx) => ({
				proposal: await ctx.db.get("files_pending_updates", proposal._id),
				file: await ctx.db.get("files_nodes", target.id),
			})),
		).toEqual(before);
		expect(file_save_events()).toHaveLength(savesBefore);
		const inputs = await f.t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect());
		expect(inputs.some((input) => input.mediaValidation?.pendingUpdateId === proposal._id)).toBe(true);
	});

	test.each(["save", "discard", "expiry"] as const)("%s retires the proposal's media set", async (operation) => {
		vi.useFakeTimers();
		const f = await create_private_text_for_test({ path: "/retire.md", staged: "# Retained" });
		const setId = await f.t.run(async (ctx) => {
			const created = await files_media_dependencies_db_create(ctx, {
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.userId,
				owner: { kind: "proposal", pendingUpdateId: f.proposal._id },
				expectedCount: 0,
			});
			if (created._nay) throw new Error(created._nay.message);
			expect(await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 })).toEqual({
				_yay: null,
			});
			await files_db_patch_pending_update(ctx, f.proposal._id, { mediaDependencySetId: created._yay });
			return created._yay;
		});
		const args = {
			membershipId: f.membershipId,
			target: f.target,
			pendingUpdateId: f.proposal._id,
			reviewedRevision: f.proposal.revision,
		};
		if (operation === "save") {
			expect((await f.asUser.action(api.files_pending_updates.save_file_pending_update, args))._nay).toBeUndefined();
		} else if (operation === "discard") {
			expect(await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, args)).toEqual({
				_yay: null,
			});
		} else {
			await expire_pending_update_for_test(f.t, f.proposal._id);
		}
		if (operation !== "save") {
			const cleanup = await f.t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").first());
			if (!cleanup) throw new Error("Expected the private cleanup task");
			await f.t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { privateNodeId: cleanup.privateNodeId });
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.proposal._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "cleanup" },
			generation: 1,
		});
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
	});

	test.each(["private", "saved_yjs", "saved_asset"] as const)(
		"%s refuses a missing proof before publishing",
		async (kind) => {
			const f = await create_private_text_for_test({
				path: "/proof.md",
				staged: "# Before",
				collaborative: kind !== "saved_asset",
			});
			let target: Doc<"files_pending_updates">["target"] = f.target;
			let proposal = f.proposal;
			if (kind !== "private") {
				const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId: f.membershipId,
					target,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected the saved file");
				target = saved._yay.target;
				const edited = await upsert_file_pending_update_public_for_test(f.asUser, {
					membershipId: f.membershipId,
					nodeId: target.id,
					stagedMarkdown: "# After",
					unstagedMarkdown: "# After",
				});
				if (edited._nay || !edited._yay.pendingUpdate) throw new Error("Expected the pending edit");
				proposal = edited._yay.pendingUpdate;
			}
			// The Copy producer owns this empty set. Use its helpers, not raw set docs.
			await f.t.run(async (ctx) => {
				const created = await files_media_dependencies_db_create(ctx, {
					organizationId: f.organizationId,
					workspaceId: f.workspaceId,
					userId: f.userId,
					owner: { kind: "proposal", pendingUpdateId: proposal._id },
					expectedCount: 0,
				});
				if (created._nay) throw new Error(created._nay.message);
				expect(await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 })).toEqual({
					_yay: null,
				});
				await files_db_patch_pending_update(ctx, proposal._id, { mediaDependencySetId: created._yay });
			});
			const args = {
				membershipId: f.membershipId,
				target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			};
			const prepared = await f.t.action((ctx) =>
				files_pending_updates_action_prepare_content(ctx, {
					...args,
					userId: f.userId,
					reviewedPrivateParentIds: [],
				}),
			);
			if (prepared._nay) throw new Error(prepared._nay.message);
			const before = await f.t.run(async (ctx) => ({
				proposal: await ctx.db.get("files_pending_updates", proposal._id),
				nodes: await ctx.db.query("files_nodes").collect(),
			}));
			const refused = await f.t.mutation(internal.files_pending_updates.commit_prepared_content, {
				userId: f.userId,
				prepared: prepared._yay,
			});
			expect(refused).toMatchObject({ _nay: { name: "media_validation_changed" } });
			expect(
				await f.t.run(async (ctx) => ({
					proposal: await ctx.db.get("files_pending_updates", proposal._id),
					nodes: await ctx.db.query("files_nodes").collect(),
				})),
			).toEqual(before);
			await f.t.mutation(internal.files_pending_updates.retire_prepared_content, { prepared: prepared._yay });
			const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, args);
			expect(saved._nay).toBeUndefined();
			expect(saved._yay?.target.kind).toBe("saved");
		},
	);
});

describe("archived-parent draft recovery", () => {
	async function fixture(nested = false) {
		vi.useFakeTimers();
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: true, retryAfter: 0 });
		const t = test_convex();
		const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const home = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
		expect(
			await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userIdToAdd: home.userId,
			}),
		).toEqual({ _yay: null });
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
				)
				.first(),
		);
		if (!membership) throw new Error("Expected the draft owner's membership");
		const folder = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: owner.membershipId,
			parentId: files_ROOT_ID,
			path: "retained",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const draft = await create_private_text_for_test(
			{
				path: nested ? "/retained/outer/inner/draft.txt" : "/retained/draft.txt",
				staged: "accepted text\n",
				unstaged: "proposed text\n",
			},
			{ t, membershipId: membership._id },
		);
		expect(
			await asOwner.mutation(api.files_nodes.archive_nodes, {
				membershipId: owner.membershipId,
				nodeIds: [folder._yay.nodeId],
			}),
		).toEqual({ _yay: null });
		return { ...draft, owner, asOwner, parentId: folder._yay.nodeId };
	}

	test.each([false, true])("reads retained branches without reopening paths or Save (nested %s)", async (nested) => {
		const f = await fixture(nested);
		const { asUser, membershipId, target, proposal, pendingUpdateId } = f;
		const before = await read_pending_review_state_for_test(f.t);
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target });
		expect(view).toMatchObject({
			entry: { path: f.path, pendingUpdate: { _id: pendingUpdateId } },
			readiness: "ready",
			canEdit: false,
			canAccept: false,
			canAcceptWithParents: false,
			recovery: { savedParentId: f.parentId, expiresAt: expect.any(Number) },
		});
		const page = await asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId,
			paginationOpts: { cursor: null, numItems: 5 },
		});
		expect(page.page).toContainEqual(
			expect.objectContaining({
				kind: "entry",
				recovery: expect.objectContaining({ savedParentId: f.parentId }),
			}),
		);
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_update, { membershipId, target }),
		).toMatchObject({ _id: pendingUpdateId, content: proposal.content });
		for (const [stateId, text] of [
			[proposal.content!.stagedStateId, "accepted text\n"],
			[proposal.content!.unstagedStateId, "proposed text\n"],
		] as const) {
			const state = await asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
				membershipId,
				target,
				stateId,
				pageIndex: 0,
			});
			expect(state).not.toBeNull();
			const decoded = files_yjs_doc_create_from_array_buffer_update(state!.bytes);
			expect(files_yjs_doc_get_text({ yjsDoc: decoded, rootKind: "plain_text" })._yay).toBe(text);
			decoded.destroy();
		}
		expect(await asUser.query(api.files_nodes.get_visible_target_by_path, { membershipId, path: f.path })).toBeNull();
		expect(
			(
				await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId,
					target,
					pendingUpdateId,
					reviewedRevision: proposal.revision,
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
					membershipId,
					target,
				})
			)._nay,
		).toBeDefined();
		expect(await read_pending_review_state_for_test(f.t)).toEqual(before);
		expect(
			await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
				membershipId: f.owner.membershipId,
				nodeIds: [f.parentId],
			}),
		).toEqual({ _yay: null });
		expect(
			await asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({ canEdit: true, canAcceptWithParents: true });
	});

	test("downloads captured bytes under an archived parent without changing its asset or expiry", async () => {
		const f = await fixture();
		await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: f.owner.membershipId,
			nodeIds: [f.parentId],
		});
		const scope = {
			organizationId: f.organizationId,
			workspaceId: f.workspaceId,
			userId: f.userId,
			membershipId: f.membershipId,
		};
		const prepared = await f.t.mutation(internal.files_ingestion.prepare_file, {
			...scope,
			requestId: "recovery-bytes",
			attemptId: "one",
			path: "/retained/capture.bin",
			size: 4,
			contentType: "application/octet-stream",
			digest: "a".repeat(64),
			content: { kind: "stored" },
		});
		if (prepared._nay || prepared._yay.kind !== "stored") throw new Error("Expected stored preparation");
		const capture = prepared._yay;
		r2Objects.set(capture.r2Key, "bits");
		const completed = await f.t.mutation(internal.files_ingestion.finalize_file, {
			...scope,
			receiptId: capture.receiptId,
			attemptId: "one",
		});
		if (completed._nay || completed._yay.target.kind !== "private") throw new Error("Expected private capture");
		const target = completed._yay.target;
		await f.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.owner.membershipId,
			nodeIds: [f.parentId],
		});
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.membershipId,
			target,
		});
		if (view?.entry.kind !== "private") throw new Error("Expected recovery view");
		expect(view.recovery).toMatchObject({ savedParentId: f.parentId, expiresAt: expect.any(Number) });
		const args = {
			membershipId: f.membershipId,
			target,
			pendingUpdateId: view.entry.pendingUpdate._id,
			reviewedRevision: view.entry.pendingUpdate.revision,
			creationGeneration: view.entry.node.creationGeneration,
		};
		const before = await read_pending_review_state_for_test(f.t);
		const assetBefore = await f.t.run((ctx) => ctx.db.get("files_r2_assets", capture.assetId));
		const download = await f.asUser.action(api.files_pending_updates.create_private_pending_download_url, args);
		if (download._nay) throw new Error(download._nay.message);
		expect(await (await fetch(download._yay.url)).text()).toBe("bits");
		expect(await read_pending_review_state_for_test(f.t)).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", capture.assetId))).toEqual(assetBefore);
		expect(
			(
				await f.asOwner.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					membershipId: f.owner.membershipId,
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await f.asUser.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					reviewedRevision: args.reviewedRevision + 1,
				})
			)._nay,
		).toBeDefined();
		await f.asUser.mutation(api.organizations.remove_user_from_organization, {
			organizationId: f.organizationId,
			userIdToRemove: f.userId,
		});
		const denied = await f.asUser.action(api.files_pending_updates.create_private_pending_download_url, args);
		expect(denied._nay).toBeDefined();
		expect(JSON.stringify(denied)).not.toContain("retained");
		expect(JSON.stringify(denied)).not.toContain(capture.r2Key);
	});

	test("recovery reads keep the real expiry and cannot revive an expired draft", async () => {
		const f = await fixture();
		const args = { membershipId: f.membershipId, target: f.target };
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, args);
		if (!view?.recovery) throw new Error("Expected the recovery view");
		const draft = await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.pendingUpdateId));
		// Without a heartbeat, the recovery view shows the draft's own expiry.
		expect(view.recovery.expiresAt).toBe(draft?.expiresAt);
		const parentBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", f.parentId));

		// An open app tab keeps the draft 4 hours past the last heartbeat, and the view shows that time.
		vi.setSystemTime(view.recovery.expiresAt - 1);
		await f.asUser.mutation(api.presence.heartbeat, {
			roomId: `recovery-room-${f.pendingUpdateId}`,
			userId: f.userId,
			sessionId: "recovery-session",
			interval: presenceHeartbeatIntervalMs,
		});
		const expiry = Date.now() + files_DRAFT_IDLE_EXPIRY_MS;
		expect((await f.asUser.query(api.files_pending_updates.get_file_pending_target, args))?.recovery?.expiresAt).toBe(
			expiry,
		);
		vi.setSystemTime(expiry - 1);
		expect((await f.asUser.query(api.files_pending_updates.get_file_pending_target, args))?.recovery?.expiresAt).toBe(
			expiry,
		);
		vi.setSystemTime(expiry + 1);
		await f.t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: f.organizationId,
			workspaceId: f.workspaceId,
			userId: f.userId,
		});
		expect(await f.asUser.query(api.files_pending_updates.get_file_pending_target, args)).toBeNull();
		expect(await f.asUser.query(api.files_pending_updates.get_file_pending_update, args)).toBeNull();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
				...args,
				stateId: f.proposal.content!.unstagedStateId,
				pageIndex: 0,
			}),
		).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.parentId))).toEqual(parentBefore);
	});

	test("keeps recovery owner-only and denies revoked ancestor access or membership", async () => {
		const f = await fixture();
		const { membershipId, target } = f;
		expect(
			await f.asOwner.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.owner.membershipId,
				target,
			}),
		).toBeNull();
		// Restrict while active through the normal sharing door, then archive again.
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.unarchive_nodes, {
					membershipId: f.owner.membershipId,
					nodeIds: [f.parentId],
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.owner.membershipId,
					nodeId: f.parentId,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.archive_nodes, {
					membershipId: f.owner.membershipId,
					nodeIds: [f.parentId],
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toBeNull();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
				membershipId,
				target,
				stateId: f.proposal.content!.unstagedStateId,
				pageIndex: 0,
			}),
		).toBeNull();
		const rows = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId,
			paginationOpts: { cursor: null, numItems: 5 },
		});
		expect(rows.page).toMatchObject([{ kind: "restricted", target }]);
		expect(JSON.stringify(rows)).not.toContain("retained");
		expect(
			await f.asOwner.mutation(api.files_sharing.unrestrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.parentId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toMatchObject({ recovery: { savedParentId: f.parentId }, canAccept: false });
		expect(
			(
				await f.asUser.mutation(api.organizations.remove_user_from_organization, {
					organizationId: f.organizationId,
					userIdToRemove: f.userId,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, { membershipId, target }),
		).toBeNull();
	});
});

describe("private pending downloads", () => {
	test("signs only the owner's current ready capture and refuses stale or retired captures", async () => {
		const draft = await create_private_text_for_test({ path: "/capture.png", preparing: true });
		const { t, asUser, membershipId, target, pendingUpdateId, proposal } = draft;
		const args = { membershipId, target, pendingUpdateId, reviewedRevision: proposal.revision, creationGeneration: 1 };
		expect(
			(await asUser.action(api.files_pending_updates.create_private_pending_download_url, args))._nay?.message,
		).toContain("preparing");
		const assetId = await t.run(async (ctx) => {
			// Leave `unfinalizedExpiresAt` unset. The download door signs an asset only after its
			// upload has finished.
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: draft.organizationId,
				workspaceId: draft.workspaceId,
				createdBy: draft.userId,
				kind: "upload",
				r2Bucket: "test-bucket",
				r2Key: "private/capture.png",
				size: 8,
				updatedAt: Date.now(),
			});
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						organizationId: draft.organizationId,
						workspaceId: draft.workspaceId,
						userId: draft.userId,
						resource: { kind: "asset", id: assetId, r2Key: "private/capture.png" },
						byteCount: 8,
					})
				)._nay,
			).toBeUndefined();
			await ctx.db.patch("files_pending_updates", pendingUpdateId, {
				createIntent: { kind: "stored", assetId, size: 8, contentType: "image/png", metadata: [] },
			});
			return assetId;
		});
		expect(
			(await asUser.action(api.files_pending_updates.create_private_pending_download_url, args))._yay?.url,
		).toContain(encodeURIComponent("private/capture.png"));
		expect(
			(
				await asUser.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					reviewedRevision: args.reviewedRevision + 1,
				})
			)._nay?.name,
		).toBe("target_changed");
		expect(
			(
				await asUser.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					creationGeneration: 2,
				})
			)._nay?.name,
		).toBe("target_changed");
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-downloads" }),
		);
		const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
		expect(
			(
				await asOther.action(api.files_pending_updates.create_private_pending_download_url, {
					...args,
					membershipId: other.membershipId,
				})
			)._nay,
		).toBeDefined();
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", assetId, { uploadRetiredAt: Date.now() });
		});
		expect(
			(await asUser.action(api.files_pending_updates.create_private_pending_download_url, args))._nay?.message,
		).toContain("no longer available");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});
});

describe("saved proposal publication headroom", () => {
	test.each([false, true])(
		"saves a partial proposal at the private storage cap with collaboration %s",
		async (collaborative) => {
			const t = test_convex();
			const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/full-storage.txt", "base\n"));
			r2Objects.set("content-snapshot/full-storage.txt", "base\n");
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Owner" });
			if (collaborative)
				expect(
					(
						await asUser.action(api.files_nodes_content.set_file_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
						})
					)._nay,
				).toBeUndefined();
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...seeded,
						stagedMarkdown: "accepted\n",
						unstagedMarkdown: "remaining\n",
					})
				)._nay,
			).toBeUndefined();
			const proposal = await read_seeded_pending_row(t, seeded);
			await t.run(async (ctx) => {
				for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
					const id = await quotas_db_ensure(ctx, { ...seeded, quotaName, now: Date.now() });
					await ctx.db.patch("quotas", id, { maxCount: 0 });
				}
			});
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			if (saved._nay) throw new Error(saved._nay.message);
			expect(saved._yay.target).toEqual({ kind: "saved", id: seeded.nodeId });
			const remaining = await read_seeded_pending_row(t, seeded);
			expect(
				await t.run((ctx) =>
					read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind: "plain_text" }),
				),
			).toEqual({
				baseMarkdown: "accepted\n",
				stagedMarkdown: "accepted\n",
				unstagedMarkdown: "remaining\n",
			});
			const reservations = await t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
			expect(
				reservations.filter((hold) => hold.resource.kind === (collaborative ? "trusted_stage" : "asset")),
			).toMatchObject([{ settlement: { kind: collaborative ? "deleted" : "saved" } }]);
		},
	);
});

async function accept_as_member(
	t: ReturnType<typeof test_convex>,
	seeded: Awaited<ReturnType<typeof seed_non_collaborative_file>>,
	pendingUpdateId: Id<"files_pending_updates">,
) {
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});
	return await asUser.action(api.ai_chat.save_file_pending_update, {
		membershipId: seeded.membershipId,
		target: { kind: "saved", id: seeded.nodeId },
		...(await reviewed_pending_for_test(t, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: pendingUpdateId,
		})),
		pendingUpdateId,
	});
}

async function read_seeded_pending_row(
	t: ReturnType<typeof test_convex>,
	seeded: Awaited<ReturnType<typeof seed_non_collaborative_file>>,
) {
	const row = await t.run((ctx) =>
		read_pending_update_row({
			ctx,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		}),
	);
	if (!row) {
		throw new Error("Expected a pending content doc");
	}
	return row;
}

function file_save_events() {
	// Function references are fresh proxy objects on every access, so compare names.
	return enqueueActionSpy.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events");
}

describe("upsert_file_pending_update", () => {
	test.each(["refresh", "settle"] as const)("does not acknowledge a newer proposal from a stale %s", async (phase) => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/stale-ack.txt", "base\n"));
		expect(
			(await upsert_file_pending_update_internal_for_test({ t, ...seeded, unstagedMarkdown: "newer proposal\n" }))._nay,
		).toBeUndefined();

		const pendingUpdate = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!pendingUpdate) throw new Error("Expected the newer proposal");
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const args = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingUpdate._id,
			expectedRevision: pendingUpdate.revision - 1,
		};

		const result =
			phase === "refresh"
				? await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, args)
				: await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, args);

		expect(result._nay?.message).toBe("Pending update changed, retry the write");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdate._id))).toEqual(pendingUpdate);
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", args.operationBatchId)))?.expiresAt,
		).toBe(0);
	});

	test.each(["plain_text", "rich_text"] as const)(
		"acknowledges the exact committed %s proposal on every success path",
		async (rootKind) => {
			for (const collaborative of [false, true]) {
				const t = test_convex();
				const path = rootKind === "rich_text" ? "/ack.md" : "/ack.txt";
				const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, path, "base\n"));
				r2Objects.set(`content-snapshot${path}`, "base\n");
				const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
				if (collaborative) {
					expect(
						(
							await asUser.action(api.files_nodes_content.set_file_collaborative, {
								membershipId: seeded.membershipId,
								nodeId: seeded.nodeId,
							})
						)._nay,
					).toBeUndefined();
				}
				const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
				const currentYjsLastSequenceId = node?.yjsLastSequenceId ?? null;
				const empty = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					unstagedMarkdown: "base\n",
				});
				expect(empty).toEqual({ _yay: { pendingUpdate: null, currentYjsLastSequenceId } });

				const created = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					unstagedMarkdown: "first\n",
				});
				const first = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				if (!first?.content) throw new Error("Expected the first committed proposal");
				expect(created).toEqual({ _yay: { pendingUpdate: first, currentYjsLastSequenceId } });
				const firstBytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: first }));
				const refreshed = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: first._id,
					reviewedRevision: first.revision,
					unstagedMarkdown: "first\n",
				});
				const refreshedDoc = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				expect(refreshed).toEqual({ _yay: { pendingUpdate: refreshedDoc, currentYjsLastSequenceId } });
				expect(refreshedDoc?.content?.unstagedStateId).toBe(first.content.unstagedStateId);

				const changed = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: first._id,
					reviewedRevision: refreshedDoc?.revision,
					unstagedMarkdown: "second\n",
				});
				const second = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				expect(changed).toEqual({ _yay: { pendingUpdate: second, currentYjsLastSequenceId } });
				expect(second?.content?.unstagedStateId).not.toBe(first.content.unstagedStateId);
				// The old acknowledgment still identifies its own bytes after a later write.
				const oldPage = await asUser.query(api.files_pending_updates.get_file_pending_update_state_page, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
					stateId: first.content.unstagedStateId,
					pageIndex: 0,
				});
				expect(oldPage?.bytes).toEqual(firstBytes.unstagedBytes);
				expect(created._yay?.pendingUpdate).toEqual(first);

				const ended = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: first._id,
					reviewedRevision: second?.revision,
					unstagedMarkdown: "base\n",
				});
				expect(ended).toEqual({ _yay: { pendingUpdate: null, currentYjsLastSequenceId } });
				expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();

				expect(
					(await upsert_file_pending_update_public_for_test(asUser, { ...seeded, unstagedMarkdown: "move draft\n" }))
						._nay,
				).toBeUndefined();
				expect(
					(
						await upsert_file_pending_move_for_test({
							t,
							...seeded,
							destParentId: files_ROOT_ID,
							destName: "moved.txt",
						})
					)._nay,
				).toBeUndefined();
				const moved = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				const settled = await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					pendingUpdateId: moved?._id,
					reviewedRevision: moved?.revision,
					unstagedMarkdown: "base\n",
				});
				const structural = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
				expect(structural?.pendingMove).toBeDefined();
				expect(structural?.content).toBeUndefined();
				expect(settled).toEqual({ _yay: { pendingUpdate: structural, currentYjsLastSequenceId } });
			}
		},
	);

	test("upsert_file_pending_update rejects content over the size cap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-size-cap",
				name: "pending-edits-size-cap",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const overCapMarkdown = "a".repeat(files_MAX_TEXT_CONTENT_BYTES + 1);

		const unstagedOverCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: overCapMarkdown,
		});
		expect(unstagedOverCap._nay?.message).toContain("exceeds");

		// The staged branch is the one published on save, so capping only the unstaged side would
		// leave the hole exactly where it matters.
		const stagedOverCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: overCapMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		expect(stagedOverCap._nay?.message).toContain("exceeds");

		// A rejected upsert must not leave a pending update behind.
		const row = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("refuses the upsert when covered-row cleanup truncated the base reconstruction mid-walk", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-partial-base",
				name: "pending-partial-base",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The file advanced two sequences past the seeded snapshot, then the covered-row cleanup
		// deleted both rows (as it does behind a newer snapshot) while the base walker still
		// holds the older header. The one-row reader then reports "done" before the walk reaches
		// `throughSequence`.
		await t.run(async (ctx) => {
			const rowIds = await Promise.all(
				[1, 2].map((sequence) =>
					ctx.db.insert("files_yjs_updates", {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						fileNodeId: seeded.nodeId,
						sequence,
						update: files_u8_to_array_buffer(encodeStateAsUpdate(new YDoc())),
						origin: { type: "USER_EDIT", sessionId: "partial-base-session" },
						createdBy: seeded.userId,
						createdAt: Date.now(),
					}),
				),
			);
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!node?.yjsLastSequenceId) {
				throw new Error("Expected the seeded node to have a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", node.yjsLastSequenceId, { lastSequence: 2 });
			await Promise.all(rowIds.map((rowId) => ctx.db.delete("files_yjs_updates", rowId)));
		});

		// A partial document labeled with the full sequence must never become a proposal base:
		// done-before-target means stale, so the whole upsert refuses.
		const result = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Base\n\nMore text",
		});
		expect(result._nay?.message).toBe("Failed to load file state");

		const row = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("an accept anchored to a stale reviewed version refuses; the current version passes", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-reviewed-version",
				name: "pending-reviewed-version",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const created = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft v1",
		});
		expect(created._nay).toBeUndefined();
		// The version the user opened for review.
		const reviewedRow = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!reviewedRow) {
			throw new Error("Expected a pending update row after the first upsert");
		}

		// The agent revises the proposal while the user is still looking at v1.
		const revised = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: reviewedRow._id,
			unstagedMarkdown: "# Draft v2 (revised)",
		});
		expect(revised._nay).toBeUndefined();
		const currentRow = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!currentRow) {
			throw new Error("Expected a pending update row after the revision");
		}
		expect(currentRow.updatedAt).not.toBe(reviewedRow.updatedAt);

		// Publishing what the stale review decoded must refuse instead of silently dropping the
		// revision the user never saw.
		const staleAccept = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: reviewedRow._id,
			reviewedRevision: reviewedRow.revision,
			stagedMarkdown: "# Draft v1",
			unstagedMarkdown: "# Draft v1",
		});
		expect(staleAccept._nay?.message).toBe("Pending changes were revised, review the latest version");

		// A review of the current version passes.
		const freshAccept = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: currentRow._id,
			reviewedRevision: currentRow.revision,
			stagedMarkdown: "# Draft v2 (revised)",
			unstagedMarkdown: "# Draft v2 (revised)",
		});
		expect(freshAccept._nay).toBeUndefined();
	});

	test("upsert_file_pending_update refuses over-cap frontmatter before any canonical write", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-frontmatter-cap",
				name: "pending-edits-frontmatter-cap",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const frontmatterMarkdown = (fieldCount: number) =>
			`---\n${Array.from({ length: fieldCount }, (_, index) => `field_${index}: ${index}`).join("\n")}\n---\n\n# Body`;
		// One field whose unique date-like array values each index a string value plus a
		// `maybe_date` companion, so the TOTAL index-document count blows the 512 cap while the
		// field count stays at one.
		const largeArrayMarkdown = (dateCount: number) => {
			const dates = Array.from(
				{ length: dateCount },
				(_, index) => ` - "${new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10)}"`,
			);
			return `---\ntags:\n${dates.join("\n")}\n---\n\n# Body`;
		};

		// The commit refuses BEFORE any canonical proposal/state/chunk/metadata write, and the
		// action retires the staged input batch: a visible `_nay`, not a thrown rollback.
		const overFieldCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: frontmatterMarkdown(files_metadata_MAX_FRONTMATTER_FIELDS + 1),
		});
		expect(overFieldCap._nay?.message).toBe("Too many frontmatter fields");

		// 1 field doc + 256 string values + 256 maybe_date companions = 513 > 512.
		const overIndexDocumentCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: largeArrayMarkdown((files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS - 1) / 2 + 1),
		});
		expect(overIndexDocumentCap._nay?.message).toBe("Too many frontmatter fields");

		// No canonical or temporary row survives the refusals. The refusal retired the batch
		// family; the sweep it scheduled never runs under convex-test, so drain it directly.
		let cleanupDone = false;
		for (let pass = 0; pass < 20 && !cleanupDone; pass++) {
			cleanupDone = (
				await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
					_test_disableReschedule: true,
				})
			).done;
		}
		expect(cleanupDone).toBe(true);
		const leftovers = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			const [batches, textInputs, states, metadataDocs] = await Promise.all([
				ctx.db.query("files_pending_update_operation_batches").collect(),
				ctx.db.query("files_pending_update_text_inputs").collect(),
				ctx.db.query("files_pending_update_yjs_states").collect(),
				ctx.db.query("files_metadata_docs").collect(),
			]);
			return { row, batches, textInputs, states, metadataDocs };
		});
		expect(leftovers.row).toBeNull();
		expect(leftovers.batches).toEqual([]);
		expect(leftovers.textInputs).toEqual([]);
		expect(leftovers.states).toEqual([]);
		expect(leftovers.metadataDocs).toEqual([]);

		// Exactly at the field cap the save is allowed.
		const atCap = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: frontmatterMarkdown(files_metadata_MAX_FRONTMATTER_FIELDS),
		});
		expect(atCap._nay).toBeUndefined();
	});

	test("a pending yaml file starting with --- is not frontmatter-indexed", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-plain.yaml",
				name: "qa-plain.yaml",
				markdown: "existing: true\n",
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// On a Markdown file this opener would index `frontmatter.title`; on a plain text `.yaml`
		// it is ordinary content.
		const yamlText = "---\ntitle: not frontmatter\ncount: 3\n---\nbody: value\n";
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: yamlText,
		});
		expect(upserted._nay).toBeUndefined();

		const after = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending update doc to exist");
			}
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", row._id))
				.collect();
			const plainTextChunks = await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: row._id });
			return { metadataDocs, chunkTexts: plainTextChunks.map((chunk) => chunk.plainTextChunk) };
		});
		// The chunks exist (the content is searchable) but no frontmatter metadata doc was written.
		expect(after.metadataDocs).toEqual([]);
		expect(after.chunkTexts.join("")).toBe(yamlText);
	});

	test("frontmatter the parser cannot read saves the file without indexing it", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-frontmatter-unreadable",
				name: "pending-frontmatter-unreadable",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The parser reads one nesting level by calling itself again until the stack is full. 1000
		// levels is enough under Node, which is what convex-test runs on; the real Convex runtime
		// needs a deeper document. Flow style needs no indentation, so this whole file is about
		// 5 KB: the byte caps never see a problem. The save must still finish, because the user
		// cannot fix this by writing less and a refusal would trap their own text.
		const unreadableMarkdown = `---\na: ${"{b: ".repeat(1000)}v${"}".repeat(1000)}\n---\n\n# Body`;
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: unreadableMarkdown,
		});
		expect(upserted._nay).toBeUndefined();

		const after = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending update doc to exist");
			}
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", row._id))
				.collect();
			const plainTextChunks = await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: row._id });
			return { metadataDocs, chunkTexts: plainTextChunks.map((chunk) => chunk.plainTextChunk) };
		});
		// The text is stored and searchable; only the frontmatter index is missing. The chunks hold
		// the rendered plain text, not the raw markdown, so check the body survived rather than
		// comparing the two strings.
		expect(after.metadataDocs).toEqual([]);
		expect(after.chunkTexts.join("")).toContain("Body");
	});

	test("the agent read path returns a plain-text file's pending content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-plain-read.json",
				name: "pending-plain-read.json",
				markdown: '{"base": true}\n',
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Byte-exact plain text on purpose: no trailing newline and markdown-hostile characters,
		// which rendered Markdown text would rewrite but the plain branch must preserve.
		const pendingText = '{"pending": [1, 2, 3], "note": "*not markdown*"}';
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: pendingText,
		});
		expect(upserted._nay).toBeUndefined();

		// The agent/public-API read source: the pending branch must serve those exact bytes.
		const readState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/pending-plain-read.json",
		});
		expect(readState?.content).toBe(pendingText);
	});

	test("the agent read serves the committed text, not the stale pending text, after a lineage bump", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-stale-lineage.md",
				name: "pending-stale-lineage.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Pending draft",
		});
		expect(upserted._nay).toBeUndefined();

		// Before the repair, the read serves the proposal.
		const beforeBump = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/pending-stale-lineage.md",
		});
		expect(beforeBump?.content).toContain("Pending draft");

		// A repair replaced the document history: the proposal's base generation is now stale, so
		// the commit gate would refuse it and the read must not present it as current either.
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!node?.yjsLastSequenceId) {
				throw new Error("Expected the seeded node to have a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", node.yjsLastSequenceId, { lineageGeneration: 1 });
		});

		const afterBump = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/pending-stale-lineage.md",
		});
		expect(afterBump?.content).toBe(seeded.baseMarkdown);
		// The doc keeps its id, so the agent's next write mixes onto it and rebuilds the family.
		expect(afterBump?.pendingUpdateId).not.toBeNull();
	});

	test("both pending branches store LF with the leading BOM dropped", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-lf.txt",
				name: "pending-lf.txt",
				markdown: "base\n",
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Both content branches cross the same request boundary, and the STAGED branch is the one
		// published on save — normalizing only the unstaged row would rewrite whole files on save.
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "\uFEFFsA\r\nsB\rsC\n",
			unstagedMarkdown: "\uFEFFuA\r\nuB\ruC\n",
		});
		expect(upserted._nay).toBeUndefined();

		const branches = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the pending update doc to exist");
			}
			return await read_pending_row_state_bytes({ ctx, pendingUpdate: row });
		});

		const stagedText = files_yjs_doc_get_text({
			yjsDoc: files_yjs_doc_create_from_array_buffer_update(branches.stagedBytes),
			rootKind: "plain_text",
		});
		const unstagedText = files_yjs_doc_get_text({
			yjsDoc: files_yjs_doc_create_from_array_buffer_update(branches.unstagedBytes),
			rootKind: "plain_text",
		});
		// Each branch asserts separately, so a normalize that covers only one role fails here.
		expect(stagedText._yay).toBe("sA\nsB\nsC\n");
		expect(unstagedText._yay).toBe("uA\nuB\nuC\n");
	});

	test("upsert_file_pending_update writes the paged state family and deletes it with the content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-state-family",
				name: "pending-edits-state-family",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nState family`,
		});
		expect(upserted._nay).toBeUndefined();

		const afterUpsert = await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			return {
				row,
				states: await ctx.db.query("files_pending_update_yjs_states").collect(),
				pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			};
		});

		expect(afterUpsert.row?.content).toMatchObject({
			base: { kind: "yjs", lineageGeneration: 0 },
			baseStateId: expect.any(String),
			stagedStateId: expect.any(String),
			unstagedStateId: expect.any(String),
		});

		// One sealed family per role whose page totals reassemble to the recorded sizes (the
		// digest-verified load throws on any mismatch).
		const afterUpsertBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: afterUpsert.row! }),
		);
		expect(afterUpsert.states).toHaveLength(3);
		const stateById = new Map(afterUpsert.states.map((state) => [state._id, state]));
		expect(stateById.get(afterUpsert.row!.content!.baseStateId)).toMatchObject({
			sealed: true,
			lineageGeneration: 0,
			pageCount: 1,
			totalBytes: afterUpsertBytes.baseBytes.byteLength,
			owner: { kind: "active", pendingUpdateId: afterUpsert.row!._id, role: "base" },
		});
		expect(stateById.get(afterUpsert.row!.content!.stagedStateId)).toMatchObject({
			totalBytes: afterUpsertBytes.stagedBytes.byteLength,
			owner: { kind: "active", pendingUpdateId: afterUpsert.row!._id, role: "staged" },
		});
		expect(stateById.get(afterUpsert.row!.content!.unstagedStateId)).toMatchObject({
			totalBytes: afterUpsertBytes.unstagedBytes.byteLength,
			owner: { kind: "active", pendingUpdateId: afterUpsert.row!._id, role: "unstaged" },
		});
		expect(afterUpsert.pages).toHaveLength(3);

		// A second upsert replaces the family: the old one is retired to a cleanup task, and the
		// sweeper drain leaves exactly the new three states.
		const replaced = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nState family replaced`,
		});
		expect(replaced._nay).toBeUndefined();
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		const afterReplace = await t.run(async (ctx) => ({
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
		}));
		expect(afterReplace.states).toHaveLength(3);
		expect(afterReplace.pages).toHaveLength(3);

		// Collapsing the content back to base deletes the doc and its whole state family with it.
		const collapsed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		expect(collapsed._nay).toBeUndefined();
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		const afterCollapse = await t.run(async (ctx) => ({
			row: await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
		}));
		expect(afterCollapse.row).toBeNull();
		expect(afterCollapse.states).toHaveLength(0);
		expect(afterCollapse.pages).toHaveLength(0);
	});

	test("upsert_file_pending_update replaces updates deterministically", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-status",
				name: "pending-edits-status",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nChanged once`;

		const unresolved = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (unresolved._nay) {
			throw new Error(unresolved._nay.message);
		}
		expect(unresolved._yay.pendingUpdate).not.toBeNull();

		const ready = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (ready._nay) {
			throw new Error(ready._nay.message);
		}
		expect(ready._yay.pendingUpdate).not.toBeNull();

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(firstPendingRow).not.toBeNull();

		const readyAgain = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (readyAgain._nay) {
			throw new Error(readyAgain._nay.message);
		}
		expect(readyAgain._yay).toBeNull();

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(secondPendingRow).not.toBeNull();
		expect(secondPendingRow!._id).toBe(firstPendingRow!._id);
		expect(secondPendingRow!.content?.base).toEqual(firstPendingRow!.content?.base);

		const secondPendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: secondPendingRow! }),
		);
		expect(secondPendingRowMarkdownState.stagedMarkdown).toContain("Changed once");
		expect(secondPendingRowMarkdownState.unstagedMarkdown).toContain("Changed once");
		expect(secondPendingRowMarkdownState.stagedMarkdown).toBe(secondPendingRowMarkdownState.unstagedMarkdown);

		const discarded = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay).toBeNull();

		const pendingAfterDiscard = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterDiscard).toBeNull();
	});

	test("upsert_file_pending_update accepts a matching pendingUpdateId hint", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-matching-id-hint",
				name: "pending-edits-matching-id-hint",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nFirst`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing pending doc while testing matching pendingUpdateId hint");
		}

		const secondMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSecond`);
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstPendingRow._id,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(secondPendingRow).not.toBeNull();
		expect(secondPendingRow!._id).toBe(firstPendingRow._id);

		const secondPendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: secondPendingRow! }),
		);
		expect(secondPendingRowMarkdownState.stagedMarkdown).toBe(secondMarkdown);
		expect(secondPendingRowMarkdownState.unstagedMarkdown).toBe(secondMarkdown);
	});

	test("upsert_file_pending_update rejects a stale pendingUpdateId instead of falling back to the current scoped doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-stale-id-fallback",
				name: "pending-edits-stale-id-fallback",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFirst`,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending doc while testing fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCurrent`,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending doc while testing stale fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const staleMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nFallback`);
		const staleUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: stalePendingRow._id,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});
		// The stale id must not fall back to the newer row: the upsert refuses instead of
		// overwriting it with the dead proposal's content.
		expect(staleUpsertResult._nay?.message).toBe("Not found");

		const pendingRowAfterStaleUpsert = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingRowAfterStaleUpsert).not.toBeNull();
		expect(pendingRowAfterStaleUpsert!._id).toBe(currentPendingRow._id);

		const pendingRowAfterStaleUpsertMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRowAfterStaleUpsert! }),
		);
		expect(pendingRowAfterStaleUpsertMarkdownState.unstagedMarkdown).toContain("Current");
	});

	test("upsert_file_pending_update rejects a stale pendingUpdateId after a newer proposal replaced it", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-stale-id-race",
				name: "pending-edits-stale-id-race",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Tab A opens the diff editor on proposal one and holds its id.
		const firstUpserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the stale upsert");
		}

		// Tab B discards proposal one, then the agent creates a NEW proposal on the same file.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal two`,
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRowBefore || !files_pending_update_has_yjs_content(secondRowBefore)) {
			throw new Error("Missing second pending row before the stale upsert lands");
		}
		const secondRowBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowBefore }),
		);

		// Tab A's delayed debounced upsert still carries proposal one's id and stale content.
		const staleMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nStale editor content`);
		const staleUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});
		expect(staleUpsertResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The new proposal must be untouched: same row id, byte-identical branches.
			const secondRowAfter = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!secondRowAfter || !files_pending_update_has_yjs_content(secondRowAfter)) {
				throw new Error("Missing second pending row after the stale upsert");
			}
			expect(secondRowAfter._id).toBe(secondRowBefore._id);
			const secondRowAfterBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowAfter });
			expect(new Uint8Array(secondRowAfterBytes.baseBytes)).toEqual(new Uint8Array(secondRowBytes.baseBytes));
			expect(new Uint8Array(secondRowAfterBytes.stagedBytes)).toEqual(new Uint8Array(secondRowBytes.stagedBytes));
			expect(new Uint8Array(secondRowAfterBytes.unstagedBytes)).toEqual(new Uint8Array(secondRowBytes.unstagedBytes));
		});
	});

	test("upsert_file_pending_update creates a new row when the passed id is dead and no row exists", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-dead-id-create",
				name: "pending-edits-dead-id-create",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstUpserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the discard");
		}

		// The proposal is discarded and NO newer row exists: a retry with the dead id is the
		// normal new-proposal path and must still create.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});

		const retryMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nRetry content`);
		const retried = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: retryMarkdown,
		});
		if (retried._nay) {
			throw new Error(retried._nay.message);
		}

		const rowAfter = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfter).not.toBeNull();
		expect(rowAfter!._id).not.toBe(firstRow._id);
		const rowAfterMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: rowAfter! }),
		);
		expect(rowAfterMarkdownState.unstagedMarkdown).toBe(retryMarkdown);
	});

	test("upsert_file_pending_update keeps staged at base when the agent omits stagedMarkdown", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-new-proposal",
				name: "pending-edits-agent-new-proposal",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
		const agentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: agentMarkdown,
		});
		if (agentUpsertResult._nay) {
			throw new Error(agentUpsertResult._nay.message);
		}
		expect(agentUpsertResult._yay.pendingUpdate).not.toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after creating an agent proposal");
		}

		const pendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRow }),
		);
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(agentMarkdown);
	});

	test("upsert_file_pending_update preserves existing staged changes when the agent omits stagedMarkdown", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-preserve-staged",
				name: "pending-edits-agent-preserve-staged",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nUser staged`);
		const firstAgentMarkdown = normalize_pending_update_markdown(`${stagedMarkdown}\n\nAgent proposal`);
		const stagedPendingUpdateResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedMarkdown,
			unstagedMarkdown: firstAgentMarkdown,
		});
		if (stagedPendingUpdateResult._nay) {
			throw new Error(stagedPendingUpdateResult._nay.message);
		}

		const secondAgentMarkdown = normalize_pending_update_markdown(`${firstAgentMarkdown}\n\nAgent follow up`);
		const secondAgentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: secondAgentMarkdown,
		});
		if (secondAgentUpsertResult._nay) {
			throw new Error(secondAgentUpsertResult._nay.message);
		}
		expect(secondAgentUpsertResult._yay.pendingUpdate).not.toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after the follow-up agent proposal");
		}

		const pendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRow }),
		);
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(stagedMarkdown);
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe(secondAgentMarkdown);
	});

	test("upsert_file_pending_update keeps a pending doc for trailing whitespace at EOF", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-trailing-whitespace-eof",
				name: "pending-edits-trailing-whitespace-eof",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const whitespaceMarkdown = seeded.baseMarkdown + " ";
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: whitespaceMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}
		expect(upsertResult._yay.pendingUpdate).not.toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc after adding trailing whitespace at EOF");
		}

		const pendingRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingRow }),
		);
		expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
		expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
		// The whitespace lands on its own trailing paragraph and file content always
		// ends with one `\n`, so the read-back shape differs from the raw input.
		expect(pendingRowMarkdownState.unstagedMarkdown).toBe("# Base\n\n \n");
	});

	test("upsert_file_pending_update clears the doc when agent changes collapse to base", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-agent-collapse-to-base",
				name: "pending-edits-agent-collapse-to-base",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
		const firstAgentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: agentMarkdown,
		});
		if (firstAgentUpsertResult._nay) {
			throw new Error(firstAgentUpsertResult._nay.message);
		}

		const discardAgentUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discardAgentUpsertResult._nay) {
			throw new Error(discardAgentUpsertResult._nay.message);
		}
		expect(discardAgentUpsertResult._yay.pendingUpdate).toBeNull();

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingRow).toBeNull();
	});

	test("pending update expiry follows the latest pending doc state", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-task",
				name: "pending-edits-cleanup-task",
				markdown: "# Expiry base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nExpiry first`;
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow) {
			throw new Error("Missing first pending doc while testing expiry scheduling");
		}

		expect(firstPendingRow.expiresAt).toBe(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const firstCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		if (!firstCheck) {
			throw new Error("Missing the expiry check after the first upsert");
		}
		expect(firstCheck.nextCheckAt).toBe(firstPendingRow.expiresAt);

		await new Promise((resolve) => setTimeout(resolve, 2));

		const secondMarkdown = `${seeded.baseMarkdown}\n\nExpiry second`;
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!secondPendingRow) {
			throw new Error("Missing second pending doc while testing expiry rescheduling");
		}

		// The edit moves the draft's expiry later. The check stays at the earlier time, and when it
		// runs it reschedules itself for the new expiry.
		expect(secondPendingRow.expiresAt).toBe(secondPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(secondPendingRow.expiresAt).toBeGreaterThan(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }))).toEqual(firstCheck);

		const discardResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (discardResult._nay) {
			throw new Error(discardResult._nay.message);
		}

		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", secondPendingRow._id))).toBeNull();

		// With no draft left, the next check run deletes the check instead of scheduling again.
		vi.useFakeTimers();
		vi.setSystemTime(firstCheck.nextCheckAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});
		expect(await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }))).toBeNull();
	});

	test("an identical re-upsert refreshes the pending update lifetime", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-identical-ttl",
				name: "pending-edits-identical-ttl",
				markdown: "# Identical TTL base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const unstagedMarkdown = `${seeded.baseMarkdown}\n\nIdentical TTL content`;
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstPendingRow) {
			throw new Error("Missing pending doc while testing identical re-upsert TTL refresh");
		}
		expect(firstPendingRow.expiresAt).toBe(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		await new Promise((resolve) => setTimeout(resolve, 2));

		// The AI re-writes the exact same pending content: the row bytes do not change, but
		// the 4h lifetime must still restart or the old expiry removes the proposal.
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondPendingRow) {
			throw new Error("Missing pending doc after the identical re-upsert");
		}
		expect(secondPendingRow._id).toBe(firstPendingRow._id);
		expect(secondPendingRow.updatedAt).toBeGreaterThan(firstPendingRow.updatedAt);

		expect(secondPendingRow.expiresAt).toBe(secondPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(secondPendingRow.expiresAt).toBeGreaterThan(firstPendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
	});

	test("upsert_file_pending_update keeps a new proposal on an archived file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-archived-new-row",
				name: "pending-edits-archived-new-row",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The file is archived between the tool's read and its upsert. The archive only hides
		// the node: a proposal on it still saves, so the upsert is kept.
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.nodeId],
		});
		expect(archived).not.toHaveProperty("_nay");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAfter archive`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const rowAfter = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfter).not.toBeNull();
	});

	test("upsert_file_pending_update keeps an existing row editable on an archived file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-archived-existing-row",
				name: "pending-edits-archived-existing-row",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// The row exists before the file is archived.
		const firstUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBefore archive`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing pending row before the archive");
		}

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.nodeId],
		});
		expect(archived).not.toHaveProperty("_nay");

		// The surviving row stays editable on the archived file.
		const editedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAfter archive`);
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: editedMarkdown,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const editedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(editedRow?._id).toBe(firstRow._id);
		const editedRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: editedRow! }),
		);
		expect(editedRowMarkdownState.unstagedMarkdown).toBe(editedMarkdown);

		// The panel's content-discard revert (upsert back to base) still clears the row.
		const reverted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (reverted._nay) {
			throw new Error(reverted._nay.message);
		}
		const rowAfterRevert = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfterRevert).toBeNull();
	});

	test("the upsert action returns a message-only nay when the markdown projection fails", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-upsert-serializer-failure",
				name: "pending-edits-upsert-serializer-failure",
				markdown: "# Upsert serializer failure",
			}),
		);

		// Fail the action's first markdown read with the real producer's cause-carrying shape.
		filesYjsDocGetMarkdownMock.mockReturnValueOnce({
			_nay: {
				name: "nay",
				message: "Error while extracting markdown from Y.Doc",
				cause: new Error("serializer exploded"),
			},
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "Fresh pending content",
		});

		// The `_nay` must stay message-only: an extra `cause` field would fail the action's
		// strict `v_result` returns validator in a real deployment.
		expect(upserted).toEqual({
			_nay: { message: "Failed to apply unstaged text to pending branch" },
		});
	});
});

describe("upsert, discard, move, and restore on a file with collaboration off", () => {
	test("builds the branches from the committed text and records the node's asset as base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-create.md", "# Off base"));
		const unstagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a pending content doc");
			}
			expect(row.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(await read_pending_row_markdown_state({ ctx, pendingUpdate: row })).toEqual({
				baseMarkdown: normalize_pending_update_markdown("# Off base"),
				stagedMarkdown: normalize_pending_update_markdown("# Off base"),
				unstagedMarkdown,
			});

			// The file has no Yjs document, so its states carry no lineage.
			const states = await ctx.db.query("files_pending_update_yjs_states").collect();
			expect(states).toHaveLength(3);
			expect(states.map((state) => state.lineageGeneration)).toEqual([undefined, undefined, undefined]);

			// Pending chunks let the agent's overlay reads see the proposal.
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).not.toHaveLength(0);
		});
	});

	test("a second write on the same base keeps the doc and its base asset", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-second-write.md", "# Off base"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const read_row = () =>
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			);

		// The member accepted the first hunk: the staged branch differs from the base. A second
		// write must reuse this branch family, not rebuild it, or the accepted hunk is lost.
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted");
		const first = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted\n\nFirst"),
		});
		expect(first._nay).toBeUndefined();
		const firstRow = await read_row();
		if (!firstRow) {
			throw new Error("Expected a pending content doc after the first write");
		}

		const secondMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted\n\nSecond");
		const second = await upsert_file_pending_update_internal_for_test({
			...ids,
			pendingUpdateId: firstRow._id,
			unstagedMarkdown: secondMarkdown,
		});
		expect(second._nay).toBeUndefined();

		const secondRow = await read_row();
		expect(secondRow?._id).toBe(firstRow._id);
		expect(secondRow?.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		// A rebuild would clone the base into the staged branch and lose the accepted hunk.
		const state = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: secondRow! }));
		expect(state.baseMarkdown).toBe(normalize_pending_update_markdown("# Off base"));
		expect(state.stagedMarkdown).toBe(stagedMarkdown);
		expect(state.unstagedMarkdown).toBe(secondMarkdown);
	});

	test("accepts a client edit on a fresh proposal, the way the pending row does before Accept", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-client-fresh.md", "# Off base"));
		const proposalMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: proposalMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		// The row's Accept first stages every hunk through the anchored public upsert.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const staged = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: row._id,
			reviewedRevision: row.revision,
			stagedMarkdown: proposalMarkdown,
			unstagedMarkdown: proposalMarkdown,
		});
		expect(staged._nay).toBeUndefined();

		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		expect(rowAfter?.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		const state = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: rowAfter! }));
		expect(state.stagedMarkdown).toBe(proposalMarkdown);
		expect(state.unstagedMarkdown).toBe(proposalMarkdown);
	});

	test("refuses a client edit after a member saved the file and leaves the proposal untouched", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-client-stale.md", "# Off base"));

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member(t, seeded, "# Off base\n\nMember line");

		// The client reviewed the doc as it is (`reviewedRevision` matches), so the only refusal
		// left is the stale base.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const edited = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: row._id,
			reviewedRevision: row.revision,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line edited"),
		});
		expect(edited._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		// The stale proposal stays as it was, for Discard.
		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		expect(rowAfter?.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		expect(rowAfter?.updatedAt).toBe(row.updatedAt);
		expect(rowAfter?.content?.unstagedStateId).toBe(row.content?.unstagedStateId);

		// The refusal retired its operation batch, so the next attempt is refused for the same
		// reason, not as a batch that is still in progress.
		const activeBatches = await t.run(
			async (ctx) =>
				(await ctx.db.query("files_pending_update_operation_batches").collect()).filter(
					(batch) => batch.target.kind === "saved" && batch.target.id === seeded.nodeId && batch.expiresAt > Date.now(),
				).length,
		);
		expect(activeBatches).toBe(0);
		const editedAgain = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: row._id,
			reviewedRevision: row.revision,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line edited twice"),
		});
		expect(editedAgain._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
	});

	test("direct agent upsert keeps a stale proposal until preparation", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-agent-rebuild.md", "# Off base"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};

		const first = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line"),
		});
		expect(first._nay).toBeUndefined();
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member(t, seeded, "# Off base\n\nMember line");

		const rebuiltMarkdown = normalize_pending_update_markdown("# Off base\n\nMember line\n\nAgent line");
		const second = await upsert_file_pending_update_internal_for_test({
			...ids,
			pendingUpdateId: firstRow._id,
			unstagedMarkdown: rebuiltMarkdown,
		});
		expect(second._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		await t.run(async (ctx) => {
			const row = await ctx.db.get("files_pending_updates", firstRow._id);
			expect(row).toEqual(firstRow);
			// Refusal leaves the retained family active for Review.
			const activeRoles = (await ctx.db.query("files_pending_update_yjs_states").collect())
				.flatMap((state) =>
					state.owner.kind === "active" && state.owner.pendingUpdateId === firstRow._id ? [state.owner.role] : [],
				)
				.sort();
			expect(activeRoles).toEqual(["base", "staged", "unstaged"]);
			expect(await read_pending_row_markdown_state({ ctx, pendingUpdate: firstRow })).toEqual({
				baseMarkdown: normalize_pending_update_markdown("# Off base"),
				stagedMarkdown: normalize_pending_update_markdown("# Off base"),
				unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAgent line"),
			});
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base\n\nMember line");
		});
	});

	test("a version restore keeps the content proposal for preparation", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-restore-preserve.md", "# Off base"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		// The first save is the version to restore. The second save is the base of the proposal.
		const versionAssetId = await save_as_member(t, seeded, "# Off base\n\nFirst save");
		await save_as_member(t, seeded, "# Off base\n\nSecond save");
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nSecond save\n\nAgent line"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const versionId = await t.run(async (ctx) => {
			const snapshot = await ctx.db
				.query("files_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", versionAssetId))
				.first();
			if (!snapshot) {
				throw new Error("Expected the first save to keep a version");
			}
			return snapshot._id;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			snapshotId: versionId,
			sessionId: "restore-preserve",
		});
		expect(restored._nay).toBeUndefined();

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base\n\nFirst save");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual({
				...row,
				revision: row.revision + 1,
				contentNeedsRebase: true,
				contentRebaseRootKind: "rich_text",
			});
		});
	});

	test("the commit refuses a base asset the node no longer has", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-commit-stale.md", "# Off base"));
		const commit = async (expectedAssetId: Id<"files_r2_assets">) => {
			const family = await seal_output_family_for_test(t, seeded);
			const committed = await t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: family.operationBatchId,
				expectedRevision: null,
				base: { kind: "asset", expectedAssetId },
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "# Off base\n\nAgent line",
				unstagedBranchChanged: true,
			});
			// The action retires the batch on a refusal; do the same so the next commit can open one.
			if (committed._nay) {
				await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
					operationBatchId: family.operationBatchId,
				});
			}
			return committed;
		};

		// The action read the seeded asset; a member saved before the commit landed.
		const savedAssetId = await save_as_member(t, seeded, "# Off base\n\nMember line");
		const stale = await commit(seeded.assetId);
		expect(stale._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);

		// The asset check comes before the mode check: with collaboration turned on in the meantime
		// the agent still reads the stale message, not `Not found`.
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { collaborationEnabled: true }));
		const staleAndCollaborative = await commit(seeded.assetId);
		expect(staleAndCollaborative._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { collaborationEnabled: false }));

		// Positive control: the same commit with the node's current asset lands.
		const fresh = await commit(savedAssetId);
		expect(fresh._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.content?.base).toEqual({ kind: "asset", assetId: savedAssetId });
	});

	test("Discard deletes a stale proposal even when its staged branch differs from base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-discard-stale.md", "# Off base"));

		// The positive control is the first test of `discard_file_pending_content`: a collaborative
		// doc with accepted staged text survives Discard.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted change"),
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted change\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member(t, seeded, "# Off base\n\nMember line");

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		// The branches are retired to a cleanup task; the sweeper drain deletes them.
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", row._id)).toBeNull();
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toHaveLength(0);
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).toHaveLength(0);
		});
	});

	test("Discard on a stale mixed row keeps the move and drops the content with its base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-discard-stale-mixed.md", "# Off base"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		// The staged branch differs from the base, so only the stale rule can collapse the content.
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown: normalize_pending_update_markdown("# Off base\n\nStale staged change"),
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nStale mixed change"),
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-discard-stale-mixed-renamed.md",
		});
		expect(moved._nay).toBeUndefined();
		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...ids }));
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member(t, seeded, "# Off base\n\nMember line");

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const after = await ctx.db.get("files_pending_updates", row._id);
			expect(after?.pendingMove?.destName).toBe("off-discard-stale-mixed-renamed.md");
			expect(after?.content).toBeUndefined();
			expect(after?.size).toBe(0);
		});
	});

	test("Discard on a stale row with a delete keeps the delete and drops the content", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-discard-stale-delete.md", "# Off base"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nStale change"),
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test(ids);
		expect(archived._nay).toBeUndefined();
		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...ids }));
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		await save_as_member(t, seeded, "# Off base\n\nMember line");

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const after = await ctx.db.get("files_pending_updates", row._id);
			expect(after?.pendingArchive).toEqual(row.pendingArchive);
			expect(after?.content).toBeUndefined();
		});
	});

	test("Discard on a fresh proposal deletes the doc when no hunk was accepted", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-discard-fresh.md", "# Off base"));

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		// Staged equals base, so nothing is left to review: the doc goes, like on a collaborative file.
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", row._id)).toBeNull();
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toHaveLength(0);
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).toHaveLength(0);
		});
	});

	test("Discard on a fresh proposal keeps the accepted hunks and drops only the unstaged edits", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-discard-partial.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted change");

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nAccepted change\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: row._id,
			})),
			pendingUpdateId: row._id,
		});
		expect(discarded._nay).toBeUndefined();

		// The doc stays with its base asset. The unstaged branch is now a copy of the staged one,
		// stored in a new state that carries no lineage, like the other states of this file.
		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		if (!rowAfter) {
			throw new Error("Expected the doc to survive Discard");
		}
		expect(rowAfter.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
		expect(rowAfter.content?.stagedStateId).toBe(row.content?.stagedStateId);
		expect(rowAfter.content?.unstagedStateId).not.toBe(row.content?.unstagedStateId);
		const state = await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: rowAfter }));
		expect(state.stagedMarkdown).toBe(stagedMarkdown);
		expect(state.unstagedMarkdown).toBe(stagedMarkdown);
		const unstagedState = await t.run((ctx) =>
			ctx.db.get("files_pending_update_yjs_states", rowAfter.content!.unstagedStateId),
		);
		expect(unstagedState?.lineageGeneration).toBeUndefined();
	});

	test("requires one review for a move with non-collaborative content", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-apply-mixed.md", "# Off base"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};

		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nApply mixed change"),
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-apply-mixed-renamed.md",
		});
		expect(moved._nay).toBeUndefined();

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("dropping the content of a mixed row clears the base asset with the branches", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-drop-mixed.md", "# Off base"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};

		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nDropped change"),
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-drop-mixed-renamed.md",
		});
		expect(moved._nay).toBeUndefined();

		await t.run(async (ctx) => {
			await files_pending_updates_db_drop_content_for_node(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			});

			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the move to survive as a move-only row");
			}
			expect(row.pendingMove).toBeDefined();
			expect(row.content).toBeUndefined();
		});
	});

	test("builds the base from an empty file, which stores no chunk", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-empty.md", ""));
		const unstagedMarkdown = normalize_pending_update_markdown("Agent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a pending content doc");
			}
			expect(row.content?.base).toEqual({ kind: "asset", assetId: seeded.assetId });
			const state = await read_pending_row_markdown_state({ ctx, pendingUpdate: row });
			expect(state.stagedMarkdown).toBe("");
			expect(state.unstagedMarkdown).toBe(unstagedMarkdown);
		});
	});
});

describe("pending update provenance", () => {
	test("a later copy proposal overwrites the recorded source", async () => {
		const t = test_convex();

		const sourceA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-source-a.md",
				name: "provenance-source-a.md",
				markdown: "# Provenance source A",
			}),
		);
		const sourceB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-source-b.md",
				name: "provenance-source-b.md",
				markdown: "# Provenance source B",
				membership: {
					userId: sourceA.userId,
					organizationId: sourceA.organizationId,
					workspaceId: sourceA.workspaceId,
					membershipId: sourceA.membershipId,
				},
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/provenance-dest.md",
				name: "provenance-dest.md",
				markdown: "# Provenance dest base",
				membership: {
					userId: sourceA.userId,
					organizationId: sourceA.organizationId,
					workspaceId: sourceA.workspaceId,
					membershipId: sourceA.membershipId,
				},
			}),
		);

		const firstCopy = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${sourceA.baseMarkdown}\n\nFrom A`,
			copiedFrom: { nodeId: sourceA.nodeId, path: "/provenance-source-a.md" },
		});
		if (firstCopy._nay) {
			throw new Error(firstCopy._nay.message);
		}

		// cp from A, then cp from B onto the same target: the newest intent wins the provenance slot.
		const secondCopy = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${sourceB.baseMarkdown}\n\nFrom B`,
			copiedFrom: { nodeId: sourceB.nodeId, path: "/provenance-source-b.md" },
		});
		if (secondCopy._nay) {
			throw new Error(secondCopy._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		expect(row?.copiedFrom).toEqual({
			target: { kind: "saved", id: sourceB.nodeId },
			path: "/provenance-source-b.md",
		});
	});

	test("an agent content upsert stamps its thread and dedupes across writers", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-stamp.md",
				name: "thread-ids-stamp.md",
				markdown: "# Thread ids stamp base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...seeded }), seed_chat_thread({ ctx, ...seeded })]),
		);

		const firstWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread A`,
			threadId: threadA,
		});
		if (firstWrite._nay) {
			throw new Error(firstWrite._nay.message);
		}
		const rowAfterFirst = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterFirst?.threadIds).toEqual([threadA]);

		const secondWriteSameThread = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread A again`,
			threadId: threadA,
		});
		if (secondWriteSameThread._nay) {
			throw new Error(secondWriteSameThread._nay.message);
		}
		const rowAfterSameThread = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterSameThread?.threadIds).toEqual([threadA]);

		const thirdWriteOtherThread = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFrom thread B`,
			threadId: threadB,
		});
		if (thirdWriteOtherThread._nay) {
			throw new Error(thirdWriteOtherThread._nay.message);
		}
		const rowAfterOtherThread = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterOtherThread?.threadIds).toEqual([threadA, threadB]);
	});

	test("an identical re-write from another chat still appends its thread", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-identical.md",
				name: "thread-ids-identical.md",
				markdown: "# Thread ids identical base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...seeded }), seed_chat_thread({ ctx, ...seeded })]),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nSame bytes from both threads`;
		for (const threadId of [threadA, threadB]) {
			const written = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				unstagedMarkdown: changedMarkdown,
				threadId,
			});
			if (written._nay) {
				throw new Error(written._nay.message);
			}
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.threadIds).toEqual([threadA, threadB]);
	});

	test("a client upsert preserves the recorded threads", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-client-preserve.md",
				name: "thread-ids-client-preserve.md",
				markdown: "# Thread ids client preserve base",
			}),
		);
		const threadA = await t.run(async (ctx) => seed_chat_thread({ ctx, ...seeded }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const agentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent write`,
			threadId: threadA,
		});
		if (agentWrite._nay) {
			throw new Error(agentWrite._nay.message);
		}

		const clientWrite = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nClient edit on top`,
		});
		if (clientWrite._nay) {
			throw new Error(clientWrite._nay.message);
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.threadIds).toEqual([threadA]);
	});

	test("an agent move stamps a fresh row and appends on an existing content row", async () => {
		const t = test_convex();

		const moveOnly = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-move-only.md",
				name: "thread-ids-move-only.md",
				markdown: "# Thread ids move only",
			}),
		);
		const contentThenMove = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-content-move.md",
				name: "thread-ids-content-move.md",
				markdown: "# Thread ids content move",
				membership: {
					userId: moveOnly.userId,
					organizationId: moveOnly.organizationId,
					workspaceId: moveOnly.workspaceId,
					membershipId: moveOnly.membershipId,
				},
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...moveOnly }), seed_chat_thread({ ctx, ...moveOnly })]),
		);

		const freshMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: moveOnly.organizationId,
			workspaceId: moveOnly.workspaceId,
			userId: moveOnly.userId,
			nodeId: moveOnly.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-move-only-renamed.md",
			threadId: threadA,
		});
		if (freshMove._nay) {
			throw new Error(freshMove._nay.message);
		}
		const moveOnlyRow = await t.run((ctx) => read_pending_update_row({ ctx, ...moveOnly }));
		expect(moveOnlyRow?.pendingMove).toBeDefined();
		expect(moveOnlyRow?.threadIds).toEqual([threadA]);

		const contentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: contentThenMove.organizationId,
			workspaceId: contentThenMove.workspaceId,
			userId: contentThenMove.userId,
			nodeId: contentThenMove.nodeId,
			unstagedMarkdown: `${contentThenMove.baseMarkdown}\n\nContent from thread A`,
			threadId: threadA,
		});
		if (contentWrite._nay) {
			throw new Error(contentWrite._nay.message);
		}
		const moveAfterContent = await upsert_file_pending_move_for_test({
			t,
			organizationId: contentThenMove.organizationId,
			workspaceId: contentThenMove.workspaceId,
			userId: contentThenMove.userId,
			nodeId: contentThenMove.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-content-move-renamed.md",
			threadId: threadB,
		});
		if (moveAfterContent._nay) {
			throw new Error(moveAfterContent._nay.message);
		}
		const contentMoveRow = await t.run((ctx) => read_pending_update_row({ ctx, ...contentThenMove }));
		expect(contentMoveRow?.pendingMove).toBeDefined();
		expect(contentMoveRow?.threadIds).toEqual([threadA, threadB]);
	});

	test("a structural discard keeps the recorded threads on the surviving content doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-discard-preserve.md",
				name: "thread-ids-discard-preserve.md",
				markdown: "# Thread ids discard preserve base",
			}),
		);
		const [threadA, threadB] = await t.run(async (ctx) =>
			Promise.all([seed_chat_thread({ ctx, ...seeded }), seed_chat_thread({ ctx, ...seeded })]),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const contentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nContent from thread A`,
			threadId: threadA,
		});
		if (contentWrite._nay) {
			throw new Error(contentWrite._nay.message);
		}
		const moveWrite = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "thread-ids-discard-preserve-renamed.md",
			threadId: threadB,
		});
		if (moveWrite._nay) {
			throw new Error(moveWrite._nay.message);
		}

		// The client-driven structural discard drops the move but keeps the content doc alive —
		// and with it the recorded contributor set.
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		const row = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(row?.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row!)).toBe(true);
		expect(row?.threadIds).toEqual([threadA, threadB]);
	});

	test("an upsert without a thread leaves threadIds unset until an agent write lands", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/thread-ids-unset.md",
				name: "thread-ids-unset.md",
				markdown: "# Thread ids unset base",
			}),
		);
		const threadA = await t.run(async (ctx) => seed_chat_thread({ ctx, ...seeded }));

		const threadlessWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nThreadless write`,
		});
		if (threadlessWrite._nay) {
			throw new Error(threadlessWrite._nay.message);
		}
		const rowAfterThreadless = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterThreadless?.threadIds).toBeUndefined();

		const agentWrite = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent write after`,
			threadId: threadA,
		});
		if (agentWrite._nay) {
			throw new Error(agentWrite._nay.message);
		}
		const rowAfterAgent = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(rowAfterAgent?.threadIds).toEqual([threadA]);
	});
});

describe("pending file chunk docs lifecycle", () => {
	const read_pending_row = async (args: {
		t: ReturnType<typeof test_convex>;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		nodeId: Id<"files_nodes">;
	}) =>
		await args.t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("userId", args.userId)
						.eq("target.kind", "saved")
						.eq("target.id", args.nodeId),
				)
				.first(),
		);

	test("upsert creates chunks, re-chunks only on unstaged change, and collapse deletes them", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-chunks-upsert",
				name: "pending-chunks-upsert",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nChunk needle one`);
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing chunk creation");
		}
		expect(pendingRow.size).toBe(files_get_utf8_byte_size(firstMarkdown));

		const firstTextChunks = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const firstPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(firstTextChunks.length).toBeGreaterThan(0);
		expect(firstPlainTextChunks).toHaveLength(firstTextChunks.length);
		expect(firstTextChunks.map((chunk) => chunk.textChunk).join("\n")).toContain("Chunk needle one");
		expect(firstPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).toContain("Chunk needle one");
		expect(firstTextChunks[0]).toMatchObject({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: String(seeded.userId),
			target: { kind: "saved", id: seeded.nodeId },
			proposalRevision: pendingRow.revision,
			pendingUpdateId: pendingRow._id,
			sourceKind: "pending",
			chunkIndex: 0,
		});
		expect(firstPlainTextChunks[0]).toMatchObject({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: String(seeded.userId),
			target: { kind: "saved", id: seeded.nodeId },
			proposalRevision: pendingRow.revision,
			pendingUpdateId: pendingRow._id,
			sourceKind: "pending",
			path: "/pending-chunks-upsert",
			chunkIndex: 0,
		});
		expect(new Set(firstTextChunks.map((chunk) => chunk._id))).toContain(firstPlainTextChunks[0]?.textChunkId);
		for (const chunk of firstPlainTextChunks) {
			const textChunk = firstTextChunks.find((candidate) => candidate._id === chunk.textChunkId);
			if (!textChunk) throw new Error("Expected linked text chunk");
			expect(chunk).toMatchObject({
				textChunk: textChunk.textChunk,
				startIndex: textChunk.startIndex,
				endIndex: textChunk.endIndex,
				lineStart: textChunk.lineStart,
				lineEnd: textChunk.lineEnd,
				chunkFlags: textChunk.chunkFlags,
				hasChunkAbove: chunk.chunkIndex > 0,
				hasChunkBelow: chunk.chunkIndex < firstPlainTextChunks.length - 1,
			});
		}

		// Unstaged content changed -> chunk docs are replaced.
		const secondMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nChunk needle two`);
		const secondUpsertResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		const secondPendingRow = await read_pending_row({ t, ...seeded });
		if (!secondPendingRow) {
			throw new Error("Missing pending doc while testing chunk replacement");
		}
		expect(secondPendingRow._id).toBe(pendingRow._id);
		expect(secondPendingRow.size).toBe(files_get_utf8_byte_size(secondMarkdown));

		const secondTextChunks = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const secondPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(secondTextChunks.length).toBeGreaterThan(0);
		expect(secondPlainTextChunks).toHaveLength(secondTextChunks.length);
		expect(secondTextChunks.map((chunk) => chunk.textChunk).join("\n")).toContain("Chunk needle two");
		expect(secondTextChunks.map((chunk) => chunk.textChunk).join("\n")).not.toContain("Chunk needle one");
		expect(secondPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).toContain("Chunk needle two");
		expect(secondPlainTextChunks.map((chunk) => chunk.plainTextChunk).join("\n")).not.toContain("Chunk needle one");
		const firstTextChunkIds = new Set(firstTextChunks.map((chunk) => chunk._id));
		for (const chunk of secondTextChunks) {
			expect(firstTextChunkIds.has(chunk._id)).toBe(false);
		}
		const firstPlainTextChunkIds = new Set(firstPlainTextChunks.map((chunk) => chunk._id));
		for (const chunk of secondPlainTextChunks) {
			expect(firstPlainTextChunkIds.has(chunk._id)).toBe(false);
		}

		// Staged-only change (Accept all) keeps the unstaged content intact -> chunk doc ids survive.
		const stagedOnlyUpsertResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (stagedOnlyUpsertResult._nay) {
			throw new Error(stagedOnlyUpsertResult._nay.message);
		}

		const stagedOnlyPendingRow = await read_pending_row({ t, ...seeded });
		if (!stagedOnlyPendingRow) {
			throw new Error("Missing pending doc while testing staged-only pending update");
		}
		expect(stagedOnlyPendingRow.size).toBe(secondPendingRow.size);

		const stagedOnlyTextChunks = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const stagedOnlyPlainTextChunks = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(new Set(stagedOnlyTextChunks.map((chunk) => chunk._id))).toEqual(
			new Set(secondTextChunks.map((chunk) => chunk._id)),
		);
		expect(new Set(stagedOnlyPlainTextChunks.map((chunk) => chunk._id))).toEqual(
			new Set(secondPlainTextChunks.map((chunk) => chunk._id)),
		);

		// Collapse back to base deletes the pending update doc and its chunk docs in the same mutation.
		const collapseResult = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (collapseResult._nay) {
			throw new Error(collapseResult._nay.message);
		}

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const textChunksAfterCollapse = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterCollapse = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksAfterCollapse).toHaveLength(0);
		expect(plainTextChunksAfterCollapse).toHaveLength(0);
	});

	test("full save deletes the pending chunks with the pending update doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-chunks-full-save",
				name: "pending-chunks-full-save",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved chunk needle`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: resolvedMarkdown,
			unstagedMarkdown: resolvedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing full-save chunk cleanup");
		}
		const textChunksBeforeSave = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksBeforeSave = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksBeforeSave.length).toBeGreaterThan(0);
		expect(plainTextChunksBeforeSave.length).toBeGreaterThan(0);

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const textChunksAfterSave = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterSave = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksAfterSave).toHaveLength(0);
		expect(plainTextChunksAfterSave).toHaveLength(0);
	});

	test("expiry cleanup deletes the pending chunks with the pending update doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-chunks-expiry",
				name: "pending-chunks-expiry",
				markdown: "# Expiry base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nExpiry chunk needle`,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await read_pending_row({ t, ...seeded });
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing expiry chunk cleanup");
		}
		const textChunksBeforeExpiry = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksBeforeExpiry = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksBeforeExpiry.length).toBeGreaterThan(0);
		expect(plainTextChunksBeforeExpiry.length).toBeGreaterThan(0);

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		expect(await read_pending_row({ t, ...seeded })).toBeNull();
		const textChunksAfterExpiry = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		const plainTextChunksAfterExpiry = await t.run((ctx) =>
			list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
		);
		expect(textChunksAfterExpiry).toHaveLength(0);
		expect(plainTextChunksAfterExpiry).toHaveLength(0);
	});
});

describe("expire_file_pending_updates owner activity", () => {
	async function seed_saved_draft(t: ReturnType<typeof test_convex>, path: string) {
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path, name: path.slice(1), markdown: "# Expiry base" }),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}

Expiry pending`,
		});
		if (upserted._nay) throw new Error(upserted._nay.message);
		const scope = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, userId: seeded.userId };
		const read = () =>
			t.run(async (ctx) => {
				const draft = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", scope.organizationId)
							.eq("workspaceId", scope.workspaceId)
							.eq("userId", scope.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.nodeId),
					)
					.unique();
				const check = await read_pending_update_expiry_check({ ctx, ...scope });
				const reviewVersion = await ctx.db
					.query("files_pending_review_versions")
					.withIndex("by_organization_workspace_user", (q) =>
						q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", scope.userId),
					)
					.unique();
				return { draft, check, reviewVersion: reviewVersion?.revision ?? null };
			});
		return { seeded, asUser, scope, read };
	}

	test("keeps due drafts while an app tab is open, then removes them 4 hours after the last heartbeat", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const { seeded, asUser, scope, read } = await seed_saved_draft(t, "/expiry-active-owner");
		const created = await read();
		if (!created.draft || !created.check) throw new Error("Missing the draft or its expiry check");
		expect(created.draft.expiresAt).toBe(created.draft.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(created.check.nextCheckAt).toBe(created.draft.expiresAt);

		// The tab sends a heartbeat 3 hours later, then the draft's own deadline passes.
		vi.setSystemTime(created.draft.updatedAt + 3 * 60 * 60 * 1000);
		const heartbeat = await asUser.mutation(api.presence.heartbeat, {
			roomId: `expiry-room-${seeded.nodeId}`,
			userId: seeded.userId,
			sessionId: "expiry-session",
			interval: presenceHeartbeatIntervalMs,
		});
		const lastActiveAt = Date.now();
		vi.setSystemTime(created.draft.expiresAt + 1);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);

		const kept = await read();
		expect(kept.draft).toEqual(created.draft);
		expect(kept.reviewVersion).toBe(created.reviewVersion);
		expect(kept.check?.nextCheckAt).toBe(lastActiveAt + files_DRAFT_IDLE_EXPIRY_MS);

		// Closing the tab does not shorten the lifetime.
		await asUser.mutation(api.presence.disconnect, { sessionToken: heartbeat.sessionToken });
		vi.setSystemTime(lastActiveAt + files_DRAFT_IDLE_EXPIRY_MS - 1);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);
		expect((await read()).draft).not.toBeNull();

		vi.setSystemTime(lastActiveAt + files_DRAFT_IDLE_EXPIRY_MS);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);
		const expired = await read();
		expect(expired.draft).toBeNull();
		// No draft is left, so the check deletes itself instead of waking up again.
		expect(expired.check).toBeNull();
	});

	test("removes drafts in a workspace the owner left, even while the owner uses the app", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const { seeded, asUser, scope, read } = await seed_saved_draft(t, "/expiry-left-workspace");
		const created = await read();
		if (!created.draft) throw new Error("Missing the draft");

		vi.setSystemTime(created.draft.expiresAt);
		await asUser.mutation(api.presence.heartbeat, {
			roomId: `expiry-room-${seeded.nodeId}`,
			userId: seeded.userId,
			sessionId: "expiry-session",
			interval: presenceHeartbeatIntervalMs,
		});
		await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", seeded.membershipId, { active: false }));
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);

		expect((await read()).draft).toBeNull();
	});

	test("a new-session heartbeat does not read or schedule drafts, even with 1,500 of them", async () => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: true });
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/expiry-many-drafts", name: "expiry-many-drafts", markdown: "# Many" }),
		);
		for (let batch = 0; batch < 3; batch++) {
			await t.run(async (ctx) => {
				for (let index = 0; index < 500; index++) {
					await files_db_insert_pending_update(ctx, {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userId: seeded.userId,
						target: { kind: "saved", id: seeded.nodeId },
						revision: 1,
						size: 0,
						updatedAt: Date.now(),
					});
				}
			});
		}

		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		const heartbeat = await asUser.mutation(api.presence.heartbeat, {
			roomId: "expiry-many-drafts-room",
			userId: seeded.userId,
			sessionId: "expiry-many-drafts-session",
			interval: presenceHeartbeatIntervalMs,
		});

		expect(heartbeat.isNewSession).toBe(true);
		const lastActive = await t.run((ctx) =>
			ctx.db
				.query("users_last_active")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique(),
		);
		expect(lastActive?.lastActiveAt).toBe(Date.now());
	});

	test("stops a batch after about one full-size draft, then continues at once", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/expiry-large-drafts", name: "expiry-large-drafts", markdown: "# Large" }),
		);
		const scope = { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId, userId: seeded.userId };
		const updatedAt = Date.now();
		await t.run(async (ctx) => {
			for (let index = 0; index < 3; index++) {
				await files_db_insert_pending_update(ctx, {
					...scope,
					target: { kind: "saved", id: seeded.nodeId },
					revision: 1,
					size: files_MAX_TEXT_CONTENT_BYTES,
					updatedAt,
				});
			}
		});

		const dueAt = updatedAt + files_DRAFT_IDLE_EXPIRY_MS;
		vi.setSystemTime(dueAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, scope);

		const after = await t.run(async (ctx) => ({
			drafts: await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_expiresAt", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", scope.userId),
				)
				.collect(),
			check: await read_pending_update_expiry_check({ ctx, ...scope }),
		}));
		expect(after.drafts).toHaveLength(2);
		expect(after.check?.nextCheckAt).toBe(dueAt);
	});
});

describe("save_file_pending_update", () => {
	test("save_file_pending_update returns Not found when there is no pending doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-missing-doc",
				name: "pending-edits-save-missing-doc",
				markdown: "# Missing doc base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const deletedProposalId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			});
			await ctx.db.delete("files_pending_updates", id);
			return id;
		});
		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: deletedProposalId,
			reviewedRevision: 1,
		});

		expect(saveResult._nay?.message).toBe("Not found");
	});

	test("save_file_pending_update throws when a file points to missing Yjs state", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-broken-yjs",
				name: "pending-edits-save-broken-yjs",
				markdown: "# Broken Yjs base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingMarkdown = `${seeded.baseMarkdown}\n\nPending chunk`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: pendingMarkdown,
			unstagedMarkdown: pendingMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		await t.run(async (ctx) => {
			const file = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!file?.yjsSnapshotId) {
				throw new Error("Expected seeded file Yjs snapshot");
			}
			await ctx.db.delete("files_yjs_snapshots", file.yjsSnapshotId);
		});

		await expect(
			asUser.action(api.ai_chat.save_file_pending_update, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				...(await reviewed_pending_for_test(t, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
				})),
			}),
		).rejects.toThrow("fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc");
	});

	test("save_file_pending_update blocks Free users at zero credits before saving", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-zero-credits",
				name: "pending-edits-save-zero-credits",
				markdown: "# Save base",
			}),
		);
		await t.run(async (ctx) => {
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique();
			if (!usageSnapshot?.meter) {
				throw new Error("Expected seeded billing snapshot meter");
			}
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				meter: {
					...usageSnapshot.meter,
					creditedUnits: 0,
					balance: 0,
				},
			});
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
		});

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterDeniedSave).toBe(seeded.baseMarkdown);
	});

	test("save_file_pending_update blocks anonymous users at zero credits before saving", async () => {
		const t = test_convex();
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);

		const seeded = await t.run(async (ctx) => {
			const result = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-anon-zero-credits",
				name: "pending-edits-save-anon-zero-credits",
				markdown: "# Anon save base",
			});
			// Replace the signed-in billing snapshot with an anonymous one and drain it.
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", result.userId))
				.unique();
			if (usageSnapshot) await ctx.db.delete("billing_usage_snapshots", usageSnapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId: result.userId, now: Date.now() });
			const user = await ctx.db.get("users", result.userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}
			await ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: result.userId,
							externalId: "manual_credit::anonymous_pending_updates::1",
							metadata: {
								amount: recurringCredits,
							},
						}),
					},
				],
			});
			return result;
		});

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous User",
		});

		await upsert_file_pending_update_public_for_test(asAnonymous, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
		});

		const saveResult = await asAnonymous.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterDeniedSave).toBe(seeded.baseMarkdown);
	});

	test("save_file_pending_update bills anonymous users locally after a successful save", async () => {
		const t = test_convex();
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);

		const seeded = await t.run(async (ctx) => {
			const result = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-anon-success",
				name: "pending-edits-save-anon-success",
				markdown: "# Anon save base",
			});
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", result.userId))
				.unique();
			if (usageSnapshot) await ctx.db.delete("billing_usage_snapshots", usageSnapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId: result.userId, now: Date.now() });
			return result;
		});

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous User",
		});

		await upsert_file_pending_update_public_for_test(asAnonymous, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
		});

		const saveResult = await asAnonymous.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing anonymous save billing");
		}

		expect(saveResult._yay.newSequence).not.toBeNull();
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique(),
		);
		expect(usageSnapshot?.meter?.consumedUnits).toBe(1);
		expect(usageSnapshot?.meter?.balance).toBe(recurringCredits - 1);

		const savedMarkdown = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdown).toContain("Saved anon chunk");
	});

	test("save_file_pending_update supports partial save and keeps unresolved pending doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save",
				name: "pending-edits-save",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing partial save");
		}
		expect(saveResult._yay.newSequence).not.toBeNull();
		const savedVersion = `${(await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId}:${saveResult._yay.newSequence}`;
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "file_save",
					externalCustomerId: seeded.userId,
					externalId: `file_save::${seeded.userId}::${seeded.userId}::${seeded.organizationId}::${seeded.workspaceId}::${seeded.nodeId}::${savedVersion}`,
					metadata: expect.objectContaining({
						amount: 1,
						actorUserId: seeded.userId,
						billedUserId: seeded.userId,
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						nodeId: seeded.nodeId,
						version: savedVersion,
					}),
				}),
			],
		});

		const yjsUpdatesAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.order("asc")
				.collect(),
		);
		expect(yjsUpdatesAfterSave).toHaveLength(1);
		expect(yjsUpdatesAfterSave[0]?.createdBy).toBe(seeded.userId);

		const pendingUpdateLastSequenceSaved = await t.run(async (ctx) =>
			read_pending_update_last_sequence_saved_doc({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!.content?.base).toMatchObject({ kind: "yjs", sequence: saveResult._yay.newSequence });
		const pendingAfterSaveMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingAfterSave! }),
		);
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Accepted chunk");
		expect(pendingAfterSaveMarkdownState.baseMarkdown).not.toContain("Unresolved chunk");
		expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Accepted chunk");
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved chunk");

		const savedMarkdownAfterPartialSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterPartialSave).toContain("Accepted chunk");
		expect(savedMarkdownAfterPartialSave).not.toContain("Unresolved chunk");
	});

	test("saving a plain-text proposal writes the staged text into the live document byte for byte", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-plain-save.json",
				name: "pending-plain-save.json",
				markdown: '{"base": true}\n',
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Byte-exact plain text on purpose: no trailing newline and markdown-hostile characters.
		const stagedText = '{"pending": [1, 2, 3], "note": "*not markdown*"}';
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saveResult._nay).toBeUndefined();

		// The accept diff assumes the staged branch shares the live document's lineage. A staged
		// branch rebuilt in a fresh Y.Doc would pass the seal shape check but duplicate the text
		// here, so assert byte equality, not containment.
		const savedText = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				rootKind: "plain_text",
			}),
		);
		expect(savedText).toBe(stagedText);

		// staged == unstaged, so the save is a full consume and the pending row is gone.
		const rowAfterSave = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfterSave).toBeNull();
	});

	test("save_file_pending_update clears pending doc when all changes are resolved", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-full",
				name: "pending-edits-save-full",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingUpdateLastSequenceSavedBeforeFirstSave = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedBeforeFirstSave).toBeNull();

		const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: resolvedMarkdown,
			unstagedMarkdown: resolvedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing full save");
		}
		expect(saveResult._yay.newSequence).not.toBeNull();

		const pendingUpdateLastSequenceSaved = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).toBeNull();

		const savedMarkdownAfterFullSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterFullSave).toContain("Fully resolved");
	});

	test("save_file_pending_update rejects a stale pendingUpdateId instead of falling back to the current scoped doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-stale-id",
				name: "pending-edits-save-stale-id",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const staleMarkdown = `${seeded.baseMarkdown}\n\nStale doc`;
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending doc while testing save fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		const currentMarkdown = `${seeded.baseMarkdown}\n\nCurrent doc`;
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: currentMarkdown,
			unstagedMarkdown: currentMarkdown,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending doc while testing save fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: stalePendingRow._id,
			})),
			pendingUpdateId: stalePendingRow._id,
		});
		// The stale id must not fall back to the newer row: saving it would publish a
		// proposal this tab never had open.
		expect(saveResult._nay?.message).toBe("Not found");

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!._id).toBe(currentPendingRow._id);

		const pendingUpdateLastSequenceSaved = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(pendingUpdateLastSequenceSaved).toBeNull();

		const savedMarkdownAfterRejectedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterRejectedSave).not.toContain("Current doc");
	});

	test("save_file_pending_update rejects a stale pendingUpdateId instead of accepting a newer copy proposal", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-stale-id-replace-source.md",
				name: "save-stale-id-replace-source.md",
				markdown: "# Stale save replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-stale-id-replace-dest.md",
				name: "save-stale-id-replace-dest.md",
				markdown: "# Stale save replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});

		// Tab A opens the diff editor on proposal one and holds its id.
		const firstUpserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the stale save");
		}

		// Tab B discards proposal one, then the agent proposes a cp onto the file.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const replacementMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nReplacement content`);
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-stale-id-replace-source.md" },
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!secondRowBefore) {
			throw new Error("Missing copy row before the stale save lands");
		}

		// Tab A's Save click still carries proposal one's id: acting on the copy row would publish
		// its content — accepting a proposal the user never accepted.
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
				pendingUpdateId: firstRow._id,
			})),
			pendingUpdateId: firstRow._id,
		});
		expect(saved._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// Nothing was published and the copy row stays intact.
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			});
			expect(committedMarkdown).not.toContain("Replacement content");
			const rowAfter = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(rowAfter?._id).toBe(secondRowBefore._id);
			expect(rowAfter?.copiedFrom).toEqual({
				target: { kind: "saved", id: source.nodeId },
				path: "/save-stale-id-replace-source.md",
			});
		});
	});

	test("save_file_pending_update keeps unresolved doc based on saved pending base when remote drift exists", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-no-staged",
				name: "pending-edits-save-no-staged",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing save without staged changes");
		}
		expect(saveResult._yay.newSequence).toBeNull();

		const pendingUpdateLastSequenceSaved = await t.run(async (ctx) =>
			read_pending_update_last_sequence_saved_doc({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(1);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });

		const pendingAfterSaveMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingAfterSave! }),
		);
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("# Save base");
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Remote drift");
		expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved only");
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Remote drift");

		const savedMarkdownAfterNoStagedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterNoStagedSave).toContain("# Save base");
		expect(savedMarkdownAfterNoStagedSave).toContain("Remote drift");
		expect(savedMarkdownAfterNoStagedSave).not.toContain("Unresolved only");
	});

	test("save_file_pending_update returns rate-limit _nay and preserves pending doc when the limiter rejects", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-rate-limited",
				name: "pending-edits-save-rate-limited",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Rate Limit User",
			email: "rate-limit-user@example.com",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nStaged change`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingBeforeSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeSave).not.toBeNull();

		for (let i = 0; i < 2; i++) {
			const result = await asUser.action(api.ai_chat.save_file_pending_update, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				...(await reviewed_pending_for_test(t, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
				})),
			});
			if (result._nay) {
				throw new Error(`Expected save #${i + 1} to succeed, got: ${result._nay.message}`);
			}

			const saveMarkdown = `${seeded.baseMarkdown}\n\nStaged change ${i + 1}`;
			const upsert = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				stagedMarkdown: saveMarkdown,
				unstagedMarkdown: saveMarkdown,
			});
			if (upsert._nay) {
				throw new Error(upsert._nay.message);
			}
		}

		const pendingBeforeBlockedSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeBlockedSave).not.toBeNull();

		const lastSequenceSavedBeforeBlockedSave = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(lastSequenceSavedBeforeBlockedSave?.lastSequenceSaved).toBe(2);

		// The bucket allows a burst of 50, so force the next limiter check to reject instead of
		// exhausting it with 50 real saves.
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValueOnce({ ok: false, retryAfter: 5_000 } as never);

		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (!saveResult._nay) {
			throw new Error("Expected save_file_pending_update to be rate limited");
		}
		expect(saveResult._nay.message).toBe("Rate limit exceeded");

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave?._id).toBe(pendingBeforeBlockedSave?._id);

		const lastSequenceSavedAfter = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(lastSequenceSavedAfter?._id).toBe(lastSequenceSavedBeforeBlockedSave?._id);
		expect(lastSequenceSavedAfter?.lastSequenceSaved).toBe(2);

		const yjsUpdatesAfterSave = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_yjs_updates")
					.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("fileNodeId", seeded.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_yjs_docs_last_sequences")
					.withIndex("by_organization_workspace_fileNode", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("fileNodeId", seeded.nodeId),
					)
					.first(),
			]).then(([updates, lastSequence]) => ({
				updateCount: updates.length,
				lastSequence: lastSequence?.lastSequence ?? null,
			})),
		);
		expect(yjsUpdatesAfterSave.updateCount).toBe(2);
		expect(yjsUpdatesAfterSave.lastSequence).toBe(2);
	});

	test("save_file_pending_update_in_db rejects a stale replayed save without publishing or billing again", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-stale-replay",
				name: "pending-edits-save-stale-replay",
				markdown: "# Stale replay base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		// Two tabs' save actions read this same live base before either mutation runs.
		const originalFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const firstSave = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (firstSave._nay) {
			throw new Error(firstSave._nay.message);
		}
		if (!firstSave._yay) {
			throw new Error("Missing save result _yay while testing the stale replayed save");
		}
		expect(firstSave._yay.newSequence).toBe(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());
		enqueueActionSpy.mockClear();

		// The second tab's mutation still runs with its stale action-read sequence.
		const rowBeforeReplay = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowBeforeReplay) {
			throw new Error("Missing pending row while testing the stale replayed save");
		}
		const replayedSave = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			pendingUpdateId: rowBeforeReplay._id,
			expectedRevision: rowBeforeReplay.revision,
			baseYjsSequence: originalFileState.yjsSequence,
			baseLineageGeneration: 0,
		});
		expect(replayedSave._nay?.message).toBe("Stale save");
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		await t.run(async (ctx) => {
			// No second publish: the sequence and update count stay at the first save's values.
			const yjsUpdates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(yjsUpdates).toHaveLength(1);
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first();
			expect(lastSequenceDoc?.lastSequence).toBe(1);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });
		});
	});

	test("save_file_pending_update_in_db rejects a save whose base misses another user's commit", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-concurrent-commit",
				name: "pending-edits-save-concurrent-commit",
				markdown: "# Concurrent commit base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		// The save action reads this live base, then another user commits before the mutation runs.
		const actionReadFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const otherUserDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nOther user's commit`,
			}),
		);
		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: otherUserDiff,
			sessionId: "other-user-session",
		});
		// The push above bills its own event; only the stale save below must not bill.
		enqueueActionSpy.mockClear();

		// The mutation still runs with the action-read sequence: saving would stamp the pushed
		// sequence onto row content that lacks the other user's commit, hiding that commit
		// from pending reads while claiming the latest sequence.
		const rowBeforeStaleSave = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowBeforeStaleSave) {
			throw new Error("Missing pending row while testing the concurrent-commit stale save");
		}
		const saved = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			pendingUpdateId: rowBeforeStaleSave._id,
			expectedRevision: rowBeforeStaleSave.revision,
			baseYjsSequence: actionReadFileState.yjsSequence,
			baseLineageGeneration: 0,
		});
		expect(saved._nay?.message).toBe("Stale save");
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		await t.run(async (ctx) => {
			// Only the other user's commit exists; nothing was published on top of it.
			const yjsUpdates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(yjsUpdates).toHaveLength(1);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.content?.base).toMatchObject({ kind: "yjs", sequence: 0 });
		});
	});
});

describe("save_file_pending_update on a file with collaboration off", () => {
	test("a full accept publishes the staged text as a member save and settles the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-accept.txt", "base line"));
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved).toEqual({
			_yay: { target: { kind: "saved", id: seeded.nodeId }, newSequence: null, pendingUpdateRevision: null },
		});

		// The branches are retired to a cleanup task; the sweeper drain deletes them.
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!node?.assetId) {
				throw new Error("Expected the node to keep a content asset");
			}
			return {
				assetId: node.assetId,
				asset: await ctx.db.get("files_r2_assets", node.assetId),
				committedText: await read_committed_text({ ctx, ...seeded }),
				snapshots: (await ctx.db.query("files_snapshots").collect()).filter(
					(snapshot) => snapshot.fileNodeId === seeded.nodeId,
				),
				doc: await ctx.db.get("files_pending_updates", row._id),
				states: await ctx.db.query("files_pending_update_yjs_states").collect(),
				pendingChunks: await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id }),
				lastSequenceSaved: await read_pending_update_last_sequence_saved_doc({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			};
		});

		// The staged text is the file now, byte for byte, under a new version snapshot.
		expect(after.assetId).not.toBe(seeded.assetId);
		expect(after.committedText).toBe(stagedText);
		expect(after.snapshots).toHaveLength(1);
		expect(after.snapshots[0]?.assetId).toBe(after.assetId);

		// The version object holds the staged text, and its asset row is finalized, so the
		// unfinalized-asset sweep leaves the file's current content alone.
		const versionKey = r2_create_asset_key({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			assetId: after.assetId,
		});
		expect(after.asset?.r2Key).toBe(versionKey);
		expect(after.asset?.unfinalizedExpiresAt).toBeUndefined();
		expect(r2Objects.get(versionKey)).toBe(stagedText);

		// The proposal is done: no doc, no branches, no pending chunks, and no Sync marker (that
		// marker only feeds the Sync gate, which this mode hides).
		expect(after.doc).toBeNull();
		expect(after.states).toHaveLength(0);
		expect(after.pendingChunks).toHaveLength(0);
		expect(after.lastSequenceSaved).toBeNull();

		// One save billed, with the version snapshot as the save id.
		expect(file_save_events()).toHaveLength(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "file_save",
					externalCustomerId: seeded.userId,
					externalId: `file_save::${seeded.userId}::${seeded.userId}::${seeded.organizationId}::${seeded.workspaceId}::${seeded.nodeId}::${after.assetId}`,
					metadata: expect.objectContaining({ amount: 1, nodeId: seeded.nodeId, version: after.assetId }),
				}),
			],
		});
	});

	test("a full accept with a pending move publishes the text and keeps the doc as move-only", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-accept-mixed.txt", "base line"));
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-accept-mixed-renamed.txt",
		});
		expect(moved._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved._nay).toBeUndefined();

		// Save publishes the content only. The move proposal survives as a move-only doc with no
		// branches and no base, and the result names that doc so the diff view can wait for it.
		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe(stagedText);
			const docAfter = await ctx.db.get("files_pending_updates", row._id);
			if (!docAfter) {
				throw new Error("Expected the move proposal to survive the save");
			}
			expect(docAfter.pendingMove).toBeDefined();
			expect(docAfter.content).toBeUndefined();
			expect(docAfter.size).toBe(0);
			expect(saved._yay).toEqual({
				target: { kind: "saved", id: seeded.nodeId },
				newSequence: null,
				pendingUpdateRevision: docAfter.revision,
			});
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).toHaveLength(0);
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/off-accept-mixed.txt");
		});
		expect(file_save_events()).toHaveLength(1);
	});

	test("a member save between the upload and the commit refuses and hands the upload to the deletion ledger", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-accept-race.txt", "base line"));
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action has read the doc and is uploading the version object when the first PUT
		// lands. A member save right then moves the node to another asset before the commit runs.
		const fetchMock = vi.mocked(globalThis.fetch);
		const uploadFetch = fetchMock.getMockImplementation();
		if (!uploadFetch) throw new Error("Expected the R2 fetch stub");
		let savedDuringUpload = false;
		fetchMock.mockImplementation(async (url, init) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (!savedDuringUpload && urlString.startsWith("https://r2.test/upload?key=")) {
				savedDuringUpload = true;
				await save_as_member(t, seeded, "member line");
			}
			return uploadFetch(url, init);
		});
		const saved = await accept_as_member(t, seeded, row._id);
		fetchMock.mockImplementation(uploadFetch);
		expect(savedDuringUpload).toBe(true);
		expect(saved._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			return {
				assetId: node?.assetId,
				committedText: await read_committed_text({ ctx, ...seeded }),
				doc: await ctx.db.get("files_pending_updates", row._id),
				assetKeys: (await ctx.db.query("files_r2_assets").collect()).map((asset) =>
					r2_create_asset_key({
						organizationId: asset.organizationId,
						workspaceId: asset.workspaceId,
						assetId: asset._id,
					}),
				),
				deletionJobs: (await ctx.db.query("files_r2_object_deletion_jobs").collect()).filter(
					(job) => job.reason === "failed_create",
				),
			};
		});
		// The member's text stays the file, and the proposal stays for the member to discard.
		expect(after.committedText).toBe("member line");
		expect(after.doc).not.toBeNull();

		// The accept's version object was uploaded but is nobody's content now: its asset row is
		// gone and a deletion job owns its key, so nothing waits for the unfinalized-asset sweep.
		expect(after.deletionJobs).toHaveLength(1);
		const releasedKey = after.deletionJobs[0]!.r2Key;
		expect(r2Objects.get(releasedKey)).toBe(stagedText);
		expect(after.assetKeys).not.toContain(releasedKey);
		expect(after.assetKeys).toContain(
			r2_create_asset_key({
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				assetId: after.assetId!,
			}),
		);
	});

	test("a full accept on a Markdown file commits the staged branch as the rich text document reads it", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-accept.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\n- Agent item");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved).toEqual({
			_yay: { target: { kind: "saved", id: seeded.nodeId }, newSequence: null, pendingUpdateRevision: null },
		});

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).not.toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe(stagedMarkdown);
		});
	});

	test("a partial accept publishes the staged text and keeps the unstaged edits on the new base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-partial.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted change");
		const unstagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted change\n\nUnresolved change");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).not.toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe(stagedMarkdown);

			// The doc lives on, based on the new content asset, with the unstaged text untouched.
			const docAfter = await ctx.db.get("files_pending_updates", row._id);
			if (!docAfter) {
				throw new Error("Expected the unstaged edits to keep the pending doc");
			}
			expect(docAfter.content?.base).toEqual({ kind: "asset", assetId: node?.assetId });
			expect(docAfter.updatedAt).not.toBe(row.updatedAt);
			// The result names the rewritten doc, so the diff view can wait for its doc query to show it.
			expect(saved._yay).toEqual({
				target: { kind: "saved", id: seeded.nodeId },
				newSequence: null,
				pendingUpdateRevision: docAfter.revision,
			});
			expect(await read_pending_row_markdown_state({ ctx, pendingUpdate: docAfter })).toEqual({
				baseMarkdown: stagedMarkdown,
				stagedMarkdown,
				unstagedMarkdown,
			});
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).not.toHaveLength(0);
		});
		expect(file_save_events()).toHaveLength(1);
	});

	test("an accept with nothing staged writes and bills nothing and leaves the doc as it is", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-nothing-staged.md", "# Off base"));
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: normalize_pending_update_markdown("# Off base"),
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved).toEqual({
			_yay: { target: { kind: "saved", id: seeded.nodeId }, newSequence: null, pendingUpdateRevision: row.revision },
		});

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.assetId);
			expect(
				(await ctx.db.query("files_snapshots").collect()).filter((s) => s.fileNodeId === seeded.nodeId),
			).toHaveLength(0);
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		expect(file_save_events()).toHaveLength(0);
	});

	test("refuses a stale proposal after a member save and changes nothing", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-accept-stale.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const savedAssetId = await save_as_member(t, seeded, "# Off base\n\nMember line");
		const read_file = () =>
			t.run(async (ctx) => ({
				assetId: (await ctx.db.get("files_nodes", seeded.nodeId))?.assetId,
				committedText: await read_committed_text({ ctx, ...seeded }),
				snapshotCount: (await ctx.db.query("files_snapshots").collect()).filter((s) => s.fileNodeId === seeded.nodeId)
					.length,
			}));
		const beforeAccept = await read_file();
		expect(beforeAccept.assetId).toBe(savedAssetId);
		const billedBefore = file_save_events().length;
		const count_deletion_jobs = () =>
			t.run(async (ctx) => (await ctx.db.query("files_r2_object_deletion_jobs").collect()).length);
		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await count_deletion_jobs();

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		// The member's text stays the file; nothing was uploaded, versioned, or billed. The action
		// refuses before its upload: no new object in the bucket and no deletion job for one.
		expect(await read_file()).toEqual(beforeAccept);
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await count_deletion_jobs()).toBe(deletionJobsBefore);
		expect(file_save_events()).toHaveLength(billedBefore);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", row._id))).toEqual(row);
	});

	test("refuses at zero credits before inserting the version asset", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-no-credits.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: seeded.userId, plan: "Free" });
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique();
			if (!usageSnapshot?.meter) {
				throw new Error("Expected seeded billing snapshot meter");
			}
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				meter: { ...usageSnapshot.meter, creditedUnits: 0, balance: 0 },
			});
		});
		const assetsBefore = await t.run((ctx) => ctx.db.query("files_r2_assets").collect());
		const count_deletion_jobs = () =>
			t.run(async (ctx) => (await ctx.db.query("files_r2_object_deletion_jobs").collect()).length);
		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await count_deletion_jobs();

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved).toEqual({ _nay: { message: "Insufficient funds" } });

		// The credit check runs before the upload: no asset row, no object, no deletion job.
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assetsBefore);
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await count_deletion_jobs()).toBe(deletionJobsBefore);
		expect(file_save_events()).toHaveLength(0);
	});

	test("refuses a read-only file", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-read-only.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved._nay?.name).toBe("read_only");
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual(deletionJobsBefore);
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.assetId).toBe(seeded.assetId);
		});
		expect(file_save_events()).toHaveLength(0);
	});

	test("the action refuses a pending delete before uploading a version", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-action-delete.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test(ids);
		expect(archived._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);
		const assetsBefore = await t.run((ctx) => ctx.db.query("files_r2_assets").collect());
		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved._nay?.message).toBe("File has a pending delete");
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assetsBefore);
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual(deletionJobsBefore);
		expect(await read_seeded_pending_row(t, seeded)).toEqual(row);
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("# Off base");
		expect(file_save_events()).toHaveLength(0);
	});

	test("a rate-limited accept writes nothing and leaves the doc as it was", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-rate-limit.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);
		const assetsBefore = await t.run((ctx) => ctx.db.query("files_r2_assets").collect());
		const objectsBefore = r2Objects.size;
		const limitSpy = vi
			.spyOn(RateLimiter.prototype, "limit")
			.mockResolvedValueOnce({ ok: false, retryAfter: 5_000 } as never);

		const saved = await accept_as_member(t, seeded, row._id);
		expect(saved).toEqual({ _nay: { name: "rate_limited", message: "Rate limit exceeded" } });
		expect(limitSpy).toHaveBeenCalledWith(expect.anything(), "save_file_pending_update", expect.anything());

		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assetsBefore);
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", row._id))).toEqual(row);
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses a save action that read the doc before another tab rewrote it", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-replay.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action read `updatedAt` before another tab's partial accept rewrote the doc. Its
		// commit must not publish the old staged text over that.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const replayed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision - 1,
				publish: null,
			},
		);
		expect(replayed._nay?.message).toBe("Stale save");

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses when a delete was proposed after the action read the doc", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-commit-delete.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(archived._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: null,
			},
		);
		expect(committed._nay?.message).toBe("File has a pending delete");

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit checks the lock again after the action's own check", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-commit-lock.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action saw an unlocked file; a member locked it before the commit ran.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: null,
			},
		);
		expect(committed._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses when collaboration was turned on after the action read the doc", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-commit-collab-on.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The ON toggle also marks the proposal. Flip the flag alone, so the commit's own check is
		// the one that refuses.
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { collaborationEnabled: true }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: null,
			},
		);
		expect(committed._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses at zero credits even when the action's check passed", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-commit-credits.md", "# Off base"));
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action checked credits and uploaded the version object; the credits ran out before
		// its commit ran.
		const prepared = await t.mutation(internal.files_pending_updates.prepare_pending_save_assets, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: row._id,
			expectedRevision: row.revision,
			contentSize: files_get_utf8_byte_size(stagedMarkdown),
		});
		if (prepared._nay) throw new Error(prepared._nay.message);
		const versionSnapshotAssetId = prepared._yay.assets[0]!.assetId;
		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: seeded.userId, plan: "Free" });
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique();
			if (!usageSnapshot?.meter) {
				throw new Error("Expected seeded billing snapshot meter");
			}
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				meter: { ...usageSnapshot.meter, creditedUnits: 0, balance: 0 },
			});
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: {
					text: stagedMarkdown,
					textSize: files_get_utf8_byte_size(stagedMarkdown),
					versionSnapshotAssetId,
				},
			},
		);
		expect(committed).toEqual({ _nay: { message: "Insufficient funds" } });

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		expect(file_save_events()).toHaveLength(0);
	});

	test("a refused partial accept retires its output batch, so the next operation is not blocked", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-accept-race-partial.txt", "base line"));
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText + "\nunstaged line",
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);
		// The retire marks the batch expired; the scheduled cleanup deletes the row later.
		const count_active_batches = () =>
			t.run(
				async (ctx) =>
					(await ctx.db.query("files_pending_update_operation_batches").collect()).filter(
						(batch) =>
							batch.target.kind === "saved" && batch.target.id === seeded.nodeId && batch.expiresAt > Date.now(),
					).length,
			);
		const count_active_temporary_states = () =>
			t.run(
				async (ctx) =>
					(await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
						(state) => state.owner.kind === "temporary" && state.owner.expiresAt > Date.now(),
					).length,
			);
		expect(await count_active_batches()).toBe(0);

		// Same race as above, in the partial shape: the unstaged edit survives the accept, so the
		// action seals an output family under a batch before it uploads.
		const fetchMock = vi.mocked(globalThis.fetch);
		const uploadFetch = fetchMock.getMockImplementation();
		if (!uploadFetch) throw new Error("Expected the R2 fetch stub");
		let savedDuringUpload = false;
		fetchMock.mockImplementation(async (url, init) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (!savedDuringUpload && urlString.startsWith("https://r2.test/upload?key=")) {
				savedDuringUpload = true;
				await save_as_member(t, seeded, "member line");
			}
			return uploadFetch(url, init);
		});
		const saved = await accept_as_member(t, seeded, row._id);
		fetchMock.mockImplementation(uploadFetch);
		expect(savedDuringUpload).toBe(true);
		expect(saved._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		// The batch is gone with the refusal, with its output states, and the doc still holds its
		// own states.
		expect(await count_active_batches()).toBe(0);
		expect(await count_active_temporary_states()).toBe(0);
		const after = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		expect(after?.content?.stagedStateId).toBe(row.content?.stagedStateId);
		expect(after?.content?.unstagedStateId).toBe(row.content?.unstagedStateId);
		// The one event is the member save during the upload. The refused accept billed nothing.
		expect(file_save_events()).toHaveLength(1);
	});
});

describe("overlay reads on a file with collaboration off", () => {
	const committedMarkdown = "# Off overlay\n\ncommitted needle\n";
	// The needle moves from line 3 to line 5 so `grep` tells the two texts apart by line number.
	const proposalMarkdown = normalize_pending_update_markdown("# Off overlay\n\nnew first line\n\nproposal needle");

	async function seed_file_with_proposal(t: ReturnType<typeof test_convex>, path: string) {
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, path, committedMarkdown));
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: proposalMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}
		return { seeded, row, readScope: { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId } };
	}

	test("the read doors serve the proposal instead of the committed text", async () => {
		const t = test_convex();
		const path = "/off-overlay-fresh.md";
		const { seeded, row, readScope } = await seed_file_with_proposal(t, path);

		// read_file_content_from_chunks: the door behind bash `cat` and the agent file tools.
		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: seeded.userId,
			path,
			mode: { kind: "full", maxBytes: 10_000 },
		});
		if (!full) throw new Error("expected a full read");
		expect(full.content).toBe(proposalMarkdown);
		expect(full.pendingUpdateId).toBe(row._id);

		// read_committed_file_chunk_stats: the door behind `wc`. A proposal is not in the
		// committed chunks, so the caller must count the in-memory text instead.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		expect(stats.usable).toBe(false);

		// match_plain_text_file_lines: the door behind `textgrep`.
		const textgrep = await t.query(internal.files_nodes.match_plain_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		if (!textgrep) throw new Error("expected a textgrep result");
		expect(textgrep.lines.map(({ lineNumber }) => lineNumber)).toEqual([5]);

		// match_text_file_lines: the door behind `grep` and `sed`.
		const grep = await t.query(internal.files_nodes.match_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
			before: 0,
			after: 0,
		});
		if (!grep) throw new Error("expected a grep result");
		expect(grep.lines.map(({ lineNumber }) => lineNumber)).toEqual([5]);

		// get_file_text_content_db_state_by_path: the door behind the app editor and `edit_file`.
		const state = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		if (!state) throw new Error("expected a content state");
		expect(state.content).toBe(proposalMarkdown);
		expect(state.pendingUpdateId).toBe(row._id);

		// Workspace search reads the proposal's pending chunks instead of the committed ones.
		const search = async (query: string) => {
			const result = await t.query(internal.files_nodes.text_search_files, {
				...readScope,
				userId: seeded.userId,
				hasWorkspaceRead: true,
				query,
				numItems: 10,
				cursor: null,
			});
			return result.items.map((item) => item.path);
		};
		expect(await search("proposal")).toContain(path);
		expect(await search("committed")).not.toContain(path);
	});

	test("after a member save the read doors hide the stale proposal and serve the saved text", async () => {
		const t = test_convex();
		const path = "/off-overlay-stale.md";
		const { seeded, row, readScope } = await seed_file_with_proposal(t, path);
		const savedMarkdown = "# Off overlay\n\nsaved needle\n";
		await save_as_member(t, seeded, savedMarkdown);

		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: seeded.userId,
			path,
			mode: { kind: "full", maxBytes: 10_000 },
		});
		if (!full) throw new Error("expected a full read");
		expect(full.content).toBe(savedMarkdown);

		// read_committed_file_chunk_stats: the door behind `wc`. The stale proposal has no text of
		// its own, so the committed chunks answer with the saved text's counts.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		expect(stats).toMatchObject({ usable: true, nodeId: seeded.nodeId, lineCount: 3 });

		const textgrep = await t.query(internal.files_nodes.match_plain_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		if (!textgrep) throw new Error("expected a textgrep result");
		expect(textgrep.lines.map(({ lineNumber }) => lineNumber)).toEqual([3]);

		const grep = await t.query(internal.files_nodes.match_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
			before: 0,
			after: 0,
		});
		if (!grep) throw new Error("expected a grep result");
		expect(grep.lines.map(({ lineNumber }) => lineNumber)).toEqual([3]);

		// The stale doc stays, and the door still names it, so the agent's next write rebuilds
		// the proposal on it instead of creating a second doc.
		const state = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		if (!state) throw new Error("expected a content state");
		expect(state.content).toBe(savedMarkdown);
		expect(state.pendingUpdateId).toBe(row._id);
		expect(state.materializationState).toBeNull();

		const search = async (query: string) => {
			const result = await t.query(internal.files_nodes.text_search_files, {
				...readScope,
				userId: seeded.userId,
				hasWorkspaceRead: true,
				query,
				numItems: 10,
				cursor: null,
			});
			return result.items.map((item) => item.path);
		};
		expect(await search("saved")).toContain(path);
		expect(await search("proposal")).not.toContain(path);
	});

	test("wc counts the committed text behind a move-only doc", async () => {
		const t = test_convex();
		const path = "/off-overlay-move.md";
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, path, committedMarkdown));
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "off-overlay-moved.md",
		});
		expect(moved._nay).toBeUndefined();

		// A move-only doc has no text, so `wc` must not be sent to the in-memory read path.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path,
		});
		expect(stats).toMatchObject({ usable: true, nodeId: seeded.nodeId, lineCount: 3 });
	});

	test("metadata search reads the proposal's frontmatter until a member save makes it stale", async () => {
		const t = test_convex();
		const path = "/off-overlay-frontmatter.md";
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file(ctx, path, "---\ntitle: committed\n---\n\n# Body\n"),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "---\ntitle: proposal\n---\n\n# Body",
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const search_title = async (value: string) => {
			const result = await t.query(internal.files_metadata.search, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				plan: { op: "eq", fieldPath: "frontmatter.title", value },
				numItems: 20,
				cursor: null,
			});
			return result.items.map((item) => item.path);
		};

		expect(await search_title("proposal")).toContain(path);
		expect(await search_title("committed")).not.toContain(path);

		await save_as_member(t, seeded, "---\ntitle: saved\n---\n\n# Body\n");
		expect(await search_title("saved")).toContain(path);
		expect(await search_title("proposal")).not.toContain(path);
	});

	test("the sidebar search and the by-path metadata door follow the same stale rule", async () => {
		const t = test_convex();
		const path = "/off-overlay-frontmatter-doors.md";
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file(ctx, path, "---\ntitle: committed\n---\n\n# Body\n"),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "---\ntitle: proposal\n---\n\n# Body",
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const search_nodes_title = async (value: string) => {
			const found = await asUser.query(api.files_metadata.search_nodes, {
				membershipId: seeded.membershipId,
				plans: [{ op: "eq", fieldPath: "frontmatter.title", value }],
			});
			return found.targets.map((target) => target.id);
		};
		const title_by_path = async () => {
			const found = await t.query(internal.files_metadata.get_by_path, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path,
			});
			return found?.values.find((value) => value.fieldPath === "frontmatter.title")?.stringValue;
		};

		expect(await search_nodes_title("proposal")).toEqual([seeded.nodeId]);
		expect(await search_nodes_title("committed")).toEqual([]);
		expect(await title_by_path()).toBe("proposal");

		await save_as_member(t, seeded, "---\ntitle: saved\n---\n\n# Body\n");
		expect(await search_nodes_title("saved")).toEqual([seeded.nodeId]);
		expect(await search_nodes_title("proposal")).toEqual([]);
		expect(await title_by_path()).toBe("saved");
	});
});

describe("files_pending_updates_last_sequence_saved", () => {
	test("upsert_file_pending_update and persist_file_pending_update_rebased_state do not write last saved sequence marker", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-marker-non-save-paths",
				name: "pending-edits-save-marker-non-save-paths",
				markdown: "# Save marker base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingUpdateLastSequenceSavedBeforeChanges = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedBeforeChanges).toBeNull();

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const pendingUpdateLastSequenceSavedAfterUpsert = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedAfterUpsert).toBeNull();

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to create unstaged branch while testing save marker non-save paths");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}

		const pendingUpdateLastSequenceSavedAfterPersist = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedAfterPersist).toBeNull();
	});
});

describe("files_pending_updates_db_mark_content_for_rebase", () => {
	test("keeps every owner's content and expiry while leaving structural and copy proposals alone", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/mark.txt", "base\n"));
		const otherUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_mark_other" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return userId;
		});
		for (const userId of [seeded.userId, otherUserId]) {
			expect(
				(
					await upsert_file_pending_update_internal_for_test({
						t,
						...seeded,
						userId,
						unstagedMarkdown: `markedneedle ${userId}\n`,
					})
				)._nay,
			).toBeUndefined();
		}
		expect((await upsert_file_pending_archive_for_test({ t, ...seeded, userId: otherUserId }))._nay).toBeUndefined();

		const before = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			const baseContentVersion = await files_nodes_db_get_content_version(ctx, node!);
			if (!baseContentVersion) throw new Error("Missing saved content version");
			for (const [userId, extra] of [
				[
					"move-owner",
					{ pendingMove: { destParent: { kind: "root" }, destName: "renamed.txt", fromPath: "/mark.txt" } },
				],
				[
					"copy-owner",
					{
						copiedFrom: { target: { kind: "saved", id: seeded.nodeId }, path: "/source.txt" },
						pendingReplacement: {
							assetId: seeded.assetId,
							baseAssetId: seeded.assetId,
							baseContentVersion,
							size: 5,
							contentType: "text/plain",
							yjsRootKind: "plain_text" as const,
						},
					},
				],
			] as const) {
				await ctx.db.insert("files_pending_updates", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: await ctx.db.insert("users", { clerkUserId: userId }),
					target: { kind: "saved", id: seeded.nodeId },
					revision: 1,
					size: 0,
					updatedAt: 123,
					expiresAt: 123 + files_DRAFT_IDLE_EXPIRY_MS,
					...extra,
				});
			}
			for (const userId of [seeded.userId, otherUserId])
				await ctx.db.insert("files_pending_updates_last_sequence_saved", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					fileNodeId: seeded.nodeId,
					lastSequenceSaved: 9,
					updatedAt: 123,
				});
			return {
				docs: await ctx.db.query("files_pending_updates").collect(),
				states: await ctx.db.query("files_pending_update_yjs_states").collect(),
				pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
				chunks: await ctx.db.query("files_text_chunks").collect(),
				checks: await ctx.db.query("files_pending_update_expiry_checks").collect(),
			};
		});

		const searchArgs = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			hasWorkspaceRead: true,
			query: "markedneedle",
			numItems: 10,
			cursor: null,
		};
		expect(
			(await t.query(internal.files_nodes.text_search_files, searchArgs)).items.map((item) => item.path),
		).toContain("/mark.txt");
		await t.run((ctx) => files_pending_updates_db_mark_content_for_rebase(ctx, seeded));
		await t.run((ctx) => files_pending_updates_db_mark_content_for_rebase(ctx, seeded));
		expect((await t.query(internal.files_nodes.text_search_files, searchArgs)).items).toEqual([]);
		const content = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/mark.txt",
			mode: { kind: "full", maxBytes: 1000 },
		});
		expect(content?.content).toBe("base\n");

		await t.run(async (ctx) => {
			for (const doc of before.docs) {
				expect(await ctx.db.get("files_pending_updates", doc._id)).toEqual(
					doc.content ? { ...doc, contentNeedsRebase: true, revision: doc.revision + 1 } : doc,
				);
			}
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toEqual(before.states);
			expect(await ctx.db.query("files_pending_update_yjs_state_pages").collect()).toEqual(before.pages);
			expect(await ctx.db.query("files_text_chunks").collect()).toEqual(before.chunks);
			expect(await ctx.db.query("files_pending_update_expiry_checks").collect()).toEqual(before.checks);
			expect(await ctx.db.query("files_pending_updates_last_sequence_saved").collect()).toEqual([]);
		});
	});

	test("removes saved markers even when there is no content proposal", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/mark-empty.txt", "base\n"));
		await t.run(async (ctx) => {
			await ctx.db.insert("files_pending_updates_last_sequence_saved", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				fileNodeId: seeded.nodeId,
				lastSequenceSaved: 9,
				updatedAt: 123,
			});
			await files_pending_updates_db_mark_content_for_rebase(ctx, seeded);
			expect(await ctx.db.query("files_pending_updates_last_sequence_saved").collect()).toEqual([]);
		});
	});
});

describe("files_db_get_pending_update", () => {
	test("keeps saved targets, private targets, and owners separate", async () => {
		const t = test_convex();
		await t.run(async (ctx) => {
			const seeded = await seed_non_collaborative_file(ctx, "/target-lookup.txt", "base");
			const { organizationId, workspaceId, userId } = seeded;
			const otherUserId = await ctx.db.insert("users", { clerkUserId: "other-pending-owner" });
			const privateNodeId = await ctx.db.insert("files_pending_nodes", {
				organizationId,
				workspaceId,
				userId,
				kind: "folder",
				name: "private",
				parent: { kind: "root" },
				creationGeneration: 1,
				structuralRevision: 1,
				state: "active",
				closedAt: null,
			});
			const savedId = await ctx.db.insert("files_pending_updates", {
				organizationId,
				workspaceId,
				userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			});
			const privateId = await ctx.db.insert("files_pending_updates", {
				organizationId,
				workspaceId,
				userId,
				target: { kind: "private", id: privateNodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			});
			expect(
				(
					await files_db_get_pending_update(ctx, {
						organizationId,
						workspaceId,
						userId,
						target: { kind: "private", id: privateNodeId },
						pendingUpdateId: savedId,
					})
				)?._id,
			).toBe(privateId);
			expect(
				(
					await files_db_get_pending_update(ctx, {
						organizationId,
						workspaceId,
						userId,
						target: { kind: "saved", id: seeded.nodeId },
						pendingUpdateId: privateId,
					})
				)?._id,
			).toBe(savedId);
			expect(
				await files_db_get_pending_update(ctx, {
					organizationId,
					workspaceId,
					userId: otherUserId,
					target: { kind: "private", id: privateNodeId },
					pendingUpdateId: privateId,
				}),
			).toBeNull();
		});
	});
});

describe("get_file_pending_update", () => {
	test.each(["plain_text", "rich_text"] as const)(
		"returns the current document id with marked and prepared %s content",
		async (rootKind) => {
			const t = test_convex();
			const path = rootKind === "rich_text" ? "/query-current.md" : "/query-current.txt";
			const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, path, "base\n"));
			r2Objects.set(`content-snapshot${path}`, "base\n");
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...seeded,
						unstagedMarkdown: "proposed\n",
					})
				)._nay,
			).toBeUndefined();
			const original = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!original) throw new Error("Expected the original proposal");
			const queryArgs = {
				membershipId: seeded.membershipId,
				target: { kind: "saved" as const, id: seeded.nodeId },
				pendingUpdateId: original._id,
			};
			expect(await asUser.query(api.files_pending_updates.get_file_pending_update, queryArgs)).toEqual({
				...original,
				currentYjsLastSequenceId: null,
			});

			for (const collaborative of [true, false]) {
				const toggled = collaborative
					? await asUser.action(api.files_nodes_content.set_file_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
						})
					: await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							acknowledgeDropCollaborativeHistory: true,
						});
				expect(toggled._nay).toBeUndefined();
				const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
				const currentYjsLastSequenceId = node?.yjsLastSequenceId ?? null;
				if (collaborative) expect(currentYjsLastSequenceId).not.toBeNull();
				else expect(currentYjsLastSequenceId).toBeNull();
				const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", original._id));
				expect(marked?.contentNeedsRebase).toBe(true);
				expect(await asUser.query(api.files_pending_updates.get_file_pending_update, queryArgs)).toEqual({
					...marked,
					currentYjsLastSequenceId,
				});
				const prepared = await asUser.action(
					api.files_pending_updates.prepare_file_pending_update_for_review,
					queryArgs,
				);
				expect(prepared._nay).toBeUndefined();
				expect(prepared._yay?.pendingUpdate?.contentNeedsRebase).toBeUndefined();
				expect(await asUser.query(api.files_pending_updates.get_file_pending_update, queryArgs)).toEqual({
					...prepared._yay?.pendingUpdate,
					currentYjsLastSequenceId,
				});
			}

			const other = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "clerk_query_other" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					active: true,
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return { userId, membershipId };
			});
			const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId, name: "Other Member" });
			expect(
				await asOther.query(api.files_pending_updates.get_file_pending_update, {
					...queryArgs,
					membershipId: other.membershipId,
				}),
			).toBeNull();
		},
	);
});

describe("pending text after restore and collaborative edits", () => {
	async function seed_proposal(args: {
		rootKind: "plain_text" | "rich_text";
		collaborative: boolean;
		base: string;
		staged: string;
		unstaged: string;
	}) {
		const t = test_convex();
		const path = args.rootKind === "rich_text" ? "/accepted-changes.md" : "/accepted-changes.txt";
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, path, args.base));
		r2Objects.set(`content-snapshot${path}`, args.base);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		if (args.collaborative) {
			expect(
				(
					await asUser.action(api.files_nodes_content.set_file_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
					})
				)._nay,
			).toBeUndefined();
		}
		// Create the branches after enabling collaboration so they share the live history.
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await read_seeded_pending_row(t, seeded);
		const proposalArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, proposalArgs };
	}

	async function push_live_edit(fixture: Awaited<ReturnType<typeof seed_proposal>>, edit: (doc: YDoc) => void) {
		const { t, seeded, asUser } = fixture;
		const live = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
		const before = files_yjs_doc_create_from_array_buffer_update(live.yjsUpdate);
		const after = files_yjs_doc_clone({ yjsDoc: before });
		try {
			edit(after);
			const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: after, yjsBeforeDoc: before });
			if (!update) throw new Error("Expected a live edit");
			expect(
				(
					await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
						update: files_u8_to_array_buffer(update),
						sessionId: "accepted-changes-live-edit",
					})
				)._nay,
			).toBeUndefined();
		} finally {
			before.destroy();
			after.destroy();
		}
	}

	async function save_staged_then_accept_remaining(
		fixture: Awaited<ReturnType<typeof seed_proposal>>,
		args: { rootKind: "plain_text" | "rich_text"; collaborative: boolean; staged: string; unstaged: string },
	) {
		const { t, seeded, asUser, proposalArgs } = fixture;
		const readCurrent = () =>
			t.run((ctx) =>
				args.collaborative
					? read_file_markdown_from_yjs({ ctx, ...seeded, rootKind: args.rootKind })
					: read_committed_text({ ctx, ...seeded }),
			);
		const reviewed = await read_seeded_pending_row(t, seeded);
		expect(
			(
				await asUser.action(api.files_pending_updates.save_file_pending_update, {
					...proposalArgs,
					reviewedRevision: reviewed.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await readCurrent()).toBe(args.staged);
		const remaining = await read_seeded_pending_row(t, seeded);
		expect(remaining._id).toBe(reviewed._id);
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind: args.rootKind })),
		).toEqual({
			baseMarkdown: args.staged,
			stagedMarkdown: args.staged,
			unstagedMarkdown: args.unstaged,
		});
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...proposalArgs,
					nodeId: proposalArgs.target.id,
					reviewedRevision: remaining.revision,
					stagedMarkdown: args.unstaged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const accepted = await read_seeded_pending_row(t, seeded);
		expect(
			(
				await asUser.action(api.files_pending_updates.save_file_pending_update, {
					...proposalArgs,
					reviewedRevision: accepted.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await readCurrent()).toBe(args.unstaged);
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();
		if (args.collaborative) {
			const live = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
			const doc = files_yjs_doc_create_from_array_buffer_update(live.yjsUpdate);
			expect(doc.store.pendingStructs).toBeNull();
			expect(doc.store.pendingDs).toBeNull();
			doc.destroy();
		}
	}

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((sourceRootKind) =>
			[false, true].map((collaborative) => ({ sourceRootKind, collaborative })),
		),
	)(
		"prepares a $sourceRootKind shape-changing restore and saves both branches (collaboration $collaborative)",
		async ({ sourceRootKind, collaborative }) => {
			const rootKind = sourceRootKind === "plain_text" ? "rich_text" : "plain_text";
			const base = "Budget: 100\n\nOwner: Bob\n\nTail: old\n";
			const staged = base.replace("100", "150");
			const unstaged = base.replace("100", "170");
			const fixture = await seed_proposal({ rootKind: sourceRootKind, collaborative, base, staged, unstaged });
			const { t, seeded, asUser, original, proposalArgs } = fixture;

			const restoredText = base.replace("100", "120").replace("Bob", "Alice");
			const snapshotId = await t.run(async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-bucket",
					size: files_get_utf8_byte_size(restoredText),
					createdBy: seeded.userId,
					updatedAt: Date.now(),
				});
				const r2Key = `test/accepted-restore-${assetId}`;
				r2Objects.set(r2Key, restoredText);
				await ctx.db.patch("files_r2_assets", assetId, { r2Key });
				return await ctx.db.insert("files_snapshots", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					fileNodeId: seeded.nodeId,
					assetId,
					createdBy: seeded.userId,
					archivedAt: 0,
					contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: rootKind,
					collaborationEnabled: true,
				});
			});

			expect(
				(
					await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						snapshotId,
						sessionId: "accepted-shape-restore",
					})
				)._nay,
			).toBeUndefined();
			expect(await read_seeded_pending_row(t, seeded)).toEqual({
				...original,
				revision: original.revision + 1,
				contentNeedsRebase: true,
				contentRebaseRootKind: sourceRootKind,
			});

			// Preparation uses the latest saved text, including edits made after the restore.
			const current = restoredText.replace("Tail: old", "Tail: current");
			if (collaborative) {
				await push_live_edit(fixture, (doc) => {
					expect(files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: current, rootKind })._nay).toBeUndefined();
				});
			} else {
				await save_as_member(t, seeded, current);
			}

			const result = await asUser.action(
				api.files_pending_updates.prepare_file_pending_update_for_review,
				proposalArgs,
			);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared.contentNeedsRebase).toBeUndefined();
			expect(prepared.contentRebaseRootKind).toBeUndefined();
			const mergedStaged = current.replace("120", "150");
			const mergedUnstaged = current.replace("120", "170");
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: current,
					stagedMarkdown: mergedStaged,
					unstagedMarkdown: mergedUnstaged,
				},
			);

			await save_staged_then_accept_remaining(fixture, {
				rootKind,
				collaborative,
				staged: mergedStaged,
				unstaged: mergedUnstaged,
			});
		},
	);

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((rootKind) =>
			[false, true].flatMap((collaborative) =>
				["120", "200"].map((savedBudget) => ({ rootKind, collaborative, savedBudget })),
			),
		),
	)(
		"saves accepted 150 over saved $savedBudget and keeps proposed 170 in $rootKind (collaboration $collaborative)",
		async ({ rootKind, collaborative, savedBudget }) => {
			const base = "Budget: 100\n\nOwner: Bob\n";
			const fixture = await seed_proposal({
				rootKind,
				collaborative,
				base,
				staged: base.replace("100", "150"),
				unstaged: base.replace("100", "170"),
			});
			const { t, seeded, asUser, proposalArgs } = fixture;
			const current = base.replace("100", savedBudget).replace("Bob", "Alice");

			if (collaborative) {
				await push_live_edit(fixture, (doc) => {
					expect(files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: current, rootKind })._nay).toBeUndefined();
				});
			} else {
				await save_as_member(t, seeded, current);
				const result = await asUser.action(
					api.files_pending_updates.prepare_file_pending_update_for_review,
					proposalArgs,
				);
				expect(result._nay).toBeUndefined();
			}

			// A collaborative Save also merges changes that arrived after the review.
			await save_staged_then_accept_remaining(fixture, {
				rootKind,
				collaborative,
				staged: current.replace(savedBudget, "150"),
				unstaged: current.replace(savedBudget, "170"),
			});
		},
	);

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((rootKind) =>
			(["delete", "move"] as const).flatMap((edit) => [false, true].map((prepare) => ({ rootKind, edit, prepare }))),
		),
	)(
		"keeps a proposed section after a shared-history $edit in $rootKind (prepare $prepare)",
		async ({ rootKind, edit, prepare }) => {
			const base = "First section.\n\nTarget section.\n\nLast section.\n";
			const fixture = await seed_proposal({
				rootKind,
				collaborative: true,
				base,
				staged: base.replace("Target section.", "Target accepted."),
				unstaged: base.replace("Target section.", "Target proposed."),
			});
			const { t, seeded, asUser, original, proposalArgs } = fixture;
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));

			await push_live_edit(fixture, (doc) => {
				if (rootKind === "rich_text") {
					const fragment = doc.getXmlFragment("default");
					const moved = fragment.get(1).clone();
					fragment.delete(1, 1);
					if (edit === "move") fragment.insert(fragment.length, [moved]);
				} else {
					const text = doc.getText("plain_text");
					text.delete(base.indexOf("Target section."), "Target section.\n\n".length);
					if (edit === "move") text.insert(text.length, "\nTarget section.\n");
				}
				const text = files_yjs_doc_get_text({ yjsDoc: doc, rootKind });
				if (text._nay) throw new Error(text._nay.message);
				expect(
					files_yjs_doc_update_from_text({
						mut_yjsDoc: doc,
						rootKind,
						text: text._yay.replace("Last section.", "Last changed."),
					})._nay,
				).toBeUndefined();
			});
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
			const current =
				edit === "move" ? "First section.\n\nLast changed.\n\nTarget section.\n" : "First section.\n\nLast changed.\n";
			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(current);

			const staged =
				edit === "move"
					? current.replace("Target section.", "Target accepted.")
					: "First section.\n\nTarget accepted.\n\nLast changed.\n";
			const unstaged = staged.replace("Target accepted.", "Target proposed.");

			if (prepare) {
				const result = await asUser.action(
					api.files_pending_updates.prepare_file_pending_update_for_review,
					proposalArgs,
				);
				expect(result._nay).toBeUndefined();
				const pendingUpdate = result._yay?.pendingUpdate;
				if (!pendingUpdate) throw new Error("Expected the prepared proposal");
				expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind }))).toEqual({
					baseMarkdown: current,
					stagedMarkdown: staged,
					unstagedMarkdown: unstaged,
				});
			}

			await save_staged_then_accept_remaining(fixture, { rootKind, collaborative: true, staged, unstaged });
		},
	);

	test.each([false, true])("refuses Save from an older accepted pane (collaboration %s)", async (collaborative) => {
		const base = "Budget: 100\n";
		const { t, seeded, asUser, original, proposalArgs } = await seed_proposal({
			rootKind: "plain_text",
			collaborative,
			base,
			staged: "Budget: 150\n",
			unstaged: "Budget: 170\n",
		});

		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...proposalArgs,
					nodeId: proposalArgs.target.id,
					reviewedRevision: original.revision,
					stagedMarkdown: "Budget: 160\n",
					unstagedMarkdown: "Budget: 170\n",
				})
			)._nay,
		).toBeUndefined();
		const newer = await read_seeded_pending_row(t, seeded);
		expect(newer.updatedAt).not.toBe(original.updatedAt);

		const result = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			...proposalArgs,
			reviewedRevision: original.revision,
		});

		expect(result._nay).toBeDefined();
		expect(await read_seeded_pending_row(t, seeded)).toEqual(newer);
		expect(
			await t.run((ctx) =>
				collaborative
					? read_file_markdown_from_yjs({ ctx, ...seeded, rootKind: "plain_text" })
					: read_committed_text({ ctx, ...seeded }),
			),
		).toBe(base);
	});
});

describe("prepare_file_pending_update_for_agent upload in flight", () => {
	test("refuses a file whose upload has not landed, then allows it after landing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const ids = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 10,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 60 * 1000,
				updatedAt: now,
			});
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: files_ROOT_ID,
				path: "/uploading.txt",
				treePath: "/uploading.txt",
				pathDepth: 1,
				lowercaseExtension: "txt",
				name: "uploading.txt",
				sortName: files_sort_text_key("uploading.txt"),
				kind: "file",
				contentType: "text/plain",
				assetId,
				contentByteSize: null,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,
				archiveOperationId: null,
			});
			return { assetId, nodeId };
		});

		const args = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved" as const, id: ids.nodeId },
		};
		const refused = await t.action(internal.files_pending_updates.prepare_file_pending_update_for_agent, args);
		expect(refused._nay).toMatchObject({ name: "upload_in_progress" });

		await t.run(async (ctx) => ctx.db.patch("files_r2_assets", ids.assetId, { r2Key: "landed-key" }));
		const allowed = await t.action(internal.files_pending_updates.prepare_file_pending_update_for_agent, args);
		expect(allowed._nay?.name).not.toBe("upload_in_progress");
	});
});

describe("prepare_file_pending_update_for_review after a member save", () => {
	async function seed_stale_proposal(args: {
		base: string;
		staged: string;
		unstaged: string;
		current: string;
		rootKind?: "plain_text" | "rich_text";
	}) {
		const t = test_convex();
		const rootKind = args.rootKind ?? "plain_text";
		const path = rootKind === "rich_text" ? "/saved-proposal.md" : "/saved-proposal.txt";
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, path, args.base));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await read_seeded_pending_row(t, seeded);
		const currentAssetId = await save_as_member(t, seeded, args.current);
		expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
		expect(original.contentNeedsRebase).toBeUndefined();
		const prepareArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, currentAssetId, prepareArgs, rootKind };
	}

	test.each(["plain_text", "rich_text"] as const)(
		"merges saved %s text and keeps accepted and proposed changes separate",
		async (rootKind) => {
			const base = "first\n\nsecond\n\nlast\n";
			const staged = base.replace("first", "FIRST");
			const unstaged = staged.replace("second", "SECOND");
			const current = base.replace("last", "LAST");
			const { t, seeded, asUser, original, currentAssetId, prepareArgs } = await seed_stale_proposal({
				base,
				staged,
				unstaged,
				current,
				rootKind,
			});
			const savesBefore = file_save_events().length;

			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared._id).toBe(original._id);
			expect(prepared.content?.base).toEqual({ kind: "asset", assetId: currentAssetId });
			expect(prepared.content?.baseStateId).not.toBe(original.content?.baseStateId);
			expect(prepared.contentNeedsRebase).toBeUndefined();
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: current,
					stagedMarkdown: staged.replace("last", "LAST"),
					unstagedMarkdown: unstaged.replace("last", "LAST"),
				},
			);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(current);
			expect(file_save_events()).toHaveLength(savesBefore);

			// A second Review does not replace a family that is already current.
			expect(
				await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs),
			).toEqual(result);

			expect(
				(
					await asUser.action(api.files_pending_updates.save_file_pending_update, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(staged.replace("last", "LAST"));
			const remaining = await read_seeded_pending_row(t, seeded);
			expect(
				(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind })))
					.unstagedMarkdown,
			).toBe(unstaged.replace("last", "LAST"));
		},
	);

	test.each(["plain_text", "rich_text"] as const)(
		"keeps accepted and proposed %s text on overlap without publishing it",
		async (rootKind) => {
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base: "old\n",
				staged: "accepted\n",
				unstaged: "proposed\n",
				current: "saved\n",
				rootKind,
			});
			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared._id).toBe(original._id);
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: "saved\n",
					stagedMarkdown: "accepted\n",
					unstagedMarkdown: "proposed\n",
				},
			);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);

	test.each(["plain_text", "rich_text"] as const)(
		"settles already saved %s changes without another file save",
		async (rootKind) => {
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base: "old\n",
				staged: "saved\n",
				unstaged: "saved\n",
				current: "saved\n",
				rootKind,
			});
			const savesBefore = file_save_events().length;
			expect(
				await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs),
			).toEqual({ _yay: { pendingUpdate: null } });
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", original._id))).toBeNull();
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
			expect(file_save_events()).toHaveLength(savesBefore);
		},
	);

	test.each(["write", "refresh", "settle"] as const)("refuses a stale %s and preserves the proposal", async (phase) => {
		const { t, seeded, original } = await seed_stale_proposal({
			base: "base\n",
			staged: "base\n",
			unstaged: "proposal\n",
			current: "saved\n",
		});
		const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));

		if (phase === "write") {
			const result = await upsert_file_pending_update_internal_for_test({
				t,
				...seeded,
				pendingUpdateId: original._id,
				unstagedMarkdown: "new proposal\n",
			});
			expect(result._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		} else {
			const batch = await t.mutation(
				internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
				{
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					target: { kind: "saved", id: seeded.nodeId },
				},
			);
			if (batch._nay) throw new Error(batch._nay.message);
			const args = {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: batch._yay.operationBatchId,
				pendingUpdateId: original._id,
				expectedRevision: original.revision,
			};
			const result =
				phase === "refresh"
					? await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, args)
					: await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, args);
			expect(result._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		}

		expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
		expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
	});

	test.each(["changed text", "same text"] as const)(
		"refuses preparation if a second save publishes %s before commit",
		async (secondSave) => {
			const current = "base\n\nsaved\n";
			const { t, seeded, asUser, original, currentAssetId, prepareArgs } = await seed_stale_proposal({
				base: "base\n\nlast\n",
				staged: "BASE\n\nlast\n",
				unstaged: "BASE\n\nlast\n",
				current,
			});
			if (!original.content) throw new Error("Expected content branches");
			const family = await seal_output_family_for_test(t, seeded);
			const nextText = secondSave === "same text" ? current : "base\n\nnewer save\n";
			await save_as_member(t, seeded, nextText);

			const result = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: prepareArgs.pendingUpdateId,
				operationBatchId: family.operationBatchId,
				expectedRevision: original.revision,
				base: { kind: "asset", expectedAssetId: currentAssetId },
				preparation: {
					sourceBaseStateId: original.content.baseStateId,
					sourceStagedStateId: original.content.stagedStateId,
					sourceUnstagedStateId: original.content.unstagedStateId,
					rootKind: "plain_text",
					hasChanges: true,
				},
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "BASE\n\nsaved\n",
			});

			expect(result._nay?.message).toBe(
				"Pending update base is stale and must be rebuilt from the latest live file state",
			);
			expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(nextText);

			// This test calls the final mutation directly. Its owning action retires refused output.
			await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId: family.operationBatchId,
			});
		},
	);

	test.each(["staged", "unstaged"] as const)(
		"keeps a stale proposal when merged %s text exceeds the limit",
		async (branch) => {
			const base = "first\nlast\n";
			const proposed = `${"a".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n${base}`;
			const current = `${base}${"z".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n`;
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base,
				staged: branch === "staged" ? proposed : base,
				unstaged: proposed,
				current,
			});
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));
			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay?.message).toBe(`Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`);
			expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(current);
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);
});

describe("prepare_file_pending_update_for_review", () => {
	async function seed_marked_proposal(args: {
		base: string;
		staged: string;
		unstaged: string;
		current?: string;
		rootKind?: "plain_text" | "rich_text";
		target?: "yjs" | "asset";
		ordinaryMember?: boolean;
	}) {
		const t = test_convex();
		const rootKind = args.rootKind ?? "plain_text";
		const path = rootKind === "rich_text" ? "/prepare.md" : "/prepare.txt";
		const file = await t.run((ctx) => seed_non_collaborative_file(ctx, path, args.base));
		const member = args.ordinaryMember
			? await t.run(async (ctx) => {
					const userId = await ctx.db.insert("users", { clerkUserId: "clerk_preparation_member" });
					await seed_billing_snapshot_for_user(ctx, userId);
					const membershipId = await ctx.db.insert("organizations_workspaces_users", {
						organizationId: file.organizationId,
						workspaceId: file.workspaceId,
						userId,
						active: true,
					});
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: file.organizationId,
						workspaceId: file.workspaceId,
						userId,
						role: "member",
						now: Date.now(),
					});
					return { userId, membershipId };
				})
			: null;
		const seeded = member ? { ...file, ...member } : file;
		r2Objects.set(`content-snapshot${path}`, args.base);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!original) throw new Error("Expected the original proposal");
		if (args.current !== undefined) await save_as_member(t, seeded, args.current);
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: seeded.membershipId,
					nodeId: seeded.nodeId,
				})
			)._nay,
		).toBeUndefined();
		if (args.target === "asset") {
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
		}
		const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", original._id));
		if (!marked) throw new Error("Expected the proposal after the toggle");
		expect(marked.contentNeedsRebase).toBe(true);
		const prepareArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, marked, prepareArgs, rootKind, ownerUserId: file.userId };
	}

	test.each(["staged", "unstaged"] as const)("keeps the proposal when merged %s text exceeds a cap", async (branch) => {
		const fields = (prefix: string) =>
			Array.from(
				{ length: Math.floor(files_metadata_MAX_FRONTMATTER_FIELDS / 2) },
				(_, index) => `${prefix}${index}: value\n`,
			).join("");
		const markdownBase = "---\nfirst: base\nmiddle: base\nlast: base\n---\n\nbody\n";

		for (const fixture of [
			{
				rootKind: "plain_text" as const,
				base: "first\nlast\n",
				proposed: `${"a".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\nfirst\nlast\n`,
				current: `first\nlast\n${"z".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n`,
				message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`,
			},
			{
				rootKind: "rich_text" as const,
				base: markdownBase,
				proposed: markdownBase.replace("first: base\n", `first: base\n${fields("proposed")}`),
				current: markdownBase.replace("last: base\n", `last: base\n${fields("current")}`),
				message: "Too many frontmatter fields",
			},
		]) {
			const { t, seeded, asUser, marked, prepareArgs } = await seed_marked_proposal({
				...fixture,
				staged: branch === "staged" ? fixture.proposed : fixture.base,
				unstaged: fixture.proposed,
				target: "asset",
			});
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }));
			const eventsBefore = file_save_events().length;

			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay?.message).toBe(fixture.message);

			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }))).toEqual(bytes);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
			expect(file_save_events()).toHaveLength(eventsBefore);
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches).toHaveLength(1);
			expect(batches[0]?.expiresAt).toBe(0);
		}
	});

	test.each(["plain_text", "rich_text"] as const)(
		"keeps exact %s text across partial save, live edit, and second save",
		async (rootKind) => {
			const base = "title\n\nfirst\n\nsecond\n\nlast\n";
			const staged = base.replace("first", "FIRST");
			const unstaged = staged.replace("second", "SECOND");
			const { t, seeded, asUser, prepareArgs } = await seed_marked_proposal({ base, staged, unstaged, rootKind });

			const prepared = await asUser.action(
				api.files_pending_updates.prepare_file_pending_update_for_review,
				prepareArgs,
			);
			expect(prepared._nay).toBeUndefined();
			const pendingUpdate = prepared._yay?.pendingUpdate;
			if (!pendingUpdate) throw new Error("Expected the prepared proposal");
			expect(pendingUpdate.content?.base).toMatchObject({ kind: "yjs", sequence: 0 });
			expect(pendingUpdate.contentNeedsRebase).toBeUndefined();
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind }))).toEqual({
				baseMarkdown: base,
				stagedMarkdown: staged,
				unstagedMarkdown: unstaged,
			});

			expect(
				(
					await asUser.action(api.files_pending_updates.save_file_pending_update, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();
			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(staged);

			const live = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
			const beforeDoc = files_yjs_doc_create_from_array_buffer_update(live.yjsUpdate);
			const editedDoc = files_yjs_doc_clone({ yjsDoc: beforeDoc });
			expect(
				files_yjs_doc_update_from_text({ mut_yjsDoc: editedDoc, text: staged.replace("last", "LAST"), rootKind })._nay,
			).toBeUndefined();
			const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: editedDoc, yjsBeforeDoc: beforeDoc });
			if (!update) throw new Error("Expected the live edit update");
			expect(
				(
					await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
						update: files_u8_to_array_buffer(update),
						sessionId: "preparation-intervening-edit",
					})
				)._nay,
			).toBeUndefined();
			beforeDoc.destroy();
			editedDoc.destroy();

			const remaining = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!remaining) throw new Error("Expected the unaccepted second change");
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...prepareArgs,
						nodeId: prepareArgs.target.id,
						reviewedRevision: remaining.revision,
						stagedMarkdown: unstaged,
						unstagedMarkdown: unstaged,
					})
				)._nay,
			).toBeUndefined();

			expect(
				(
					await asUser.action(api.files_pending_updates.save_file_pending_update, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(
				unstaged.replace("last", "LAST"),
			);
			expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();
		},
	);

	test.each([
		{
			name: "disjoint edits",
			base: "a\nb\nc\n",
			staged: "A\nb\nc\n",
			unstaged: "A\nb\nC\n",
			current: "a\nB\nc\n",
			mergedStaged: "A\nB\nc\n",
			mergedUnstaged: "A\nB\nC\n",
		},
		{
			name: "identical overlaps",
			base: "a\nb\n",
			staged: "A\nb\n",
			unstaged: "A\nB\n",
			current: "A\nb\n",
			mergedStaged: "A\nb\n",
			mergedUnstaged: "A\nB\n",
		},
		{
			name: "overlapping Unicode lines with the accepted line kept",
			base: "😀 old\nlast\n",
			staged: "😃 old\nlast\n",
			unstaged: "😃 old\nlast!\n",
			current: "😀 new\nlast\n",
			mergedStaged: "😃 old\nlast\n",
			mergedUnstaged: "😃 old\nlast!\n",
		},
	])("merges $name without publishing text", async (fixture) => {
		const { t, asUser, seeded, prepareArgs } = await seed_marked_proposal({ ...fixture, target: "asset" });
		const eventsBefore = file_save_events().length;

		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result._nay).toBeUndefined();
		const pendingUpdate = result._yay?.pendingUpdate;
		if (!pendingUpdate) throw new Error("Expected the merged proposal");

		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: fixture.current,
			stagedMarkdown: fixture.mergedStaged,
			unstagedMarkdown: fixture.mergedUnstaged,
		});
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test.each([
		{ base: "old\n", staged: "proposal\n", unstaged: "proposal\n", current: "other\n" },
		{ base: "start end\n", staged: "start Aend\n", unstaged: "start Aend\n", current: "start Bend\n" },
	])("keeps the proposed line on an overlap ($base)", async (fixture) => {
		const { t, seeded, asUser, prepareArgs } = await seed_marked_proposal({ ...fixture, target: "asset" });
		const eventsBefore = file_save_events().length;
		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result._nay).toBeUndefined();
		const pendingUpdate = result._yay?.pendingUpdate;
		if (!pendingUpdate) throw new Error("Expected the prepared proposal");
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: fixture.current,
			stagedMarkdown: fixture.staged,
			unstagedMarkdown: fixture.unstaged,
		});
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches).toHaveLength(0);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test("settles an identical proposal without a file save", async () => {
		const { t, asUser, prepareArgs } = await seed_marked_proposal({
			base: "old\n",
			staged: "new\n",
			unstaged: "new\n",
			current: "new\n",
		});
		const eventsBefore = file_save_events().length;
		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result).toEqual({ _yay: { pendingUpdate: null } });
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", prepareArgs.pendingUpdateId))).toBeNull();
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test("refuses direct writes before preparation and from an old pane after preparation", async () => {
		const { t, asUser, marked, prepareArgs } = await seed_marked_proposal({
			base: "base\n",
			staged: "base\n",
			unstaged: "proposed\n",
		});
		const oldWrite = {
			...prepareArgs,
			nodeId: prepareArgs.target.id,
			reviewedRevision: marked.revision,
			stagedMarkdown: "proposed\n",
			unstagedMarkdown: "proposed\n",
		};
		expect((await upsert_file_pending_update_public_for_test(asUser, oldWrite))._nay?.message).toContain(
			"Update the proposal",
		);
		expect(
			(
				await asUser.action(api.files_pending_updates.save_file_pending_update, {
					...prepareArgs,
					...(await reviewed_pending_for_test(t, prepareArgs)),
				})
			)._nay?.message,
		).toContain("Update the proposal");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);
		const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(prepared._nay).toBeUndefined();
		expect((await upsert_file_pending_update_public_for_test(asUser, oldWrite))._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(prepared._yay?.pendingUpdate);
	});

	test.each([
		"live edit",
		"no-change live edit",
		"mode cycle",
		"discard",
		"replacement proposal",
		"lock",
		"membership loss",
		"write access loss",
	] as const)("refuses a %s while preparation is in flight", async (race) => {
		const noChange = race === "no-change live edit";
		const { t, asUser, seeded, marked, prepareArgs, ownerUserId } = await seed_marked_proposal({
			base: "base\n",
			staged: "proposal\n",
			unstaged: "proposal\n",
			current: noChange ? "proposal\n" : undefined,
			ordinaryMember: race === "write access loss",
		});

		const normalFetch = globalThis.fetch;
		let release: (() => void) | undefined;
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		let announce: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announce?.();
					await paused;
				}
				return await normalFetch(input, init);
			}),
		);

		const preparing = asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		await started;

		let replacementId: Id<"files_pending_updates"> | undefined;
		try {
			if (race === "mode cycle") {
				const beforePointers = await test_get_file_yjs_pointers(t, seeded.nodeId);
				expect(
					(
						await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							acknowledgeDropCollaborativeHistory: true,
						})
					)._nay,
				).toBeUndefined();
				expect(
					(
						await asUser.action(api.files_nodes_content.set_file_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
						})
					)._nay,
				).toBeUndefined();
				expect((await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId).not.toBe(
					beforePointers.yjsLastSequenceId,
				);
			} else if (race === "discard" || race === "replacement proposal") {
				expect(
					(
						await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
							...prepareArgs,
							...(await reviewed_pending_for_test(t, prepareArgs)),
						})
					)._nay,
				).toBeUndefined();
				if (race === "replacement proposal") {
					// A stalled preparation can lose its batch to the existing idle takeover.
					vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 1000 + 1);
					expect(
						(
							await upsert_file_pending_update_public_for_test(asUser, {
								membershipId: seeded.membershipId,
								nodeId: seeded.nodeId,
								unstagedMarkdown: "replacement\n",
							})
						)._nay,
					).toBeUndefined();
					replacementId = (await t.run((ctx) => read_pending_update_row({ ctx, ...seeded })))?._id;
					expect(replacementId).not.toBe(marked._id);
				}
			} else if (race === "lock") {
				await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
			} else if (race === "membership loss") {
				await t.run((ctx) => ctx.db.delete("organizations_workspaces_users", seeded.membershipId));
			} else if (race === "write access loss") {
				const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: ownerUserId, name: "Owner" });
				expect(
					(
						await asOwner.mutation(api.access_control.set_user_role, {
							organizationId: seeded.organizationId,
							workspaceId: seeded.workspaceId,
							userId: seeded.userId,
							role: "viewer",
						})
					)._nay,
				).toBeUndefined();
			} else {
				const state = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
				const before = files_yjs_doc_create_from_array_buffer_update(state.yjsUpdate);
				const after = files_yjs_doc_clone({ yjsDoc: before });
				expect(
					files_yjs_doc_update_from_text({ mut_yjsDoc: after, rootKind: "plain_text", text: "newer live text\n" })._nay,
				).toBeUndefined();
				const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: after, yjsBeforeDoc: before });
				if (!update) throw new Error("Expected the intervening live edit");
				expect(
					(
						await asUser.mutation(api.files_nodes.yjs_push_update, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
							update: files_u8_to_array_buffer(update),
							sessionId: "preparation-race",
						})
					)._nay,
				).toBeUndefined();
				before.destroy();
				after.destroy();
			}
		} finally {
			release?.();
		}

		const result = await preparing;
		expect(result._nay).toBeDefined();
		if (race === "lock") expect(result._nay?.name).toBe("read_only");
		if (race === "membership loss") expect(result._nay?.message).toBe("Unauthorized");
		if (race === "write access loss") expect(result._nay?.message).toBe("Permission denied");
		if (race === "discard" || race === "replacement proposal") {
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toBeNull();
			if (replacementId)
				expect(
					(await t.run((ctx) => ctx.db.get("files_pending_updates", replacementId)))?.contentNeedsRebase,
				).toBeUndefined();
		} else expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);

		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches).toHaveLength(1);
		expect(batches[0]?.expiresAt).toBe(0);
	});

	test.each(["plain_text", "rich_text"] as const)(
		"keeps and prepares a %s proposal after turning collaboration off",
		async (rootKind) => {
			const t = test_convex();
			const seeded = await t.run(async (ctx) => {
				const file = await seed_signed_in_file_with_markdown({
					ctx,
					path: "/prepare-off",
					name: "prepare-off",
					markdown: "base\n",
					rootKind,
				});
				await seed_committed_chunks_for_file({ ctx, ...file, path: "/prepare-off", markdown: file.baseMarkdown });
				return file;
			});
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });

			const proposed = "base\n\nproposed\n";
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...seeded,
						stagedMarkdown: proposed,
						unstagedMarkdown: proposed,
					})
				)._nay,
			).toBeUndefined();

			const before = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!before) throw new Error("Expected the proposal before turning collaboration off");
			const beforeBytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: before }));

			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
			const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", before._id));
			expect(marked).toMatchObject({ ...before, revision: before.revision + 1, contentNeedsRebase: true });
			if (!marked) throw new Error("Expected the proposal to survive the toggle");
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }))).toEqual(beforeBytes);

			const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: before._id,
			});
			expect(prepared._nay).toBeUndefined();
			expect(prepared._yay?.pendingUpdate).toMatchObject({ _id: before._id });
			expect(prepared._yay?.pendingUpdate?.contentNeedsRebase).toBeUndefined();
			expect(prepared._yay?.pendingUpdate?.content?.base).toEqual({ kind: "asset", assetId: expect.any(String) });

			expect(
				(
					await asUser.action(api.files_pending_updates.save_file_pending_update, {
						membershipId: seeded.membershipId,
						target: { kind: "saved", id: seeded.nodeId },
						...(await reviewed_pending_for_test(t, {
							membershipId: seeded.membershipId,
							target: { kind: "saved", id: seeded.nodeId },
							pendingUpdateId: before._id,
						})),
						pendingUpdateId: before._id,
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(proposed);
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", before._id))).toBeNull();
		},
	);
});

describe("persist_file_pending_update_rebased_state", () => {
	test("persist_file_pending_update_rebased_state stores the rebased doc as the new authoritative pending state", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-rebased",
				name: "pending-edits-persist-rebased",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const remoteMarkdown = `${seeded.baseMarkdown}\n\nRemote drift`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: remoteMarkdown,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);

		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${remoteMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to create unstaged rebased branch while testing pending update persistence");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}
		if (!persistResult._yay || !("pendingUpdate" in persistResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update row");
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();
		expect(persistResult._yay.pendingUpdate!.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });

		const pendingAfterPersist = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterPersist).not.toBeNull();

		const pendingAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingAfterPersist! }),
		);
		expect(pendingAfterPersistMarkdownState.baseMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.stagedMarkdown).toBe(pendingAfterPersistMarkdownState.baseMarkdown);
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Unresolved only");
	});

	test("persist_file_pending_update_rebased_state rejects a mismatched pendingUpdateId from another file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) => {
			const fileA = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-a",
				name: "pending-edits-persist-mismatch-a",
				markdown: "# File A",
			});
			const fileB = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-b",
				name: "pending-edits-persist-mismatch-b",
				markdown: "# File B",
				membership: fileA,
			});

			return {
				membershipId: fileA.membershipId,
				organizationId: fileA.organizationId,
				workspaceId: fileA.workspaceId,
				userId: fileA.userId,
				fileAId: fileA.nodeId,
				fileABaseMarkdown: fileA.baseMarkdown,
				fileBId: fileB.nodeId,
				fileBBaseMarkdown: fileB.baseMarkdown,
			};
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileAId,
			stagedMarkdown: seeded.fileABaseMarkdown,
			unstagedMarkdown: `${seeded.fileABaseMarkdown}\n\nFile A current`,
		});
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileBId,
			stagedMarkdown: seeded.fileBBaseMarkdown,
			unstagedMarkdown: `${seeded.fileBBaseMarkdown}\n\nFile B current`,
		});

		const [fileAPendingRow, fileBPendingRow] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileBId),
					)
					.first(),
			]),
		);
		if (!fileAPendingRow || !fileBPendingRow) {
			throw new Error("Missing pending docs while testing mismatched rebase pendingUpdateId");
		}

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.fileAId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.fileABaseMarkdown}\n\nFile A rebased`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build rebased branch while testing mismatched pendingUpdateId");
		}

		// The synced id must match the row the mutation resolves: a foreign id means the
		// client's view is stale, so the persist refuses instead of patching either row.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.fileAId,
			pendingUpdateId: fileBPendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		const [fileAPendingRowAfterPersist, fileBPendingRowAfterPersist] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileBId),
					)
					.first(),
			]),
		);
		expect(fileAPendingRowAfterPersist).not.toBeNull();
		expect(fileAPendingRowAfterPersist!._id).toBe(fileAPendingRow._id);
		expect(fileBPendingRowAfterPersist).not.toBeNull();

		const fileAPendingRowAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: fileAPendingRowAfterPersist! }),
		);
		expect(fileAPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File A current");

		const fileBPendingRowAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: fileBPendingRowAfterPersist! }),
		);
		expect(fileBPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File B current");
	});

	test("persist_file_pending_update_rebased_state clears the pending doc when the rebased branches match the live base", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-clear",
				name: "pending-edits-persist-clear",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const clearResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: latestFileState.yjsUpdate,
		});
		if (clearResult._nay) {
			throw new Error(clearResult._nay.message);
		}
		if (!clearResult._yay || !("pendingUpdate" in clearResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update result");
		}
		expect(clearResult._yay.pendingUpdate).toBeNull();

		const pendingAfterClear = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterClear).toBeNull();
	});

	test("persist_file_pending_update_rebased_state rejects stale live bases", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale",
				name: "pending-edits-persist-stale",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const staleFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const stalePersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: staleFileState.yjsSequence,
			baseYjsUpdate: staleFileState.yjsUpdate,
			stagedBranchYjsUpdate: staleFileState.yjsUpdate,
			unstagedBranchYjsUpdate: staleFileState.yjsUpdate,
		});
		expect(stalePersistResult._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);
	});

	test("persist_file_pending_update_rebased_state does not recreate a discarded row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-discarded",
				name: "pending-edits-persist-discarded",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Another tab discards the proposal while this tab's sync is in flight.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", pendingRow._id),
			]);
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build stale sync branch while testing the discarded row");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The discarded proposal must stay dead: no row and no pending chunks reappear.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
			const textChunks = await ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(textChunks.filter((chunk) => chunk.sourceKind === "pending")).toHaveLength(0);
		});
	});

	test("persist_file_pending_update_rebased_state does not patch a newer proposal on the same file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-replaced",
				name: "pending-edits-persist-replaced",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the in-flight sync");
		}

		// Another tab discards the first proposal, then the agent creates a NEW proposal on
		// the same file while this tab's sync is still in flight.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent proposal two`,
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRowBefore || !files_pending_update_has_yjs_content(secondRowBefore)) {
			throw new Error("Missing second pending row before the stale sync lands");
		}
		const secondRowUnstagedBytes = (
			await t.run(async (ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowBefore }))
		).unstagedBytes;

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build stale sync branch while testing the replaced row");
		}

		// The stale sync still carries the FIRST row's id and branches.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The new proposal must be untouched: same row id, same unstaged branch bytes.
			const secondRowAfter = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!secondRowAfter || !files_pending_update_has_yjs_content(secondRowAfter)) {
				throw new Error("Missing second pending row after the stale sync");
			}
			expect(secondRowAfter._id).toBe(secondRowBefore._id);
			const secondRowAfterBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowAfter });
			expect(new Uint8Array(secondRowAfterBytes.unstagedBytes)).toEqual(new Uint8Array(secondRowUnstagedBytes));
		});
	});

	test("commit_file_pending_update_rebase_in_db rejects a stale base after a save advanced the row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale-base",
				name: "pending-edits-persist-stale-base",
				markdown: "# Persist stale base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Tab A's sync action reads this live base before tab B's save lands.
		const originalFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		// Tab B's partial save rebases the row to the new sequence with fresh unresolved content.
		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing the stale persist base");
		}
		expect(saveResult._yay.newSequence).toBe(1);

		const rowAfterSave = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowAfterSave || !files_pending_update_has_yjs_content(rowAfterSave)) {
			throw new Error("Missing rebased pending row after the save");
		}
		expect(rowAfterSave.content.base).toMatchObject({ kind: "yjs", sequence: 1 });
		const rowAfterSaveBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: rowAfterSave }),
		);

		// Tab A's delayed commit still carries branches rebased onto the OLD captured base.
		const staleBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(originalFileState.yjsUpdate);
		const staleUnstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: staleBaseYjsDoc,
		});
		const staleUnstagedProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: staleUnstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nStale sync content`,
		});
		if (staleUnstagedProjection._nay) {
			throw new Error("Failed to build the stale sync branch while testing the stale persist base");
		}

		const staleFamily = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: originalFileState.yjsUpdate,
			stagedBranchYjsUpdate: originalFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(staleUnstagedBranchYjsDoc)),
		});
		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.commit_file_pending_update_rebase_in_db,
			{
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: pendingRow._id,
				operationBatchId: staleFamily.operationBatchId,
				expectedRevision: rowAfterSave.revision,
				base: {
					kind: "yjs",
					baseYjsSequence: originalFileState.yjsSequence,
					baseLineageGeneration: 0,
					expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
				},
				baseStateId: staleFamily.base.stateId,
				stagedStateId: staleFamily.staged.stateId,
				unstagedStateId: staleFamily.unstaged.stateId,
				baseStateDigest: staleFamily.base.digest,
				stagedStateDigest: staleFamily.staged.digest,
				unstagedStateDigest: staleFamily.unstaged.digest,
				unstagedText: `${seeded.baseMarkdown}\n\nStale sync content`,
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Stale save");

		await t.run(async (ctx) => {
			// The post-save row must be untouched: same base sequence and branch bytes.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row || !files_pending_update_has_yjs_content(row)) {
				throw new Error("Missing pending row after the stale persist");
			}
			expect(row.content.base).toMatchObject({ kind: "yjs", sequence: 1 });
			const rowBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: row });
			expect(new Uint8Array(rowBytes.baseBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.baseBytes));
			expect(new Uint8Array(rowBytes.stagedBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.stagedBytes));
			expect(new Uint8Array(rowBytes.unstagedBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.unstagedBytes));
		});
	});

	test("commit_file_pending_update_rebase_in_db does not resurrect content on a row degraded to a pure move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-degraded.md",
				name: "pending-edits-persist-degraded.md",
				markdown: "# Persist degraded base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nMixed content`,
		});
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-edits-persist-degraded-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const mixedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!mixedRow || !files_pending_update_has_yjs_content(mixedRow)) {
			throw new Error("Missing mixed pending row before the revert");
		}
		const capturedBaseYjsSequence = mixedRow.content.base.sequence;
		const capturedBytes = await t.run(async (ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: mixedRow }));

		// Another tab reverts the content: the row degrades to a pure move with no yjs fields.
		const reverted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (reverted._nay) {
			throw new Error(reverted._nay.message);
		}
		const degradedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(degradedRow?._id).toBe(mixedRow._id);
		expect(degradedRow?.content).toBeUndefined();

		// The in-flight sync still carries the reverted content branches with the old captured base.
		const staleFamily = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: capturedBytes.baseBytes,
			stagedBranchYjsUpdate: capturedBytes.stagedBytes,
			unstagedBranchYjsUpdate: capturedBytes.unstagedBytes,
		});
		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.commit_file_pending_update_rebase_in_db,
			{
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: mixedRow._id,
				operationBatchId: staleFamily.operationBatchId,
				expectedRevision: mixedRow.revision,
				base: {
					kind: "yjs",
					baseYjsSequence: capturedBaseYjsSequence,
					baseLineageGeneration: 0,
					expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
				},
				baseStateId: staleFamily.base.stateId,
				stagedStateId: staleFamily.staged.stateId,
				unstagedStateId: staleFamily.unstaged.stateId,
				baseStateDigest: staleFamily.base.digest,
				stagedStateDigest: staleFamily.staged.digest,
				unstagedStateDigest: staleFamily.unstaged.digest,
				unstagedText: `${seeded.baseMarkdown}\n\nMixed content`,
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The pure-move row must stay content-free: resurrecting the branches would revive
			// a proposal the user already reverted.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?._id).toBe(mixedRow._id);
			expect(row?.pendingMove?.destName).toBe("pending-edits-persist-degraded-dest.md");
			expect(row?.content).toBeUndefined();
		});
	});

	test("an identical persist refreshes the pending update lifetime", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-identical-ttl",
				name: "pending-edits-persist-identical-ttl",
				markdown: "# Persist identical TTL base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build the unstaged branch while testing identical persist TTL refresh");
		}
		const persistArgs = {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		};

		const firstPersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, persistArgs);
		if (firstPersistResult._nay) {
			throw new Error(firstPersistResult._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing pending row after the first persist");
		}
		expect(firstRow.expiresAt).toBe(firstRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		await new Promise((resolve) => setTimeout(resolve, 2));

		// A retried sync persists the exact same bytes: the row content does not change, but
		// the 4h lifetime must still restart or the old expiry removes the proposal.
		const secondPersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, persistArgs);
		if (secondPersistResult._nay) {
			throw new Error(secondPersistResult._nay.message);
		}
		if (!secondPersistResult._yay || !("pendingUpdate" in secondPersistResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update row");
		}
		expect(secondPersistResult._yay.pendingUpdate).not.toBeNull();

		const secondRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRow) {
			throw new Error("Missing pending row after the identical persist");
		}
		expect(secondRow._id).toBe(firstRow._id);
		expect(secondRow.updatedAt).toBeGreaterThan(firstRow.updatedAt);

		expect(secondRow.expiresAt).toBe(secondRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(secondRow.expiresAt).toBeGreaterThan(firstRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
	});

	test("persist_file_pending_update_rebased_state returns a message-only nay when branch comparison fails", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-poisoned-branch",
				name: "pending-edits-persist-poisoned-branch",
				markdown: "# Persist poisoned branch",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nPending chunk`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow || !files_pending_update_has_yjs_content(pendingRow)) {
			throw new Error("Missing pending row content before the failing persist");
		}
		const pendingRowBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: pendingRow }),
		);

		// Stage and seal valid inputs first: the seal reads markdown too, and the mock below must
		// fail the ACTION's first comparison read instead.
		const family = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: pendingRowBytes.baseBytes,
			stagedBranchYjsUpdate: pendingRowBytes.stagedBytes,
			unstagedBranchYjsUpdate: pendingRowBytes.unstagedBytes,
		});

		// Fail the action's first markdown read with the real producer's cause-carrying shape.
		filesYjsDocGetMarkdownMock.mockReturnValueOnce({
			_nay: {
				name: "nay",
				message: "Error while extracting markdown from Y.Doc",
				cause: new Error("serializer exploded"),
			},
		});

		const persisted = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			operationBatchId: family.operationBatchId,
			baseYjsSequence: pendingRow.content.base.sequence,
		});

		// The `_nay` must stay message-only: an extra `cause` field would fail the action's
		// strict `v_result` returns validator in a real deployment.
		expect(persisted).toEqual({
			_nay: { message: "Failed to compare rebased pending update branches with base" },
		});
	});
});

describe("expire_file_pending_updates saved drafts", () => {
	test("a check at the old expiry keeps a draft that a newer edit moved later", async () => {
		vi.useFakeTimers();
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-stale",
				name: "pending-edits-cleanup-stale",
				markdown: "# Cleanup stale base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending first`;
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow?.expiresAt) {
			throw new Error("Missing first pending doc while testing stale expiry");
		}

		vi.setSystemTime(Date.now() + 60_000);

		const secondMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending second`;
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		// The check was scheduled for the first expiry. The newer edit moved the draft's expiry later,
		// so this run keeps the draft and waits for the new expiry.
		vi.setSystemTime(firstPendingRow.expiresAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});

		const pendingAfterStaleCleanup = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterStaleCleanup?._id).toBe(firstPendingRow._id);
		expect(pendingAfterStaleCleanup?.expiresAt).toBe(pendingAfterStaleCleanup!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(pendingAfterStaleCleanup?.expiresAt).toBeGreaterThan(firstPendingRow.expiresAt);
		const check = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(check?.nextCheckAt).toBe(pendingAfterStaleCleanup?.expiresAt);
	});

	test("expire_file_pending_updates deletes due saved drafts and then its check", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-expired",
				name: "pending-edits-cleanup-expired",
				markdown: "# Cleanup expired base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nCleanup expired`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing expired cleanup");
		}

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		const pendingAfterCleanup = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterCleanup).toBeNull();
		expect(await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }))).toBeNull();
	});
});

describe("membership scoped pending updates", () => {
	test("pending update APIs reject cross-user membership ids", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-membership-unauthorized",
				name: "pending-edits-membership-unauthorized",
				markdown: "# Base",
			}),
		);

		const otherUserId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: null,
			}),
		);
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: otherUserId,
			name: "Other User",
		});

		const unauthorizedUpsert = await upsert_file_pending_update_public_for_test(asOtherUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnauthorized`,
		});
		if (!unauthorizedUpsert._nay) {
			throw new Error("Expected upsert_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedUpsert._nay.message).toBe("Unauthorized");

		const unauthorizedPending = await asOtherUser.query(api.ai_chat.get_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(unauthorizedPending).toBeNull();

		const unauthorizedLastSaved = await asOtherUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(unauthorizedLastSaved).toBeNull();

		const proposalId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);
		const unauthorizedSave = await asOtherUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: proposalId,
			reviewedRevision: 1,
		});
		if (!unauthorizedSave._nay) {
			throw new Error("Expected save_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedSave._nay.message).toBe("Unauthorized");

		const unauthorizedPersist = await persist_file_pending_update_rebased_state_for_test(asOtherUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate: new ArrayBuffer(0),
			stagedBranchYjsUpdate: new ArrayBuffer(0),
			unstagedBranchYjsUpdate: new ArrayBuffer(0),
		});
		if (!unauthorizedPersist._nay) {
			throw new Error("Expected persist_file_pending_update_rebased_state to reject cross-user membership");
		}
		expect(unauthorizedPersist._nay.message).toBe("Unauthorized");
	});
});

describe("upsert_file_pending_move_in_db", () => {
	test("creates a pure-move row and replaces the proposal on a second mv", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-upsert-src.md",
				name: "move-upsert-src.md",
				markdown: "# Move upsert base",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-upsert-dest",
				name: "move-upsert-dest",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "moved.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay).toEqual({
			fromPath: "/move-upsert-src.md",
			destPath: "/move-upsert-dest/moved.md",
			replacesExistingOccupant: false,
			cancelledExistingMove: false,
			appliedImmediately: false,
		});

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after move upsert");
		}
		expect(pendingRow.pendingMove).toEqual({
			destParent: { kind: "saved", id: destFolderId },
			destName: "moved.md",
			fromPath: "/move-upsert-src.md",
		});
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(false);
		expect(pendingRow.size).toBe(0);

		expect(pendingRow.expiresAt).toBe(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const expiryCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(expiryCheck?.nextCheckAt).toBeLessThanOrEqual(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		const replaced = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}

		const replacedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(replacedRow?._id).toBe(pendingRow._id);
		expect(replacedRow?.pendingMove?.destName).toBe("renamed.md");
	});

	test("a rename may change the extension because the stored type stays", async () => {
		const t = test_convex();

		// Direct mutation calls stand in for any future caller that skips the bash command's own
		// checks: the proposal mutation itself must not judge the name against the type.
		const markdownSeeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/typed-rich.md",
				name: "typed-rich.md",
				markdown: "# Typed rich",
			}),
		);
		const renamedToJson = await upsert_file_pending_move_for_test({
			t,
			organizationId: markdownSeeded.organizationId,
			workspaceId: markdownSeeded.workspaceId,
			userId: markdownSeeded.userId,
			nodeId: markdownSeeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "typed-rich.json",
		});
		expect(renamedToJson._nay).toBeUndefined();

		// A stored file follows the same rule: the name is free, the type stays.
		const uploadNodeId = await t.run(async (ctx) =>
			ctx.db.insert("files_nodes", {
				organizationId: markdownSeeded.organizationId,
				workspaceId: markdownSeeded.workspaceId,
				path: "/typed-photo.png",
				treePath: "/typed-photo.png",
				pathDepth: 1,
				name: "typed-photo.png",
				sortName: files_sort_text_key("typed-photo.png"),
				kind: "file",
				lowercaseExtension: "png",
				contentType: "image/png",
				parentId: files_ROOT_ID,
				createdBy: markdownSeeded.userId,
				updatedBy: markdownSeeded.userId,
				updatedAt: Date.now(),
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
			}),
		);
		const relabeled = await upsert_file_pending_move_for_test({
			t,
			organizationId: markdownSeeded.organizationId,
			workspaceId: markdownSeeded.workspaceId,
			userId: markdownSeeded.userId,
			nodeId: uploadNodeId,
			destParentId: files_ROOT_ID,
			destName: "typed-movie.mp4",
		});
		expect(relabeled._nay).toBeUndefined();
	});

	test("makes a mixed row when mv follows a pending content edit", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-mixed-src.md",
				name: "move-mixed-src.md",
				markdown: "# Mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nMixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-mixed-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const mixedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!mixedRow) {
			throw new Error("Missing mixed pending row");
		}
		expect(mixedRow.pendingMove?.destName).toBe("move-mixed-renamed.md");
		expect(files_pending_update_has_yjs_content(mixedRow)).toBe(true);
		const mixedRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: mixedRow }),
		);
		expect(mixedRowMarkdownState.unstagedMarkdown).toContain("Mixed change");
		const pendingChunks = await t.run((ctx) => list_pending_update_text_chunks({ ctx, pendingUpdateId: mixedRow._id }));
		expect(pendingChunks.length).toBeGreaterThan(0);
	});

	test("rejects invalid move targets with short literal errors", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-src.md",
				name: "move-validate-src.md",
				markdown: "# Validate base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const sibling = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-sibling.md",
				name: "move-validate-sibling.md",
				markdown: "# Sibling base",
				membership,
			}),
		);

		// Destination parent must be an active folder or root.
		const destParentIsFile = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: sibling.nodeId,
			destName: "moved.md",
		});
		expect(destParentIsFile._nay?.message).toBe("Destination folder is missing");

		// Same source and destination path.
		const samePath = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-src.md",
		});
		expect(samePath._nay?.message).toBe("Source and destination are the same");

		// Active sibling already owns the destination name.
		const siblingConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-sibling.md",
		});
		expect(siblingConflict._nay?.message).toBe("Path already exists");

		// Folder cannot move into its own subtree.
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-validate-folder",
				name: "move-validate-folder",
			}),
		);
		const subFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderId,
				path: "/move-validate-folder/sub",
				name: "sub",
			}),
		);
		const folderIntoItself = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: subFolderId,
			destName: "move-validate-folder",
		});
		expect(folderIntoItself._nay?.message).toBe("Cannot move a folder into itself");

		// Archived source nodes are not movable.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-validate" });
		});
		const archivedSource = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "moved.md",
		});
		expect(archivedSource._nay?.message).toBe("Not found");
	});

	test("records the replace target only with the replace opt-in", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-src.md",
				name: "move-replace-src.md",
				markdown: "# Replace source base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-dest.md",
				name: "move-replace-dest.md",
				markdown: "# Replace dest base",
				membership,
			}),
		);

		// Without the opt-in the occupied destination stays a conflict.
		const withoutReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
		});
		expect(withoutReplace._nay?.message).toBe("Path already exists");

		const withReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
			replace: true,
		});
		if (withReplace._nay) {
			throw new Error(withReplace._nay.message);
		}
		expect(withReplace._yay).toEqual({
			fromPath: "/move-replace-src.md",
			destPath: "/move-replace-dest.md",
			replacesExistingOccupant: true,
			cancelledExistingMove: false,
			appliedImmediately: false,
		});

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove).toMatchObject({
			destParent: { kind: "root" },
			destName: "move-replace-dest.md",
			fromPath: "/move-replace-src.md",
			replacesTarget: { kind: "saved", id: occupant.nodeId },
		});

		// A file never replaces a folder occupant, even with the opt-in.
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-replace-folder",
				name: "move-replace-folder",
			}),
		);
		const folderConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-folder",
			replace: true,
		});
		expect(folderConflict._nay?.message).toBe("Path already exists");
	});

	test("accepts a destination vacated by the proposer's own pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-src.md",
				name: "vacated-src.md",
				markdown: "# Vacated base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-other.md",
				name: "vacated-other.md",
				markdown: "# Vacated other base",
				membership,
			}),
		);

		// The first proposal vacates /vacated-src.md in the proposer's visible tree.
		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// The committed sibling moved away for this user, so its path is free to claim.
		const reuseMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-src.md",
		});
		if (reuseMove._nay) {
			throw new Error(reuseMove._nay.message);
		}
		expect(reuseMove._yay.destPath).toBe("/vacated-src.md");
		expect(reuseMove._yay.replacesExistingOccupant).toBe(false);
	});

	test("rejects a destination already claimed by another pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-a.md",
				name: "claim-a.md",
				markdown: "# Claim a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-b.md",
				name: "claim-b.md",
				markdown: "# Claim b base",
				membership,
			}),
		);

		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// One visible path, one proposal: the second claim is rejected, replace or not.
		const doubleBooked = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		expect(doubleBooked._nay?.message).toBe("Path already exists");
		const doubleBookedReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
			replace: true,
		});
		expect(doubleBookedReplace._nay?.message).toBe("Path already exists");
	});

	test("rejects a folder parent cycle across two pending moves", async () => {
		const t = test_convex();

		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const folderAId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-a",
				name: "parent-cycle-a",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-b",
				name: "parent-cycle-b",
			}),
		);
		const folderCId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-c",
				name: "parent-cycle-c",
			}),
		);

		// Folder A moves into folder B: A shows at /parent-cycle-b/x.
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderAId,
			destParentId: folderBId,
			destName: "x",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Folder B into the moved folder A: the visible destination sits inside B itself, a
		// parent cycle across two rows that would drop both rows from the overlay.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderBId,
			destParentId: folderAId,
			destName: "inside",
		});
		expect(moveB._nay?.message).toBe("Cannot move a folder into itself");

		// A legitimate move of an unrelated folder into the moved folder A still passes.
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderCId,
			destParentId: folderAId,
			destName: "c",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		expect(moveC._yay.destPath).toBe("/parent-cycle-a/c");
	});

	test("rejects a folder replace proposal onto a non-empty folder", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-full/keep.md",
				name: "keep.md",
				markdown: "# Edr proposal keep base",
			}),
		);
		const { folderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-src",
				name: "edr-p-src",
			});
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-full",
				name: "edr-p-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return { folderId };
		});

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-full",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("rejects replacing an empty folder occupant that a pending move targets into", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-into-file.md",
				name: "edr-p-into-file.md",
				markdown: "# Edr into base",
			}),
		);
		const { folderId, emptyFolderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into-src",
				name: "edr-p-into-src",
			});
			const emptyFolderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into",
				name: "edr-p-into",
			});
			return { folderId, emptyFolderId };
		});

		// The user proposes moving a file INTO the empty folder: replacing the folder would
		// break that proposal's destination, so the folder no longer counts as empty.
		const movedIn = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: emptyFolderId,
			destName: "moved.md",
		});
		if (movedIn._nay) {
			throw new Error(movedIn._nay.message);
		}
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-into",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("keeps a file replace proposal onto an empty folder rejected", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-file-src.md",
				name: "edr-p-file-src.md",
				markdown: "# Edr file src base",
			}),
		);
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-dstdir",
				name: "edr-p-dstdir",
			}),
		);

		// rename() fails EISDIR here: a file never replaces a folder, empty or not.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-dstdir",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Path already exists");
	});

	test("mv back to the original path cancels a pure pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-move-src.md",
				name: "cancel-move-src.md",
				markdown: "# Cancel move base",
			}),
		);

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before cancel");
		}

		// mv back to the source path cancels the proposal instead of failing validation.
		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay).toEqual({
			fromPath: "/cancel-move-src.md",
			destPath: "/cancel-move-src.md",
			replacesExistingOccupant: false,
			cancelledExistingMove: true,
			appliedImmediately: false,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(row).toBeNull();
		});

		// Without a pending move the same-path mv keeps the current rejection.
		const samePathWithoutRow = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		expect(samePathWithoutRow._nay?.message).toBe("Source and destination are the same");
	});

	test("mv back to the original path keeps the content of a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-mixed-src.md",
				name: "cancel-mixed-src.md",
				markdown: "# Cancel mixed base",
			}),
		);

		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCancel mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay.cancelledExistingMove).toBe(true);

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the content proposal to survive the cancelled move");
		}
		expect(row.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
		const rowMarkdownState = await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: row }));
		expect(rowMarkdownState.unstagedMarkdown).toContain("Cancel mixed change");
	});
});

describe("apply_file_pending_move", () => {
	test("applies a pure file move and patches denormalized paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-src.md",
				name: "apply-src.md",
				markdown: "# Apply base",
			}),
		);
		const destFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-dest",
				name: "apply-dest",
			}),
		);
		const { plainTextChunkId } = await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const metadataDocId = await t.run((ctx) =>
			ctx.db.insert("files_metadata_docs", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				fileNodeId: seeded.nodeId,
				sourceKind: "committed",
				path: "/apply-src.md",
				treePath: "/apply-src.md",
				fieldPath: "meta.topic",
				docKind: "field",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.parentId).toBe(destFolderId);
			expect(node?.name).toBe("renamed.md");
			expect(node?.path).toBe("/apply-dest/renamed.md");
			expect(node?.treePath).toBe("/apply-dest/renamed.md");

			const plainTextChunk = await ctx.db.get("files_plain_text_chunks", plainTextChunkId);
			expect(plainTextChunk?.path).toBe("/apply-dest/renamed.md");

			const metadataDoc = await ctx.db.get("files_metadata_docs", metadataDocId);
			expect(metadataDoc?.path).toBe("/apply-dest/renamed.md");
			expect(metadataDoc?.treePath).toBe("/apply-dest/renamed.md");

			const rowAfterApply = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterApply).toBeNull();
		});
	});

	test("accepting a rename keeps the stored type", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/subtype-src.json",
				name: "subtype-src.json",
				markdown: '{"a": 1}\n',
				rootKind: "plain_text",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "subtype-renamed.yaml",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		// json→yaml readback: the name and the extension index move, the stored type does not.
		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.name).toBe("subtype-renamed.yaml");
		expect(node?.path).toBe("/subtype-renamed.yaml");
		expect(node?.lowercaseExtension).toBe("yaml");
		expect(node?.contentType).toBe("text/plain;charset=utf-8");
		expect(node?.textKind).toBe("plain_text");
	});

	test("applies a folder move and cascades descendant paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-folder/child.md",
				name: "child.md",
				markdown: "# Folder child base",
			}),
		);
		const { folderId, destFolderId, childChunkIds } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder",
				name: "apply-folder",
			});
			await ctx.db.patch("files_nodes", seeded.nodeId, { parentId: folderId });
			const destFolderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder-dest",
				name: "apply-folder-dest",
			});
			const childChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-folder/child.md",
				markdown: seeded.baseMarkdown,
			});
			return { folderId, destFolderId, childChunkIds };
		});

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: destFolderId,
			destName: "apply-folder",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/apply-folder-dest/apply-folder");
			expect(folder?.treePath).toBe("/apply-folder-dest/apply-folder/");
			expect(folder?.parentId).toBe(destFolderId);

			const child = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(child?.path).toBe("/apply-folder-dest/apply-folder/child.md");

			const childChunk = await ctx.db.get("files_plain_text_chunks", childChunkIds.plainTextChunkId);
			expect(childChunk?.path).toBe("/apply-folder-dest/apply-folder/child.md");
		});
	});

	test("requires one review for a move with collaborative content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-mixed-src.md",
				name: "apply-mixed-src.md",
				markdown: "# Apply mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-mixed-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses a newcomer file that was not reviewed", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-conflict-src.md",
				name: "apply-conflict-src.md",
				markdown: "# Apply conflict base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-conflict-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A file appears at the proposed destination after the proposal was created. The
		// pending move claims its destination, so accept replaces the newcomer like `mv -f`.
		await t.run(async (ctx) =>
			ctx.db.insert("files_nodes", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				path: "/apply-conflict-dest.md",
				treePath: "/apply-conflict-dest.md",
				pathDepth: 1,
				lowercaseExtension: "md",
				name: "apply-conflict-dest.md",
				sortName: files_sort_text_key("apply-conflict-dest.md"),
				kind: "file",
				parentId: files_ROOT_ID,
				createdBy: seeded.userId,
				updatedBy: seeded.userId,
				updatedAt: Date.now(),
				contentType: null,
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("archives the replaced file when applying a replace move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-src.md",
				name: "apply-replace-src.md",
				markdown: "# Apply replace base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-dest.md",
				name: "apply-replace-dest.md",
				markdown: "# Apply replace dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-dest.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The replaced file is archived (recoverable), never hard-deleted.
			const replacedNode = await ctx.db.get("files_nodes", occupant.nodeId);
			expect(replacedNode?.archiveOperationId).toBeDefined();

			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-replace-dest.md");
			expect(node?.archiveOperationId).toBeNull();

			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("requires review of a destination's pending content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-saved-src.md",
				name: "apply-replace-saved-src.md",
				markdown: "# Replace saved source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-saved-dst.md",
				name: "apply-replace-saved-dst.md",
				markdown: "# Replace saved dest",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);
		// The destination has this user's pending content.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: occupant.organizationId,
			workspaceId: occupant.workspaceId,
			userId: occupant.userId,
			nodeId: occupant.nodeId,
			unstagedMarkdown: `${occupant.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const occupantRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: occupant.organizationId,
				workspaceId: occupant.workspaceId,
				userId: occupant.userId,
				nodeId: occupant.nodeId,
			}),
		);
		if (!occupantRow) {
			throw new Error("Missing the occupant's saved row");
		}

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-saved-dst.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay.replacesExistingOccupant).toBe(true);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires review of a destination's shared pending work", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-shared-src.md",
				name: "apply-replace-shared-src.md",
				markdown: "# Replace shared source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-shared-dst.md",
				name: "apply-replace-shared-dst.md",
				markdown: "# Replace shared dest",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: occupant.organizationId,
			workspaceId: occupant.workspaceId,
			userId: occupant.userId,
			nodeId: occupant.nodeId,
			unstagedMarkdown: `${occupant.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// The replacement must also protect another member's pending content.
		await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: occupant.organizationId,
				workspaceId: occupant.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_apply_saved_guard" }),
				target: { kind: "saved", id: occupant.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-shared-dst.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses an unreviewed folder at the destination", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-src.md",
				name: "apply-replace-conflict-src.md",
				markdown: "# Replace conflict base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
				markdown: "# Replace conflict dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-conflict-dest.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// The recorded target goes away and a FOLDER takes the destination path. Files
		// auto-replace at accept, but a folder occupant still fails and keeps the row.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", occupant.nodeId, { archiveOperationId: "archive-op-replaced-away" });
			await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("returns Not found when the source was archived after the proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archived-src.md",
				name: "apply-archived-src.md",
				markdown: "# Apply archived base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-archived-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-apply" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay?.message).toBe("Not found");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("apply-archived-dest.md");
	});

	test("requires one review for connected moves", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-a.md",
				name: "chain-a.md",
				markdown: "# Chain a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-b.md",
				name: "chain-b.md",
				markdown: "# Chain b base",
				membership,
			}),
		);

		// Move B vacates /chain-b.md in the proposer's visible tree, so move A may claim it.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}
		const pendingRowA = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRowA) {
			throw new Error("Missing pending move row for move A before apply");
		}

		// Accepting A first must not archive B: B still sits at /chain-b.md only because its own
		// pending move is not accepted yet, so accept must ask for B's move first.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts chained moves in dependency order", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-a.md",
				name: "chain-order-a.md",
				markdown: "# Chain order a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-b.md",
				name: "chain-order-b.md",
				markdown: "# Chain order b base",
				membership,
			}),
		);

		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Accepting B first frees /chain-order-b.md, so accepting A afterwards is a plain move.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const appliedB = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: other.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: other.nodeId },
			})),
		});
		if (appliedB._nay) {
			throw new Error(appliedB._nay.message);
		}
		const appliedA = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (appliedA._nay) {
			throw new Error(appliedA._nay.message);
		}

		await t.run(async (ctx) => {
			const nodeB = await ctx.db.get("files_nodes", other.nodeId);
			expect(nodeB?.path).toBe("/chain-order-c.md");
			expect(nodeB?.archiveOperationId).toBeNull();

			const nodeA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(nodeA?.path).toBe("/chain-order-b.md");
			expect(nodeA?.archiveOperationId).toBeNull();
		});
	});

	test("requires one review for a two-file swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-a.md",
				name: "swap-a.md",
				markdown: "# Swap a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-b.md",
				name: "swap-b.md",
				markdown: "# Swap b base",
				membership,
			}),
		);

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a cycle (A: a→b, B: b→a) that no single accept order can resolve.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting either row applies the whole cycle inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("keeps a restricted swap partner unchanged before review", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/cyc-a.md", name: "cyc-a.md", markdown: "# Cycle a" }),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/cyc-b.md", name: "cyc-b.md", markdown: "# Cycle b", membership }),
		);

		// The seeded user owns the organization and bypasses every check, so the accept has to be made
		// by somebody else. This one holds ordinary workspace write and nothing on the restricted file.
		const mover = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_cycle_perm" });
			await seed_billing_snapshot_for_user(ctx, userId);
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now,
			});
			return { userId, membershipId };
		});

		// mv a→tmp, mv b→a, mv a→b leaves the two rows that form the cycle.
		for (const move of [
			{ nodeId: seeded.nodeId, destName: "cyc-tmp.md" },
			{ nodeId: other.nodeId, destName: "cyc-a.md" },
			{ nodeId: seeded.nodeId, destName: "cyc-b.md" },
		]) {
			const proposed = await upsert_file_pending_move_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: mover.userId,
				nodeId: move.nodeId,
				destParentId: files_ROOT_ID,
				destName: move.destName,
			});
			if (proposed._nay) {
				throw new Error(proposed._nay.message);
			}
		}

		// Only now is the swap partner closed off. The proposal outlived the access that made it.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", other.nodeId, { restrictedScopeNodeId: other.nodeId });
		});

		const asMover = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: mover.userId,
			name: "Mover",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asMover.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: mover.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: mover.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for content within a swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-a.md",
				name: "swap-mixed-a.md",
				markdown: "# Swap mixed a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-b.md",
				name: "swap-mixed-b.md",
				markdown: "# Swap mixed b base",
				membership,
			}),
		);

		// B carries a content edit, so its row stays mixed through the swap.
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			stagedMarkdown: other.baseMarkdown,
			unstagedMarkdown: `${other.baseMarkdown}\n\nSwap mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the mixed row's side: the cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: other.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: other.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a long file rotation", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/rotate-1.md",
				name: "rotate-1.md",
				markdown: "# Rotate 1 base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const fileCount = 14;
		const rotated = [seeded];
		for (let index = 2; index <= fileCount; index++) {
			const file = await t.run(async (ctx) =>
				seed_file_with_markdown({
					ctx,
					path: `/rotate-${index}.md`,
					name: `rotate-${index}.md`,
					markdown: `# Rotate ${index} base`,
					membership,
				}),
			);
			rotated.push(file);
		}

		// mv f1→tmp frees /rotate-1.md, each next mv shifts a file down one slot, and the final
		// mv replaces f1's tmp proposal: the rows form one rotation cycle of 14 files.
		const movedToTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "rotate-tmp.md",
		});
		if (movedToTmp._nay) {
			throw new Error(movedToTmp._nay.message);
		}
		for (const [index, file] of rotated.entries()) {
			if (index === 0) {
				continue;
			}
			const moved = await upsert_file_pending_move_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: file.nodeId,
				destParentId: files_ROOT_ID,
				destName: `rotate-${index}.md`,
			});
			if (moved._nay) {
				throw new Error(moved._nay.message);
			}
		}
		const movedToLast = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: `rotate-${fileCount}.md`,
		});
		if (movedToLast._nay) {
			throw new Error(movedToLast._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a two-folder swap", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc swap a child base",
			}),
		);
		const membership = {
			userId: childA.userId,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			membershipId: childA.membershipId,
		};
		const childB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-b/b-child.md",
				name: "b-child.md",
				markdown: "# Fsc swap b child base",
				membership,
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-a",
				name: "fsc-swap-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-b",
				name: "fsc-swap-b",
			});
			await ctx.db.patch("files_nodes", childB.nodeId, { parentId: folderBId });
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-swap-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a folder swap cycle (A: a→b, B: b→a).
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting either row applies the whole cycle inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a file and folder swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-mix-a.md",
				name: "fsc-mix-a.md",
				markdown: "# Fsc mix a base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-mix-b",
				name: "fsc-mix-b",
			}),
		);

		// The file and the folder trade paths through a temp name.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the mixed cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("keeps content and move cycle members unchanged before review", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-cnm-a.md",
				name: "fsc-cnm-a.md",
				markdown: "# Fsc cnm base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-cnm-b",
				name: "fsc-cnm-b",
			}),
		);

		// The file carries a content proposal, then joins the swap: its doc is content-plus-move.
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nCnm change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the file is the NON-clicked cycle member.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a three-folder rotation", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-rot-a/rot-child.md",
				name: "rot-child.md",
				markdown: "# Fsc rot child base",
			}),
		);
		const { folderAId, folderBId, folderCId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-a",
				name: "fsc-rot-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-b",
				name: "fsc-rot-b",
			});
			const folderCId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-c",
				name: "fsc-rot-c",
			});
			return { folderAId, folderBId, folderCId };
		});

		// A→tmp frees a, B claims a, C claims b, and the final move replaces A's tmp
		// row: the three rows form the A→c, B→a, C→b rotation.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderCId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-b",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-c",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review when a cycle parent also moves", async () => {
		const t = test_convex();

		// M=/fsc-nest-m holds C=child.md; K=/fsc-nest-k.md is a file with committed chunks.
		const childC = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-m/child.md",
				name: "child.md",
				markdown: "# Fsc nest child base",
			}),
		);
		const membership = {
			userId: childC.userId,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			membershipId: childC.membershipId,
		};
		const fileK = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-k.md",
				name: "fsc-nest-k.md",
				markdown: "# Fsc nest k base",
				membership,
			}),
		);
		const { folderMId } = await t.run(async (ctx) => {
			const folderMId = await seed_folder_node({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				userId: childC.userId,
				path: "/fsc-nest-m",
				name: "fsc-nest-m",
			});
			await ctx.db.patch("files_nodes", childC.nodeId, { parentId: folderMId });
			const fileKChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				nodeId: fileK.nodeId,
				path: "/fsc-nest-k.md",
				markdown: fileK.baseMarkdown,
			});
			return { folderMId, fileKChunkIds };
		});

		// C→tmp frees child.md, K claims it INSIDE M, M claims K's path, and the final
		// move replaces C's tmp row: the cycle is C→/fsc-nest-m, M→/fsc-nest-k.md,
		// K→(M)/child.md — K's destination parent M moves in the same cycle.
		const moveCTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-tmp.md",
		});
		if (moveCTmp._nay) {
			throw new Error(moveCTmp._nay.message);
		}
		const moveK = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: fileK.nodeId,
			destParentId: folderMId,
			destName: "child.md",
		});
		if (moveK._nay) {
			throw new Error(moveK._nay.message);
		}
		const moveM = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: folderMId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-k.md",
		});
		if (moveM._nay) {
			throw new Error(moveM._nay.message);
		}
		const moveCFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-m",
		});
		if (moveCFinal._nay) {
			throw new Error(moveCFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childC.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childC.membershipId,
			target: { kind: "saved", id: childC.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childC.membershipId,
				target: { kind: "saved", id: childC.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("keeps a changed parent loop unchanged before review", async () => {
		const t = test_convex();

		// A=/fsc-loop-q/a and B=/fsc-loop-b swap; Q is A's committed parent.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-loop-file.md",
				name: "fsc-loop-file.md",
				markdown: "# Fsc loop base",
			}),
		);
		const { folderQId, folderAId, folderBId } = await t.run(async (ctx) => {
			const folderQId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-q",
				name: "fsc-loop-q",
			});
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderQId,
				path: "/fsc-loop-q/a",
				name: "a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-b",
				name: "fsc-loop-b",
			});
			return { folderQId, folderAId, folderBId };
		});

		// The swap cycle: A→/fsc-loop-b, B→(Q)/a.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: folderQId,
			destName: "a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Another user commits Q under B after the proposals: the final tree would nest
		// B under Q and Q under B — a parent loop.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folderQId, {
				parentId: folderBId,
				path: "/fsc-loop-b/fsc-loop-q",
				treePath: "/fsc-loop-b/fsc-loop-q/",
				pathDepth: 2,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a folder swap with an empty occupant", async () => {
		const t = test_convex();

		// A holds a child (with chunks); B is EMPTY, so A's destination occupant is
		// replaceable on its own — the cycle must still swap, never archive B.
		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-empty-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc empty a child base",
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-a",
				name: "fsc-empty-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-b",
				name: "fsc-empty-b",
			});
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-empty-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts a folder move that replaces an empty folder occupant", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-src/child.md",
				name: "child.md",
				markdown: "# Edr child base",
			}),
		);
		const { folderId, occupantId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-src",
				name: "edr-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-dst",
				name: "edr-dst",
			});
			return { folderId, occupantId };
		});

		// rename() semantics: a folder may replace an EMPTY folder occupant.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-dst",
			replace: true,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		expect(proposed._yay.replacesExistingOccupant).toBe(true);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: child.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: child.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The empty occupant is archived (never hard-deleted), the mover owns the path.
			const occupant = await ctx.db.get("files_nodes", occupantId);
			expect(occupant?.archiveOperationId).toBeDefined();
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/edr-dst");
			expect(folder?.archiveOperationId).toBeNull();
			const movedChild = await ctx.db.get("files_nodes", child.nodeId);
			expect(movedChild?.path).toBe("/edr-dst/child.md");

			const row = await read_pending_update_row({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				nodeId: folderId,
			});
			expect(row).toBeNull();
		});
	});

	test("refuses an empty folder that was not reviewed", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-new-src/child.md",
				name: "child.md",
				markdown: "# Edr newcomer child base",
			}),
		);
		const folderId = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new-src",
				name: "edr-new-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return folderId;
		});

		// Propose while the destination is free, then an empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-new",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new",
				name: "edr-new",
			}),
		);

		// Accept replays rename(): the empty folder occupant is auto-replaced like a file.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: child.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: child.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses a hidden newcomer parent and the move that would replace it", async () => {
		const t = test_convex();

		const file = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-claim-file.md",
				name: "edr-claim-file.md",
				markdown: "# Edr claim base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim-src",
				name: "edr-claim-src",
			}),
		);

		// The owner's folder proposal hides a later saved occupant at the same path.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-claim",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const newcomerId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim",
				name: "edr-claim",
			}),
		);
		const beforeReview = await read_pending_review_state_for_test(t);
		const movedInto = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: file.nodeId,
			destParentId: newcomerId,
			destName: "into.md",
		});
		expect(movedInto._nay?.message).toBe("Destination folder is missing");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: file.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: file.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: file.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(applied._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses a nonempty folder that was not reviewed", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-full/keep.md",
				name: "keep.md",
				markdown: "# Edr keep base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full-src",
				name: "edr-full-src",
			}),
		);

		// Propose while the destination is free, then a NON-empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-full",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		await t.run(async (ctx) => {
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full",
				name: "edr-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return occupantId;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: occupantChild.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: occupantChild.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: occupantChild.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires review of a mixed proposal after a manual move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-idem-src.md",
				name: "apply-idem-src.md",
				markdown: "# Apply idem base",
			}),
		);

		// Mixed row: the content proposal keeps the row alive after the first accept.
		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply idem change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-idem-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing mixed pending row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts a pure move whose rename the UI already performed", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-renamed-src.md",
				name: "apply-ui-renamed-src.md",
				markdown: "# Apply ui renamed base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-ui-renamed-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A committed rename lands the node at the proposed destination before the accept.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-renamed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		// The move is already applied, so accept is a success no-op that settles the row.
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-ui-renamed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("requires review of mixed content after a manual rename", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-mixed-src.md",
				name: "apply-ui-mixed-src.md",
				markdown: "# Apply ui mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nUi mixed change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-ui-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-mixed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});
});

describe("upsert_file_pending_archive_in_db", () => {
	test("creates a delete row, sets its expiry, and is idempotent", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-upsert.md",
				name: "archive-upsert.md",
				markdown: "# Archive upsert base",
			}),
		);

		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay).toEqual({
			fromPath: "/archive-upsert.md",
			nodeKind: "file",
			outcome: "proposed",
		});

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after archive upsert");
		}
		expect(pendingRow.pendingArchive).toEqual({ fromPath: "/archive-upsert.md" });
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(false);
		expect(pendingRow.size).toBe(0);

		expect(pendingRow.expiresAt).toBe(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const expiryCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(expiryCheck?.nextCheckAt).toBeLessThanOrEqual(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		const repeated = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(repeated._yay?.outcome).toBe("proposed");
		const repeatedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(repeatedRow?._id).toBe(pendingRow._id);
		expect(repeatedRow?.pendingArchive).toEqual({ fromPath: "/archive-upsert.md" });
	});

	test("supersedes a pending move, keeps content branches, and dedupes threadIds", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-supersede.md",
				name: "archive-supersede.md",
				markdown: "# Archive supersede base",
			}),
		);
		const threadId = await t.run((ctx) =>
			seed_chat_thread({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
			}),
		);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nDelete me later`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "archive-supersede-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		for (let i = 0; i < 2; i++) {
			const archived = await upsert_file_pending_archive_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				threadId,
			});
			if (archived._nay) {
				throw new Error(archived._nay.message);
			}
		}

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after archive supersede");
		}
		expect(pendingRow.pendingArchive).toEqual({ fromPath: "/archive-supersede.md" });
		expect(pendingRow.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(true);
		expect(pendingRow.threadIds).toEqual([threadId]);
	});

	test("rejects missing or archived nodes", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-rejected.md",
				name: "archive-rejected.md",
				markdown: "# Archive rejected base",
			}),
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: crypto.randomUUID() }));

		const rejected = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(rejected._nay?.message).toBe("Not found");
	});
});

describe("apply_file_pending_archive", () => {
	test("archives the file, patches chunk scope, and removes the doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive.md",
				name: "apply-archive.md",
				markdown: "# Apply archive base",
			}),
		);
		const { plainTextChunkId } = await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-archive.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending delete row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBeDefined();
			const plainTextChunk = await ctx.db.get("files_plain_text_chunks", plainTextChunkId);
			expect(plainTextChunk?.archiveOperationId).toBe(node?.archiveOperationId);
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});

		// Re-accept after settle is a quiet no-op (bulk retries).
		const reApplied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: pendingRow._id,
			reviewedRevision: pendingRow.revision,
		});
		expect(reApplied._yay).toBe(null);
	});

	test("archives a folder subtree with one operation id and settles only the acting user's docs", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-folder/child.md",
				name: "child.md",
				markdown: "# Folder child base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-archive-folder",
				name: "apply-archive-folder",
			}),
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { parentId: folderId }));
		const outsiderSeeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-outsider.md",
				name: "apply-archive-outsider.md",
				markdown: "# Outsider base",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);

		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		// The acting user also has their own doc on the child: accept removes it too.
		const childDelete = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (childDelete._nay) {
			throw new Error(childDelete._nay.message);
		}
		// Another user's doc on the child must survive the accept untouched. They are a real member with a
		// real role, because proposing a delete asks the node whether this user may write it.
		const otherUserId = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_apply_archive_other" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now,
			});
			return userId;
		});
		const otherDoc = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: otherUserId,
			nodeId: seeded.nodeId,
		});
		if (otherDoc._nay) {
			throw new Error(otherDoc._nay.message);
		}
		// A file committed into the folder AFTER the proposal is archived too.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const lateFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: seeded.membershipId,
			parentId: folderId,
			path: "late.md",
		});
		if (lateFile._nay) throw new Error(lateFile._nay.message);
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folder = await ctx.db.get("files_nodes", folderId);
			const child = await ctx.db.get("files_nodes", seeded.nodeId);
			const late = await ctx.db.get("files_nodes", lateFile._yay.nodeId);
			expect(folder?.archiveOperationId).toBeDefined();
			expect(child?.archiveOperationId).toBe(folder?.archiveOperationId);
			expect(late?.archiveOperationId).toBe(folder?.archiveOperationId);
			const outsider = await ctx.db.get("files_nodes", outsiderSeeded.nodeId);
			expect(outsider?.archiveOperationId).toBeNull();

			const actingFolderRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: folderId,
			});
			expect(actingFolderRow).toBeNull();
			const actingChildRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(actingChildRow).toBeNull();
			const otherChildRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: otherUserId,
				nodeId: seeded.nodeId,
			});
			expect(otherChildRow?.pendingArchive).toBeDefined();
		});
	});

	test("ignores a locked archived tree when a new active folder reuses its path", async () => {
		const t = test_convex();
		const membership = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const archivedTree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-reused-docs",
				name: "pending-reused-docs",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-reused-docs/secret",
				name: "secret",
			});
			return { rootId, childId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Pending Path Reuse User",
		});
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: membership.membershipId,
			nodeIds: [archivedTree.rootId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		const archivedOperationId = (await t.run((ctx) => ctx.db.get("files_nodes", archivedTree.rootId)))
			?.archiveOperationId;
		expect(archivedOperationId).toBeDefined();

		const activeTree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-reused-docs",
				name: "pending-reused-docs",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-reused-docs/current",
				name: "current",
			});
			return { rootId, childId };
		});
		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: activeTree.rootId,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}

		// The lock arrives after the proposal. Accept must still use node lineage rather than
		// mistaking the archived `/pending-reused-docs` tree for this active one.
		await set_pending_test_read_only(asUser, membership.membershipId, archivedTree.childId);
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: membership.membershipId,
			target: { kind: "saved", id: activeTree.rootId },
			...(await reviewed_pending_for_test(t, {
				membershipId: membership.membershipId,
				target: { kind: "saved", id: activeTree.rootId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const activeRoot = await ctx.db.get("files_nodes", activeTree.rootId);
			const activeChild = await ctx.db.get("files_nodes", activeTree.childId);
			expect(activeRoot?.archiveOperationId).toBeDefined();
			expect(activeChild?.archiveOperationId).toBe(activeRoot?.archiveOperationId);
			expect((await ctx.db.get("files_nodes", archivedTree.rootId))?.archiveOperationId).toBe(archivedOperationId);
			expect((await ctx.db.get("files_nodes", archivedTree.childId))?.archiveOperationId).toBe(archivedOperationId);
		});
	});

	test("a true archived descendant still blocks a pending folder archive at accept time", async () => {
		const t = test_convex();
		const membership = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const tree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-true-archived",
				name: "pending-true-archived",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-true-archived/child",
				name: "child",
			});
			return { rootId, childId };
		});
		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: tree.rootId,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Pending True Descendant User",
		});
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: membership.membershipId,
			nodeIds: [tree.childId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		await set_pending_test_read_only(asUser, membership.membershipId, tree.childId);

		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: membership.membershipId,
			target: { kind: "saved", id: tree.rootId },
			...(await reviewed_pending_for_test(t, {
				membershipId: membership.membershipId,
				target: { kind: "saved", id: tree.rootId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_nodes", tree.rootId)))?.archiveOperationId).toBeNull();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: membership.userId,
					nodeId: tree.rootId,
				}),
			),
		).not.toBeNull();
	});

	test("drops the doc quietly when the node was already archived", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-raced.md",
				name: "apply-archive-raced.md",
				markdown: "# Raced base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		// The sidebar Archive action (or another accept) archived the node first.
		const sidebarOperationId = crypto.randomUUID();
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: sidebarOperationId }));

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._yay).toBe(null);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBe(sidebarOperationId);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});
});

describe("pending delete discard, save, expiry, and overlay reads", () => {
	test("discard clears the delete and keeps the content proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-delete-content.md",
				name: "discard-delete-content.md",
				markdown: "# Discard delete base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nStill wanted`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", seeded.nodeId)).not.toBeNull();
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.pendingArchive).toBeUndefined();
			expect(row && files_pending_update_has_yjs_content(row)).toBe(true);
		});
	});

	test("discard removes a delete-only doc and never touches the node", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-delete-only.md",
				name: "discard-delete-only.md",
				markdown: "# Discard delete-only base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing delete-only row before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("save is rejected while a delete pends", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-behind-delete.md",
				name: "save-behind-delete.md",
				markdown: "# Save behind delete base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nStaged change`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nStaged change`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const rowWithDelete = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowWithDelete) {
			throw new Error("Missing pending row while testing save behind a pending delete");
		}
		const saved = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			pendingUpdateId: rowWithDelete._id,
			expectedRevision: rowWithDelete.revision,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
		});
		expect(saved._nay?.message).toBe("File has a pending delete");
	});

	test("an expired delete-only doc is removed and the node stays", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-delete.md",
				name: "expire-delete.md",
				markdown: "# Expire delete base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing delete-only row before expiry");
		}
		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node).not.toBeNull();
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("get_by_path hides a pending-deleted file for the proposer only", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-delete.md",
				name: "overlay-delete.md",
				markdown: "# Overlay delete base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const forProposer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete.md",
			overlayUserId: seeded.userId,
		});
		expect(forProposer).toBeNull();

		const committed = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete.md",
		});
		expect(committed?._id).toBe(seeded.nodeId);
	});

	test("get_by_path hides a deleted folder's descendants", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-delete-folder/child.md",
				name: "child.md",
				markdown: "# Overlay folder child base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/overlay-delete-folder",
				name: "overlay-delete-folder",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const childForProposer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete-folder/child.md",
			overlayUserId: seeded.userId,
		});
		expect(childForProposer).toBeNull();

		const childCommitted = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete-folder/child.md",
		});
		expect(childCommitted?._id).toBe(seeded.nodeId);
	});
});

describe("discard_file_pending_content", () => {
	test("copies staged content into unstaged content without saving it", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content.md",
				name: "discard-content.md",
				markdown: "# Discard content base",
			}),
		);
		const stagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAccepted change`);
		const unstagedMarkdown = normalize_pending_update_markdown(`${stagedMarkdown}\n\nUnresolved change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const pendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingDoc) {
			throw new Error("Missing pending content doc before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingDoc._id,
			})),
			pendingUpdateId: pendingDoc._id,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		const docAfterDiscard = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingDoc._id));
		if (!docAfterDiscard) {
			throw new Error("Expected accepted staged content to keep the pending doc");
		}
		expect(
			await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: docAfterDiscard })),
		).toEqual({
			baseMarkdown: seeded.baseMarkdown,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
	});

	test("rejects a stale pendingUpdateId instead of discarding the replacement doc", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content-stale-id.md",
				name: "discard-content-stale-id.md",
				markdown: "# Discard stale content base",
			}),
		);

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFirst draft`,
		});
		const stalePendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!stalePendingDoc) {
			throw new Error("Missing stale pending content doc before replacement");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		const currentStagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nCurrent staged`);
		const currentUnstagedMarkdown = normalize_pending_update_markdown(`${currentStagedMarkdown}\n\nCurrent draft`);
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: currentStagedMarkdown,
			unstagedMarkdown: currentUnstagedMarkdown,
		});
		const currentPendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!currentPendingDoc) {
			throw new Error("Missing replacement pending content doc");
		}
		expect(currentPendingDoc._id).not.toBe(stalePendingDoc._id);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: stalePendingDoc._id,
			})),
			pendingUpdateId: stalePendingDoc._id,
		});
		expect(discarded._nay?.message).toBe("Not found");

		const docAfterDiscard = await t.run((ctx) => ctx.db.get("files_pending_updates", currentPendingDoc._id));
		expect(docAfterDiscard).not.toBeNull();
		expect(
			await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: docAfterDiscard! })),
		).toEqual({
			baseMarkdown: seeded.baseMarkdown,
			stagedMarkdown: currentStagedMarkdown,
			unstagedMarkdown: currentUnstagedMarkdown,
		});
	});
});

describe("discard_file_pending_structural", () => {
	test("deletes a pure-move row and leaves the node untouched", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-move-src.md",
				name: "discard-move-src.md",
				markdown: "# Discard move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/discard-move-src.md");
			const rowAfterDiscard = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterDiscard).toBeNull();
		});
	});

	test("refuses replacement after a swap partner was discarded", async () => {
		const t = test_convex();

		// Two EMPTY folders swap; discarding one side turns the other accept into a
		// plain empty-folder replacement of the now-stationary occupant.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-disc-file.md",
				name: "edr-disc-file.md",
				markdown: "# Edr disc base",
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-a",
				name: "edr-disc-a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-b",
				name: "edr-disc-b",
			});
			return { folderAId, folderBId };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("drops the move and keeps the content on a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-mixed-src.md",
				name: "discard-mixed-src.md",
				markdown: "# Discard mixed base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDiscard mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the content proposal to survive the structural discard");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks.length).toBeGreaterThan(0);
		});
	});

	test("keeps the destination node when discarding a copy row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-source.md",
				name: "discard-copy-source.md",
				markdown: "# Copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-dest.md",
				name: "discard-copy-dest.md",
				markdown: "# Copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// cp onto an existing file: the destination node was NOT created by the proposal.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Only the proposal row is dropped; the pre-existing node keeps its committed content.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps both the source and the destination when discarding a copy row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-keep-source.md",
				name: "discard-copy-keep-source.md",
				markdown: "# Copy keep source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-keep-dest.md",
				name: "discard-copy-keep-dest.md",
				markdown: "# Copy keep dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// cp onto an existing file: the copy lives on the TARGET row and names its source.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-keep-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Nothing moved and nothing was archived: only the proposal row is dropped.
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeNull();
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBeNull();
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when content was committed since the copy was proposed", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-source.md",
				name: "discard-copy-committed-source.md",
				markdown: "# Committed guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-dest.md",
				name: "discard-copy-committed-dest.md",
				markdown: "# Committed guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-committed-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Someone commits real content to the destination node through the regular Yjs flow.
		await t.run(async (ctx) => {
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			if (!destNode?.yjsLastSequenceId) {
				throw new Error("Missing destination yjsLastSequenceId while advancing committed state");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", destNode.yjsLastSequenceId, { lastSequence: 1 });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Discard removes the proposal and keeps the saved file.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-committed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when a rebase re-aligns the row base after a commit", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-source.md",
				name: "discard-copy-rebase-source.md",
				markdown: "# Rebase guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-dest.md",
				name: "discard-copy-rebase-dest.md",
				markdown: "# Rebase guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-rebase-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});

		// A remote edit lands before the client rebases the copied content.
		const remoteMarkdown = `${dest.baseMarkdown}\n\nRemote commit`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: dest.nodeId,
				markdown: remoteMarkdown,
			}),
		);
		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, dest.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${remoteMarkdown}\n\nCopied content`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build the rebased copy branch");
		}
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row?.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });
			expect(row?.copiedFrom).toEqual({
				target: { kind: "saved", id: source.nodeId },
				path: "/discard-copy-rebase-source.md",
			});
		});

		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Discard keeps the saved file after the copied content was rebased.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-rebase-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when another user has a pending row on it", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-source.md",
				name: "discard-copy-otheruser-source.md",
				markdown: "# Other user guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-dest.md",
				name: "discard-copy-otheruser-dest.md",
				markdown: "# Other user guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-otheruser-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Another user drafts on the destination node; hard delete would destroy their draft.
		const otherUserRowId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_pending_guard" }),
				target: { kind: "saved", id: dest.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-otheruser-dest.md");
			const otherUserRow = await ctx.db.get("files_pending_updates", otherUserRowId);
			expect(otherUserRow).not.toBeNull();
			const proposerRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(proposerRow).toBeNull();
		});
	});

	test("keeps a saved node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-saved-renamed-dest.md",
				name: "discard-saved-renamed-dest.md",
				markdown: "# Saved renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing saved row before discard");
		}

		// Another member renames the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_saved_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await asOtherUser.mutation(api.files_nodes.rename_node, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "discard-saved-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The other user's rename must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-saved-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("keeps a saved node that another user moved with move_nodes since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-saved-moved-dest.md",
				name: "discard-saved-moved-dest.md",
				markdown: "# Saved moved base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing saved row before discard");
		}

		// Another member moves the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_saved_moved_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				path: "/discard-saved-moved-folder",
				name: "discard-saved-moved-folder",
			});
			return { otherUserId, otherMembershipId, folderId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const moved = await asOtherUser.mutation(api.files_nodes.move_nodes, {
			membershipId: other.otherMembershipId,
			itemIds: [dest.nodeId],
			targetParentId: other.folderId,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The other user's move must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-saved-moved-folder/discard-saved-moved-dest.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("no-ops on content-only rows and keeps the content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content-src.md",
				name: "discard-content-src.md",
				markdown: "# Discard content base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nContent only`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		// No structural aspect on the row: the discard is an idempotent no-op success.
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(discarded._nay).toBeUndefined();

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});
});

describe("structural rows on content collapse", () => {
	test("content collapse on a mixed row degrades it to a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/degrade-mixed-src.md",
				name: "degrade-mixed-src.md",
				markdown: "# Degrade base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDegrade change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "degrade-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the content to base would normally delete the row; the move must survive.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a degraded pure-move row after content collapse");
			}
			expect(row.pendingMove?.destName).toBe("degrade-mixed-dest.md");
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(row.size).toBe(0);
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks).toHaveLength(0);
			expect(row.expiresAt).toBe(row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
			expect((await read_pending_update_expiry_check({ ctx, ...seeded }))?.nextCheckAt).toBeLessThanOrEqual(
				row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS,
			);
		});
	});

	test.each([false, true])("content collapse keeps a delete when collaboration off is %s", async (nonCollaborative) => {
		const t = test_convex();
		const baseMarkdown = normalize_pending_update_markdown("# Delete base");
		const seeded = await t.run(async (ctx) =>
			nonCollaborative
				? seed_non_collaborative_file(ctx, "/degrade-delete.md", baseMarkdown)
				: seed_file_with_markdown({
						ctx,
						path: "/degrade-delete.md",
						name: "degrade-delete.md",
						markdown: baseMarkdown,
					}),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown: baseMarkdown,
			unstagedMarkdown: `${baseMarkdown}\n\nAgent line`,
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test(ids);
		expect(archived._nay).toBeUndefined();
		const beforeCollapse = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(beforeCollapse?.content?.unstagedStateId).toBeDefined();

		// Discard all sends both branches back to the base. The delete still needs review.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const collapsed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: baseMarkdown,
			unstagedMarkdown: baseMarkdown,
		});
		expect(collapsed._nay).toBeUndefined();
		await t.run(async (ctx) => {
			const pendingUpdate = await read_pending_update_row({ ctx, ...seeded });
			expect(pendingUpdate).not.toBeNull();
			expect(pendingUpdate?.pendingArchive).toEqual({ fromPath: "/degrade-delete.md" });
			expect(pendingUpdate?.content).toBeUndefined();
			expect(pendingUpdate?.size).toBe(0);
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingUpdate!._id })).toHaveLength(0);
			expect(pendingUpdate!.expiresAt).toBe(pendingUpdate!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
			expect((await read_pending_update_expiry_check({ ctx, ...seeded }))?.nextCheckAt).toBeLessThanOrEqual(
				pendingUpdate!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS,
			);
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.archiveOperationId).toBeNull();
		});
	});

	test("content collapse degrades a copy row with a move to a pure move", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-source.md",
				name: "collapse-replace-source.md",
				markdown: "# Collapse replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-dest.md",
				name: "collapse-replace-dest.md",
				markdown: "# Collapse replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/collapse-replace-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			destParentId: files_ROOT_ID,
			destName: "collapse-replace-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the copied content keeps only the pending move.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: dest.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the degraded pure-move row to survive the content collapse");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(row.pendingMove?.destName).toBe("collapse-replace-renamed.md");
		expect(files_pending_update_has_yjs_content(row)).toBe(false);
	});
});

describe("save with structural rows", () => {
	test("save on a pure-move row returns No content to save", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-move-src.md",
				name: "save-move-src.md",
				markdown: "# Save move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saved._nay?.message).toBe("No content to save");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("save-move-dest.md");
	});

	test("full save on a mixed row publishes the content and keeps the move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-mixed-src.md",
				name: "save-mixed-src.md",
				markdown: "# Save mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSave mixed change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const committedMarkdown = await t.run((ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(committedMarkdown).toContain("Save mixed change");

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the move proposal to survive a full save");
			}
			expect(row.pendingMove?.destName).toBe("save-mixed-dest.md");
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(row.size).toBe(0);
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks).toHaveLength(0);
			expect(row.expiresAt).toBe(row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
			expect((await read_pending_update_expiry_check({ ctx, ...seeded }))?.nextCheckAt).toBeLessThanOrEqual(
				row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS,
			);
		});
	});

	test("partial save clears copiedFrom and keeps the remaining content", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-source.md",
				name: "save-copy-source.md",
				markdown: "# Save copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-dest.md",
				name: "save-copy-dest.md",
				markdown: "# Save copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// Staged stays at base while unstaged carries the copied content, so a save is partial.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/save-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the pending row to survive a partial save");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});

	test("save onto an archived target publishes the content and settles the row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-source.md",
				name: "save-archived-target-source.md",
				markdown: "# Archived target source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-dest.md",
				name: "save-archived-target-dest.md",
				markdown: "# Archived target dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const replacementMarkdown = normalize_pending_update_markdown(
			`${source.baseMarkdown}\n\nArchived target replacement`,
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-archived-target-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Any user archives the target file before the proposer accepts.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", dest.nodeId, { archiveOperationId: "archive-op-save-target" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		expect(saved._yay.newSequence).not.toBeNull();

		await t.run(async (ctx) => {
			// The save published the proposal onto the still-archived node and settled the row;
			// unarchiving later shows the saved text.
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBe("archive-op-save-target");
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeNull();
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			});
			expect(committedMarkdown).toBe(replacementMarkdown);
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});
});

describe("expire_file_pending_updates structural rows", () => {
	test("expiry keeps a saved node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-saved-renamed-dest.md",
				name: "expire-saved-renamed-dest.md",
				markdown: "# Expire saved renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing saved row before expiry");
			}
			return pendingRow;
		});

		// Another member renames the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_expire_saved_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await asOtherUser.mutation(api.files_nodes.rename_node, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "expire-saved-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			// The other user's rename must survive expiry: keep the node, drop only the row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-saved-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("expiry deletes a copy row but keeps the node", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-source.md",
				name: "expire-copy-source.md",
				markdown: "# Expire copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-dest.md",
				name: "expire-copy-dest.md",
				markdown: "# Expire copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/expire-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing copy row before expiry");
			}
			return pendingRow;
		});

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			// The row expires like a plain content row; the pre-existing node is never hard-deleted.
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-copy-dest.md");
		});
	});

	test("expiry deletes a pure-move row but keeps the node", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-move-src.md",
				name: "expire-move-src.md",
				markdown: "# Expire move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "expire-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing pending move row before expiry");
			}
			return pendingRow;
		});

		// A check run before the draft's expiry must not delete the proposal.
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});
		const rowAfterStaleRun = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id));
		expect(rowAfterStaleRun).not.toBeNull();

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/expire-move-src.md");
		});
	});
});

describe("reads behind a pure-move row", () => {
	test("committed content stays readable behind a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/read-move-src.md",
				name: "read-move-src.md",
				markdown: "# Read move base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/read-move-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "read-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before reads");
		}

		// Chunk reads must fall through to the committed chunks, not return an empty pending view.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/read-move-src.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read returns the committed content but still reports the
		// structural row's id, so write_file/edit_file mix onto it.
		const markdownState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/read-move-src.md",
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);
	});
});

describe("pending path overlay reads", () => {
	test("get_by_path resolves through the proposer's pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-src.md",
				name: "overlay-src.md",
				markdown: "# Overlay base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "overlay-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// The claimed destination presents the moved node with its doc UNCHANGED.
		const atDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(atDest?._id).toBe(seeded.nodeId);
		expect(atDest?.path).toBe("/overlay-src.md");

		// The vacated source reads as missing for the proposer.
		const atSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(atSource).toBeNull();

		// Without `overlayUserId` the committed lookup is unchanged (other users' view).
		const committedSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-src.md",
		});
		expect(committedSource?._id).toBe(seeded.nodeId);
		const committedDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-dest.md",
		});
		expect(committedDest).toBeNull();

		// Another user commits a rename of the source node and a newcomer file takes the old
		// path. The newcomer is untouched by the overlay, so it stays visible to the proposer.
		const newcomerNodeId = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, {
				path: "/overlay-moved-away.md",
				treePath: "/overlay-moved-away.md",
				name: "overlay-moved-away.md",
			});
			return await ctx.db.insert("files_nodes", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				path: "/overlay-src.md",
				treePath: "/overlay-src.md",
				pathDepth: 1,
				lowercaseExtension: "md",
				name: "overlay-src.md",
				sortName: files_sort_text_key("overlay-src.md"),
				kind: "file",
				parentId: files_ROOT_ID,
				createdBy: seeded.userId,
				updatedBy: seeded.userId,
				updatedAt: Date.now(),
				contentType: null,
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
			});
		});
		const newcomer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(newcomer?._id).toBe(newcomerNodeId);
	});

	test("content reads at the claimed destination serve the moved file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-content-src.md",
				name: "overlay-content-src.md",
				markdown: "# Overlay content base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/overlay-content-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "overlay-content-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before reads");
		}

		// Chunk reads translate the claimed destination to the moved file's content.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.target).toEqual({ kind: "saved", id: seeded.nodeId });
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read composes with the structural row: content resolves from the
		// committed tree and the row's id is still reported for mixing.
		const markdownState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);

		// The vacated source path serves nothing for the proposer.
		const vacatedRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-src.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(vacatedRead).toBeNull();
	});
});

// #region door 2 shape checks
describe("create_file_pending_update_operation_batch", () => {
	test("refuses an old batch after a new proposal reuses revision one", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/batch-replaced.md",
				name: "batch-replaced.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_move_for_test({
					t,
					...seeded,
					destParentId: files_ROOT_ID,
					destName: "first-move.md",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!before) throw new Error("Expected the first proposal");
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
					...(await reviewed_pending_for_test(t, {
						membershipId: seeded.membershipId,
						target: { kind: "saved", id: seeded.nodeId },
					})),
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await upsert_file_pending_move_for_test({
					t,
					...seeded,
					destParentId: files_ROOT_ID,
					destName: "second-move.md",
				})
			)._nay,
		).toBeUndefined();
		const after = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(after?._id).not.toBe(before._id);
		expect(after?.revision).toBe(before.revision);
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "old input",
		});
		expect(staged._nay?.name).toBe("target_changed");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect())).toEqual([]);
	});

	test("rejects sealed outputs after a same-time proposal change and keeps index revisions current", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/revision-base.md", "# Base"));
		r2Objects.set("content-snapshot/revision-base.md", "# Base");
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			...seeded,
			unstagedMarkdown: "---\ntopic: draft\n---\n# Proposed",
		});
		if (proposed._nay) throw new Error(proposed._nay.message);
		const before = await read_seeded_pending_row(t, seeded);
		if (!before) throw new Error("Expected the proposal");
		const beforeIndexes = await t.run(async (ctx) => ({
			text: await list_pending_update_text_chunks({ ctx, pendingUpdateId: before._id }),
			plain: await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: before._id }),
			metadata: await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", before._id))
				.collect(),
		}));
		const family = await seal_output_family_for_test(t, seeded);
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", family.operationBatchId)),
		).toMatchObject({ target: before.target, expectedRevision: before.revision, expectedPrivateVersion: null });

		// Two writes can share a millisecond. The revision must still reject the old batch.
		vi.spyOn(Date, "now").mockReturnValue(before.updatedAt);
		const moved = await upsert_file_pending_move_for_test({
			t,
			...seeded,
			destParentId: files_ROOT_ID,
			destName: "revision-moved.md",
		});
		expect(moved._nay).toBeUndefined();
		const after = await read_seeded_pending_row(t, seeded);
		if (!after) throw new Error("Expected the moved proposal");
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(after.revision).toBe(before.revision + 1);
		expect(after.content).toEqual(before.content);
		await t.run(async (ctx) => {
			for (const rows of Object.values(beforeIndexes)) {
				expect(rows.length).toBeGreaterThan(0);
			}
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: before._id })).toEqual(
				beforeIndexes.text.map((row) => ({ ...row, proposalRevision: after.revision })),
			);
			expect(await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: before._id })).toEqual(
				beforeIndexes.plain.map((row) => ({ ...row, proposalRevision: after.revision })),
			);
			expect(
				await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", before._id))
					.collect(),
			).toEqual(beforeIndexes.metadata.map((row) => ({ ...row, proposalRevision: after.revision })));
		});

		const committed = await t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: before._id,
			operationBatchId: family.operationBatchId,
			expectedRevision: before.revision,
			base: { kind: "asset", expectedAssetId: seeded.assetId },
			baseStateId: family.base.stateId,
			stagedStateId: family.staged.stateId,
			unstagedStateId: family.unstaged.stateId,
			baseStateDigest: family.base.digest,
			stagedStateDigest: family.staged.digest,
			unstagedStateDigest: family.unstaged.digest,
			unstagedText: "old output",
			unstagedBranchChanged: true,
		});
		expect(committed._nay?.name).toBe("target_changed");
		expect(await read_seeded_pending_row(t, seeded)).toEqual(after);
		expect(await t.run((ctx) => ctx.db.get("files_pending_update_yjs_states", family.base.stateId))).toMatchObject({
			owner: { kind: "temporary", operationBatchId: family.operationBatchId },
		});
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: family.operationBatchId,
		});
	});

	test.each(["creationGeneration", "structuralRevision", "state"] as const)(
		"refuses more private text after %s changes",
		async (field) => {
			const t = test_convex();
			const seeded = await t.run(async (ctx) => {
				const membership = await test_mocks_fill_db_with.membership(ctx);
				const { organizationId, workspaceId, userId } = membership;
				const nodeId = await ctx.db.insert("files_pending_nodes", {
					organizationId,
					workspaceId,
					userId,
					kind: "file",
					name: "private.txt",
					parent: { kind: "root" },
					creationGeneration: 1,
					structuralRevision: 1,
					state: "active",
					closedAt: null,
				});
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
					organizationId,
					workspaceId,
					userId,
					target: { kind: "private", id: nodeId },
					revision: 1,
					size: 0,
					updatedAt: Date.now(),
					expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
				});
				const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
					organizationId,
					workspaceId,
					userId,
					target: { kind: "private", id: nodeId },
					expectedPendingUpdateId: pendingUpdateId,
					expectedRevision: 1,
					expectedPrivateVersion: { creationGeneration: 1, structuralRevision: 1 },
					expiresAt: Date.now() + 60_000,
					updatedAt: Date.now(),
					lastActivityAt: Date.now(),
				});
				await ctx.db.patch(
					"files_pending_nodes",
					nodeId,
					field === "state" ? { state: "discarded", closedAt: Date.now() } : { [field]: 2 },
				);
				return { organizationId, workspaceId, userId, operationBatchId };
			});
			const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...seeded,
				role: "unstaged",
				text: "late text",
			});
			expect(staged._nay?.name).toBe("target_changed");
			expect(await t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect())).toEqual([]);
		},
	);

	test("refuses a second batch while one is already active for the same user and file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-admission",
				name: "pending-batch-admission",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(first._nay).toBeUndefined();

		// Two interleaved operations on one proposal would tear each other's staging, so the
		// second admission is a visible refusal instead of a silent queue.
		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay?.message).toBe("A pending update operation for this file is already in progress");
	});

	test("takes over the same user's batch once it sits idle past the takeover window", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-takeover",
				name: "pending-batch-takeover",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstBatchId = first._yay.operationBatchId;

		// A crashed client stages nothing, so only time passes. Age the liveness stamp past the
		// takeover window instead of waiting.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_operation_batches", firstBatchId, {
				lastActivityAt: Date.now() - 3 * 60 * 1000,
			});
		});

		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay).toBeUndefined();

		// The idle batch was retired by the takeover, not left active beside the new one.
		const firstBatch = await t.run(async (ctx) => ctx.db.get("files_pending_update_operation_batches", firstBatchId));
		expect(firstBatch?.expiresAt).toBe(0);
	});

	test("staging activity refreshes the liveness stamp, so an active client's batch is not taken over", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-active",
				name: "pending-batch-active",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstBatchId = first._yay.operationBatchId;

		// The batch looks idle, but the client then stages a text input, which refreshes the
		// liveness stamp.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_operation_batches", firstBatchId, {
				lastActivityAt: Date.now() - 3 * 60 * 1000,
			});
		});
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: firstBatchId,
			role: "unstaged",
			text: "# Still typing",
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}

		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay?.message).toBe("A pending update operation for this file is already in progress");
	});
});

describe("pending update state seal door 2", () => {
	function encode_doc(build: (yjsDoc: YDoc) => void) {
		const yjsDoc = new YDoc();
		yjsDoc.transact(() => build(yjsDoc));
		return files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));
	}

	async function seed_plain_text_pending_fixture(t: ReturnType<typeof test_convex>, path: string) {
		return await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path,
				name: path.slice(1),
				markdown: "",
				rootKind: "plain_text",
			}),
		);
	}

	// Control 8's named assertion: door 2 must NOT run door 1's content whitelist. A plain-text
	// document that also carries a real Tiptap `default` root encodes ContentType structs, so
	// the whitelist would refuse it forever — while parity on the plain root answers allow.
	test("accepts a branch state whose plain-text root is intact but which also carries a default root, and the pending row is patched", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-both-roots");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Both Roots User",
		});

		// Create the pending row through the real flow first: the rebase commit is update-only.
		const initialUpsert = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "line one\nline two\n",
			unstagedMarkdown: "line one\nline two\n",
		});
		if (initialUpsert._nay) {
			throw new Error(initialUpsert._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the both-roots rebase");
		}

		// The both-roots branches: real content under plain_text, a stale tab's Tiptap paragraph
		// beside it. The client base is a clone of the live state.
		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const liveBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const stagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: liveBaseYjsDoc });
		stagedBranchYjsDoc.transact(() => {
			stagedBranchYjsDoc.getText("plain_text").insert(0, "line one\nline two\n");
			stagedBranchYjsDoc.getXmlFragment("default").insert(0, [new YXmlElement("paragraph")]);
		});
		const unstagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: liveBaseYjsDoc });
		unstagedBranchYjsDoc.transact(() => {
			unstagedBranchYjsDoc.getText("plain_text").insert(0, "line one\nline two\nline three\n");
			unstagedBranchYjsDoc.getXmlFragment("default").insert(0, [new YXmlElement("paragraph")]);
		});

		// Door 2 runs at the seal inside this helper: all three states must be accepted.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(stagedBranchYjsDoc)),
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(`Expected door 2 to accept the both-roots branch: ${persistResult._nay.message}`);
		}
		if (!persistResult._yay || !("pendingUpdate" in persistResult._yay)) {
			throw new Error("Expected the rebase action result while testing the both-roots branch");
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();

		// Save projects only the file's plain text onto the live document.
		const saveResult = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingRow._id,
			})),
			pendingUpdateId: pendingRow._id,
		});
		expect(saveResult._nay).toBeUndefined();
		const savedState = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
		const savedDoc = files_yjs_doc_create_from_array_buffer_update(savedState.yjsUpdate);
		expect(savedDoc.getText("plain_text").toString()).toBe("line one\nline two\n");
		expect(savedDoc.getXmlFragment("default").length).toBe(0);
		savedDoc.destroy();
		const remaining = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!remaining) throw new Error("Expected the unaccepted third line");
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: "line one\nline two\n",
			stagedMarkdown: "line one\nline two\n",
			unstagedMarkdown: "line one\nline two\nline three\n",
		});

		const discardResult = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingRow._id,
			})),
			pendingUpdateId: pendingRow._id,
		});
		expect(discardResult._nay).toBeUndefined();
	});

	test("refuses a branch state whose plain root is a Y.Map at the seal, before any write", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-map-root");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Map Root User",
		});

		// Parity is vacuously true on this state (a map's content is invisible to toString and
		// length); only the root-scoped `_map.size === 0` line refuses it. The refusal happens at
		// the first (base) seal, so no pending row and no canonical state is ever written.
		const mapRootState = encode_doc((d) => {
			d.getMap("plain_text").set("k", "v");
		});

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate: mapRootState,
			stagedBranchYjsUpdate: mapRootState,
			unstagedBranchYjsUpdate: mapRootState,
		});
		expect(persistResult._nay?.message).toBe("Update does not match the file shape");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("refuses malformed, V2-encoded, and zero-byte states with their named messages", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-encodings");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Encoding User",
		});
		const legalState = encode_doc((d) => {
			d.getText("plain_text").insert(0, "legal");
		});

		const persist_with_unstaged = async (unstaged: ArrayBuffer) =>
			await persist_file_pending_update_rebased_state_for_test(asUser, {
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				baseYjsSequence: 0,
				baseYjsUpdate: legalState,
				stagedBranchYjsUpdate: legalState,
				unstagedBranchYjsUpdate: unstaged,
			});

		const v2Doc = new YDoc();
		v2Doc.getText("plain_text").insert(0, "v2");
		expect((await persist_with_unstaged(files_u8_to_array_buffer(encodeStateAsUpdateV2(v2Doc))))._nay?.message).toBe(
			"Unsupported update encoding",
		);
		expect((await persist_with_unstaged(files_u8_to_array_buffer(new Uint8Array([255, 255, 255]))))._nay?.message).toBe(
			"Malformed update",
		);
		// Zero bytes must be a refusal, never a crash. The paged pipeline refuses it twice over:
		// a zero-byte page cannot be staged, and a role with no staged pages cannot be sealed
		// (the helper stages no page for zero bytes, so its seal finds no state).
		expect((await persist_with_unstaged(files_u8_to_array_buffer(new Uint8Array(0))))._nay?.message).toBe("Not found");
		const emptyPage = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (emptyPage._nay) {
			throw new Error(emptyPage._nay.message);
		}
		const stagedEmptyPage = await asUser.mutation(api.files_pending_updates.stage_file_pending_update_state_page, {
			membershipId: seeded.membershipId,
			operationBatchId: emptyPage._yay.operationBatchId,
			role: "unstaged",
			pageIndex: 0,
			bytes: files_u8_to_array_buffer(new Uint8Array(0)),
		});
		expect(stagedEmptyPage._nay?.message).toBe("Empty state page");
	});

	test("refuses a state page over the wire cap before any page insert", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-page-cap");

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}

		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: batch._yay.operationBatchId,
			phase: "input",
			role: "unstaged",
			pageIndex: 0,
			bytes: files_u8_to_array_buffer(new Uint8Array(files_MAX_YJS_WIRE_BYTES + 1)),
		});
		expect(staged._nay?.message).toBe(`State page exceeds ${files_MAX_YJS_WIRE_BYTES}-byte limit`);

		// The cap runs before the insert: no page row was written.
		const pages = await t.run(async (ctx) => ctx.db.query("files_pending_update_yjs_state_pages").collect());
		expect(pages).toHaveLength(0);
	});

	test("seals a legal multi-page tombstone-heavy state and refuses one over the 4 MiB cap", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-state-caps");

		// A legal state can be far larger than its visible text: a gc-disabled client doc keeps
		// deleted characters in its encoded state, so the size rule must come from the state
		// bytes, never the visible text.
		function tombstone_heavy_state(args: { cycles: number; cycleChars: number }) {
			const yjsDoc = new YDoc({ gc: false });
			const ytext = yjsDoc.getText("plain_text");
			for (let i = 0; i < args.cycles; i++) {
				ytext.insert(0, "a".repeat(args.cycleChars));
				ytext.delete(0, args.cycleChars);
			}
			ytext.insert(0, "kept\n");
			return files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));
		}

		// One batch for both roles (one active batch per user/node): the legal state seals under
		// the "unstaged" role, the over-cap one refuses under "staged".
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const operationBatchId = batch._yay.operationBatchId;

		async function stage_and_seal(role: "staged" | "unstaged", state: ArrayBuffer) {
			const bytes = new Uint8Array(state);
			for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
				const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
				const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					operationBatchId,
					phase: "input",
					role,
					pageIndex,
					bytes: files_u8_to_array_buffer(bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES)),
				});
				if (staged._nay) {
					throw new Error(staged._nay.message);
				}
			}
			return await t.mutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				operationBatchId,
				phase: "input",
				role,
				expectedTotalBytes: state.byteLength,
			});
		}

		// ~3.16 MB across four pages (the plan's round-13 legal full state, approximated): seals.
		const legalState = tombstone_heavy_state({ cycles: 4, cycleChars: 790_000 });
		expect(legalState.byteLength).toBeGreaterThan(2 * files_MAX_YJS_WIRE_BYTES);
		expect(legalState.byteLength).toBeLessThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
		const legalSealed = await stage_and_seal("unstaged", legalState);
		expect(legalSealed._nay).toBeUndefined();
		if (legalSealed._nay) {
			throw new Error(legalSealed._nay.message);
		}
		const sealedStateDoc = await t.run(async (ctx) =>
			ctx.db.get("files_pending_update_yjs_states", legalSealed._yay.stateId),
		);
		expect(sealedStateDoc).toMatchObject({ sealed: true, totalBytes: legalState.byteLength, pageCount: 4 });

		// One past 4 MiB: the seal refuses on the recorded byte total.
		const overState = tombstone_heavy_state({ cycles: 5, cycleChars: 850_000 });
		expect(overState.byteLength).toBeGreaterThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
		const overSealed = await stage_and_seal("staged", overState);
		expect(overSealed._nay?.message).toBe(`State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit`);
	});
});
// #endregion door 2 shape checks

// #region pending state TTL sweep
describe("cleanup_expired_pending_state_rows", () => {
	async function seed_state_family(
		t: ReturnType<typeof test_convex>,
		seeded: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			nodeId: Id<"files_nodes">;
		},
		owner:
			| { kind: "active"; pendingUpdateId: Id<"files_pending_updates">; role: "base" }
			| {
					kind: "temporary";
					operationBatchId: Id<"files_pending_update_operation_batches">;
					phase: "input";
					role: "base";
					expiresAt: number;
			  }
			| { kind: "retired"; cleanupTaskId: Id<"files_pending_update_state_cleanup_tasks"> },
		pageCount = 1,
	) {
		return await t.run(async (ctx) => {
			const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				owner,
				lineageGeneration: 0,
				sealed: true,
				pageCount,
				totalBytes: pageCount * 2,
				digest: "test-digest",
			});
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "state", id: stateId },
						byteCount: pageCount * 2,
					})
				)._nay,
			).toBeUndefined();
			for (let pageIndex = 0; pageIndex < pageCount; pageIndex++)
				await ctx.db.insert("files_pending_update_yjs_state_pages", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					stateId,
					pageIndex,
					bytes: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				});
			return stateId;
		});
	}

	test("keeps the full byte charge until the last page is deleted across bounded passes", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-pages.md", name: "sweep-pages.md", markdown: "# Sweep" }),
		);
		const now = Date.now();
		const operationBatchId = await t.run((ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);
		const stateIds: Id<"files_pending_update_yjs_states">[] = [];
		for (let index = 0; index < 2; index++)
			stateIds.push(
				await seed_state_family(
					t,
					seeded,
					{ kind: "temporary", operationBatchId, phase: "input", role: "base", expiresAt: now - 1000 },
					5,
				),
			);
		const first = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(first.done).toBe(false);
		const remaining = await t.run(async (ctx) => ({
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			holds: await ctx.db.query("files_private_storage_reservations").collect(),
		}));
		expect(remaining.pages).toHaveLength(4);
		expect(remaining.states).toHaveLength(1);
		expect(remaining.states[0]?.totalBytes).toBe(10);
		expect(remaining.holds.find((hold) => hold.resource.id === remaining.states[0]?._id)).toMatchObject({
			byteCount: 10,
			settlement: { kind: "held" },
		});
		const second = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(second.done).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_pending_update_yjs_state_pages").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toEqual([]);
			expect(await ctx.db.get("files_pending_update_operation_batches", operationBatchId)).toBeNull();
			const holds = await ctx.db.query("files_private_storage_reservations").collect();
			for (const id of stateIds)
				expect(holds.find((hold) => hold.resource.id === id)).toMatchObject({
					byteCount: 10,
					settlement: { kind: "deleted" },
				});
		});
	});

	test("sweeps expired temporary families but never active ones (the gte(0) lower bound)", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-bounds", name: "sweep-bounds", markdown: "# Sweep" }),
		);
		const now = Date.now();

		const pendingUpdateId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: now,
				expiresAt: now + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);
		const batchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: pendingUpdateId,
				expectedRevision: 1,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);

		// Docs without `owner.expiresAt` sort BEFORE every number on the index: without the
		// gte(0) lower bound the sweep would also return (and delete) this active family.
		const activeStateId = await seed_state_family(t, seeded, {
			kind: "active",
			pendingUpdateId,
			role: "base",
		});
		const expiredTemporaryStateId = await seed_state_family(t, seeded, {
			kind: "temporary",
			operationBatchId: batchId,
			phase: "input",
			role: "base",
			expiresAt: now - 1000,
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_yjs_states", activeStateId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_update_yjs_states", expiredTemporaryStateId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_operation_batches", batchId)).toBeNull();
		});
	});

	test("expired operation batches take their text inputs and temporary families with them", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-batches", name: "sweep-batches", markdown: "# Sweep" }),
		);
		const now = Date.now();
		const expiredBatchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);
		const liveBatchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now + 30 * 60 * 1000,
				lastActivityAt: now,
				updatedAt: now,
			}),
		);
		const expiredTextInputId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_text_inputs", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				operationBatchId: expiredBatchId,
				role: "staged",
				text: "staged text",
				expiresAt: now - 1000,
			}),
		);
		const expiredStageId = await t.run(async (ctx) =>
			ctx.db.insert("files_yjs_trusted_update_stages", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				fileNodeId: seeded.nodeId,
				kind: "pending_accept",
				update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				expiresAt: now - 1000,
			}),
		);
		await t.run(async (ctx) => {
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "text_input", id: expiredTextInputId },
						byteCount: files_get_utf8_byte_size("staged text"),
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "trusted_stage", id: expiredStageId },
						byteCount: 2,
					})
				)._nay,
			).toBeUndefined();
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_operation_batches", expiredBatchId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_operation_batches", liveBatchId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_update_text_inputs", expiredTextInputId)).toBeNull();
			expect(await ctx.db.get("files_yjs_trusted_update_stages", expiredStageId)).toBeNull();
		});
	});

	test("drains retired cleanup tasks and tolerates a task whose states were already deleted", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-tasks", name: "sweep-tasks", markdown: "# Sweep" }),
		);
		const now = Date.now();

		// A task whose states user-deletion already removed: the drain must still delete the
		// task doc instead of keeping it forever as a false signal of pending work.
		const drainedTaskId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				createdAt: now,
			}),
		);
		// A task that still owns a family: the drain deletes states, pages, then the task.
		const ownedTaskId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				createdAt: now,
			}),
		);
		const retiredStateId = await seed_state_family(t, seeded, {
			kind: "retired",
			cleanupTaskId: ownedTaskId,
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", drainedTaskId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", ownedTaskId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_yjs_states", retiredStateId)).toBeNull();
		});
	});
});
// #endregion pending state TTL sweep

describe("pending update read-only checks", () => {
	test("a locked target refuses a new content proposal without creating a row", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-proposal.md",
				name: "pending-read-only-proposal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only proposal user",
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a proposal survives a lock and accepts after unlock", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-durable.md",
				name: "pending-read-only-durable.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only durable user",
		});
		const proposedMarkdown = "# Accepted after unlock";
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: proposedMarkdown,
			unstagedMarkdown: proposedMarkdown,
		});
		expect(proposed._nay).toBeUndefined();
		const pendingBeforeLock = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingBeforeLock) {
			throw new Error("Missing proposal before lock");
		}

		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		const refused = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingBeforeLock._id))).not.toBeNull();

		await set_pending_test_writable(asUser, seeded.membershipId, seeded.nodeId);
		const accepted = await asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingBeforeLock._id))).toBeNull();
		expect(
			await t.run((ctx) =>
				read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		).toContain("Accepted after unlock");
	});

	test("a lock and unlock before the no-change final mutation still settles the batch", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-final-barrier.md",
				name: "pending-read-only-final-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only final barrier user",
		});
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		await set_pending_test_writable(asUser, seeded.membershipId, seeded.nodeId);

		const settled = await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			expectedRevision: null,
		});
		expect(settled._nay).toBeUndefined();
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId)))
				?.expiresAt,
		).toBe(0);
	});

	test("a no-change settle that read no doc leaves a doc that appeared since then", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-no-change-late-doc.md",
				name: "pending-no-change-late-doc.md",
				markdown: "# Base",
			}),
		);

		// The action read no doc. A concurrent write made one before the settle ran.
		const lateDoc = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Base\n\nLate doc",
		});
		if (lateDoc._nay) {
			throw new Error(lateDoc._nay.message);
		}
		const lateRow = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!lateRow) {
			throw new Error("expected the late doc to exist");
		}

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const settled = await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			expectedRevision: null,
		});
		expect(settled._nay?.message).toBe("Pending update changed, retry the write");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", lateRow._id))).toEqual(lateRow);
	});

	test("a lock before the no-change final mutation refuses and retires the batch", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-no-change-gap.md",
				name: "pending-read-only-no-change-gap.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only no-change gap user",
		});
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const operationBatchId = batch._yay.operationBatchId;
		const staged = await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: seeded.membershipId,
			operationBatchId,
			role: "unstaged",
			text: seeded.baseMarkdown,
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}

		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const proposing = asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			operationBatchId,
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		releaseSnapshotFetch?.();
		const refused = await proposing;
		expect(refused._nay?.name).toBe("read_only");
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", operationBatchId)))?.expiresAt,
		).toBe(0);
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock and unlock before the refresh final mutation still refreshes the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-refresh-barrier.md",
				name: "pending-read-only-refresh-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only refresh barrier user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing proposal before refresh barrier");
		}
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		await set_pending_test_writable(asUser, seeded.membershipId, seeded.nodeId);

		const refreshed = await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingRow._id,
			expectedRevision: pendingRow.revision,
		});
		expect(refreshed._nay).toBeUndefined();

		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id));
		expect(rowAfter?.updatedAt).toBeGreaterThan(pendingRow.updatedAt);
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId)))
				?.expiresAt,
		).toBe(0);
	});

	test("a lock and unlock in the save action gap still saves the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-save-gap.md",
				name: "pending-read-only-save-gap.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only save gap user",
		});
		const proposalText = "# Save gap proposal";
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: proposalText,
			unstagedMarkdown: proposalText,
		});
		expect(proposed._nay).toBeUndefined();
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing proposal before save gap");
		}

		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const saving = asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		await set_pending_test_writable(asUser, seeded.membershipId, seeded.nodeId);
		releaseSnapshotFetch?.();
		const saved = await saving;
		expect(saved._nay).toBeUndefined();
		expect(saved._yay?.newSequence).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const trustedStages = await ctx.db
				.query("files_yjs_trusted_update_stages")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(trustedStages).toEqual([]);
			const lastSaved = await ctx.db
				.query("files_pending_updates_last_sequence_saved")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first();
			expect(lastSaved?.lastSequenceSaved).toBe(saved._yay?.newSequence);
			expect(
				await read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			).toContain("Save gap proposal");
		});
	});

	test("a lock and unlock before the rebase final mutation still rebases the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-rebase-final.md",
				name: "pending-read-only-rebase-final.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only rebase user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const [pendingRow, fileState] = await Promise.all([
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
			t.run((ctx) =>
				read_file_yjs_state({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		]);
		if (!pendingRow) {
			throw new Error("Missing proposal before rebase final");
		}
		const staged = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: fileState.yjsUpdate,
			stagedBranchYjsUpdate: fileState.yjsUpdate,
			unstagedBranchYjsUpdate: fileState.yjsUpdate,
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		await set_pending_test_writable(asUser, seeded.membershipId, seeded.nodeId);

		const rebased = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			operationBatchId: staged.operationBatchId,
			expectedRevision: pendingRow.revision,
			base: {
				kind: "yjs",
				baseYjsSequence: fileState.yjsSequence,
				baseLineageGeneration: 0,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			},
			baseStateId: staged.base.stateId,
			stagedStateId: staged.staged.stateId,
			unstagedStateId: staged.unstaged.stateId,
			baseStateDigest: staged.base.digest,
			stagedStateDigest: staged.staged.digest,
			unstagedStateDigest: staged.unstaged.digest,
			unstagedText: seeded.baseMarkdown,
		});
		expect(rebased._nay).toBeUndefined();
		expect(rebased._yay?.pendingUpdate?._id).toBe(pendingRow._id);
		expect(rebased._yay?.pendingUpdate?.updatedAt).toBeGreaterThan(pendingRow.updatedAt);
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", staged.operationBatchId)),
		).toBeNull();
	});

	test("a locked copy source stays readable", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-copy-source.md",
				name: "pending-read-only-copy-source.md",
				markdown: "# Source",
			}),
		);
		const copyDest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-copy-dest.md",
				name: "pending-read-only-copy-dest.md",
				markdown: "# Destination",
				membership: source,
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: source.userId,
			name: "Read-only copy user",
		});
		await set_pending_test_read_only(asUser, source.membershipId, source.nodeId);

		// A copy only reads the source, so the source's lock does not stop it.
		const copied = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: copyDest.nodeId,
			unstagedMarkdown: source.baseMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/pending-read-only-copy-source.md" },
		});
		expect(copied._nay).toBeUndefined();
	});

	test("a locked move participant refuses proposal, while a durable move accepts after unlock", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-source.md",
				name: "pending-read-only-move-source.md",
				markdown: "# Source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-occupant.md",
				name: "pending-read-only-move-occupant.md",
				markdown: "# Occupant",
				membership: source,
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: source.userId,
			name: "Read-only move user",
		});
		await set_pending_test_read_only(asUser, source.membershipId, occupant.nodeId);
		const blockedReplacement = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-occupant.md",
			replace: true,
		});
		expect(blockedReplacement._nay?.name).toBe("read_only");
		await set_pending_test_writable(asUser, source.membershipId, occupant.nodeId);

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-moved.md",
		});
		expect(proposed._nay).toBeUndefined();
		await set_pending_test_read_only(asUser, source.membershipId, source.nodeId);
		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: source.membershipId,
			target: { kind: "saved", id: source.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: source.membershipId,
				target: { kind: "saved", id: source.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		await set_pending_test_writable(asUser, source.membershipId, source.nodeId);
		const accepted = await asUser.mutation(api.files_pending_updates.apply_file_pending_move, {
			membershipId: source.membershipId,
			target: { kind: "saved", id: source.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: source.membershipId,
				target: { kind: "saved", id: source.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_nodes", source.nodeId)))?.path).toBe("/pending-read-only-moved.md");
	});

	test("a locked descendant refuses a folder archive proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-archive-folder",
				name: "pending-read-only-archive-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive user",
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.childNodeId);

		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.folderId,
		});
		expect(proposed._nay?.name).toBe("read_only");
	});

	test("a locked file refuses the content batch before any Yjs state is staged", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-batch-door.md",
				name: "pending-read-only-batch-door.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only batch door user",
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		// The editor asks for a batch before it uploads any branch state. Refusing here keeps the
		// client from uploading Yjs pages that could never be committed.
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(batch._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect())).toEqual([]);
	});

	test("a batch made on a locked file cannot commit", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file(ctx, "/off-batch-lock.md", "# Off base"));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only batch commit user",
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		// The internal batch door checks nothing by design: its callers check. Only the commit can
		// still refuse this write, so a batch made after the lock must not carry a write through.
		const staged = await seal_output_family_for_test(t, seeded);
		const commit = (family: typeof staged) =>
			t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: family.operationBatchId,
				expectedRevision: null,
				base: { kind: "asset", expectedAssetId: seeded.assetId },
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "# Draft",
				unstagedBranchChanged: true,
			});

		const committed = await commit(staged);
		expect(committed._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();

		await set_pending_test_writable(asUser, seeded.membershipId, seeded.nodeId);
		// The refused commit left its batch active; the retry starts over with a fresh one.
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: staged.operationBatchId,
		});
		const retry = await seal_output_family_for_test(t, seeded);
		const retried = await commit(retry);
		expect(retried._nay).toBeUndefined();
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).not.toBeNull();
	});

	test("a private draft cannot publish while its parent folder is locked", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read-only draft publish user",
		});
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/locked-parent",
				name: "locked-parent",
			}),
		);
		await set_pending_test_read_only(asUser, db.membershipId, folderId);

		// The draft door checks the destination first, so a pending draft never sits under a locked
		// folder. Seed this one directly: the publish door is shared with transfer drafts, which can
		// exist under a locked parent, and its own live check must stop the write.
		const text = "Saved from a private draft\n";
		const seeded = await t.run(async (ctx) => {
			const created = await files_pending_nodes_db_create(ctx, {
				...db,
				parent: { kind: "saved", id: folderId },
				name: "draft.txt",
				kind: "file",
			});
			if (created._nay) throw new Error(created._nay.message);
			await ctx.db.patch("files_pending_updates", created._yay.pendingUpdateId, {
				createIntent: {
					kind: "text",
					contentType: "text/plain",
					textKind: "plain_text",
					collaborationEnabled: false,
					metadata: [],
				},
			});
			const contentAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(text),
				unfinalizedExpiresAt: Date.now() + 60_000,
				updatedAt: Date.now(),
			});
			const r2Key = r2_create_asset_key({ ...db, assetId: contentAssetId });
			const held = await files_private_storage_db_reserve(ctx, {
				...db,
				resource: { kind: "asset", id: contentAssetId, r2Key },
				byteCount: files_get_utf8_byte_size(text),
			});
			if (held._nay) throw new Error(held._nay.message);
			r2Objects.set(r2Key, text);
			const membership = await ctx.db.get("organizations_workspaces_users", db.membershipId);
			const node = await ctx.db.get("files_pending_nodes", created._yay.privateNodeId);
			const pendingUpdate = await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId);
			if (!membership || !node || !pendingUpdate) throw new Error("Expected private draft records");
			return { membership, node, pendingUpdate, contentAssetId };
		});
		const publish = () =>
			t.run((ctx) =>
				files_nodes_content_db_publish_private_node(ctx, {
					membership: seeded.membership,
					node: seeded.node,
					pendingUpdate: seeded.pendingUpdate,
					billedUserId: db.userId,
					prepared: { text, contentAssetId: seeded.contentAssetId },
				}),
			);

		const refused = await publish();
		expect(refused._nay?.name).toBe("read_only");
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_nodes", seeded.node._id)).toMatchObject({ state: "active" });
			expect(await ctx.db.get("files_pending_updates", seeded.pendingUpdate._id)).not.toBeNull();
			expect(await ctx.db.query("files_nodes").collect()).toEqual([expect.objectContaining({ _id: folderId })]);
		});

		await set_pending_test_writable(asUser, db.membershipId, folderId);
		const published = await publish();
		if (published._nay) throw new Error(published._nay.message);
		expect(published._yay.target.kind).toBe("saved");
	});

	test("a private draft cannot edit while its parent folder is locked", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx);
			const folderId = await seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/draft-parent",
				name: "draft-parent",
			});
			const created = await files_pending_nodes_db_create(ctx, {
				...db,
				parent: { kind: "saved", id: folderId },
				name: "draft.txt",
				kind: "file",
			});
			if (created._nay) throw new Error(created._nay.message);
			return { ...db, folderId, privateNodeId: created._yay.privateNodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only draft edit user",
		});
		const target = { kind: "private" as const, id: seeded.privateNodeId };
		const readTarget = () =>
			asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: seeded.membershipId,
				target,
			});

		expect((await readTarget())?.canEdit).toBe(true);
		// The header's breadcrumb hangs the pending chain from this saved folder.
		expect((await readTarget())?.savedParentId).toBe(seeded.folderId);
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.folderId);
		expect((await readTarget())?.canEdit).toBe(false);
		await set_pending_test_writable(asUser, seeded.membershipId, seeded.folderId);
		expect((await readTarget())?.canEdit).toBe(true);
	});

	test("the agent proposal path refuses a locked file", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-agent-path.md",
				name: "pending-read-only-agent-path.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only agent path user",
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		// The agent creates its batch server-side, so it never passes the public batch door above.
		// An agent write is still a normal write and has to stop at the lock.
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Agent draft",
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock taken while the content action runs refuses the commit mutation", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-commit-barrier.md",
				name: "pending-read-only-commit-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only commit barrier user",
		});

		// Hold the action inside its snapshot read, then lock. The action already checked the lock,
		// so only the commit mutation can still refuse this write.
		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const proposing = upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		releaseSnapshotFetch?.();
		const proposed = await proposing;

		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock before the refresh final mutation refuses and keeps the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-refresh-refusal.md",
				name: "pending-read-only-refresh-refusal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only refresh refusal user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing proposal before refresh refusal");
		}
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		// A refresh rewrites the stored branches, so it is a write and the lock stops it. The
		// proposal itself stays, so the user can still read or discard it.
		const refreshed = await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingRow._id,
			expectedRevision: pendingRow.revision,
		});
		expect(refreshed._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id)))?.updatedAt).toBe(
			pendingRow.updatedAt,
		);
	});

	test("a lock before the rebase final mutation refuses and keeps the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-rebase-refusal.md",
				name: "pending-read-only-rebase-refusal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only rebase refusal user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const [pendingRow, fileState] = await Promise.all([
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
			t.run((ctx) =>
				read_file_yjs_state({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		]);
		if (!pendingRow) {
			throw new Error("Missing proposal before rebase refusal");
		}
		const staged = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: fileState.yjsUpdate,
			stagedBranchYjsUpdate: fileState.yjsUpdate,
			unstagedBranchYjsUpdate: fileState.yjsUpdate,
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		// A rebase replaces the stored branch states, so it writes and the lock stops it.
		const rebased = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			operationBatchId: staged.operationBatchId,
			expectedRevision: pendingRow.revision,
			base: {
				kind: "yjs",
				baseYjsSequence: fileState.yjsSequence,
				baseLineageGeneration: 0,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			},
			baseStateId: staged.base.stateId,
			stagedStateId: staged.staged.stateId,
			unstagedStateId: staged.unstaged.stateId,
			baseStateDigest: staged.base.digest,
			stagedStateDigest: staged.staged.digest,
			unstagedStateDigest: staged.unstaged.digest,
			unstagedText: seeded.baseMarkdown,
		});
		expect(rebased._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id)))?.updatedAt).toBe(
			pendingRow.updatedAt,
		);
	});

	test("a lock taken while the save action runs refuses the save mutation", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-save-barrier.md",
				name: "pending-read-only-save-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only save barrier user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "# Save barrier draft",
			unstagedMarkdown: "# Save barrier draft",
		});
		expect(proposed._nay).toBeUndefined();

		// Hold the save action inside its snapshot read, then lock. The action already checked the
		// lock, so only the final save mutation can still refuse this write.
		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const saving = asUser.action(api.ai_chat.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);
		releaseSnapshotFetch?.();
		const saved = await saving;

		expect(saved._nay?.name).toBe("read_only");
		await t.run(async (ctx) => {
			expect(
				await read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			).not.toBeNull();
			expect(
				await read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			).not.toContain("Save barrier draft");
		});
	});

	test("a locked move source refuses the proposal, and a locked file inside a moved folder does not", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-leaf.md",
				name: "pending-read-only-move-leaf.md",
				markdown: "# Leaf",
				membership,
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-folder",
				name: "pending-read-only-move-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, leafNodeId: file.nodeId, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only move source user",
		});

		// A move renames the node itself, so a lock on the moved file refuses the proposal.
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.leafNodeId);
		const refusedLeaf = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.leafNodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-leaf-renamed.md",
		});
		expect(refusedLeaf._nay?.name).toBe("read_only");

		// A writable folder may move while it holds a locked child. Rename and move check the named
		// item and its immediate parent, not descendants.
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.childNodeId);
		const movedFolder = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.folderId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-folder-renamed",
		});
		expect(movedFolder._nay).toBeUndefined();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.folderId,
				}),
			),
		).not.toBeNull();
	});

	test("a locked move destination or a locked file inside the replaced folder refuses the move proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-dest-file.md",
				name: "pending-read-only-move-dest-file.md",
				markdown: "# Mover",
				membership,
			});
			const destFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-dest",
				name: "pending-read-only-move-dest",
			});
			const sourceFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-src-folder",
				name: "pending-read-only-move-src-folder",
			});
			const occupantFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-occupant-folder",
				name: "pending-read-only-move-occupant-folder",
			});
			const occupantChild = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-occupant-folder/child.md",
				name: "child.md",
				markdown: "# Occupant child",
				membership,
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantFolderId });
			return {
				...membership,
				fileNodeId: file.nodeId,
				destFolderId,
				sourceFolderId,
				occupantFolderId,
				occupantChildNodeId: occupantChild.nodeId,
			};
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only move destination user",
		});

		// Dropping a file into a folder adds a child entry to that folder, so a locked destination
		// refuses the proposal.
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.destFolderId);
		const refusedDestination = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileNodeId,
			destParentId: seeded.destFolderId,
			destName: "pending-read-only-move-dest-file.md",
		});
		expect(refusedDestination._nay?.name).toBe("read_only");

		// A folder may replace a folder that has no active child. Accepting that replace archives the
		// occupant with everything below it, so a locked archived file under it refuses the proposal.
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.occupantChildNodeId],
		});
		expect(archived._nay).toBeUndefined();
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.occupantChildNodeId);
		const refusedOccupant = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.sourceFolderId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-occupant-folder",
			replace: true,
		});
		expect(refusedOccupant._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.sourceFolderId,
				}),
			),
		).toBeNull();
	});

	test("a locked file refuses its own archive proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-self.md",
				name: "pending-read-only-archive-self.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive self user",
		});
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.nodeId);

		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock on the file or on an active descendant refuses the archive accept", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-accept.md",
				name: "pending-read-only-archive-accept.md",
				markdown: "# Base",
				membership,
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-archive-accept-folder",
				name: "pending-read-only-archive-accept-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-accept-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, fileNodeId: file.nodeId, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive accept user",
		});
		for (const nodeId of [seeded.fileNodeId, seeded.folderId]) {
			const proposed = await upsert_file_pending_archive_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId,
			});
			if (proposed._nay) {
				throw new Error(proposed._nay.message);
			}
		}

		// Both proposals were made while everything was writable. Accept checks the current lock
		// again: once on the node itself, and once on every active file the archive would sweep.
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.fileNodeId);
		await set_pending_test_read_only(asUser, seeded.membershipId, seeded.childNodeId);
		const refusedFile = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.fileNodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.fileNodeId },
			})),
		});
		expect(refusedFile._nay?.name).toBe("read_only");
		const refusedFolder = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.folderId },
			})),
		});
		expect(refusedFolder._nay?.name).toBe("read_only");
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.fileNodeId))?.archiveOperationId).toBeNull();
			expect((await ctx.db.get("files_nodes", seeded.folderId))?.archiveOperationId).toBeNull();
		});
	});
});

describe("pending file that was moved while pending", () => {
	test("accept saves content onto the moved node", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-mv-repro.md",
				name: "qa-mv-repro.md",
				markdown: "# Base",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-dest",
				name: "qa-mv-dest",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const moved = await asUser.mutation(api.files_nodes.move_nodes, {
			membershipId: seeded.membershipId,
			itemIds: [seeded.nodeId],
			targetParentId: destFolderId,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.path).toBe("/qa-mv-dest/qa-mv-repro.md");

		const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saved._nay).toBeUndefined();

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("agent mv of a saved file with pending content onto an occupied path stays reviewable", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-mv-src2/qa-mv-saved2.md",
				name: "qa-mv-saved2.md",
				markdown: "# Base",
			}),
		);
		const srcFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-src2",
				name: "qa-mv-src2",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-dst2",
				name: "qa-mv-dst2",
			}),
		);
		// A committed occupant already owns the destination path.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { parentId: srcFolderId });
			const occupant = await seed_file_with_markdown({
				ctx,
				path: "/qa-mv-dst2/qa-mv-saved2.md",
				name: "qa-mv-saved2.md",
				markdown: "# Existing",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			});
			await ctx.db.patch("files_nodes", occupant.nodeId, { parentId: destFolderId });
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "qa-mv-saved2.md",
			replace: true,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		// The occupant's fate is reviewable, so the move stays a proposal.
		expect(proposed._yay.appliedImmediately).toBe(false);
		expect(proposed._yay.replacesExistingOccupant).toBe(true);

		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.path).toBe("/qa-mv-src2/qa-mv-saved2.md");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("qa-mv-saved2.md");
	});

	test("mv -f onto a saved occupant stays reviewable when another member has a pending row on it", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-other-src.md",
				name: "saved-other-src.md",
				markdown: "# e1",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-other-dst.md",
				name: "saved-other-dst.md",
				markdown: "# e2",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const sourceUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nAgent content`,
		});
		if (sourceUpserted._nay) {
			throw new Error(sourceUpserted._nay.message);
		}
		// Another member's draft on the destination makes it real work — no hard delete.
		const otherRowId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_saved_move_guard" }),
				target: { kind: "saved", id: dest.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "saved-other-dst.md",
			replace: true,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		expect(moved._yay.appliedImmediately).toBe(false);
		expect(moved._yay.replacesExistingOccupant).toBe(true);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", dest.nodeId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_updates", otherRowId)).not.toBeNull();
		});
	});

	test("mv -f onto a saved occupant stays reviewable after committed content landed on it", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-edited-src.md",
				name: "saved-edited-src.md",
				markdown: "# e1",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-edited-dst.md",
				name: "saved-edited-dst.md",
				markdown: "# e2",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		for (const seeded of [source, dest]) {
			const upserted = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			});
			if (upserted._nay) {
				throw new Error(upserted._nay.message);
			}
		}

		// A saved edit on the destination keeps replacement subject to review.
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			if (!node?.yjsLastSequenceId) {
				throw new Error("Expected a yjs last sequence doc on the destination");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", node.yjsLastSequenceId, { lastSequence: 1 });
		});

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "saved-edited-dst.md",
			replace: true,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		expect(moved._yay.appliedImmediately).toBe(false);
		expect(moved._yay.replacesExistingOccupant).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", dest.nodeId))).not.toBeNull();
	});
});
