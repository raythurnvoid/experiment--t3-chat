// Fixtures shared by the files_pending_updates test files.
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { expect, vi, type MockInstance } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import {
	test_save_file_pending_update,
	test_finish_pending_update_run,
	test_convex,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_nodes_db_insert_file_content_docs } from "./files_nodes_create.ts";
import { files_pending_overlay_list } from "../server/files-pending-overlay.ts";
import { files_content_heads_db_wrap } from "../server/files-content-heads.ts";
import { files_saved_content_db_get_head } from "../server/files-saved-content-head.ts";
import { files_metadata_maps_db_write } from "../server/files-metadata-maps.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
import {
	files_db_load_pending_update_yjs_state_bytes,
	files_db_get_pending_update,
	files_default_text_shape_for_name,
	files_ROOT_ID,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_MAX_YJS_WIRE_BYTES, files_get_utf8_byte_size } from "../shared/files.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { files_sort_text_key } from "../shared/files-sort.ts";

export let enqueueActionSpy: MockInstance;
export const r2Objects = new Map<string, string | ArrayBuffer>();
// Keep the automatic presence timeout from firing during these tests; convex-test
// scheduled functions can otherwise race past the active transaction and leak an unhandled rejection.
export const presenceHeartbeatIntervalMs = 60 * 60 * 1000;

// Each test file calls this in `beforeEach`.
export function mock_pending_updates_storage() {
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
}

export async function seed_billing_snapshot_for_user(ctx: MutationCtx, userId: Id<"users">) {
	// The shared membership fixture puts every seeded user on a paying plan. Move this one to
	// `Free`, which is what every caller here is asking for.
	await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Free" });
}

export async function seed_file_with_markdown(args: {
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
	const { path, name, markdown } = args;
	// Saved fixtures need the same content owner as normal file writes.
	const ctx = { ...args.ctx, db: files_content_heads_db_wrap(args.ctx).db };
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
		pendingContentVersion: 1,
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
		extendedScopeNodeId: null,
		isRestrictedScopeRoot: false,
		readOnly: false,
		readOnlyDecisionId: null,
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

export async function seed_folder_node(args: {
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
		pendingContentVersion: 1,
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
		extendedScopeNodeId: null,
		isRestrictedScopeRoot: false,
		readOnly: false,

		archiveOperationId: null,
		readOnlyDecisionId: null,
	});
}

/**
 * Insert one committed Markdown + plain-text chunk pair covering the whole markdown, so
 * committed chunk reads and denormalized-path assertions have real docs to work with.
 */
export async function seed_committed_chunks_for_file(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
	path: string;
	markdown: string;
}) {
	const ctx = { ...args.ctx, db: files_content_heads_db_wrap(args.ctx).db };
	const textChunkId = await ctx.db.insert("files_text_chunks", {
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
	const plainTextChunkId = await ctx.db.insert("files_plain_text_chunks", {
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

export async function seed_signed_in_file_with_markdown(
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
 * in `files_nodes.content_yjs.test.ts`, on a mutation ctx instead of the test harness. The owner is a
 * Clerk-backed user so its saves bill through the workpool the tests spy on; an anonymous user's
 * events take another path.
 */
export async function seed_non_collaborative_file(args: { ctx: MutationCtx; path: string; text: string }) {
	const { path, text } = args;
	const ctx = { ...args.ctx, db: files_content_heads_db_wrap(args.ctx).db };

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
		pendingContentVersion: 1,
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
		extendedScopeNodeId: null,
		isRestrictedScopeRoot: false,
		readOnly: false,

		archiveOperationId: null,
		readOnlyDecisionId: null,
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

let saveRequestNumber = 0;

/**
 * Save `text` on a file with collaboration off through the member save door. Returns the node's
 * new content asset id.
 */
export async function save_as_member(args: {
	t: ReturnType<typeof test_convex>;
	seeded: Awaited<ReturnType<typeof seed_non_collaborative_file>>;
	text: string;
}) {
	const { t, seeded, text } = args;

	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});
	const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
		requestId: `fixture-save:${++saveRequestNumber}`,
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
export async function read_committed_text(args: {
	ctx: MutationCtx;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	nodeId: Id<"files_nodes">;
}) {
	const head = await files_saved_content_db_get_head(args.ctx.db, args.nodeId);
	if (!head) throw new Error("Expected a saved file content head");
	const chunks = await args.ctx.db
		.query("files_text_chunks")
		.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", head._id))
		.collect();
	return chunks.map((chunk) => chunk.textChunk).join("");
}

export async function read_file_yjs_snapshot_update(args: {
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

export async function read_file_markdown_from_yjs(args: {
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

export function normalize_pending_update_markdown(markdown: string) {
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

export async function read_file_yjs_state(args: {
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

export async function build_file_diff_update_from_snapshot(args: {
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

export async function read_pending_row_state_bytes(args: {
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

export async function expect_consumed_pending_content_cleanup_for_test(
	t: ReturnType<typeof test_convex>,
	content: NonNullable<Doc<"files_pending_updates">["content"]>,
	assertion: string,
) {
	const stateIds = [content.baseStateId, content.stagedStateId, content.unstagedStateId];
	const quotaIds = await t.run(async (ctx) => {
		const states = await Promise.all(stateIds.map((id) => ctx.db.get("files_pending_update_yjs_states", id)));
		expect(states.map((state) => state?.owner.kind), assertion).toEqual(["retired", "retired", "retired"]);
		const ids = new Set<Id<"quotas">>();
		for (const state of states) {
			if (!state) throw new Error("Expected a retired draft state");
			const receipt = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "state").eq("resource.id", state._id))
				.unique();
			expect(receipt, "Retired draft bytes stay held until their pages are deleted").toMatchObject({
				byteCount: state.totalBytes,
				settlement: { kind: "held" },
			});
			if (!receipt?.workspaceQuotaId) throw new Error("Expected both private byte quotas");
			expect(receipt.cohortContentId).toBeUndefined();
			ids.add(receipt.userQuotaId);
			ids.add(receipt.workspaceQuotaId);
		}
		return [...ids];
	});
	expect(quotaIds).toHaveLength(2);
	// Drive the real bounded cleanup. Do not run unrelated timers or change the clock.
	for (let pass = 0; pass < 100; pass++) {
		const result = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_disableReschedule: true,
		});
		if (result.done) break;
		if (pass === 99) throw new Error("Retired draft cleanup did not finish");
	}
	await t.run(async (ctx) => {
		for (const id of stateIds) {
			expect(await ctx.db.get("files_pending_update_yjs_states", id), "The consumed draft state is deleted").toBeNull();
			expect(
				await ctx.db
					.query("files_pending_update_yjs_state_pages")
					.withIndex("by_state_pageIndex", (q) => q.eq("stateId", id))
					.collect(),
				"The consumed draft pages are deleted",
			).toEqual([]);
			expect(
				await ctx.db
					.query("files_private_storage_reservations")
					.withIndex("by_resource", (q) => q.eq("resource.kind", "state").eq("resource.id", id))
					.unique(),
				"Deleting the draft pages releases their private bytes",
			).toMatchObject({ settlement: { kind: "deleted", proof: { kind: "database" } } });
		}
		for (const id of quotaIds) {
			const quota = await ctx.db.get("quotas", id);
			if (!quota) throw new Error("Expected a private byte quota");
			// These fixtures have only a few drafts and receipts.
			const held =
				quota.quotaName === "files_private_user_bytes"
					? await ctx.db
							.query("files_private_storage_reservations")
							.withIndex("by_userQuota_settlement", (q) => q.eq("userQuotaId", id).eq("settlement.kind", "held"))
							.collect()
						: await ctx.db
							.query("files_private_storage_reservations")
							.withIndex("by_workspaceQuota_settlement", (q) => q.eq("workspaceQuotaId", id).eq("settlement.kind", "held"))
							.collect();
			expect(held.every((receipt) => receipt.cohortContentId === undefined)).toBe(true);
			expect(quota.usedCount, "Private byte counters match the remaining held receipts").toBe(
				held.reduce((bytes, receipt) => bytes + receipt.byteCount, 0),
			);
		}
	});
}

export async function read_pending_row_markdown_state(args: {
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

export async function read_pending_update_expiry_check(args: {
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
 * Run expiry at the draft's deadline, including a finished job's review window.
 * The owner has no heartbeat here, so activity does not extend the deadline.
 */
export async function expire_pending_update_for_test(
	t: ReturnType<typeof test_convex>,
	pendingUpdateId: Id<"files_pending_updates">,
) {
	const draft = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
	if (!draft) throw new Error("Expected a draft");
	const expiresAt = await t.run(async (ctx) => {
		const holds = await ctx.db.query("files_pending_holds")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", pendingUpdateId)).collect();
		let deadline = draft.expiresAt;
		for (const hold of holds) {
			if (hold.role === "source" || hold.role === "preparing_output") continue;
			const run = hold.producer.kind === "files_transfer_run"
				? await ctx.db.get("files_transfer_runs", hold.producer.id)
				: await ctx.db.get("files_pending_update_runs", hold.producer.id);
			deadline = Math.max(deadline, run?.outputReviewUntil ?? 0);
		}
		return deadline;
	});
	vi.setSystemTime(expiresAt);
	await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
		organizationId: draft.organizationId,
		workspaceId: draft.workspaceId,
		userId: draft.userId,
	});
}

export async function list_pending_update_text_chunks(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
}) {
	return await args.ctx.db
		.query("files_text_chunks")
		.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
}

export async function list_pending_update_plain_text_chunks(args: {
	ctx: MutationCtx;
	pendingUpdateId: Id<"files_pending_updates">;
}) {
	return await args.ctx.db
		.query("files_plain_text_chunks")
		.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
		.collect();
}

export async function read_pending_update_row(args: {
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

export async function read_pending_update_last_sequence_saved_doc(args: {
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

export async function seed_chat_thread(args: {
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
		newestNodeId: null,
		starred: false,
	});
}

export async function upsert_file_pending_update_internal_for_test(args: {
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
			expectedPendingContentVersion: (await args.t.run((ctx) => ctx.db.get("files_nodes", args.nodeId)))!.pendingContentVersion,
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

export type TestConvexIdentity = ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;

export async function set_pending_test_read_only(args: {
	asUser: TestConvexIdentity;
	membershipId: Id<"organizations_workspaces_users">;
	nodeId: Id<"files_nodes">;
}) {
	const { asUser, membershipId, nodeId } = args;

	const result = await asUser.mutation(api.files_nodes.read_only_set, {
		readOnly: true,
		membershipId,
		nodeId,
	});
	if (result._nay) {
		throw new Error(result._nay.message);
	}
}

export async function set_pending_test_writable(args: {
	asUser: TestConvexIdentity;
	membershipId: Id<"organizations_workspaces_users">;
	nodeId: Id<"files_nodes">;
}) {
	const { asUser, membershipId, nodeId } = args;

	const result = await asUser.mutation(api.files_nodes.read_only_set, {
		readOnly: false,
		membershipId,
		nodeId,
	});
	if (result._nay) {
		throw new Error(result._nay.message);
	}
}

export async function upsert_file_pending_update_public_for_test(
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
		expectedPendingContentVersion: (await asIdentity.run((ctx) => ctx.db.get("files_nodes", args.nodeId)))!.pendingContentVersion,
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

export async function persist_file_pending_update_rebased_state_for_test(
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
		expectedPendingContentVersion: (await asIdentity.run((ctx) => ctx.db.get("files_nodes", args.nodeId)))!.pendingContentVersion,
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
export async function stage_and_seal_input_family_for_test(args: {
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
			expectedPendingContentVersion: (await args.t.run((ctx) => ctx.db.get("files_nodes", args.nodeId)))!.pendingContentVersion,
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

export async function upsert_file_pending_move_for_test(args: {
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

export async function upsert_file_pending_archive_for_test(args: {
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
export async function seal_output_family_for_test(
	t: ReturnType<typeof test_convex>,
	seeded: Awaited<ReturnType<typeof seed_non_collaborative_file>>,
) {
	const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		expectedPendingContentVersion: (await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.pendingContentVersion,
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

export async function reviewed_pending_for_test(
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

/**
 * The first 10 root children that the member's agent sees, with the member's drafts.
 */
export async function list_root_for_test(
	t: ReturnType<typeof test_convex>,
	args: { membershipId: Id<"organizations_workspaces_users"> },
) {
	const membership = await t.run((ctx) => ctx.db.get("organizations_workspaces_users", args.membershipId));
	if (!membership) throw new Error("Expected a test membership");
	return await files_pending_overlay_list({ runQuery: t.query } as unknown as Pick<ActionCtx, "runQuery">, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		visibilityUserId: membership.userId,
		subject: { kind: "user", userId: membership.userId, plugin: null },
		overlayUserId: membership.userId,
		folderPath: "/",
		mode: "children",
		order: "asc",
		numItems: 10,
		cursor: null,
	});
}

export async function read_pending_review_state_for_test(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => ({
		nodes: await ctx.db.query("files_nodes").collect(),
		proposals: await ctx.db.query("files_pending_updates").collect(),
		states: await ctx.db.query("files_pending_update_yjs_states").collect(),
		chunks: await ctx.db.query("files_text_chunks").collect(),
	}));
}

export async function finish_pending_job_review_holds_for_test(
	t: ReturnType<typeof test_convex>,
	producer: Doc<"files_pending_holds">["producer"],
) {
	const finished = await t.run(async (ctx) => {
		const run =
			producer.kind === "files_transfer_run"
				? await ctx.db.get("files_transfer_runs", producer.id)
				: await ctx.db.get("files_pending_update_runs", producer.id);
		const activity = await ctx.db
			.query("activities")
			.withIndex("by_source_id", (q) => q.eq("source.id", producer.id))
			.unique();
		if (run?.outputReviewUntil === undefined || activity?.finishedAt === undefined)
			throw new Error("Expected a finished proposal job with a review deadline");
		return { expiresAt: run.outputReviewUntil, finishedAt: activity.finishedAt };
	});
	expect(finished.expiresAt).toBe(finished.finishedAt + 4 * 60 * 60 * 1000);
	// These fixtures hold at most two proposals, so one release page finishes them.
	await t.mutation(internal.files_pending_holds.release_producer, { producer });
	expect(
		await t.run((ctx) =>
			ctx.db
				.query("files_pending_holds")
				.withIndex("by_producer_pendingUpdate_role", (q) =>
					q.eq("producer.kind", producer.kind).eq("producer.id", producer.id),
				)
				.first(),
		),
		"The finished job releases its proposal holds",
	).toBeNull();
	return finished.expiresAt;
}

export async function finish_single_save_review_holds_for_test(
	draft: Pick<Awaited<ReturnType<typeof create_private_text_for_test>>, "t" | "userId" | "membershipId">,
	proposal: Doc<"files_pending_updates">,
) {
	const requestId = `single-save:${draft.membershipId}:${proposal.target.id}:${proposal._id}:${proposal.revision}`;
	const runId = await draft.t.run(
		async (ctx) =>
			(
				await ctx.db
					.query("files_pending_update_runs")
					.withIndex("by_user_requestId", (q) => q.eq("userId", draft.userId).eq("requestId", requestId))
					.unique()
			)?._id ?? null,
	);
	// Some permission refusals return before they create a Save job.
	return runId
		? await finish_pending_job_review_holds_for_test(draft.t, { kind: "files_pending_update_run", id: runId })
		: 0;
}

export async function create_private_text_for_test(
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
	if (args.collaborative === false) {
		await t.run(async (ctx) => {
			const proposal = await ctx.db.get("files_pending_updates", pendingUpdateId);
			if (proposal?.createIntent?.kind !== "text") throw new Error("Expected a text create intent");
			await ctx.db.patch("files_pending_updates", pendingUpdateId, {
				createIntent: {
					...proposal.createIntent,
					collaborationEnabled: false,
				},
			});
		});
	}
	if (args.metadata) {
		// Copy clones captured metadata before text preparation.
		const metadata = args.metadata;
		await t.run((ctx) =>
			files_metadata_maps_db_write(ctx.db, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				owner: { kind: "pending", id: pendingUpdateId },
				entries: metadata,
			}),
		);
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

export async function run_agent_move_for_test(
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
	expect(
		await draft.t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: draft.membershipId,
			threadId: args.threadId,
			runId,
		}),
	).toEqual({ _yay: null });
	await test_finish_transfer_run(draft.asUser, runId);
	const view = await draft.asUser.query(api.files_transfer_status.get, { membershipId: draft.membershipId, runId });
	if (!view) throw new Error("Expected the transfer");
	return view;
}

export async function save_pending_review_for_test(
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
	await test_finish_pending_update_run(draft.asUser, runId);
	return await draft.asUser.query(api.files_pending_update_runs.get, { membershipId: draft.membershipId, runId });
}

export async function accept_as_member(args: {
	t: ReturnType<typeof test_convex>;
	seeded: Awaited<ReturnType<typeof seed_non_collaborative_file>>;
	pendingUpdateId: Id<"files_pending_updates">;
}) {
	const { t, seeded, pendingUpdateId } = args;

	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});
	return await test_save_file_pending_update(asUser, {
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

export async function read_seeded_pending_row(
	t: ReturnType<typeof test_convex>,
	seeded: Pick<Awaited<ReturnType<typeof seed_non_collaborative_file>>, "organizationId" | "workspaceId" | "userId" | "nodeId">,
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

export function file_save_events() {
	// Function references are fresh proxy objects on every access, so compare names.
	return enqueueActionSpy.mock.calls.filter((call) => getFunctionName(call[1]) === "billing:ingest_events");
}
