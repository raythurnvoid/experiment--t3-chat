import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import {
	applyUpdate,
	Doc as YjsDoc,
	XmlElement as YXmlElement,
	encodeStateAsUpdate,
	encodeStateAsUpdateV2,
	encodeStateVector,
	mergeUpdates,
} from "yjs";
import { Result } from "common/errors-as-values-utils.ts";
import { api, components, internal } from "./_generated/api.js";
import {
	files_db_yjs_push_update,
	files_line_range_from_text,
	files_tail_lines_from_text,
	yjs_reserve_and_increment_last_sequence,
} from "./files_nodes.ts";
import {
	files_nodes_create_yjs_snapshot_update_from_text,
	files_nodes_db_fill_text_node_content,
	files_nodes_db_insert_file_content_docs,
} from "./files_nodes_content.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	test_apply_file_pending_move,
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_rename_node,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_node_has_editable_text_content,
	files_node_has_editable_yjs_state,
	files_ROOT_ID,
	files_YJS_DOC_KEYS,
	files_default_text_shape_for_name,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_doc_create_from_text,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "../shared/files-tiptap.ts";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../shared/files-yjs.ts";
import { delay } from "../shared/async-utils.ts";
import { r2_confirmed_object_delete, r2_create_asset_key, r2_server_side_copy } from "./r2_client.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import type { Id } from "./_generated/dataModel.js";
import { files_metadata_MAX_FRONTMATTER_FIELDS } from "../shared/files-metadata.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_updated_by_db_delete_for_node } from "./files_updated_by.ts";
import {
	seed_billing_snapshot_for_user,
	upsert_pending_update_internal_for_test,
	propose_move_for_test,
	test_setup_r2_capture,
	test_materialize_markdown_file,
	text_search_files_all_pages,
	seed_unpublished_asset_pair,
	read_deletion_jobs,
	expected_ledger_keys,
} from "./files_nodes.setup.test.ts";

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return {
		...actual,
		generateText: generateTextMock,
		streamText: streamTextMock,
	};
});

// Tests that run the real SDK set this fake provider model. The receipt middleware stays real.
const inlineAiProvider = vi.hoisted(() => ({ model: null as MockLanguageModelV3 | null }));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
	return {
		...actual,
		openai: Object.assign(() => inlineAiProvider.model, actual.openai),
	};
});

let enqueueActionSpy: MockInstance;
let generateUploadUrlSpy: ReturnType<typeof vi.fn<(customKey?: string) => Promise<{ key: string; url: string }>>>;
const test = baseTest;

beforeEach(() => {
	generateTextMock.mockReset();
	streamTextMock.mockReset();
	inlineAiProvider.model = null;
	// Keep file tests focused on file behavior; billing event enqueue behavior is
	// covered in billing tests.
	enqueueActionSpy = vi
		.spyOn(Workpool.prototype, "enqueueAction")
		.mockResolvedValue("work_file_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	generateUploadUrlSpy = vi.fn(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(generateUploadUrlSpy);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("materialize_file_content writes empty version and Yjs snapshots to R2 and no current-content object", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const r2Writes = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return {
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		};
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Writes.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Writes.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}

			return new Response(null, { status: 404 });
		}),
	);

	const createdFileId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/empty-materialized.md",
	});

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFileId,
		userId: db.userId,
		targetSequence: 0,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFileId);
		if (!fileNode?.assetId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected materialized empty file docs");
		}
		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", createdFileId),
			)
			.collect();
		const versionSnapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFileId)
					.eq("archivedAt", -1),
			)
			.collect();
		const versionSnapshotAssets = await Promise.all(
			versionSnapshots.map((snapshot) => ctx.db.get("files_r2_assets", snapshot.assetId)),
		);

		return {
			asset,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			versionSnapshots,
			versionSnapshotAssets,
		};
	});

	const versionSnapshotAsset = saved.versionSnapshotAssets.find((asset) => asset?.size === 0);
	// Editable files do not store their current content in R2: materialization uploads the Yjs
	// and version snapshots and points the node at the fresh version snapshot.
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: 0,
	});
	expect(saved.asset?.r2Key).toBe(
		`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.asset?._id}`,
	);
	expect(saved.versionSnapshots.some((snapshot) => snapshot.assetId === saved.asset?._id)).toBe(true);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshots.length).toBeGreaterThan(0);
	expect(versionSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${versionSnapshotAsset?._id}`,
		size: 0,
	});
	const versionSnapshotR2Key = versionSnapshotAsset?.r2Key;
	const yjsSnapshotR2Key = saved.yjsSnapshotAsset?.r2Key;
	if (!versionSnapshotR2Key || !yjsSnapshotR2Key) {
		throw new Error("Expected version and Yjs snapshot R2 keys");
	}
	expect(r2Writes.get(saved.asset?.r2Key ?? "")).toBe("");
	expect(r2Writes.get(versionSnapshotR2Key)).toBe("");
	expect(r2Writes.has(yjsSnapshotR2Key)).toBe(true);
});

test("materialize_file_content writes nonempty version and Yjs snapshots to R2 and no current-content object", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Materialize User",
		email: "materialize-user@example.com",
	});
	const r2Writes = new Map<string, BodyInit>();
	generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return {
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		};
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Writes.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			if (urlString.startsWith("https://r2.test/object?key=")) {
				const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
				const body = r2Writes.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
			}

			return new Response(null, { status: 404 });
		}),
	);

	const createdFileId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/materialized.md",
	});

	const markdown = "# Café\n\nEmoji 🙂\n";
	const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: markdown });
	if ("_nay" in yjsDoc) {
		throw new Error(yjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId: createdFileId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFileId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		sessionId: "materialize-session",
	});
	yjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFileId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	// Finalization schedules the covered-doc cleanup instead of deleting in-transaction;
	// convex-test never runs scheduled functions, so drain it directly before the readback.
	await t.mutation(internal.files_nodes_content.cleanup_file_materialization_covered_rows, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFileId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFileId)).yjsLastSequenceId,
		throughSequence: 1,
	});

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFileId);
		if (!fileNode?.assetId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected materialized file docs");
		}
		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", createdFileId),
			)
			.collect();
		const versionSnapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFileId)
					.eq("archivedAt", -1),
			)
			.collect();
		const versionSnapshotAssets = await Promise.all(
			versionSnapshots.map((snapshot) => ctx.db.get("files_r2_assets", snapshot.assetId)),
		);

		return {
			asset,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			versionSnapshots,
			versionSnapshotAssets,
		};
	});

	const versionSnapshotAsset = saved.versionSnapshotAssets.find(
		(asset) => asset?.size === files_get_utf8_byte_size(markdown),
	);
	// Editable files do not store their current content in R2: materialization uploads the Yjs
	// and version snapshots and points the node at the fresh version snapshot.
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(markdown),
	});
	expect(saved.asset?._id).toBe(versionSnapshotAsset?._id);
	expect(saved.yjsSnapshot?.sequence).toBe(1);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshots.length).toBeGreaterThan(0);
	expect(versionSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${versionSnapshotAsset?._id}`,
		size: files_get_utf8_byte_size(markdown),
	});
	const versionSnapshotR2Key = versionSnapshotAsset?.r2Key;
	const yjsSnapshotR2Key = saved.yjsSnapshotAsset?.r2Key;
	if (!versionSnapshotR2Key || !yjsSnapshotR2Key) {
		throw new Error("Expected version and Yjs snapshot R2 keys");
	}
	expect(r2Writes.get(versionSnapshotR2Key)).toBe(markdown);
	expect(r2Writes.has(yjsSnapshotR2Key)).toBe(true);
});

test("materialize_file_content rolls back Convex writes when committed chunking fails", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Chunk Failure User",
		email: "chunk-failure-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/chunk-failure.md",
		markdown: "# Last good\n",
	});
	const nextYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# Next version\n" });
	if ("_nay" in nextYjsDoc) {
		throw new Error(nextYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(nextYjsDoc)),
		sessionId: "chunk-failure-session",
	});
	nextYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const before = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const yjsSnapshot = fileNode?.yjsSnapshotId
			? await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId)
			: null;
		const textChunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		const yjsAsset = yjsSnapshot ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		return { fileNode, yjsSnapshot, textChunks, yjsKey: yjsAsset?.r2Key };
	});
	const savedYjsBytes = r2Writes.get(before.yjsKey!);

	const chunkMarkdownSpy = vi
		.spyOn(await import("../server/files-markdown-chunking-mastra.ts"), "files_chunk_markdown")
		.mockResolvedValueOnce(
			Result({
				_nay: {
					name: "nay",
					message: "Error while chunking markdown",
					cause: new Error("Test chunking failure"),
				},
			}),
		);

	await expect(
		t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: pushResult._yay.newSequence,
		}),
	).rejects.toThrow("Failed to materialize file content");
	expect(chunkMarkdownSpy).toHaveBeenCalled();

	const after = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const yjsSnapshot = fileNode?.yjsSnapshotId
			? await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId)
			: null;
		const textChunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.collect();
		return { fileNode, yjsSnapshot, textChunks, yjsUpdates, jobs };
	});

	expect(after.fileNode?.assetId).toBe(before.fileNode?.assetId);
	expect(after.yjsSnapshot?.assetId).toBe(before.yjsSnapshot?.assetId);
	expect(r2Writes.get(before.yjsKey!)).toEqual(savedYjsBytes);
	expect(after.yjsSnapshot?.sequence).toBe(before.yjsSnapshot?.sequence);
	expect(after.textChunks).toEqual(before.textChunks);
	expect(after.yjsUpdates).not.toHaveLength(0);
	expect(after.jobs).not.toHaveLength(0);
});

test("materialize_file_content marks over-cap content too large and leaves the node on its last good content", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Too Large User",
		email: "too-large-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	const smallMarkdown = "# Small\n";
	const nodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/too-large.md",
		markdown: smallMarkdown,
	});
	const beforePush = await t.run(async (ctx) => ({
		assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
		assetId: (await ctx.db.get("files_nodes", nodeId))?.assetId,
	}));
	const r2WriteCountBeforePush = r2Writes.size;

	// Two very long paragraphs rather than many short ones: the byte size is what matters, and
	// Yjs stores each paragraph as one item. The document must cross the 900000-byte text cap
	// while its one encoded update stays under door 1's 930000-byte wire cap, so target just
	// past the text cap. Plain `x` runs also round-trip through Markdown unchanged.
	const overCapParagraph = `${"x".repeat(files_MAX_TEXT_CONTENT_BYTES / 2 + 2)}\n\n`;
	const overCapMarkdown = overCapParagraph.repeat(2);
	const overCapYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: overCapMarkdown });
	if ("_nay" in overCapYjsDoc) {
		throw new Error(overCapYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(overCapYjsDoc)),
		sessionId: "too-large-session",
	});
	overCapYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: pushResult._yay.newSequence,
	});

	expect(materialized._nay).toMatchObject({
		message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`,
	});

	const afterReject = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.collect();
		const assetCount = (await ctx.db.query("files_r2_assets").collect()).length;
		return { fileNode, jobs, assetCount };
	});

	expect(afterReject.fileNode?.contentTooLargeByteSize).toBeGreaterThan(files_MAX_TEXT_CONTENT_BYTES);
	// The node keeps pointing at the last content that fit, so every committed reader stays readable.
	expect(afterReject.fileNode?.assetId).toBe(beforePush.assetId);
	// Retrying cannot make the content smaller, so the job settles instead of lingering.
	expect(afterReject.jobs).toHaveLength(0);
	// The guard runs before `insert_asset` and the R2 writes, so an over-cap run leaves no orphan
	// asset doc and no new object in the bucket.
	expect(afterReject.assetCount).toBe(beforePush.assetCount);
	expect(r2Writes.size).toBe(r2WriteCountBeforePush);
});

test("materialize_file_content settles over-cap frontmatter with the marker pair before any asset write", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Frontmatter Cap User",
	});
	const r2Writes = test_setup_r2_capture();

	// Seed without a push (the rate limiter allows two pushes per test window and this test
	// needs both for the over-cap and the fitting content).
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/frontmatter-cap.md",
	});
	const seededMaterialize = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 0,
	});
	if (seededMaterialize._nay) {
		throw new Error(seededMaterialize._nay.message);
	}
	const beforePush = await t.run(async (ctx) => ({
		assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
		assetId: (await ctx.db.get("files_nodes", nodeId))?.assetId,
	}));
	const r2WriteCountBeforePush = r2Writes.size;

	// 129 frontmatter fields: over the field cap, far under the byte cap. The editor path goes
	// through yjs_push_update, so the pending-path preflight never runs for it.
	const overCapMarkdown = `---\n${Array.from({ length: files_metadata_MAX_FRONTMATTER_FIELDS + 1 }, (_, index) => `field_${index}: ${index}`).join("\n")}\n---\n\n# Body\n`;
	const overCapYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: overCapMarkdown });
	if ("_nay" in overCapYjsDoc) {
		throw new Error(overCapYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(overCapYjsDoc)),
		sessionId: "frontmatter-cap-session",
	});
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: pushResult._yay.newSequence,
	});
	expect(materialized._nay).toMatchObject({ message: "Frontmatter exceeds the index caps" });

	const afterReject = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const jobs = await ctx.db
			.query("files_content_materialization_jobs")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.collect();
		const assetCount = (await ctx.db.query("files_r2_assets").collect()).length;
		return { fileNode, jobs, assetCount };
	});

	// Both marker halves are written and the job settles: retrying cannot shrink the frontmatter.
	expect(afterReject.fileNode?.contentFrontmatterTooLargeFieldCount).toBe(files_metadata_MAX_FRONTMATTER_FIELDS + 1);
	expect(afterReject.fileNode?.contentFrontmatterTooLargeIndexDocumentCount).toBeGreaterThan(
		files_metadata_MAX_FRONTMATTER_FIELDS + 1,
	);
	expect(afterReject.jobs).toHaveLength(0);
	// The preflight runs before `insert_asset` and the R2 uploads, so the refusal leaves no
	// orphan asset doc and no new object, and the node keeps its last good content.
	expect(afterReject.fileNode?.assetId).toBe(beforePush.assetId);
	expect(afterReject.assetCount).toBe(beforePush.assetCount);
	expect(r2Writes.size).toBe(r2WriteCountBeforePush);

	// The next fitting content clears both marker halves at finalization. Build it as a diff on
	// the live document's own lineage: pushing a fresh doc's whole state would MERGE with the
	// over-cap frontmatter instead of replacing it.
	const fittingDoc = files_yjs_doc_clone({ yjsDoc: overCapYjsDoc });
	const fitted = files_yjs_doc_update_from_text({
		mut_yjsDoc: fittingDoc,
		text: "# Small again\n",
		rootKind: "rich_text",
	});
	if (fitted._nay) {
		throw new Error(fitted._nay.message);
	}
	const fittingDiff = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: fittingDoc, yjsBeforeDoc: overCapYjsDoc });
	if (!fittingDiff) {
		throw new Error("Expected the fitting content to produce a diff update");
	}
	const fittingPush = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(fittingDiff),
		sessionId: "frontmatter-cap-session",
	});
	overCapYjsDoc.destroy();
	fittingDoc.destroy();
	if (fittingPush._nay) {
		throw new Error(fittingPush._nay.message);
	}
	const rematerialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: fittingPush._yay.newSequence,
	});
	expect(rematerialized._nay).toBeUndefined();
	const cleared = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
	expect(cleared?.contentFrontmatterTooLargeFieldCount).toBeNull();
	expect(cleared?.contentFrontmatterTooLargeIndexDocumentCount).toBeNull();
});

test("materialize_file_content clears the too-large mark once the content fits again", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Trimmed User",
		email: "trimmed-user@example.com",
	});
	test_setup_r2_capture();

	const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/trimmed.md", markdown: "# Trimmed\n" });
	await t.run(async (ctx) => {
		return await ctx.db.patch("files_nodes", nodeId, {
			contentTooLargeByteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
		});
	});

	const trimmedYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# Trimmed again\n" });
	if ("_nay" in trimmedYjsDoc) {
		throw new Error(trimmedYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(trimmedYjsDoc)),
		sessionId: "trimmed-session",
	});
	trimmedYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: pushResult._yay.newSequence,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const fileNode = await t.run(async (ctx) => await ctx.db.get("files_nodes", nodeId));
	expect(fileNode?.contentTooLargeByteSize).toBeNull();
});

// Get the exact committed markdown for a file, to compare chunk reads against. Editable files
// do not store their current content in R2, so read the newest version snapshot instead:
// materialization writes the exact committed markdown there.
async function test_read_committed_markdown(args: {
	t: ReturnType<typeof test_convex>;
	nodeId: Id<"files_nodes">;
	r2Writes: Map<string, BodyInit>;
}) {
	const { t, nodeId, r2Writes } = args;

	return t.run(async (ctx) => {
		const snapshots = (await ctx.db.query("files_snapshots").collect()).filter(
			(snapshot) => snapshot.fileNodeId === nodeId && snapshot.archivedAt <= 0,
		);
		const newest = snapshots.sort((a, b) => b._creationTime - a._creationTime)[0];
		const asset = newest ? await ctx.db.get("files_r2_assets", newest.assetId) : null;
		return asset?.r2Key ? (r2Writes.get(asset.r2Key) as string | undefined) : undefined;
	});
}

test("read_committed_file_chunks_line_range/stats match full-text slicing across chunks", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Chunk Read User",
		email: "chunk-read-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	// Long enough to materialize into several chunks (default maxChunkSize 1200), so reads exercise
	// the cross-chunk seek + merge, not a single chunk.
	const paragraphs = Array.from(
		{ length: 40 },
		(_, i) =>
			`Paragraph ${i + 1} carries searchable words alpha-${i} beta gamma delta epsilon zeta eta theta${i === 0 ? " 🙂" : ""}.`,
	);
	const markdown = `# Chunked Document\n\n${paragraphs.join("\n\n")}`;

	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/chunked.md",
	});

	const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: markdown });
	if ("_nay" in yjsDoc) {
		throw new Error(yjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		sessionId: "chunk-read-session",
	});
	yjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}

	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	// Compare against the exact committed markdown the chunker saw: materialization writes it to
	// the version snapshot. The chunk reader must return the same line ranges as slicing that text.
	const committed = await test_read_committed_markdown({ t, nodeId, r2Writes });
	const chunkCount = await t.run(async (ctx) => {
		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect();
		return chunks.length;
	});
	if (committed === undefined) {
		throw new Error("Expected committed markdown to be stored in R2");
	}
	// Guard the test is meaningful: the document really spans multiple chunks.
	expect(chunkCount).toBeGreaterThan(1);

	const totalLines = committed.split("\n").length;
	const readRange = (args: { startLine: number; maxLines: number; fromEnd?: boolean }) => {
		const { fromEnd = false, maxLines, startLine } = args;

		return asUser.query(internal.files_nodes.read_committed_file_chunks_line_range, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/chunked.md",
			startLine,
			maxLines,
			fromEnd,
		});
	};

	// Head, a deep mid-document range (the case the leading byte window could not reach), and the
	// final lines — each must equal slicing the full committed text.
	for (const [startLine, maxLines] of [
		[1, 5],
		[41, 6],
		[Math.max(1, totalLines - 3), 10],
	] as const) {
		const result = await readRange({ startLine, maxLines });
		expect(result.usable).toBe(true);
		if (!result.usable) throw new Error("expected usable");
		expect(result.content).toBe(files_line_range_from_text({ content: committed, startLine, maxLines }).content);
	}

	// moreLines after the bounded-streaming refactor: a shallow read reports content follows; a range
	// entirely past EOF does not (and is a valid empty page, not a fallback).
	const shallow = await readRange({ startLine: 1, maxLines: 5 });
	expect(shallow.usable && shallow.moreLines).toBe(true);
	const pastEof = await readRange({ startLine: totalLines + 50, maxLines: 5 });
	expect(pastEof.usable).toBe(true);
	if (!pastEof.usable) throw new Error("expected usable");
	expect(pastEof.content).toBe("");
	expect(pastEof.moreLines).toBe(false);

	// tail.
	const tail = await readRange({ startLine: 1, maxLines: 5, fromEnd: true });
	expect(tail.usable).toBe(true);
	if (!tail.usable) throw new Error("expected usable");
	expect(tail.content).toBe(files_tail_lines_from_text(committed, 5).content);

	// Exact counts from chunks match counting the full committed text.
	const stats = await asUser.query(internal.files_nodes.read_committed_file_chunk_stats, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/chunked.md",
	});
	expect(stats.usable).toBe(true);
	if (!stats.usable) throw new Error("expected usable");
	expect(stats.lineCount).toBe((committed.match(/\n/gu) ?? []).length);
	// charCount is Unicode code points (wc -m), not UTF-16 units: the 🙂 makes these differ.
	expect(Array.from(committed).length).toBeLessThan(committed.length);
	expect(stats.charCount).toBe(Array.from(committed).length);
	expect(stats.byteCount).toBe(files_get_utf8_byte_size(committed));
	expect(stats.wordCount).toBe(committed.trim().length === 0 ? 0 : committed.trim().split(/\s+/u).length);

	// Currency gate: a stale snapshot (latest sequence ahead of the materialized snapshot) must not
	// use chunks — the action falls back so output can never disagree with `cat`.
	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nodeId);
		const snapshot = fileNode?.yjsSnapshotId ? await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId) : null;
		if (!fileNode?.yjsLastSequenceId || !snapshot) {
			throw new Error("Expected materialized yjs docs");
		}
		await ctx.db.patch("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId, {
			lastSequence: snapshot.sequence + 1,
		});
	});
	const staleResult = await readRange({ startLine: 1, maxLines: 5 });
	expect(staleResult.usable).toBe(false);
});

test("match_text_file_lines and match_plain_text_file_lines query committed and pending chunks", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Query Grep User",
		email: "query-grep-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	const path = "/grep-query.md";
	const committedMarkdown = "intro context\n**critical** alert\ncommittedneedle one\nmiddle\ncommittedneedle two\n";
	const nodeId = await test_materialize_markdown_file({ t, asUser, db, path, markdown: committedMarkdown });
	const committed = await test_read_committed_markdown({ t, nodeId, r2Writes });
	if (committed === undefined) throw new Error("Expected committed markdown");

	const grepArgs = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		target: { kind: "saved" as const, id: nodeId },
	};

	const committedGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(committedGrep).not.toBeNull();
	if (!committedGrep) throw new Error("expected committed grep");
	expect(committedGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "committedneedle one" },
		{ lineNumber: 5, line: "committedneedle two" },
	]);
	expect(committedGrep.scanTruncated).toBe(false);

	const committedRegexGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: String.raw`committedneedle\s+(one|two)`,
		ignoreCase: false,
		fixedStrings: false,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(committedRegexGrep).not.toBeNull();
	if (!committedRegexGrep) throw new Error("expected committed regex grep");
	expect(committedRegexGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "committedneedle one" },
		{ lineNumber: 5, line: "committedneedle two" },
	]);
	expect(committedRegexGrep.scanTruncated).toBe(false);

	const committedPlainRegex = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: String.raw`critical\s+alert`,
		ignoreCase: false,
		fixedStrings: false,
		invert: false,
	});
	expect(committedPlainRegex).not.toBeNull();
	if (!committedPlainRegex) throw new Error("expected committed plain-text regex grep");
	expect(committedPlainRegex.lines).toEqual([{ lineNumber: 2, line: "critical alert", matched: true }]);
	expect(committedPlainRegex.scanTruncated).toBe(false);

	const committedPlainLiteral = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: "critical alert",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	});
	expect(committedPlainLiteral).not.toBeNull();
	if (!committedPlainLiteral) throw new Error("expected committed plain-text literal grep");
	expect(committedPlainLiteral.lines).toEqual([{ lineNumber: 2, line: "critical alert", matched: true }]);
	expect(committedPlainLiteral.selectedCount).toBe(1);

	const committedPlainLiteralMeta = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: "critical.alert",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	});
	expect(committedPlainLiteralMeta).not.toBeNull();
	if (!committedPlainLiteralMeta) throw new Error("expected committed plain-text literal-meta grep");
	// `-F` treats `.` literally, so "critical.alert" does not match "critical alert".
	expect(committedPlainLiteralMeta.lines).toEqual([]);
	expect(committedPlainLiteralMeta.selectedCount).toBe(0);

	const committedPlainInvert = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: String.raw`critical\s+alert`,
		ignoreCase: false,
		fixedStrings: false,
		invert: true,
	});
	expect(committedPlainInvert).not.toBeNull();
	if (!committedPlainInvert) throw new Error("expected committed plain-text inverted grep");
	// `-v` keeps every non-matching line, so the one matching line is excluded.
	expect(committedPlainInvert.lines.some((line) => line.line === "critical alert")).toBe(false);
	expect(committedPlainInvert.lines.length).toBeGreaterThan(0);
	expect(committedPlainInvert.selectedCount).toBe(committedPlainInvert.lines.length);

	const committedScan = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 1,
		after: 1,
	});
	expect(committedScan).not.toBeNull();
	if (!committedScan) throw new Error("expected committed grep scan");
	expect(committedScan.lines).toEqual([
		{ lineNumber: 2, line: "**critical** alert", matched: false },
		{ lineNumber: 3, line: "committedneedle one", matched: true },
		{ lineNumber: 4, line: "middle", matched: false },
		{ lineNumber: 5, line: "committedneedle two", matched: true },
	]);
	expect(committedScan.selectedCount).toBe(2);
	expect(committedScan.scanTruncated).toBe(false);

	const committedWindow = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
		window: { kind: "lines", startLine: 5, maxLines: 2 },
	});
	expect(committedWindow).not.toBeNull();
	if (!committedWindow) throw new Error("expected committed window grep");
	expect(committedWindow.lines).toEqual([{ lineNumber: 5, line: "committedneedle two", matched: true }]);
	expect(committedWindow.scanTruncated).toBe(false);

	const cappedOutputMarkdown = [
		"outputneedle-primer",
		...Array.from({ length: 24 }, (_, lineIndex) => `group-1-before-${lineIndex + 1}`),
		"outputneedle-01",
		...Array.from({ length: 25 }, (_, lineIndex) => `group-1-after-${lineIndex + 1}`),
		...Array.from({ length: 154 }, (_, index) =>
			index % 2 === 0 ? `outputneedle-dense-${index + 1}` : `dense-filler-${index + 1}`,
		),
	].join("\n");
	const cappedOutputNodeId = await test_materialize_markdown_file({
		t,
		asUser,
		db,
		path: "/grep-capped-output.md",
		markdown: cappedOutputMarkdown,
	});
	const cappedContextScan = await asUser.query(internal.files_nodes.match_text_file_lines, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		target: { kind: "saved", id: cappedOutputNodeId },
		pattern: "outputneedle-01",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 100,
		after: 100,
	});
	expect(cappedContextScan).not.toBeNull();
	if (!cappedContextScan) throw new Error("expected capped context scan");
	expect(cappedContextScan.lines.map((line) => line.lineNumber)).toEqual(
		Array.from({ length: 41 }, (_, index) => index + 6),
	);
	expect(cappedContextScan.scanTruncated).toBe(true);

	const cappedOutputScan = await asUser.query(internal.files_nodes.match_text_file_lines, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		target: { kind: "saved", id: cappedOutputNodeId },
		pattern: "outputneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 20,
		after: 20,
	});
	expect(cappedOutputScan).not.toBeNull();
	if (!cappedOutputScan) throw new Error("expected capped output scan");
	expect(cappedOutputScan.lines.length).toBe(200);
	expect(cappedOutputScan.scanTruncated).toBe(true);

	const pendingMarkdown = "pending context\n**pending** alert\npendingneedle only in the pending version\n";
	const pending = await upsert_pending_update_internal_for_test(t, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId,
		unstagedMarkdown: pendingMarkdown,
	});
	if (pending._nay) throw new Error(pending._nay.message);

	const pendingGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "pendingneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(pendingGrep).not.toBeNull();
	if (!pendingGrep) throw new Error("expected pending grep");
	expect(pendingGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "pendingneedle only in the pending version" },
	]);

	const pendingWindow = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "pendingneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
		window: { kind: "lines", startLine: 3, maxLines: 2 },
	});
	expect(pendingWindow).not.toBeNull();
	if (!pendingWindow) throw new Error("expected pending window grep");
	expect(pendingWindow.lines).toEqual([
		{ lineNumber: 3, line: "pendingneedle only in the pending version", matched: true },
	]);
	expect(pendingWindow.scanTruncated).toBe(false);

	const pendingPlainRegex = await asUser.query(internal.files_nodes.match_plain_text_file_lines, {
		...grepArgs,
		pattern: String.raw`pending\s+alert`,
		ignoreCase: false,
		fixedStrings: false,
		invert: false,
	});
	expect(pendingPlainRegex).not.toBeNull();
	if (!pendingPlainRegex) throw new Error("expected pending plain-text regex grep");
	expect(pendingPlainRegex.lines).toEqual([{ lineNumber: 2, line: "pending alert", matched: true }]);

	const staleCommittedGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		...grepArgs,
		pattern: "committedneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(staleCommittedGrep).not.toBeNull();
	if (!staleCommittedGrep) throw new Error("expected pending grep view");
	expect(staleCommittedGrep.lines).toEqual([]);

	await t.run(async (ctx) => {
		const chunks = await ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", cappedOutputNodeId),
			)
			.collect();
		const secondChunk = chunks[1];
		if (!secondChunk) {
			throw new Error("Expected more than one chunk");
		}
		await ctx.db.patch("files_text_chunks", secondChunk._id, { startIndex: secondChunk.startIndex + 1 });
	});

	const brokenGrep = await asUser.query(internal.files_nodes.match_text_file_lines, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		target: { kind: "saved", id: cappedOutputNodeId },
		pattern: "outputneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(brokenGrep).toBeNull();
});

// Seed an external (reserved-scope) committed file the way a read-only mount will: a node with no
// Yjs/pending/materialization, committed markdown + plain-text chunks with NO yjsSequence, a linked
// R2 `content` asset, and exact wc stats. `r2Writes` gets the raw body so action-level R2 reads
// resolve. Returns the node id. Mirrors committed chunk doc shapes minus yjsSequence.
async function test_insert_committed_external_markdown(args: {
	t: ReturnType<typeof test_convex>;
	r2Writes: Map<string, BodyInit>;
	userId: Id<"users">;
	path: string;
	markdown: string;
}) {
	const { t, r2Writes, path, markdown } = args;

	const chunks = await files_chunk_markdown(markdown);
	if (chunks._nay) throw new Error(chunks._nay.message);
	const byteSize = files_get_utf8_byte_size(markdown);
	return await t.run(async (ctx) => {
		const now = Date.now();
		const name = path.split("/").filter(Boolean).at(-1);
		if (!name) throw new Error("Expected a root-level file path");
		const nodeId = await ctx.db.insert("files_nodes", {
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
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			parentId: files_ROOT_ID,
			path,
			treePath: path,
			pathDepth: 1,
			lowercaseExtension: "md",
			name,
			sortName: files_sort_text_key(name),
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
			updatedAt: now,
			newChildWritePolicy: null,
		});
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			kind: "content",
			r2Bucket: "test-bucket",
			r2Key: `mounts${path}`,
			size: byteSize,
			createdBy: users_SYSTEM_AUTHOR,
			updatedAt: now,
		});
		r2Writes.set(`mounts${path}`, markdown);
		const statsId = await ctx.db.insert("file_stats", {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			fileNodeId: nodeId,
			lineCount: (markdown.match(/\n/gu) ?? []).length,
			wordCount: markdown.trim().length === 0 ? 0 : markdown.trim().split(/\s+/u).length,
			charCount: Array.from(markdown).length,
		});
		await ctx.db.patch("files_nodes", nodeId, { assetId, statsId });
		// Committed chunks with yjsSequence OMITTED: external rows are addressed by node id alone.
		const textChunkIds = await Promise.all(
			chunks._yay.map((chunk) =>
				ctx.db.insert("files_text_chunks", {
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					fileNodeId: nodeId,
					sourceKind: "committed",
					chunkIndex: chunk.chunkIndex,
					textChunk: chunk.textChunk,
					startIndex: chunk.startIndex,
					endIndex: chunk.endIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					chunkFlags: chunk.chunkFlags,
				}),
			),
		);
		await Promise.all(
			chunks._yay.map((chunk, index) =>
				ctx.db.insert("files_plain_text_chunks", {
					organizationId: organizations_GLOBAL_ORGANIZATION_ID,
					workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
					fileNodeId: nodeId,
					sourceKind: "committed",
					textChunkId: textChunkIds[index],
					chunkIndex: chunk.chunkIndex,
					path,
					plainTextChunk: chunk.plainTextChunk,
					textChunk: chunk.textChunk,
					startIndex: chunk.startIndex,
					endIndex: chunk.endIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					chunkFlags: chunk.chunkFlags,
					hasChunkAbove: index > 0,
					hasChunkBelow: index < chunks._yay.length - 1,
				}),
			),
		);
		return nodeId;
	});
}

test("external (reserved) scope reads committed chunks and R2 without Yjs, pending, or materialization", async () => {
	const t = test_convex();
	// A real acting user id (the tenant user reading an external mount); the file itself is reserved-scope.
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const r2Writes = test_setup_r2_capture();

	const paragraphs = Array.from(
		{ length: 50 },
		(_, i) =>
			`External paragraph ${i + 1} carries words alpha-${i} beta gamma delta epsilon zeta eta theta${i === 0 ? " 🙂" : ""}.`,
	);
	const path = "/.mounts/github/external-doc.md";
	const markdown = [
		"# External Mount Document",
		"",
		"externalneedle one",
		"**critical** mount alert",
		"externalsearchneedle appears once here.",
		"",
		...paragraphs,
		"",
		"externalneedle two",
		"",
	].join("\n");

	const nodeId = await test_insert_committed_external_markdown({ t, r2Writes, userId: db.userId, path, markdown });

	// Guard the test is meaningful: the document really spans multiple committed chunks.
	const chunkCount = await t.run(async (ctx) =>
		ctx.db
			.query("files_text_chunks")
			.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
				q
					.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
					.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId),
			)
			.collect()
			.then((chunks) => chunks.length),
	);
	expect(chunkCount).toBeGreaterThan(1);

	const readScope = {
		organizationId: organizations_GLOBAL_ORGANIZATION_ID,
		workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	} as const;

	// Full read reproduces the exact committed markdown by merging chunks (no R2 fetch for chunk reads).
	const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
		...readScope,
		userId: db.userId,
		path,
		mode: { kind: "full", maxBytes: files_get_utf8_byte_size(markdown) + 1000 },
	});
	expect(full).not.toBeNull();
	if (!full) throw new Error("expected external full read");
	expect(full.content).toBe(markdown);
	expect(full.moreLines).toBe(false);
	expect(full.pendingUpdateId).toBeNull();

	// Line read slices the same range as slicing the full committed text.
	const lineRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
		...readScope,
		userId: db.userId,
		path,
		mode: { kind: "lines", startLine: 1, maxLines: 5 },
	});
	expect(lineRead).not.toBeNull();
	if (!lineRead) throw new Error("expected external line read");
	expect(lineRead.content).toBe(files_line_range_from_text({ content: markdown, startLine: 1, maxLines: 5 }).content);

	// read_committed_file_chunks_line_range: head / deep mid-document / tail each equal direct slicing.
	const totalLines = markdown.split("\n").length;
	const readRange = (args: { startLine: number; maxLines: number; fromEnd?: boolean }) => {
		const { fromEnd = false, maxLines, startLine } = args;

		return t.query(internal.files_nodes.read_committed_file_chunks_line_range, {
			...readScope,
			userId: db.userId,
			path,
			startLine,
			maxLines,
			fromEnd,
		});
	};
	for (const [startLine, maxLines] of [
		[1, 5],
		[20, 6],
		[Math.max(1, totalLines - 3), 10],
	] as const) {
		const result = await readRange({ startLine, maxLines });
		expect(result.usable).toBe(true);
		if (!result.usable) throw new Error("expected usable");
		expect(result.content).toBe(files_line_range_from_text({ content: markdown, startLine, maxLines }).content);
	}
	const tail = await readRange({ startLine: 1, maxLines: 5, fromEnd: true });
	expect(tail.usable).toBe(true);
	if (!tail.usable) throw new Error("expected usable tail");
	expect(tail.content).toBe(files_tail_lines_from_text(markdown, 5).content);

	// Exact counts come from the linked file_stats doc (byteCount from the R2 content asset size).
	const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
		...readScope,
		userId: db.userId,
		path,
	});
	expect(stats.usable).toBe(true);
	if (!stats.usable) throw new Error("expected usable stats");
	expect(stats.lineCount).toBe((markdown.match(/\n/gu) ?? []).length);
	expect(Array.from(markdown).length).toBeLessThan(markdown.length);
	expect(stats.charCount).toBe(Array.from(markdown).length);
	expect(stats.byteCount).toBe(files_get_utf8_byte_size(markdown));
	expect(stats.wordCount).toBe(markdown.trim().split(/\s+/u).length);

	// match_text_file_lines / match_plain_text_file_lines read committed chunks with no pending gate.
	const markdownGrep = await t.query(internal.files_nodes.match_text_file_lines, {
		...readScope,
		userId: db.userId,
		target: { kind: "saved", id: nodeId },
		pattern: "externalneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
		before: 0,
		after: 0,
	});
	expect(markdownGrep).not.toBeNull();
	if (!markdownGrep) throw new Error("expected external markdown grep");
	expect(markdownGrep.lines.map(({ lineNumber, line }) => ({ lineNumber, line }))).toEqual([
		{ lineNumber: 3, line: "externalneedle one" },
		{ lineNumber: 58, line: "externalneedle two" },
	]);

	const plainGrep = await t.query(internal.files_nodes.match_plain_text_file_lines, {
		...readScope,
		userId: db.userId,
		target: { kind: "saved", id: nodeId },
		pattern: "critical mount alert",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	});
	expect(plainGrep).not.toBeNull();
	if (!plainGrep) throw new Error("expected external plain-text grep");
	expect(plainGrep.lines).toEqual([{ lineNumber: 4, line: "critical mount alert", matched: true }]);

	// text_search_files finds committed external content; no pending lookup runs for reserved scope.
	const search = await t.query(internal.files_nodes.text_search_files, {
		...readScope,
		userId: db.userId,
		hasWorkspaceRead: true,
		query: "externalsearchneedle",
		numItems: 10,
		cursor: null,
	});
	expect(search.items.map((item) => item.path)).toContain(path);

	// get_file_last_available_text_content_by_path falls into the raw-R2 `.text()` branch for external.
	const available = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		...readScope,
		userId: db.userId,
		path,
	});
	expect(available).not.toBeNull();
	if (!available) throw new Error("expected external available content");
	expect(available.content).toBe(markdown);
	expect(available.pendingUpdateId).toBeNull();
});

describe("non-collaborative files", () => {
	// Build the shape a non-collaborative create leaves behind: a tenant node with committed chunks,
	// a content-snapshot asset, and no Yjs docs at all. This runs the real creation branch, so the
	// test also proves that branch writes nothing Yjs-shaped.
	/**
	 * Run the bounded continuations a toggle schedules.
	 *
	 * `ctx.scheduler.runAfter(0, ...)` registers a real timer, and the harness only waits for jobs
	 * whose timer already fired. So yield the event loop first, and repeat, because one
	 * continuation can reschedule itself while work remains.
	 */
	async function drain_scheduled_continuations(t: ReturnType<typeof test_convex>) {
		for (let round = 0; round < 5; round += 1) {
			await delay(0);
			await t.finishInProgressScheduledFunctions();
		}
	}

	async function seed_non_collaborative_file(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		path: string;
		markdown: string;
	}) {
		const { t, db, path, markdown } = args;

		return await t.run(async (ctx) => {
			const now = Date.now();
			const name = path.split("/").filter(Boolean).at(-1);
			if (!name) throw new Error("Expected a root-level file path");
			const { rootKind, contentType } = files_default_text_shape_for_name(name);

			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `content-snapshot${path}`,
				size: files_get_utf8_byte_size(markdown),
				createdBy: db.userId,
				updatedAt: now,
			});
			const nodeId = await ctx.db.insert("files_nodes", {
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
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
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
				newChildWritePolicy: null,
			});

			await files_nodes_db_insert_file_content_docs(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				path,
				contentType,
				rootKind,
				textContent: markdown,
				readOnly: false,
				nonCollaborative: true,
				userId: db.userId,
				now,
			});

			return { nodeId, assetId };
		});
	}

	test("the create branch writes committed content and frontmatter, and no Yjs docs", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const markdown = "---\ntitle: Release notes\nowner: ada\n---\n\n# Release notes\n\nFirst line here.\n";
		const { nodeId } = await seed_non_collaborative_file({ t, db, path: "/notes.md", markdown });

		const written = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			return {
				collaborationEnabled: node?.collaborationEnabled,
				textKind: node?.textKind,
				yjsSnapshotId: node?.yjsSnapshotId,
				yjsLastSequenceId: node?.yjsLastSequenceId,
				statsId: node?.statsId,
				yjsSnapshots: (await ctx.db.query("files_yjs_snapshots").collect()).length,
				yjsLastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length,
				yjsUpdates: (await ctx.db.query("files_yjs_updates").collect()).length,
				yjsSnapshotAssets: (await ctx.db.query("files_r2_assets").collect()).filter(
					(asset) => asset.kind === "yjs_snapshot",
				).length,
				textChunks: (await ctx.db.query("files_text_chunks").collect()).length,
				metadataFields: (await ctx.db.query("files_metadata_docs").collect()).map((entry) => entry.fieldPath).sort(),
			};
		});

		// A non-collaborative file carries no Yjs state of any kind.
		expect(written.collaborationEnabled).toBe(false);
		expect(written.yjsSnapshotId).toBeNull();
		expect(written.yjsLastSequenceId).toBeNull();
		expect(written.yjsSnapshots).toBe(0);
		expect(written.yjsLastSequences).toBe(0);
		expect(written.yjsUpdates).toBe(0);
		expect(written.yjsSnapshotAssets).toBe(0);

		// It keeps every committed representation, including the frontmatter index.
		// The shape stays `rich_text`, so the Markdown chunker ran and frontmatter was indexed —
		// this is what the read-only mount branch would have destroyed by forcing plain text.
		expect(written.textKind).toBe("rich_text");
		expect(written.textChunks).toBeGreaterThan(0);
		expect(written.statsId).toBeDefined();
		expect(written.metadataFields).toEqual([
			"frontmatter.owner",
			"frontmatter.owner",
			"frontmatter.title",
			"frontmatter.title",
		]);
	});

	test("every committed read door serves a non-collaborative markdown file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const lines = ["# Handbook", "", "quietneedle one", "a middle line", "quietneedle two", "the last line"];
		const markdown = lines.join("\n");
		const path = "/handbook.md";
		const { nodeId } = await seed_non_collaborative_file({ t, db, path, markdown });

		const readScope = { organizationId: db.organizationId, workspaceId: db.workspaceId } as const;

		// read_file_content_from_chunks, full: the door behind bash `cat` and the agent file tools.
		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: db.userId,
			path,
			mode: { kind: "full", maxBytes: files_get_utf8_byte_size(markdown) + 1000 },
		});
		expect(full).not.toBeNull();
		if (!full) throw new Error("expected a full read");
		expect(full.content).toBe(markdown);
		expect(full.pendingUpdateId).toBeNull();

		// The same door refuses text over the caller's cap. Before the byte-size fallback learned
		// about content-snapshot assets this read `0` and returned the whole file instead.
		const overCap = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: db.userId,
			path,
			mode: { kind: "full", maxBytes: 4 },
		});
		expect(overCap).toBeNull();

		// read_file_content_from_chunks, lines: the door behind `head` and `tail`.
		const lineRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: db.userId,
			path,
			mode: { kind: "lines", startLine: 1, maxLines: 3 },
		});
		expect(lineRead).not.toBeNull();
		if (!lineRead) throw new Error("expected a line read");
		expect(lineRead.content).toBe(files_line_range_from_text({ content: markdown, startLine: 1, maxLines: 3 }).content);

		// read_committed_file_chunk_stats: the door behind `wc`.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			...readScope,
			userId: db.userId,
			path,
		});
		expect(stats.usable).toBe(true);
		if (!stats.usable) throw new Error("expected usable stats");
		expect(stats.byteCount).toBe(files_get_utf8_byte_size(markdown));
		expect(stats.lineCount).toBe((markdown.match(/\n/gu) ?? []).length);

		// match_plain_text_file_lines: the door behind `grep` and `sed`.
		const grep = await t.query(internal.files_nodes.match_plain_text_file_lines, {
			...readScope,
			userId: db.userId,
			target: { kind: "saved", id: nodeId },
			pattern: "quietneedle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		expect(grep).not.toBeNull();
		if (!grep) throw new Error("expected a grep result");
		expect(grep.lines.map(({ lineNumber }) => lineNumber)).toEqual([3, 5]);

		// get_file_text_content_db_state_by_path: the door behind the app editor and `edit_file`.
		const state = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			...readScope,
			userId: db.userId,
			path,
		});
		expect(state).not.toBeNull();
		if (!state) throw new Error("expected a content state");
		expect(state.content).toBe(markdown);
		// No Yjs document, so nothing to materialize and nothing for the caller to rebuild.
		expect(state.materializationState).toBeNull();
		const available = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...readScope,
			userId: db.userId,
			path,
		});
		expect(available).toMatchObject({ content: markdown });

		// Workspace search reads committed chunks without requiring Yjs.
		const search = await text_search_files_all_pages(t, {
			...readScope,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "quietneedle",
			numItems: 10,
			cursor: null,
		});
		expect(search.items.map((item) => item.path)).toContain(path);
	});

	test("the editor read door returns the committed text with its asset and refuses a collaborative file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Door User",
			email: "read-door-user@example.com",
		});

		const markdown = "# Read\n\nbody\n";
		const { nodeId } = await seed_non_collaborative_file({ t, db, path: "/read.md", markdown });

		const read = await asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(read._yay).toEqual({ text: markdown, textKind: "rich_text" });

		// A collaborative file is loaded from its Yjs document, so this door must not answer for it.
		const collaborative = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "collaborative.md",
		});
		if (collaborative._nay) {
			throw new Error(collaborative._nay.message);
		}
		const refused = await asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
			membershipId: db.membershipId,
			nodeId: collaborative._yay.nodeId,
		});
		expect(refused._nay?.message).toBe("Not found");
	});

	test("the replace door saves new text, keeps zero Yjs docs, and writes a version", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Replace Door User",
			email: "replace-door-user@example.com",
		});
		const r2Writes = test_setup_r2_capture();

		const path = "/plan.md";
		const { nodeId, assetId } = await seed_non_collaborative_file({ t, db, path, markdown: "# Plan\n\nold body\n" });

		const rawNextText = "\ufeff# Plan\r\n\r\nnew body with searchword\r\n";
		const nextText = "# Plan\n\nnew body with searchword\n";
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: rawNextText,
		});
		expect(saved._nay).toBeUndefined();

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const snapshots = (await ctx.db.query("files_snapshots").collect()).filter(
				(snapshot) => snapshot.fileNodeId === nodeId,
			);
			const newAsset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			const versionAsset = snapshots[0] ? await ctx.db.get("files_r2_assets", snapshots[0].assetId) : null;
			return {
				assetId: node?.assetId,
				collaborationEnabled: node?.collaborationEnabled,
				newAssetKind: newAsset?.kind,
				newAssetKey: newAsset?.r2Key,
				newAssetSize: newAsset?.size,
				contentByteSize: node?.contentByteSize,
				versionAssetId: versionAsset?._id,
				versionAssetKey: versionAsset?.r2Key,
				snapshotCount: snapshots.length,
				yjsSnapshots: (await ctx.db.query("files_yjs_snapshots").collect()).length,
				yjsLastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length,
				yjsUpdates: (await ctx.db.query("files_yjs_updates").collect()).length,
			};
		});

		// The replacement landed and the file is still non-collaborative.
		expect(after.collaborationEnabled).toBe(false);
		expect(after.assetId).not.toBe(assetId);
		expect(saved._yay).toBeNull();
		expect(after.newAssetKind).toBe("content_snapshot");
		expect(after.newAssetSize).toBe(files_get_utf8_byte_size(nextText));
		expect(after.contentByteSize).toBe(files_get_utf8_byte_size(nextText));
		expect(after.yjsSnapshots).toBe(0);
		expect(after.yjsLastSequences).toBe(0);
		expect(after.yjsUpdates).toBe(0);

		// The version snapshot the save wrote points at the saved asset and its exact R2 body.
		expect(after.snapshotCount).toBe(1);
		expect(after.newAssetKey ? r2Writes.get(after.newAssetKey) : undefined).toBe(nextText);
		expect(after.versionAssetId).toBe(after.assetId);
		expect(after.versionAssetKey ? r2Writes.get(after.versionAssetKey) : undefined).toBe(nextText);

		// The committed chunks were replaced, not appended: reading back gives exactly the new text.
		const readBack = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(readBack?.content).toBe(nextText);
	});

	test("files_nodes_db_commit_text_replacement syncs the updater sort doc", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Replace Sync User",
		});
		test_setup_r2_capture();
		const { nodeId } = await seed_non_collaborative_file({ t, db, path: "/replace-sync.md", markdown: "# Old\n" });
		await t.run(async (ctx) => {
			await files_updated_by_db_delete_for_node(ctx, { nodeId });
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc).toBeNull();
		});

		// `replace_file_content` reaches the writer through `finalize_file_content_replacement`.
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: "# New\n",
		});
		expect(saved._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc, "files_nodes_db_commit_text_replacement syncs the updater doc").toMatchObject({
				userId: node?.updatedBy,
				name: node?.name,
				parentId: node?.parentId,
				nodeKind: node?.kind,
			});
			expect(doc?.archiveOperationId).toBeUndefined();
		});
	});

	test.each([false, true])("last write wins for two saves (overlapping uploads: %s)", async (overlap) => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Last Write Wins User",
		});
		const r2Writes = test_setup_r2_capture();
		const { nodeId } = await seed_non_collaborative_file({ t, db, path: "/two-saves.txt", markdown: "original\n" });
		const [firstRead, secondRead] = await Promise.all([
			asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: db.membershipId,
				nodeId,
			}),
			asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: db.membershipId,
				nodeId,
			}),
		]);
		if (firstRead._nay || secondRead._nay) throw new Error("Expected both file reads to succeed");
		const firstText = `${firstRead._yay.text}first tab\n`;
		const secondText = `${secondRead._yay.text}second tab\n`;

		let releaseFirstPut: (() => void) | undefined;
		const firstPutBlocked = new Promise<void>((resolve) => {
			releaseFirstPut = resolve;
		});
		let announceFirstPut: (() => void) | undefined;
		const firstPutStarted = new Promise<void>((resolve) => {
			announceFirstPut = resolve;
		});
		const capturedFetch = fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				if (overlap && init?.method === "PUT" && init.body === firstText) {
					announceFirstPut?.();
					await firstPutBlocked;
				}
				return await capturedFetch(url, init);
			}),
		);

		const firstSaving = asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: firstText,
		});
		if (overlap) {
			await firstPutStarted;
		} else {
			expect((await firstSaving)._nay).toBeUndefined();
		}
		const secondSaved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: secondText,
		});
		releaseFirstPut?.();
		const firstSaved = await firstSaving;
		expect(firstSaved._nay).toBeUndefined();
		expect(secondSaved._nay).toBeUndefined();

		// Upload start order does not decide the winner. The last commit replaces the whole text.
		const winnerText = overlap ? firstText : secondText;
		const readBack = await asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(readBack._yay?.text).toBe(winnerText);
		const history = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const versions = (await ctx.db.query("files_snapshots").collect()).filter(
				(snapshot) => snapshot.fileNodeId === nodeId,
			);
			const assets = await Promise.all(versions.map((snapshot) => ctx.db.get("files_r2_assets", snapshot.assetId)));
			return { assetId: node?.assetId, versions, assets };
		});
		expect(history.versions).toHaveLength(2);
		expect(history.assets.map((asset) => (asset?.r2Key ? r2Writes.get(asset.r2Key) : undefined))).toEqual(
			expect.arrayContaining([firstText, secondText]),
		);
		const currentAsset = history.assets.find((asset) => asset?._id === history.assetId);
		expect(currentAsset?.r2Key ? r2Writes.get(currentAsset.r2Key) : undefined).toBe(winnerText);
	});

	test("the replace door refuses a locked file and over-cap content", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Replace Door Guard User",
			email: "replace-door-guard-user@example.com",
		});
		const r2Writes = test_setup_r2_capture();

		const original = "# Guarded\n\noriginal body\n";
		const { nodeId, assetId } = await seed_non_collaborative_file({ t, db, path: "/guarded.md", markdown: original });

		const read_current_text = () =>
			t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/guarded.md",
				mode: { kind: "full", maxBytes: 100_000 },
			});

		// Text over the size limit is refused before anything is written, with a plain message —
		// not by a late throw from the chunk insert.
		const tooBig = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: "x".repeat(files_MAX_TEXT_CONTENT_BYTES + 1),
		});
		expect(tooBig._nay?.message).toContain("exceeds");

		// Frontmatter over the field limit is refused the same way.
		const tooManyFields = Array.from(
			{ length: files_metadata_MAX_FRONTMATTER_FIELDS + 5 },
			(_, index) => `field${index}: value${index}`,
		).join("\n");
		const fatFrontmatter = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: `---\n${tooManyFields}\n---\n\nbody\n`,
		});
		// Same words as the pending-update preflight: both doors take a whole text from a person who
		// can shorten it after reading the message.
		expect(fatFrontmatter._nay?.message).toBe("Too many frontmatter fields");

		// The read-only lock blocks this write door like every other one.
		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const whileLocked = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: "# Guarded\n\nwritten through the lock\n",
		});
		expect(whileLocked._nay?.name).toBe("read_only");
		expect(whileLocked._nay?.message).toBe("This item is read-only.");

		// Every refusal above happened before an R2 PUT and left the committed text untouched.
		expect(r2Writes.size).toBe(0);
		expect((await read_current_text())?.content).toBe(original);
		const afterRefusals = await t.run(async (ctx) => ({
			assetId: (await ctx.db.get("files_nodes", nodeId))?.assetId,
			assets: (await ctx.db.query("files_r2_assets").collect()).length,
			versions: (await ctx.db.query("files_snapshots").collect()).filter((snapshot) => snapshot.fileNodeId === nodeId)
				.length,
		}));
		expect(afterRefusals).toEqual({ assetId, assets: 1, versions: 0 });
	});

	test("the replacement finalizer rechecks a lock added after preflight", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Replacement Final Lock User",
		});
		const original = "# Final lock\n\noriginal body\n";
		const nextText = "# Final lock\n\nreplacement body\n";
		const { nodeId, assetId } = await seed_non_collaborative_file({
			t,
			db,
			path: "/replacement-final-lock.md",
			markdown: original,
		});

		const preflight = await t.query(internal.files_nodes_content.get_replace_file_content_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
		});
		expect(preflight?.canWrite).toBe(true);
		const versionSnapshotAssetId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(nextText),
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		// The action already passed its cheap check and uploaded. A lock added now must still stop
		// the final transaction before it publishes the asset or changes the committed text.
		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const refused = await t.mutation(internal.files_nodes_content.finalize_file_content_replacement, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			text: nextText,
			textSize: files_get_utf8_byte_size(nextText),
			versionSnapshotAssetId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");

		const after = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			newAsset: await ctx.db.get("files_r2_assets", versionSnapshotAssetId),
			versions: (await ctx.db.query("files_snapshots").collect()).filter((snapshot) => snapshot.fileNodeId === nodeId),
		}));
		expect(after.node?.assetId).toBe(assetId);
		expect(after.newAsset?.r2Key).toBeUndefined();
		expect(after.newAsset?.unfinalizedExpiresAt).toBeDefined();
		expect(after.versions).toEqual([]);
		const readBack = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/replacement-final-lock.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(readBack?.content).toBe(original);
	});

	test("the replace door refuses a member who cannot write the file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const r2Writes = test_setup_r2_capture();

		const original = "# Restricted\n\noriginal body\n";
		const { nodeId } = await seed_non_collaborative_file({ t, db, path: "/restricted.md", markdown: original });

		// A plain workspace member with no grant on this file. The owner passes every permission
		// check, so a refusal can only be proven with a second identity.
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_replace_door_member" });
			const now = Date.now();
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now,
			});
			// Restrict the file to its own scope, so workspace-wide access no longer reaches it.
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			return { userId, membershipId };
		});

		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: member.userId,
			name: "Replace Door Member",
			email: "replace-door-member@example.com",
		});

		const refused = await asMember.action(api.files_nodes_content.replace_file_content, {
			membershipId: member.membershipId,
			nodeId,
			text: "# Restricted\n\nwritten without permission\n",
		});
		// An action cannot read the database, so it only learns that its preflight query said no,
		// not which check said it. It answers one message for all of them, the same way
		// `restore_snapshot_r2` does. A mutation bubbles the exact refusal instead; see
		// `both toggles refuse a member who cannot write the file`.
		expect(refused._nay).toBeDefined();
		expect(refused._nay?.name).not.toBe("read_only");

		const stillOriginal = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/restricted.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(stillOriginal?.content).toBe(original);

		// The refusal left no orphan: no new version snapshot doc and no new content asset.
		const leftovers = await t.run(async (ctx) => ({
			snapshots: (await ctx.db.query("files_snapshots").collect()).filter((snapshot) => snapshot.fileNodeId === nodeId)
				.length,
			assets: (await ctx.db.query("files_r2_assets").collect()).length,
		}));
		expect(leftovers.snapshots).toBe(0);
		expect(leftovers.assets).toBe(1);
		expect(r2Writes.size).toBe(0);

		// Positive control: the ONLY thing missing was the permission. Grant it and the same call
		// goes through. Without this, a refusal caused by a wrong membership id or a wrong node
		// shape would look exactly like a permission refusal.
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				resourceKind: "file",
				resourceId: nodeId,
				principalKind: "user",
				userId: member.userId,
				permission: "content.write",
				createdAt: now,
				updatedAt: now,
			});
		});

		// With the permission granted, the credit gate is the next thing that stops the save. This is
		// the same gate the Yjs save door charges. Turning collaboration off is not a way to save
		// without paying.
		const unfunded = await asMember.action(api.files_nodes_content.replace_file_content, {
			membershipId: member.membershipId,
			nodeId,
			text: "# Restricted\n\nwritten with permission\n",
		});
		expect(unfunded._nay?.message).toBe("Insufficient funds");
		expect(r2Writes.size).toBe(0);

		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, member.userId));
		const allowed = await asMember.action(api.files_nodes_content.replace_file_content, {
			membershipId: member.membershipId,
			nodeId,
			text: "# Restricted\n\nwritten with permission\n",
		});
		expect(allowed._nay).toBeUndefined();
	});

	test("every Yjs door still refuses a non-collaborative file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Yjs Door User",
			email: "yjs-door-user@example.com",
		});
		const { nodeId } = await seed_non_collaborative_file({ t, db, path: "/locked.md", markdown: "# Locked\n\nbody\n" });

		// The predicate is what every Yjs door gates on, so this is the single fact that makes them
		// all fail closed. The read predicate answers the opposite for the same node.
		const verdicts = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			return {
				hasYjs: files_node_has_editable_yjs_state(node),
				hasText: files_node_has_editable_text_content(node),
			};
		});
		expect(verdicts.hasYjs).toBe(false);
		expect(verdicts.hasText).toBe(true);

		// Drive the two public Yjs doors as well. The predicate above only proves the fixture; a
		// door that forgot to ask would still write.
		const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# Locked\n\nthrough Yjs\n" });
		if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
		const removedLineageId = await t.run(async (ctx) =>
			ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				lastSequence: 0,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
				lineageGeneration: 0,
			}),
		);
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			// A collaboration-off node has no live lineage, so any client token must fail closed.
			expectedYjsLastSequenceId: removedLineageId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
			sessionId: "non-collaborative-door",
		});
		yjsDoc.destroy();
		expect(pushed._nay?.message).toBe("Not found");
		await t.run(async (ctx) => ctx.db.delete("files_yjs_docs_last_sequences", removedLineageId));

		// This one answers `null` rather than a refusal: it is a read the editor polls, and a file
		// with no document has no sequence to report.
		const sequence = await asUser.query(api.files_nodes.get_file_last_yjs_sequence, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(sequence).toBeNull();

		// The refused push wrote no update log and no sequence doc.
		const yjsDocs = await t.run(async (ctx) => ({
			updates: (await ctx.db.query("files_yjs_updates").collect()).length,
			lastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length,
		}));
		expect(yjsDocs.updates).toBe(0);
		expect(yjsDocs.lastSequences).toBe(0);
	});

	test("turning collaboration off and back on keeps the visible text", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Round Trip User",
			email: "round-trip-user@example.com",
		});
		const r2Writes = test_setup_r2_capture();

		const markdown = "# Round trip\n\nbody with searchword\n";
		const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/round-trip.md", markdown });

		const read_current_text = () =>
			t.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/round-trip.md",
				mode: { kind: "full", maxBytes: 100_000 },
			});
		const collaborative_doc_counts = () =>
			t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", nodeId);
				return {
					collaborationEnabled: node?.collaborationEnabled,
					hasPointers: node?.yjsSnapshotId != null && node?.yjsLastSequenceId != null,
					snapshots: (await ctx.db.query("files_yjs_snapshots").collect()).length,
					lastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length,
					updates: (await ctx.db.query("files_yjs_updates").collect()).length,
					materializationJobs: (await ctx.db.query("files_content_materialization_jobs").collect()).length,
				};
			});

		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		await drain_scheduled_continuations(t);

		// The whole Yjs document is gone and the text survived it.
		const afterOff = await collaborative_doc_counts();
		expect(afterOff.collaborationEnabled).toBe(false);
		expect(afterOff.hasPointers).toBe(false);
		expect(afterOff.snapshots).toBe(0);
		expect(afterOff.lastSequences).toBe(0);
		expect(afterOff.updates).toBe(0);
		expect(afterOff.materializationJobs).toBe(0);
		expect((await read_current_text())?.content).toBe(markdown);

		// The old Yjs snapshot object is not deleted straight away: a materialization worker that
		// is already running can still write it back, so the deletion job waits first.
		const deletionJob = await t.run(async (ctx) => {
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			return jobs.at(0);
		});
		expect(deletionJob?.reason).toBe("untracked_asset_event");
		expect(deletionJob?.putMayArriveUntil).toBeGreaterThan(Date.now());

		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();

		// Turning collaboration back on creates one fresh document with the same visible text.
		const afterOn = await collaborative_doc_counts();
		expect(afterOn.collaborationEnabled).toBe(true);
		expect(afterOn.hasPointers).toBe(true);
		expect(afterOn.snapshots).toBe(1);
		expect(afterOn.lastSequences).toBe(1);
		expect((await read_current_text())?.content).toBe(markdown);

		// The fresh document starts its own history at sequence 0, so nothing built against the old
		// one can be replayed onto it.
		const freshDoc = await t.run(async (ctx) => {
			const lastSequenceDoc = (await ctx.db.query("files_yjs_docs_last_sequences").collect()).at(0);
			const snapshotDoc = (await ctx.db.query("files_yjs_snapshots").collect()).at(0);
			const snapshotAsset = snapshotDoc ? await ctx.db.get("files_r2_assets", snapshotDoc.assetId) : null;
			return {
				lastSequence: lastSequenceDoc?.lastSequence,
				snapshotSequence: snapshotDoc?.sequence,
				snapshotR2Key: snapshotAsset?.r2Key,
			};
		});
		expect(freshDoc.lastSequence).toBe(0);
		expect(freshDoc.snapshotSequence).toBe(0);
		if (!freshDoc.snapshotR2Key) throw new Error("Expected the fresh Yjs snapshot object");
		const freshSnapshotBody = r2Writes.get(freshDoc.snapshotR2Key);
		if (freshSnapshotBody === undefined) throw new Error("Expected the fresh Yjs snapshot bytes in R2");
		const freshYjsDoc = new YjsDoc();
		applyUpdate(freshYjsDoc, new Uint8Array(await new Response(freshSnapshotBody).arrayBuffer()));
		const freshText = files_yjs_doc_get_text({ rootKind: "rich_text", yjsDoc: freshYjsDoc });
		freshYjsDoc.destroy();
		if (freshText._nay) throw new Error(freshText._nay.message);
		expect(freshText._yay).toBe(markdown);

		// Both toggles are idempotent, like the write-policy control beside them.
		const onAgain = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(onAgain._nay).toBeUndefined();
		expect((await collaborative_doc_counts()).snapshots).toBe(1);
	});

	test("turning collaboration off and back on never repeats a file_save id", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		// A signed-in payer: only then do the events reach the Polar workpool the spy watches.
		await t.run(async (ctx) => ctx.db.patch("users", db.userId, { clerkUserId: "clerk-repeat-id-user" }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Repeat Id User",
			email: "repeat-id-user@example.com",
		});
		test_setup_r2_capture();
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repeat-id.md",
		});
		// Count only the two edits whose Yjs histories restart at sequence 1.
		await test_drain_billing_usage_event_outbox(t);
		enqueueActionSpy.mockClear();

		const push_text = async (text: string) => {
			const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text });
			if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
			const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId: db.membershipId,
				nodeId,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
				sessionId: "repeat-id-session",
			});
			yjsDoc.destroy();
			if (pushed._nay) throw new Error(pushed._nay.message);
			return pushed._yay.newSequence;
		};
		// Match on the payload: a generated function reference is a fresh proxy on every access, so
		// `call[1] === internal.billing.ingest_events` is never true.
		const billed_file_save_ids = () =>
			enqueueActionSpy.mock.calls.flatMap((call) => {
				const payload = call[2] as { events?: Array<{ name: string; externalId: string }> };
				return (payload.events ?? []).filter((event) => event.name === "file_save").map((event) => event.externalId);
			});

		expect(await push_text("# Repeat id\n")).toBe(1);
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 1,
		});
		expect(materialized._nay).toBeUndefined();
		await test_drain_billing_usage_event_outbox(t);
		expect(billed_file_save_ids()).toHaveLength(1);

		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		await drain_scheduled_continuations(t);
		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();

		// The new lineage starts at sequence 0 again, so this save reuses sequence 1.
		const secondLineageId = (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId;
		expect(await push_text("# Repeat id\n\nsecond lineage\n")).toBe(1);

		// Every save must get its own id: Polar drops an event whose id it has already seen.
		await test_drain_billing_usage_event_outbox(t);
		const allIds = billed_file_save_ids();
		expect(allIds).toHaveLength(2);
		expect(new Set(allIds).size).toBe(2);
		expect(allIds[1]).toBe(
			`file_save::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::${nodeId}::${secondLineageId}:1`,
		);
	});

	test("turning collaboration on retires cleanup authority after every old Yjs doc is gone", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Stale Cleanup User",
			email: "stale-cleanup-user@example.com",
		});
		test_setup_r2_capture();
		const nodeId = await test_materialize_markdown_file({
			t,
			asUser,
			db,
			path: "/stale-cleanup.md",
			markdown: "# Kept\n",
		});
		const oldSnapshot = await t.run(async (ctx) => {
			const pointers = await ctx.db.get("files_nodes", nodeId);
			if (!pointers?.yjsSnapshotId) throw new Error("Missing Yjs snapshot");
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			if (!snapshot) throw new Error("Missing Yjs snapshot");
			return snapshot;
		});

		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		await drain_scheduled_continuations(t);

		const remainingDocs = await t.run(async (ctx) => {
			// Recovery may find a task after the last covered doc has already gone.
			await ctx.db.insert("files_yjs_cleanup_tasks", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				throughSequence: oldSnapshot.sequence,
				supersededYjsAssetId: oldSnapshot.assetId,
				putMayArriveUntil: null,
				historyPending: true,
			});
			return {
				snapshots: await ctx.db
					.query("files_yjs_snapshots")
					.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect(),
				updates: await ctx.db
					.query("files_yjs_updates")
					.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect(),
			};
		});
		expect(remainingDocs.snapshots).toHaveLength(0);
		expect(remainingDocs.updates).toHaveLength(0);

		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		const enabledNode = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(enabledNode?.collaborationEnabled).toBe(true);
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query("files_yjs_cleanup_tasks")
					.withIndex("by_organization_workspace_fileNode_historyPending", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", nodeId)
							.eq("historyPending", true),
					)
					.first(),
			),
		).toBeNull();
		expect(enabledNode?.yjsLastSequenceId).toBeDefined();
	});

	test("old cleanup and workers cannot cross into a new collaboration lineage", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Lineage Race User",
			email: "lineage-race-user@example.com",
		});
		const r2Writes = test_setup_r2_capture();
		const nodeId = await test_materialize_markdown_file({
			t,
			asUser,
			db,
			path: "/lineage-race.md",
			markdown: "# Before\n",
		});
		const oldLineage = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node?.yjsLastSequenceId || !node.yjsSnapshotId) throw new Error("Expected old Yjs pointers");
			const lastSequence = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			const snapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			if (!lastSequence || !snapshot) throw new Error("Expected the old Yjs lineage");
			return {
				lastSequenceId: lastSequence._id,
				snapshotId: snapshot._id,
				throughSequence: lastSequence.lastSequence,
				snapshotAssetId: snapshot.assetId,
			};
		});

		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();

		// Do not reset sequence numbers while the old numeric cleanup can still run. This is the
		// exact OFF -> ON race that used to delete sequence 1 from the new document.
		const writesBeforeBlockedOn = r2Writes.size;
		const blockedOn = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(blockedOn._nay?.message).toBe(
			"The old collaboration history is still being removed. Please try again later.",
		);
		expect(r2Writes.size).toBe(writesBeforeBlockedOn);

		const cleanupTask = await t.run(async (ctx) =>
			ctx.db
				.query("files_yjs_cleanup_tasks")
				.withIndex("by_organization_workspace_fileNode_historyPending", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", nodeId)
						.eq("historyPending", true),
				)
				.first(),
		);
		if (!cleanupTask) throw new Error("Missing cleanup task");
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: cleanupTask._id });
		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		const freshPointers = await test_get_file_yjs_pointers(t, nodeId);
		expect(freshPointers.yjsLastSequenceId).not.toBe(oldLineage.lastSequenceId);
		expect(freshPointers.yjsSnapshotId).not.toBe(oldLineage.snapshotId);

		const nextDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "# After\n" });
		if ("_nay" in nextDoc) throw new Error(nextDoc._nay.message);
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: freshPointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(nextDoc)),
			sessionId: "fresh-lineage",
		});
		nextDoc.destroy();
		expect(pushed._nay).toBeUndefined();

		// A late provider from the old editor session must not write into the fresh sequence log.
		const stalePush = await t.run(async (ctx) =>
			files_db_yjs_push_update(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId,
				expectedYjsLastSequenceId: oldLineage.lastSequenceId,
				rootKind: "rich_text",
				update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				sessionId: "stale-lineage",
				materializeImmediately: false,
			}),
		);
		expect(stalePush._nay?.message).toBe(
			"This file changed while you were editing. Copy your local changes before reloading, then try again.",
		);

		// Old workers can have the same numeric target as the new sequence. Exact document ids,
		// not the number, keep them from settling or deleting the fresh job and update.
		await t.mutation(internal.files_nodes_content.mark_file_content_too_large, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			expectedYjsLastSequenceId: oldLineage.lastSequenceId,
			sequence: 1,
			targetSequence: 1,
			byteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
		});
		await t.mutation(internal.files_nodes_content.cleanup_file_materialization_covered_rows, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			expectedYjsLastSequenceId: oldLineage.lastSequenceId,
			throughSequence: oldLineage.throughSequence,
		});
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_covered_rows, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			throughSequence: oldLineage.throughSequence,
			supersededYjsAssetId: oldLineage.snapshotAssetId,
			expectedActiveYjsLastSequenceId: oldLineage.lastSequenceId,
		});
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: cleanupTask._id });

		const afterStaleWork = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			return {
				lastSequenceId: node?.yjsLastSequenceId,
				tooLargeMarker: node?.contentTooLargeByteSize,
				updates: (await ctx.db.query("files_yjs_updates").collect()).filter((update) => update.fileNodeId === nodeId),
				jobs: (await ctx.db.query("files_content_materialization_jobs").collect()).filter(
					(job) => job.fileNodeId === nodeId,
				),
			};
		});
		expect(afterStaleWork.lastSequenceId).toBe(freshPointers.yjsLastSequenceId);
		expect(afterStaleWork.tooLargeMarker).toBeNull();
		expect(afterStaleWork.updates.map((update) => update.sequence)).toEqual([1]);
		expect(afterStaleWork.jobs.map((job) => job.targetSequence)).toEqual([1]);
	});

	test("both toggles refuse a locked file, and turning off refuses without the acknowledgement", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Toggle Guard User",
			email: "toggle-guard-user@example.com",
		});
		const r2Writes = test_setup_r2_capture();

		const markdown = "# Guarded toggle\n\nbody\n";
		const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/guarded-toggle.md", markdown });

		// A destructive toggle without the acknowledgement is refused before any read.
		const unacknowledged = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: false,
		});
		expect(unacknowledged._nay?.message).toContain("acknowledgement flag");

		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId,
		});
		expect(locked._nay).toBeUndefined();

		// The read-only lock blocks the mode toggle like any other write door.
		const offWhileLocked = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(offWhileLocked._nay?.name).toBe("read_only");
		expect(offWhileLocked._nay?.message).toBe("This item is read-only.");

		// The document is untouched, so unlocking and toggling off still works and the other
		// direction can be checked on a locked non-collaborative file.
		expect(await t.run(async (ctx) => (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length)).toBe(1);

		await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId,
		});
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		await drain_scheduled_continuations(t);

		await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId,
		});
		const objectsBeforeOn = r2Writes.size;
		const onWhileLocked = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(onWhileLocked._nay?.name).toBe("read_only");

		// The lock is answered before the uploads, so the refusal writes nothing into the bucket
		// that the cleanup ledger would then have to delete.
		expect(r2Writes.size).toBe(objectsBeforeOn);

		// The refused toggle left no half-built document and no orphan assets behind.
		const leftovers = await t.run(async (ctx) => ({
			snapshots: (await ctx.db.query("files_yjs_snapshots").collect()).length,
			lastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length,
			unfinalizedAssets: (await ctx.db.query("files_r2_assets").collect()).filter((asset) => asset.r2Key === undefined)
				.length,
		}));
		expect(leftovers.snapshots).toBe(0);
		expect(leftovers.lastSequences).toBe(0);
		expect(leftovers.unfinalizedAssets).toBe(0);
	});

	test("the collaboration-enable finalizer rechecks a lock added after preflight", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Collaboration Final Lock User",
		});
		const text = "# Enable final lock\n\nbody\n";
		const { nodeId, assetId } = await seed_non_collaborative_file({
			t,
			db,
			path: "/enable-final-lock.md",
			markdown: text,
		});

		const preflight = await t.query(internal.files_nodes_content.get_set_file_collaborative_preflight, {
			membershipId: db.membershipId,
			nodeId,
			userId: db.userId,
		});
		expect(preflight?.canWrite).toBe(true);
		expect(preflight?.alreadyCollaborative).toBe(false);
		const assets = await seed_unpublished_asset_pair(t, db);

		// The action already passed its cheap check and uploaded both objects. A lock added now must
		// still stop the final transaction before it creates or publishes a new Yjs lineage.
		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const refused = await asUser.mutation(internal.files_nodes_content.finalize_file_collaboration_enable, {
			membershipId: db.membershipId,
			nodeId,
			text,
			textSize: files_get_utf8_byte_size(text),
			baseAssetId: assetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			yjsSnapshotSize: 2,
			contentSnapshotAssetId: assets.contentSnapshotAssetId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");

		const after = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			yjsSnapshots: await ctx.db.query("files_yjs_snapshots").collect(),
			lastSequences: await ctx.db.query("files_yjs_docs_last_sequences").collect(),
			yjsAsset: await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId),
			contentAsset: await ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId),
		}));
		expect(after.node).toMatchObject({ collaborationEnabled: false, assetId });
		expect(after.node?.yjsSnapshotId).toBeNull();
		expect(after.node?.yjsLastSequenceId).toBeNull();
		expect(after.yjsSnapshots).toEqual([]);
		expect(after.lastSequences).toEqual([]);
		expect(after.yjsAsset?.r2Key).toBeUndefined();
		expect(after.contentAsset?.r2Key).toBeUndefined();
	});

	test("both toggles refuse a member who cannot write the file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Toggle Owner",
			email: "toggle-owner@example.com",
		});
		const r2Writes = test_setup_r2_capture();

		const markdown = "# Toggle acl\n\nbody\n";
		const collaborativeNodeId = await test_materialize_markdown_file({
			t,
			asUser: asOwner,
			db,
			path: "/toggle-acl-on.md",
			markdown,
		});
		const { nodeId: nonCollaborativeNodeId } = await seed_non_collaborative_file({
			t,
			db,
			path: "/toggle-acl-off.md",
			markdown,
		});
		// The seed helper writes the asset doc but never uploads its object, and the ON toggle reads
		// the committed text back from the bucket. Put it there so the positive control below
		// reaches the permission check instead of a 404.
		r2Writes.set("content-snapshot/toggle-acl-off.md", markdown);

		// A plain workspace member with no grant on either file. The owner passes every permission
		// check, so a refusal can only be proven with a second identity.
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_toggle_acl_member" });
			const now = Date.now();
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now,
			});
			// Restrict both files to their own scope, so workspace-wide access no longer reaches them.
			await ctx.db.patch("files_nodes", collaborativeNodeId, { restrictedScopeNodeId: collaborativeNodeId });
			await ctx.db.patch("files_nodes", nonCollaborativeNodeId, { restrictedScopeNodeId: nonCollaborativeNodeId });
			return { userId, membershipId };
		});
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, member.userId));

		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: member.userId,
			name: "Toggle Acl Member",
			email: "toggle-acl-member@example.com",
		});

		const offRefused = await asMember.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: member.membershipId,
			nodeId: collaborativeNodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		// A mutation asks the permission question itself, so it bubbles the shared helper's exact
		// refusal: the member can see this workspace, they just may not write this file.
		expect(offRefused._nay?.message).toBe("Permission denied");

		// The other toggle is an action. It cannot read the database, so it only learns that its
		// preflight query said no, and answers one message for every reason.
		const onRefused = await asMember.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: member.membershipId,
			nodeId: nonCollaborativeNodeId,
		});
		expect(onRefused._nay?.message).toBe("Not found");

		// Neither refusal changed a mode or built a document.
		const modes = await t.run(async (ctx) => ({
			collaborative: (await ctx.db.get("files_nodes", collaborativeNodeId))?.collaborationEnabled,
			nonCollaborative: (await ctx.db.get("files_nodes", nonCollaborativeNodeId))?.yjsSnapshotId,
			lastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length,
		}));
		expect(modes.collaborative).toBe(true);
		expect(modes.nonCollaborative).toBeNull();
		expect(modes.lastSequences).toBe(1);

		// Positive control: the ONLY thing missing was the permission. Grant it on both files and
		// the same two calls go through. Without this, a refusal caused by a wrong membership id or
		// a wrong node shape would look exactly like a permission refusal.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const nodeId of [collaborativeNodeId, nonCollaborativeNodeId]) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					resourceKind: "file",
					resourceId: nodeId,
					principalKind: "user",
					userId: member.userId,
					permission: "content.write",
					createdAt: now,
					updatedAt: now,
				});
			}
		});

		const offAllowed = await asMember.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: member.membershipId,
			nodeId: collaborativeNodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(offAllowed._nay).toBeUndefined();
		const onAllowed = await asMember.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: member.membershipId,
			nodeId: nonCollaborativeNodeId,
		});
		expect(onAllowed._nay).toBeUndefined();
	});

	test("turning collaboration off waits for temporary frontmatter recovery but not a durable marker", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Materialization Gate User",
			email: "materialization-gate-user@example.com",
		});
		test_setup_r2_capture();

		const markdown = "# Gate\n\nbody\n";
		const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/gate.md", markdown });

		// Push one more edit and do NOT materialize it. The committed text is now behind the
		// document, so dropping the document here would silently lose that edit.
		const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: `${markdown}\nunsaved line\n` });
		if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
		const push = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
			sessionId: "gate-unmaterialized",
		});
		yjsDoc.destroy();
		expect(push._nay).toBeUndefined();

		const count_materialization_jobs = () =>
			t.run(async (ctx) => (await ctx.db.query("files_content_materialization_jobs").collect()).length);
		// The push scheduled a materialization worker. Without this the job-doc check below would
		// pass on an empty table and prove nothing.
		expect(await count_materialization_jobs()).toBe(1);

		// Ask the user to wait while the background worker saves the current text.
		const stillSaving = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(stillSaving._nay?.message).toBe("This file is still saving. Try again in a moment.");

		// The frontmatter pair is temporary. A later fitting edit can clear it, so the toggle must
		// still wait for the newer text to materialize instead of silently dropping that text.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, {
				contentFrontmatterTooLargeFieldCount: files_metadata_MAX_FRONTMATTER_FIELDS + 1,
				contentFrontmatterTooLargeIndexDocumentCount: 1,
			});
		});
		const frontmatterCanRecover = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(frontmatterCanRecover._nay?.message).toBe("This file is still saving. Try again in a moment.");
		expect(await count_materialization_jobs()).toBe(1);

		// A durable marker means materialization can never catch up on its own, so waiting would be
		// a lie. The confirmation dialog names this loss, and the toggle goes ahead.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, {
				contentYjsStateTooLargeByteSize: 9_000_000,
			});
		});
		const marked = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(marked._nay).toBeUndefined();

		// The toggle stops the materialization worker and removes its job doc in its
		// own transaction, before any continuation runs. A worker left pointing at a file whose Yjs
		// document is gone writes the snapshot object back into the bucket after the toggle deleted
		// it, and nothing tracks that key afterwards.
		expect(await count_materialization_jobs()).toBe(0);

		// The Yjs and frontmatter markers are cleared with the newer document state they describe.
		// The committed text is the last materialized text, exactly as the dialog promised.
		const after = await t.run(async (ctx) => await ctx.db.get("files_nodes", nodeId));
		expect(after?.contentYjsStateTooLargeByteSize).toBeNull();
		expect(after?.contentFrontmatterTooLargeFieldCount).toBeNull();
		expect(after?.contentFrontmatterTooLargeIndexDocumentCount).toBeNull();
		expect(after?.collaborationEnabled).toBe(false);
		const readBack = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/gate.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(readBack?.content).toBe(markdown);
	});

	test("turning collaboration off goes ahead when the text grew past the cap", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Too Large Gate User",
			email: "too-large-gate-user@example.com",
		});
		test_setup_r2_capture();

		const markdown = "# Too large\n\nbody\n";
		const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/too-large.md", markdown });

		const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: `${markdown}\nunsaved line\n` });
		if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
		const push = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
			sessionId: "too-large-gate",
		});
		yjsDoc.destroy();
		expect(push._nay).toBeUndefined();

		// Settle that materialization the way the real worker does when the text no longer fits.
		// The settle deletes the job docs itself, so the committed text can never catch up again
		// and "still saving" would be a permanent lie.
		const sequence = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", fileNode!.yjsLastSequenceId!);
			return lastSequenceDoc!.lastSequence;
		});
		await t.mutation(internal.files_nodes_content.mark_file_content_too_large, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			sequence,
			targetSequence: sequence,
			byteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
		});
		expect(
			await t.run(async (ctx) => (await ctx.db.query("files_content_materialization_jobs").collect()).length),
		).toBe(0);

		const marked = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(marked._nay).toBeUndefined();

		// The over-cap text lived only in the dropped document, so the marker goes with it and the
		// file reopens at the last text that fit.
		const after = await t.run(async (ctx) => await ctx.db.get("files_nodes", nodeId));
		expect(after?.contentTooLargeByteSize).toBeNull();
		expect(after?.collaborationEnabled).toBe(false);
		const readBack = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/too-large.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(readBack?.content).toBe(markdown);
	});

	test("turning collaboration off keeps content and move proposals for review", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Pending Drop User",
			email: "pending-drop-user@example.com",
		});
		test_setup_r2_capture();

		const markdown = "# Pending\n\nbody\n";
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
		const contentOnlyNodeId = await test_materialize_markdown_file({
			t,
			asUser,
			db,
			path: "/pending-content.md",
			markdown,
		});
		const contentAndMoveNodeId = await test_materialize_markdown_file({
			t,
			asUser,
			db,
			path: "/pending-both.md",
			markdown,
		});

		// Seed one content-only proposal and one content-plus-move proposal. The real upsert flow
		// needs an operation batch and paged state staging; this test only cares about what the
		// toggle does to the docs it finds.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const nodeId of [contentOnlyNodeId, contentAndMoveNodeId]) {
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "saved", id: nodeId },
					revision: 1,
					pendingMove:
						nodeId === contentAndMoveNodeId
							? { destParent: { kind: "root" }, destName: "moved.md", fromPath: "/pending-both.md" }
							: undefined,
					size: 12,
					updatedAt: now,
					expiresAt: now + 4 * 60 * 60 * 1000,
				});
				const [baseStateId, stagedStateId, unstagedStateId] = await Promise.all(
					(["base", "staged", "unstaged"] as const).map((role) =>
						ctx.db.insert("files_pending_update_yjs_states", {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							userId: db.userId,
							target: { kind: "saved", id: nodeId },
							owner: { kind: "active", pendingUpdateId, role },
							lineageGeneration: 0,
							sealed: true,
							pageCount: 1,
							totalBytes: 12,
							digest: "0000000000000000",
						}),
					),
				);
				await ctx.db.patch("files_pending_updates", pendingUpdateId, {
					content: {
						base: { kind: "yjs", sequence: 1, lineageGeneration: 0 },
						baseStateId: baseStateId!,
						stagedStateId: stagedStateId!,
						unstagedStateId: unstagedStateId!,
					},
				});
				// The marker a real save leaves behind. It belongs to the document the toggle
				// deletes, so it has to go with it.
				await ctx.db.insert("files_pending_updates_last_sequence_saved", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					fileNodeId: nodeId,
					lastSequenceSaved: 12,
					updatedAt: now,
				});
			}
		});

		const pendingBefore = await t.run(async (ctx) => await ctx.db.query("files_pending_updates").collect());
		// Published fixtures leave retired states for background cleanup.
		const statesBefore = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_update_yjs_states")
				.filter((q) => q.eq(q.field("owner.kind"), "active"))
				.collect(),
		);
		for (const nodeId of [contentOnlyNodeId, contentAndMoveNodeId]) {
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
		}
		await drain_scheduled_continuations(t);

		// The toggle marks the proposal without changing its source history or review choices.
		const pendingAfter = await t.run(async (ctx) => {
			const docs = await ctx.db.query("files_pending_updates").collect();
			return {
				docs,
				states: await ctx.db
					.query("files_pending_update_yjs_states")
					.filter((q) => q.eq(q.field("owner.kind"), "active"))
					.collect(),
				lastSequenceSaved: (await ctx.db.query("files_pending_updates_last_sequence_saved").collect()).length,
			};
		});
		expect(pendingAfter.docs).toEqual(
			pendingBefore.map((doc) => ({ ...doc, revision: doc.revision + 1, contentNeedsRebase: true })),
		);
		expect(pendingAfter.states).toEqual(statesBefore);
		// A leftover marker would make the diff editor refetch forever after collaboration is
		// turned back on, because the fresh document starts counting at 0 again.
		expect(pendingAfter.lastSequenceSaved).toBe(0);
	});

	test("turning collaboration on keeps content and move proposals for review", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Pending Drop On User",
			email: "pending-drop-on-user@example.com",
		});
		const r2Writes = test_setup_r2_capture();

		const contentOnly = await seed_non_collaborative_file({
			t,
			db,
			path: "/off-content.md",
			markdown: "# Off\n\nbody\n",
		});
		const contentAndMove = await seed_non_collaborative_file({
			t,
			db,
			path: "/off-both.md",
			markdown: "# Off\n\nbody\n",
		});
		// The seed helper writes no R2 object, and the ON toggle reads the committed text from R2.
		r2Writes.set("content-snapshot/off-content.md", "# Off\n\nbody\n");
		r2Writes.set("content-snapshot/off-both.md", "# Off\n\nbody\n");

		// Seed one content-only proposal and one content-plus-move proposal the way the agent's
		// write leaves them on a file with collaboration off: an asset base, no Yjs sequence.
		await t.run(async (ctx) => {
			const now = Date.now();
			for (const { nodeId } of [contentOnly, contentAndMove]) {
				const node = await ctx.db.get("files_nodes", nodeId);
				if (!node?.assetId) throw new Error("Expected the seeded file to have a content asset");
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "saved", id: nodeId },
					revision: 1,
					pendingMove:
						nodeId === contentAndMove.nodeId
							? { destParent: { kind: "root" }, destName: "moved.md", fromPath: "/off-both.md" }
							: undefined,
					size: 12,
					updatedAt: now,
					expiresAt: now + 4 * 60 * 60 * 1000,
				});
				const [baseStateId, stagedStateId, unstagedStateId] = await Promise.all(
					(["base", "staged", "unstaged"] as const).map((role) =>
						ctx.db.insert("files_pending_update_yjs_states", {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							userId: db.userId,
							target: { kind: "saved", id: nodeId },
							owner: { kind: "active", pendingUpdateId, role },
							sealed: true,
							pageCount: 1,
							totalBytes: 12,
							digest: "0000000000000000",
						}),
					),
				);
				await ctx.db.patch("files_pending_updates", pendingUpdateId, {
					content: {
						base: { kind: "asset", assetId: node.assetId },
						baseStateId: baseStateId!,
						stagedStateId: stagedStateId!,
						unstagedStateId: unstagedStateId!,
					},
				});
			}
		});

		const pendingBefore = await t.run(async (ctx) => await ctx.db.query("files_pending_updates").collect());
		const statesBefore = await t.run(async (ctx) => await ctx.db.query("files_pending_update_yjs_states").collect());
		for (const { nodeId } of [contentOnly, contentAndMove]) {
			const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(on._nay).toBeUndefined();
		}

		// Old asset bases stay intact until Review rebuilds the proposal on the new document.
		const pendingAfter = await t.run(async (ctx) => {
			const docs = await ctx.db.query("files_pending_updates").collect();
			return {
				docs,
				states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			};
		});
		expect(pendingAfter.docs).toEqual(
			pendingBefore.map((doc) => ({ ...doc, revision: doc.revision + 1, contentNeedsRebase: true })),
		);
		expect(pendingAfter.states).toEqual(statesBefore);
	});

	test("renaming a non-collaborative file keeps the stored type", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
			email: "test@example.com",
		});
		const { nodeId: markdownNodeId } = await seed_non_collaborative_file({
			t,
			db,
			path: "/notes.md",
			markdown: "# Notes\n\nbody\n",
		});
		const { nodeId: plainNodeId } = await seed_non_collaborative_file({ t, db, path: "/data.json", markdown: "{}\n" });

		// The extension may change freely. The stored type does not follow the name, the same
		// as for a collaborative file.
		const crossed = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: markdownNodeId,
			path: "notes.json",
		});
		if (crossed._nay) {
			throw new Error(crossed._nay.message);
		}
		const crossedNode = await t.run(async (ctx) => ctx.db.get("files_nodes", markdownNodeId));
		expect(crossedNode?.path).toBe("/notes.json");
		expect(crossedNode?.contentType).toBe("text/markdown;charset=utf-8");
		expect(crossedNode?.textKind).toBe("rich_text");

		const subtypeRename = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: plainNodeId,
			path: "data.yaml",
		});
		if (subtypeRename._nay) {
			throw new Error(subtypeRename._nay.message);
		}
		const renamed = await t.run(async (ctx) => ctx.db.get("files_nodes", plainNodeId));
		expect(renamed?.path).toBe("/data.yaml");
		expect(renamed?.contentType).toBe("application/json");
		expect(renamed?.lowercaseExtension).toBe("yaml");

		// Accepting a proposed move can rename too, and it keeps the type in its own place.
		const move = await propose_move_for_test(t, {
			...db,
			nodeId: plainNodeId,
			destParent: { kind: "root" },
			destName: "data.json",
		});
		const movedBack = await test_apply_file_pending_move(asUser, {
			membershipId: db.membershipId,
			...move,
		});
		if (movedBack._nay) {
			throw new Error(movedBack._nay.message);
		}
		const movedNode = await t.run(async (ctx) => ctx.db.get("files_nodes", plainNodeId));
		expect(movedNode?.path).toBe("/data.json");
		expect(movedNode?.contentType).toBe("application/json");
	});

	test.each([false, true])(
		"snapshot replacement keeps mode-change guards (source collaboration off: %s)",
		async (sourceOff) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				external_id: db.userId,
				name: "Restore Mode Guard User",
			});
			test_setup_r2_capture();
			const text = "# Restore guard\n";
			const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/restore-mode.md", markdown: text });
			const before = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				snapshot: await ctx.db
					.query("files_snapshots")
					.filter((q) => q.eq(q.field("fileNodeId"), nodeId))
					.first(),
			}));
			if (!before.node?.assetId || !before.snapshot) {
				throw new Error("Expected a file and version");
			}
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			await drain_scheduled_continuations(t);

			if (sourceOff) {
				// A restore that started with collaboration off must not replace a new live document.
				const enabled = await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				});
				expect(enabled._nay).toBeUndefined();
			} else {
				// A restore that started collaborative keeps its asset check even after the mode changes.
				const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "# Saved after disabling collaboration\n",
				});
				expect(saved._nay).toBeUndefined();
			}
			const currentAssetId = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))?.assetId);
			const contentAssetId = await t.mutation(internal.r2.insert_asset, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(text),
				createdBy: db.userId,
			});
			const refused = await asUser.mutation(internal.files_nodes_content.finalize_snapshot_restore_replacement, {
				membershipId: db.membershipId,
				billedUserId: db.userId,
				nodeId,
				snapshotId: before.snapshot._id,
				expectedAssetId: sourceOff ? undefined : before.node.assetId,
				contentAssetId,
				contentSize: files_get_utf8_byte_size(text),
				contentType: "text/markdown;charset=utf-8",
				yjsRootKind: "rich_text",
				nonCollaborative: true,
				text,
			});
			expect(refused._nay?.message).toBe("This file changed while the snapshot was being restored. Try again.");
			expect(await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))?.assetId)).toBe(currentAssetId);
		},
	);

	test("last write wins when a snapshot restore finishes after another save", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Non-Collaborative User",
			email: "restore-non-collaborative@example.com",
		});
		const r2Objects = test_setup_r2_capture();

		const currentText = "- [x] done\n";
		const { nodeId, assetId } = await seed_non_collaborative_file({ t, db, path: "/todo.txt", markdown: currentText });
		const versionText = "- [ ] not yet\n";
		const version = await t.run(async (ctx) => {
			const versionAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(versionText),
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			const r2Key = r2_create_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: versionAssetId,
			});
			r2Objects.set(r2Key, versionText);
			await ctx.db.patch("files_r2_assets", versionAssetId, { r2Key });
			const snapshotId = await ctx.db.insert("files_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				assetId: versionAssetId,
				createdBy: db.userId,
				archivedAt: 0,
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: false,
			});
			return { assetId: versionAssetId, snapshotId };
		});
		let releaseRestorePut: (() => void) | undefined;
		const restorePutBlocked = new Promise<void>((resolve) => {
			releaseRestorePut = resolve;
		});
		let announceRestorePut: (() => void) | undefined;
		const restorePutStarted = new Promise<void>((resolve) => {
			announceRestorePut = resolve;
		});
		const capturedFetch = fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "PUT" && init.body === versionText) {
					announceRestorePut?.();
					await restorePutBlocked;
				}
				return await capturedFetch(url, init);
			}),
		);
		const restoring = asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: version.snapshotId,
			sessionId: "restore-non-collaborative",
		});
		await restorePutStarted;
		const interveningText = "- [x] another tab saved\n";
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: interveningText,
		});
		const interveningAssetId = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))?.assetId);
		releaseRestorePut?.();
		const restored = await restoring;
		expect(saved._nay).toBeUndefined();
		expect(restored._nay).toBeUndefined();

		// Collaboration stays off: a new content asset, and still no Yjs docs.
		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const versionRows = await ctx.db
				.query("files_snapshots")
				.filter((q) => q.eq(q.field("fileNodeId"), nodeId))
				.collect();
			return {
				assetId: node?.assetId,
				contentType: node?.contentType,
				textKind: node?.textKind,
				collaborationEnabled: node?.collaborationEnabled,
				yjsSnapshotId: node?.yjsSnapshotId,
				yjsLastSequenceId: node?.yjsLastSequenceId,
				versionAssetIds: versionRows.map((row) => row.assetId),
			};
		});
		expect(after).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: false,
		});
		expect(after.yjsSnapshotId).toBeNull();
		expect(after.yjsLastSequenceId).toBeNull();
		expect(after.assetId).not.toBe(assetId);
		expect(after.assetId).not.toBe(version.assetId);
		const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/todo.txt",
		});
		expect(readResult?.content).toBe(versionText);
		// The save that landed during restore remains in history with its exact text.
		expect(after.versionAssetIds).toContain(interveningAssetId);
		expect(after.versionAssetIds).toContain(after.assetId);
		const interveningAsset = interveningAssetId
			? await t.run(async (ctx) => ctx.db.get("files_r2_assets", interveningAssetId))
			: null;
		expect(interveningAsset?.r2Key ? r2Objects.get(interveningAsset.r2Key) : undefined).toBe(interveningText);
	});
});

test("file_stats stay fresh after an edit: re-materialization patches the same doc in place", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Stats Edit User",
		email: "stats-edit-user@example.com",
	});
	const r2Writes = test_setup_r2_capture();

	const markdownA = "# Stats Doc\n\nFirst paragraph alpha.\n\nSecond paragraph beta.";
	const markdownB = `${markdownA}\n\nThird paragraph gamma delta epsilon.\n\nFourth paragraph zeta eta theta iota.`;

	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/stats-edit.md",
	});

	const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: markdownA });
	if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
	const pushA = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		sessionId: "stats-edit-A",
	});
	if (pushA._nay) throw new Error(pushA._nay.message);
	const matA = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (matA._nay) throw new Error(matA._nay.message);

	const wc = (text: string) => ({
		lineCount: (text.match(/\n/gu) ?? []).length,
		wordCount: text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length,
		charCount: Array.from(text).length,
		byteCount: files_get_utf8_byte_size(text),
	});
	const statsArgs = {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/stats-edit.md",
	};

	const committedA = await test_read_committed_markdown({ t, nodeId, r2Writes });
	if (committedA === undefined) throw new Error("Expected committed A");
	const statsA = await asUser.query(internal.files_nodes.read_committed_file_chunk_stats, statsArgs);
	expect(statsA.usable).toBe(true);
	if (!statsA.usable) throw new Error("expected usable A");
	expect({
		lineCount: statsA.lineCount,
		wordCount: statsA.wordCount,
		charCount: statsA.charCount,
		byteCount: statsA.byteCount,
	}).toEqual(wc(committedA));
	const statsDocIdA = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))?.statsId ?? null);
	expect(statsDocIdA).not.toBeNull();

	// Edit: transform the live Yjs doc to B and push only the incremental diff, then re-materialize.
	const svA = encodeStateVector(yjsDoc);
	const updated = files_yjs_doc_update_from_text({ rootKind: "rich_text", text: markdownB, mut_yjsDoc: yjsDoc });
	if (updated._nay) throw new Error(updated._nay.message);
	const pushB = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc, svA)),
		sessionId: "stats-edit-B",
	});
	yjsDoc.destroy();
	if (pushB._nay) throw new Error(pushB._nay.message);
	const matB = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId,
		userId: db.userId,
		targetSequence: 2,
	});
	if (matB._nay) throw new Error(matB._nay.message);

	const committedB = await test_read_committed_markdown({ t, nodeId, r2Writes });
	if (committedB === undefined) throw new Error("Expected committed B");
	// The edit really changed the content — otherwise the freshness guarantee is not exercised.
	expect(committedB.length).toBeGreaterThan(committedA.length);
	const statsB = await asUser.query(internal.files_nodes.read_committed_file_chunk_stats, statsArgs);
	expect(statsB.usable).toBe(true);
	if (!statsB.usable) throw new Error("expected usable B");
	expect({
		lineCount: statsB.lineCount,
		wordCount: statsB.wordCount,
		charCount: statsB.charCount,
		byteCount: statsB.byteCount,
	}).toEqual(wc(committedB));
	expect(statsB.lineCount).toBeGreaterThan(statsA.lineCount);

	// The same stats doc was patched in place (back-ref unchanged) — no duplicate doc was inserted.
	const statsDocIdB = await t.run(async (ctx) => (await ctx.db.get("files_nodes", nodeId))?.statsId ?? null);
	expect(statsDocIdB).toBe(statsDocIdA);
	const statsDocCount = await t.run(
		async (ctx) =>
			(
				await ctx.db
					.query("file_stats")
					.withIndex("by_organization_workspace_fileNode", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect()
			).length,
	);
	expect(statsDocCount).toBe(1);
});

test("create_file_snapshot_content_url returns a signed R2 URL without fetching snapshot Markdown", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Snapshot R2 User",
	});
	const snapshotMarkdown = "# R2 snapshot\n\nStored outside Convex.";
	const getUrlSpy = vi
		.spyOn(R2.prototype, "getUrl")
		.mockImplementation(async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`);

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "snapshot-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;
	const { snapshotId } = await t.run(async (ctx) => {
		const r2Key = `content/organizations/${db.organizationId}/workspaces/${db.workspaceId}/nodes/${nodeId}/versions/42/markdown`;
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			r2Key,
			size: files_get_utf8_byte_size(snapshotMarkdown),
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			assetId,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
			createdBy: db.userId,
			archivedAt: 0,
		});

		return { snapshotId };
	});

	const fetchSpy = vi.fn(async () => {
		throw new Error("create_file_snapshot_content_url should not fetch from R2");
	});
	vi.stubGlobal("fetch", fetchSpy);

	const contentUrl = await asUser.action(api.files_nodes.create_file_snapshot_content_url, {
		membershipId: db.membershipId,
		nodeId,
		snapshotId,
	});
	expect(contentUrl).toMatchObject({
		url: `https://r2.test/object?key=${encodeURIComponent(
			`content/organizations/${db.organizationId}/workspaces/${db.workspaceId}/nodes/${nodeId}/versions/42/markdown`,
		)}`,
		snapshotId,
	});
	// The signer pins the served type from the version's stored type and the disposition from
	// the authorized node name. A presigned R2 GET carries no nosniff/CSP, so the pin is the
	// whole defense. Editable text never serves inline.
	expect(getUrlSpy).toHaveBeenCalledWith(
		`content/organizations/${db.organizationId}/workspaces/${db.workspaceId}/nodes/${nodeId}/versions/42/markdown`,
		{
			expiresIn: 15 * 60,
			responseContentType: "text/markdown;charset=utf-8",
			responseContentDisposition: "attachment; filename*=UTF-8''snapshot-r2.md",
		},
	);
	expect(fetchSpy).not.toHaveBeenCalled();
});

test("create_file_snapshot_content_url fails when a snapshot asset has no R2 key", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Missing Snapshot R2 User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "missing-snapshot-r2.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}
	const nodeId = createdFile._yay.nodeId;
	const { snapshotId } = await t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: 1,
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			assetId,
			createdBy: db.userId,
			archivedAt: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});

		return { snapshotId };
	});

	await expect(
		asUser.action(api.files_nodes.create_file_snapshot_content_url, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
		}),
	).rejects.toThrow("snapshot.assetId points to an asset without r2Key");
});

test("restore_snapshot_r2 restores from R2-backed content without Convex Markdown bodies", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Restore R2 User",
		email: "restore-r2-user@example.com",
	});
	const r2Objects = test_setup_r2_capture();

	const createdFileId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/restore-r2.md",
	});
	const currentMarkdown = "# Current\n\nBefore restore.\n";
	const currentYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: currentMarkdown });
	if ("_nay" in currentYjsDoc) {
		throw new Error(currentYjsDoc._nay.message);
	}
	const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId: createdFileId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFileId)).yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(currentYjsDoc)),
		sessionId: "restore-r2-current",
	});
	currentYjsDoc.destroy();
	if (pushResult._nay) {
		throw new Error(pushResult._nay.message);
	}
	const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		nodeId: createdFileId,
		userId: db.userId,
		targetSequence: 1,
	});
	if (materialized._nay) {
		throw new Error(materialized._nay.message);
	}

	const restoredMarkdown = "# Restored\n\nFrom R2 snapshot.\n";
	const { snapshotId } = await t.run(async (ctx) => {
		const snapshotAssetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			size: files_get_utf8_byte_size(restoredMarkdown),
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		const snapshotR2Key = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${snapshotAssetId}`;
		r2Objects.set(snapshotR2Key, restoredMarkdown);
		await ctx.db.patch("files_r2_assets", snapshotAssetId, { r2Key: snapshotR2Key });
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: createdFileId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});

		return { snapshotId };
	});

	const restoreResult = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
		membershipId: db.membershipId,
		nodeId: createdFileId,
		snapshotId,
		sessionId: "restore-r2-session",
	});
	if (restoreResult._nay) {
		throw new Error(restoreResult._nay.message);
	}

	const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/restore-r2.md",
	});
	expect(readResult?.content).toBe(restoredMarkdown);
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFileId);
		if (!fileNode?.assetId) {
			throw new Error("Expected restored node docs");
		}
		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);

		return { asset, contentByteSize: fileNode.contentByteSize };
	});
	expect(saved.asset?.size).toBe(files_get_utf8_byte_size(restoredMarkdown));
	// The node points at the restored snapshot, so its byte size must follow it.
	expect(saved.contentByteSize).toBe(saved.asset?.size);
	// The node now points at a version snapshot with the restored bytes. The backup snapshot
	// still holds the previous version.
	expect(saved.asset?.kind).toBe("content_snapshot");
	expect(r2Objects.get(saved.asset?.r2Key ?? "")).toBe(restoredMarkdown);
	expect(Array.from(r2Objects.values())).toContain(currentMarkdown);
	expect(Array.from(r2Objects.values())).toContain(restoredMarkdown);
});

describe("restore_snapshot_r2 whole-file restore", () => {
	// A version doc that recorded the type, shape, and collaboration mode of its content.
	async function seed_version(args: {
		t: ReturnType<typeof test_convex>;
		r2Objects: Map<string, BodyInit>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		version: {
			nodeId: Id<"files_nodes">;
			body: string;
			kind: "content" | "content_snapshot";
			contentType: string;
			yjsRootKind: "rich_text" | "plain_text" | null;
			collaborationEnabled: boolean;
		};
	}) {
		const { t, r2Objects, db, version } = args;

		return await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: version.kind,
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(version.body),
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			const r2Key = r2_create_asset_key({ organizationId: db.organizationId, workspaceId: db.workspaceId, assetId });
			r2Objects.set(r2Key, version.body);
			await ctx.db.patch("files_r2_assets", assetId, { r2Key });
			const snapshotId = await ctx.db.insert("files_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: version.nodeId,
				assetId,
				createdBy: db.userId,
				archivedAt: 0,
				contentType: version.contentType,
				yjsRootKind: version.yjsRootKind,
				collaborationEnabled: version.collaborationEnabled,
			});
			return { assetId, r2Key, snapshotId };
		});
	}

	async function read_versions(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
		return await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("files_snapshots")
				.filter((q) => q.eq(q.field("fileNodeId"), nodeId))
				.collect();
			return await Promise.all(
				rows.map(async (row) => {
					const asset = await ctx.db.get("files_r2_assets", row.assetId);
					return {
						assetId: row.assetId,
						r2Key: asset?.r2Key,
						contentType: row.contentType,
						yjsRootKind: row.yjsRootKind,
						collaborationEnabled: row.collaborationEnabled,
					};
				}),
			);
		});
	}

	// Push a fresh document built from `text` as one more update, and leave it unmaterialized.
	async function push_unsaved_edit(args: {
		t: ReturnType<typeof test_convex>;
		asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		nodeId: Id<"files_nodes">;
		text: string;
	}) {
		const { t, asUser, db, nodeId, text } = args;

		const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text });
		if ("_nay" in yjsDoc) {
			throw new Error(yjsDoc._nay.message);
		}
		const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
			sessionId: "restore-unsaved-edit",
		});
		yjsDoc.destroy();
		if (pushResult._nay) {
			throw new Error(pushResult._nay.message);
		}
	}

	test("a plain text version of a Markdown file comes back as plain text, and the current text stays a version", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Shape User",
			email: "restore-shape-user@example.com",
		});
		const r2Objects = test_setup_r2_capture();

		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/notes.md",
		});
		const currentMarkdown = "# Current\n\nStill Markdown.\n";
		const currentYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: currentMarkdown });
		if ("_nay" in currentYjsDoc) {
			throw new Error(currentYjsDoc._nay.message);
		}
		const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(currentYjsDoc)),
			sessionId: "restore-shape-current",
		});
		currentYjsDoc.destroy();
		if (pushResult._nay) {
			throw new Error(pushResult._nay.message);
		}
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 1,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}
		const before = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const lastSequence = node?.yjsLastSequenceId
				? await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId)
				: null;
			return {
				assetId: node?.assetId,
				yjsSnapshotId: node?.yjsSnapshotId,
				generation: lastSequence?.lineageGeneration,
			};
		});

		const versionText = "plain version\nline two\n";
		const version = await seed_version({
			t,
			r2Objects,
			db,
			version: {
				nodeId,
				body: versionText,
				kind: "content_snapshot",
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: true,
			},
		});

		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: version.snapshotId,
			sessionId: "restore-shape-session",
		});
		expect(restored._nay).toBeUndefined();

		// The file is a plain text document now, on a rotated lineage of the same snapshot doc.
		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const lastSequence = node?.yjsLastSequenceId
				? await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId)
				: null;
			return {
				assetId: node?.assetId,
				contentType: node?.contentType,
				textKind: node?.textKind,
				collaborationEnabled: node?.collaborationEnabled,
				yjsSnapshotId: node?.yjsSnapshotId,
				generation: lastSequence?.lineageGeneration,
			};
		});
		expect(after).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
			yjsSnapshotId: before.yjsSnapshotId,
			generation: (before.generation ?? 0) + 1,
		});
		expect(after.collaborationEnabled).toBe(true);
		expect(after.assetId).not.toBe(before.assetId);
		// The replacement points the node at the restored bytes, so its byte size must follow them.
		const restoredSize = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			return { contentByteSize: node?.contentByteSize, assetSize: asset?.size };
		});
		expect(restoredSize.assetSize).toBe(files_get_utf8_byte_size(versionText));
		expect(restoredSize.contentByteSize).toBe(restoredSize.assetSize);
		const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/notes.md",
		});
		expect(readResult?.content).toBe(versionText);

		// History keeps both sides with their own type. The Markdown that was current already is
		// the row its materialization stored, so the restore adds no second row with the same text.
		const versions = await read_versions(t, nodeId);
		const markdownRows = versions.filter(
			(row) => row.r2Key !== undefined && r2Objects.get(row.r2Key) === currentMarkdown,
		);
		expect(markdownRows).toHaveLength(1);
		expect(markdownRows[0]).toMatchObject({
			assetId: before.assetId,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
		});
		expect(versions.find((row) => row.assetId === after.assetId)).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			yjsRootKind: "plain_text",
		});
	});

	test("an edit the materializer has not saved yet becomes a version before the restore", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Unsaved User",
			email: "restore-unsaved-user@example.com",
		});
		const r2Objects = test_setup_r2_capture();
		const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/notes.md", markdown: "# Saved\n" });
		await push_unsaved_edit({ t, asUser, db, nodeId, text: "# Unsaved edit" });
		const version = await seed_version({
			t,
			r2Objects,
			db,
			version: {
				nodeId,
				body: "plain version\n",
				kind: "content_snapshot",
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: true,
			},
		});

		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: version.snapshotId,
			sessionId: "restore-unsaved-session",
		});
		expect(restored._nay).toBeUndefined();

		// The edit lived only in the document. It is a Markdown version now, under the restored text.
		const versions = await read_versions(t, nodeId);
		const backup = versions.find(
			(row) => row.r2Key !== undefined && String(r2Objects.get(row.r2Key)).includes("Unsaved edit"),
		);
		expect(backup).toMatchObject({ contentType: "text/markdown;charset=utf-8", yjsRootKind: "rich_text" });
		const readResult = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/notes.md",
		});
		expect(readResult?.content).toBe("plain version\n");
	});

	test.each(["saved", "edited"])(
		"a refused restore keeps live edits and cleans up uploads (%s file)",
		async (state) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				external_id: db.userId,
				name: "Restore Race User",
				email: "restore-race-user@example.com",
			});
			const r2Objects = test_setup_r2_capture();
			const nodeId = await test_materialize_markdown_file({ t, asUser, db, path: "/notes.md", markdown: "# Saved\n" });
			if (state === "edited") {
				await push_unsaved_edit({ t, asUser, db, nodeId, text: "# Earlier unsaved edit" });
				// Leave time between edits so the public edit rate limit can refill.
				vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
			}
			const version = await seed_version({
				t,
				r2Objects,
				db,
				version: {
					nodeId,
					body: "plain version\n",
					kind: "content_snapshot",
					contentType: "text/plain;charset=utf-8",
					yjsRootKind: "plain_text",
					collaborationEnabled: true,
				},
			});

			const versionsBefore = await read_versions(t, nodeId);
			const assetsBefore = await t.run(async (ctx) => ctx.db.query("files_r2_assets").collect());
			const keysBefore = new Set(r2Objects.keys());

			// Edit while the version downloads, after any backup upload has finished.
			const fetchMock = vi.mocked(globalThis.fetch);
			const baseFetch = fetchMock.getMockImplementation();
			if (baseFetch == null) {
				throw new Error("expected the fetch stub to have an implementation");
			}
			let raced = false;
			fetchMock.mockImplementation(async (input, init) => {
				const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (!raced && href === `https://r2.test/object?key=${encodeURIComponent(version.r2Key)}`) {
					raced = true;
					await push_unsaved_edit({ t, asUser, db, nodeId, text: "# Edit during restore" });
				}
				return await baseFetch(input, init);
			});
			const refused = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: version.snapshotId,
				sessionId: "restore-race-session",
			});
			fetchMock.mockImplementation(baseFetch);
			expect(raced).toBe(true);
			expect(refused._nay?.message).toBe("This file changed while the snapshot was being restored. Try again.");

			const liveContent = await asUser.action(
				internal.files_nodes_content.get_file_last_available_text_content_by_path,
				{
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					path: "/notes.md",
				},
			);
			expect(liveContent?.content).toContain("Edit during restore");
			if (state === "edited") {
				expect(liveContent?.content).toContain("Earlier unsaved edit");
			}
			expect(await read_versions(t, nodeId)).toEqual(versionsBefore);

			// Only the refused restore's uploads should be queued for deletion.
			const uploadedKeys = Array.from(r2Objects.keys()).filter((key) => !keysBefore.has(key));
			expect(uploadedKeys.length).toBeGreaterThan(0);
			const cleanupJobs = (await read_deletion_jobs(t)).filter((job) => job.reason === "failed_create");
			expect(cleanupJobs.map((job) => job.r2Key).sort()).toEqual(uploadedKeys.sort());
			expect(await t.run(async (ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assetsBefore);

			// The next restore reads the document again, so the edit becomes a version.
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: version.snapshotId,
				sessionId: "restore-race-session-2",
			});
			expect(restored._nay).toBeUndefined();
			const versions = await read_versions(t, nodeId);
			const backup = versions.find(
				(version) =>
					version.r2Key !== undefined && String(r2Objects.get(version.r2Key)).includes("Edit during restore"),
			);
			expect(backup).toMatchObject({ contentType: "text/markdown;charset=utf-8", yjsRootKind: "rich_text" });
			const readResult = await asUser.action(
				internal.files_nodes_content.get_file_last_available_text_content_by_path,
				{
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					path: "/notes.md",
				},
			);
			expect(readResult?.content).toBe("plain version\n");
		},
	);

	test.each(["Free", "Pro"] as const)("a stored version of a stored file requires a paid plan: %s", async (plan) => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		if (plan === "Free") await t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Stored User",
			email: "restore-stored-user@example.com",
		});
		const r2Objects = test_setup_r2_capture();
		const copyCalls: Array<{ sourceKey: string; destinationKey: string }> = [];
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, copyArgs) => {
			copyCalls.push({ sourceKey: copyArgs.sourceKey, destinationKey: copyArgs.destinationKey });
			const body = r2Objects.get(copyArgs.sourceKey);
			if (body === undefined) {
				return { outcome: "source_missing" as const };
			}
			r2Objects.set(copyArgs.destinationKey, body);
			return { outcome: "copied" as const, size: files_get_utf8_byte_size(String(body)), etag: "etag_copy" };
		});

		// A stored PDF whose earlier content was a PNG.
		const pdfBytes = "%PDF-current";
		const { nodeId, assetId: pdfAssetId } = await t.run(async (ctx) => {
			const now = Date.now();
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(pdfBytes),
				createdBy: db.userId,
				updatedAt: now,
			});
			const r2Key = r2_create_asset_key({ organizationId: db.organizationId, workspaceId: db.workspaceId, assetId });
			r2Objects.set(r2Key, pdfBytes);
			await ctx.db.patch("files_r2_assets", assetId, { r2Key });
			const nodeId = await ctx.db.insert("files_nodes", {
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
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: files_ROOT_ID,
				path: "/scan.pdf",
				treePath: "/scan.pdf",
				pathDepth: 1,
				lowercaseExtension: "pdf",
				name: "scan.pdf",
				sortName: files_sort_text_key("scan.pdf"),
				kind: "file",
				contentType: "application/pdf",
				assetId,
				contentByteSize: null,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
				newChildWritePolicy: null,
			});
			return { nodeId, assetId };
		});
		const pngBytes = "PNG-old-bytes";
		const version = await seed_version({
			t,
			r2Objects,
			db,
			version: {
				nodeId,
				body: pngBytes,
				kind: "content",
				contentType: "image/png",
				yjsRootKind: null,
				collaborationEnabled: false,
			},
		});

		const before = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			assets: await ctx.db.query("files_r2_assets").collect(),
			quotas: await ctx.db.query("quotas").collect(),
		}));
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: version.snapshotId,
			sessionId: "restore-stored-session",
		});
		if (plan === "Free") {
			expect(restored._nay).toMatchObject({ name: "plan_required" });
			expect(copyCalls).toEqual([]);
			expect(
				await t.run(async (ctx) => ({
					node: await ctx.db.get("files_nodes", nodeId),
					assets: await ctx.db.query("files_r2_assets").collect(),
					quotas: await ctx.db.query("quotas").collect(),
				})),
			).toEqual(before);
			return;
		}
		expect(restored._nay).toBeUndefined();

		// The bytes were copied on the R2 side into a new asset, and the file is a PNG again.
		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			return { assetId: node?.assetId, contentType: node?.contentType, textKind: node?.textKind, asset };
		});
		expect(after.contentType).toBe("image/png");
		expect(after.textKind).toBeNull();
		expect(after.assetId).not.toBe(pdfAssetId);
		expect(after.assetId).not.toBe(version.assetId);
		expect(copyCalls).toEqual([{ sourceKey: version.r2Key, destinationKey: after.asset?.r2Key }]);
		expect(after.asset).toMatchObject({ kind: "content", size: files_get_utf8_byte_size(pngBytes) });
		expect(after.asset?.unfinalizedExpiresAt).toBeUndefined();
		expect(r2Objects.get(after.asset?.r2Key ?? "")).toBe(pngBytes);

		// The PDF had no version row yet, so it got one with its own type.
		const versions = await read_versions(t, nodeId);
		const pdfVersion = versions.find((row) => row.assetId === pdfAssetId);
		expect(pdfVersion?.contentType).toBe("application/pdf");
		expect(pdfVersion?.yjsRootKind).toBeNull();
		expect(pdfVersion?.collaborationEnabled).toBe(false);
		expect(versions.find((row) => row.assetId === after.assetId)).toMatchObject({
			contentType: "image/png",
			yjsRootKind: null,
			collaborationEnabled: false,
		});
	});
});

test("yjs_push_update enforces per-user rate limit and leaves DB untouched on rejection", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Rate Limit User",
		email: "rate-limit-user@example.com",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rate-limit.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected owner to create rate-limit file");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFile._yay.nodeId)).yjsLastSequenceId,
		// Door 1 refuses zero-byte payloads, so use the legal two-byte v1 no-op as the cheap push.
		update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
		sessionId: "rate-limit-session",
	};

	for (let i = 0; i < 2; i++) {
		const result = await asUser.mutation(api.files_nodes.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected initial push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asUser.mutation(api.files_nodes.yjs_push_update, pushArgs);
	if (!blocked._nay) {
		throw new Error("Expected third push to be rate limited");
	}
	expect(blocked._nay.message).toBe("Rate limit exceeded");

	const otherDb = await t.run(async (ctx) => {
		const otherUserId = await ctx.db.insert("users", {
			clerkUserId: null,
		});

		return await test_mocks_fill_db_with.membership(ctx, {
			userId: otherUserId,
			organizationName: "yjs-rl-ws",
			workspaceName: "yjs-rl-prj",
		});
	});
	const blockedBeforeMembership = await asUser.mutation(api.files_nodes.yjs_push_update, {
		...pushArgs,
		membershipId: otherDb.membershipId,
		sessionId: "rate-limit-before-membership",
	});
	expect(blockedBeforeMembership._nay?.message).toBe("Rate limit exceeded");

	const stateAfterBlock = await t.run(async (ctx) => {
		const updates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.collect();
		const lastSequence = await ctx.db
			.query("files_yjs_docs_last_sequences")
			.withIndex("by_organization_workspace_fileNode", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.first();
		return {
			updateCount: updates.length,
			lastSequence: lastSequence?.lastSequence ?? null,
			createdByList: updates.map((update) => update.createdBy),
		};
	});
	expect(stateAfterBlock.updateCount).toBe(2);
	expect(stateAfterBlock.lastSequence).toBe(2);
	expect(stateAfterBlock.createdByList).toEqual([db.userId, db.userId]);
});

test("yjs_push_update rate limit applies to anonymous JWT identities", async () => {
	const t = test_convex();
	const anonymousUserId = await t.run(async (ctx) =>
		ctx.db.insert("users", {
			clerkUserId: null,
		}),
	);
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, anonymousUserId));
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx, { userId: anonymousUserId }));
	const asAnonymous = t.withIdentity({
		issuer: process.env.VITE_CONVEX_HTTP_URL!,
		subject: anonymousUserId,
		name: "Anonymous User",
	});

	const createdFile = await asAnonymous.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rate-limit-anonymous.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected anonymous user to create rate-limit file");
	}

	const pushArgs = {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFile._yay.nodeId)).yjsLastSequenceId,
		// Door 1 refuses zero-byte payloads, so use the legal two-byte v1 no-op as the cheap push.
		update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
		sessionId: "rate-limit-anonymous-session",
	};

	for (let i = 0; i < 2; i++) {
		const result = await asAnonymous.mutation(api.files_nodes.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected anonymous push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asAnonymous.mutation(api.files_nodes.yjs_push_update, pushArgs);
	if (!blocked._nay) {
		throw new Error("Expected anonymous third push to be rate limited");
	}
	expect(blocked._nay.message).toBe("Rate limit exceeded");
});

test("restore_snapshot blocks Free users without enough credits before writing", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Restore Credits User",
		email: "restore-credits-user@example.com",
	});

	const createdFileId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/restore-credit.md",
	});

	const restoredMarkdown = "# restored content\n";
	const restoreAssets = await t.run(async (ctx) => {
		const usageSnapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", db.userId))
			.unique();
		if (!usageSnapshot?.meter) {
			throw new Error("Expected seeded billing snapshot");
		}
		await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
			meter: {
				...usageSnapshot.meter,
				balance: 0,
			},
		});

		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/restore-credit-snapshot`,
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: createdFileId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});

		return { snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});

	const restoreResult = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFileId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFileId)).yjsLastSequenceId,
		expectedLastSequence: 0,
		snapshotId: restoreAssets.snapshotId,
		sessionId: "restore-credit-test",
		snapshotMarkdownContent: restoredMarkdown,
		currentSnapshotAssetId: restoreAssets.currentSnapshotAssetId,
		currentSnapshotSize: 0,
		restoredSnapshotAssetId: restoreAssets.restoredSnapshotAssetId,
		restoredSnapshotSize: files_get_utf8_byte_size(restoredMarkdown),
	});
	expect(restoreResult._nay?.message).toBe("Insufficient funds");

	const yjsUpdates = await t.run((ctx) =>
		ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", createdFileId),
			)
			.collect(),
	);
	expect(yjsUpdates).toHaveLength(0);
});

test("/api/files/contextual-prompt returns 429 before body validation and model work", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => {
		await seed_billing_snapshot_for_user(ctx, db.userId);
		const usageSnapshot = await ctx.db
			.query("billing_usage_snapshots")
			.withIndex("by_user", (q) => q.eq("userId", db.userId))
			.unique();
		if (!usageSnapshot?.meter) {
			throw new Error("Expected seeded billing snapshot");
		}
		await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
			meter: {
				...usageSnapshot.meter,
				balance: 0,
			},
		});
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Inline AI Rate User",
		email: "inline-ai-rate-user@example.com",
	});

	for (let i = 0; i < 1; i++) {
		const response = await asUser.fetch("/api/files/contextual-prompt", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prompt: "Continue this sentence",
				membershipId: db.membershipId,
			}),
		});
		expect(response.status).toBe(402);
	}

	const blocked = await asUser.fetch("/api/files/contextual-prompt", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: "not json",
	});
	const blockedBody = await blocked.json();

	expect(blocked.status).toBe(429);
	expect(blockedBody.message).toBe("Rate limit exceeded");
	expect(typeof blockedBody.retryAfterMs).toBe("number");
});

test("/api/files/contextual-prompt bills every provider request through its own receipt", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	await t.run(async (ctx) => {
		await ctx.db.patch("users", db.userId, { clerkUserId: "clerk-inline-ai-billing-user" });
		await seed_billing_snapshot_for_user(ctx, db.userId);
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Inline AI Billing User",
		email: "inline-ai-billing-user@example.com",
	});
	const usage = {
		inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
		outputTokens: { total: 20, text: 20, reasoning: undefined },
	};
	// Keep the SDK and the receipt middleware real. Only the provider model is fake.
	inlineAiProvider.model = new MockLanguageModelV3({
		doGenerate: async () => ({
			content: [{ type: "text", text: "Generated text" }],
			finishReason: { unified: "stop", raw: undefined },
			usage,
			warnings: [],
		}),
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					controller.enqueue({ type: "text-start", id: "text" });
					controller.enqueue({ type: "text-delta", id: "text", delta: "Generated text" });
					controller.enqueue({ type: "text-end", id: "text" });
					controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage });
					controller.close();
				},
			}),
		}),
	});
	const actualAi = await vi.importActual<typeof import("ai")>("ai");
	generateTextMock.mockImplementation(actualAi.generateText);
	streamTextMock.mockImplementation(actualAi.streamText);
	const requestBody = JSON.stringify({
		prompt: "Improve this text",
		context: {
			beforeSelection: "Before",
			selection: "Selected",
			afterSelection: "After",
		},
		membershipId: db.membershipId,
	});
	const streamRequestBody = JSON.stringify({
		prompt: "Continue this text",
		membershipId: db.membershipId,
	});

	// The same body twice per path: a repeated client request is still a new provider request.
	for (const body of [requestBody, requestBody, streamRequestBody, streamRequestBody]) {
		await t.mutation(components.rate_limiter.lib.resetRateLimit, {
			name: "ai_inline_http",
			key: db.userId,
		});
		const response = await asUser.fetch("/api/files/contextual-prompt", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body,
		});
		expect(response.status).toBe(200);
		await response.text();
	}

	const receipts = await t.run((ctx) => ctx.db.query("ai_model_call_receipts").collect());
	expect(receipts).toHaveLength(4);
	for (const receipt of receipts) {
		expect(receipt).toMatchObject({
			purpose: "inline_ai",
			modelId: "gpt-6-luna",
			threadId: null,
			billedUserId: db.userId,
			actorUserId: db.userId,
			usage: { state: "reported", inputTokens: 100, outputTokens: 20 },
			tokens: { state: "queued" },
		});
	}
	const usageEvents = enqueueActionSpy.mock.calls.map((call) => {
		const args = call[2] as {
			events: Array<{
				externalId: string;
				metadata: { modelCallId: string; purpose: string };
			}>;
		};
		return args.events[0]!;
	});
	expect(usageEvents.map((event) => event.externalId)).toEqual(
		receipts.map(
			(receipt) =>
				`ai_model_call::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::${receipt.modelCallId}`,
		),
	);
	expect(new Set(receipts.map((receipt) => receipt.modelCallId)).size).toBe(4);
	expect(usageEvents.map((event) => event.metadata.purpose)).toEqual(Array(4).fill("inline_ai"));
});

test("restore_snapshot emits file_save usage for the restored Yjs sequence", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId: "clerk-restore-billing-user",
		});
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
	await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Restore Billing User",
		email: "restore-billing-user@example.com",
	});

	const createdFileId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/restore-billing.md",
	});

	const restoredMarkdown = "# restored content\n";
	const restoreAssets = await t.run(async (ctx) => {
		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/restore-billing-snapshot`,
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: files_get_utf8_byte_size(restoredMarkdown),
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: createdFileId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});

		return { snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});

	// The restore update travels through a trusted stage now; the mutation carries only its id.
	const restoreStage = await t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		nodeId: createdFileId,
		kind: "snapshot_restore",
		update: files_u8_to_array_buffer(
			encodeStateAsUpdate(
				(() => {
					const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: restoredMarkdown });
					if ("_nay" in yjsDoc) {
						throw new Error("Expected restored markdown to produce a Yjs doc");
					}

					return yjsDoc;
				})(),
			),
		),
	});
	if (restoreStage._nay) {
		throw new Error(restoreStage._nay.message);
	}
	const restoreResult = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
		membershipId: db.membershipId,
		nodeId: createdFileId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFileId)).yjsLastSequenceId,
		expectedLastSequence: 0,
		snapshotId: restoreAssets.snapshotId,
		sessionId: "restore-billing-test",
		snapshotMarkdownContent: restoredMarkdown,
		currentSnapshotAssetId: restoreAssets.currentSnapshotAssetId,
		currentSnapshotSize: 0,
		restoredSnapshotAssetId: restoreAssets.restoredSnapshotAssetId,
		restoredSnapshotSize: files_get_utf8_byte_size(restoredMarkdown),
		restoreUpdateStageId: restoreStage._yay.stageId,
	});
	if (restoreResult._nay) {
		throw new Error(`Expected restore to succeed, got: ${restoreResult._nay.message}`);
	}

	const { asset, yjsUpdates } = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFileId);
		const asset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
		return {
			asset,
			yjsUpdates: await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", createdFileId),
				)
				.collect(),
		};
	});
	expect(yjsUpdates).toHaveLength(1);
	// The restore points the node at the restored version snapshot.
	expect(asset?._id).toBe(restoreAssets.restoredSnapshotAssetId);
	expect(asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(restoredMarkdown),
	});
	const restoredVersion = `${(await test_get_file_yjs_pointers(t, createdFileId)).yjsLastSequenceId}:${yjsUpdates[0]?.sequence}`;
	await test_drain_billing_usage_event_outbox(t);
	// The create save and the restore go to Polar in one outbox batch.
	expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
		events: expect.arrayContaining([
			expect.objectContaining({
				name: "file_save",
				externalCustomerId: db.userId,
				externalId: `file_save::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::${createdFileId}::${restoredVersion}`,
				metadata: expect.objectContaining({
					amount: 1,
					actorUserId: db.userId,
					billedUserId: db.userId,
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId: createdFileId,
					version: restoredVersion,
				}),
			}),
		]),
	});
});

describe("files_nodes.cleanup_old_snapshots", () => {
	test("keeps newest hourly daily and weekly buckets and deletes pruned R2 assets", async () => {
		vi.useFakeTimers();
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		try {
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const nodeId = await t.run(async (ctx) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: files_ROOT_ID,
					name: "retention.md",
					kind: "file",
					path: "/retention.md",
					treePath: "/retention.md",
				}),
			);
			const insertSnapshot = async (label: string, timestamp: string) => {
				vi.setSystemTime(new Date(timestamp));
				return await t.run(async (ctx) => {
					const r2Key = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${label}`;
					const assetId = await ctx.db.insert("files_r2_assets", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						kind: "content_snapshot",
						r2Bucket: "test-bucket",
						r2Key,
						size: label.length,
						createdBy: db.userId,
						updatedAt: Date.now(),
					});
					const snapshotId = await ctx.db.insert("files_snapshots", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: nodeId,
						assetId,
						createdBy: db.userId,
						archivedAt: -1,
						contentType: "text/markdown;charset=utf-8",
						yjsRootKind: "rich_text",
						collaborationEnabled: true,
					});

					return { snapshotId, assetId, r2Key };
				});
			};
			const outsideScanWindowKept = await insertSnapshot("outside-scan-window-kept", "2025-12-01T12:00:00.000Z");
			const weeklyDeleted = await insertSnapshot("weekly-deleted", "2026-01-28T12:00:00.000Z");
			const weeklyKept = await insertSnapshot("weekly-kept", "2026-01-30T12:00:00.000Z");
			const dailyDeleted = await insertSnapshot("daily-deleted", "2026-02-20T08:00:00.000Z");
			const dailyKept = await insertSnapshot("daily-kept", "2026-02-20T18:00:00.000Z");
			const hourlyDeleted = await insertSnapshot("hourly-deleted", "2026-03-05T12:10:00.000Z");
			const hourlyKept = await insertSnapshot("hourly-kept", "2026-03-05T12:50:00.000Z");
			const recentKept = await insertSnapshot("recent-kept", "2026-03-09T12:00:00.000Z");

			vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));
			await t.run((ctx) => ctx.runMutation(internal.files_nodes.cleanup_old_snapshots, {}));

			const remaining = await t.run(async (ctx) => {
				const [snapshots, outsideScanWindowAsset, deletedWeeklyAsset, deletedDailyAsset, deletedHourlyAsset] =
					await Promise.all([
						ctx.db
							.query("files_snapshots")
							.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
								q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
							)
							.collect(),
						ctx.db.get("files_r2_assets", outsideScanWindowKept.assetId),
						ctx.db.get("files_r2_assets", weeklyDeleted.assetId),
						ctx.db.get("files_r2_assets", dailyDeleted.assetId),
						ctx.db.get("files_r2_assets", hourlyDeleted.assetId),
					]);

				return {
					snapshotIds: snapshots.map((snapshot) => snapshot._id),
					outsideScanWindowAsset,
					deletedWeeklyAsset,
					deletedDailyAsset,
					deletedHourlyAsset,
				};
			});

			expect(remaining.snapshotIds).toEqual(
				expect.arrayContaining([
					outsideScanWindowKept.snapshotId,
					weeklyKept.snapshotId,
					dailyKept.snapshotId,
					hourlyKept.snapshotId,
					recentKept.snapshotId,
				]),
			);
			expect(remaining.snapshotIds).not.toContain(weeklyDeleted.snapshotId);
			expect(remaining.snapshotIds).not.toContain(dailyDeleted.snapshotId);
			expect(remaining.snapshotIds).not.toContain(hourlyDeleted.snapshotId);
			expect(remaining.outsideScanWindowAsset?._id).toBe(outsideScanWindowKept.assetId);
			expect(remaining.deletedWeeklyAsset).toBeNull();
			expect(remaining.deletedDailyAsset).toBeNull();
			expect(remaining.deletedHourlyAsset).toBeNull();
			expect(deleteObjectSpy).not.toHaveBeenCalledWith(expect.anything(), outsideScanWindowKept.r2Key);
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), weeklyDeleted.r2Key);
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), dailyDeleted.r2Key);
			expect(deleteObjectSpy).toHaveBeenCalledWith(expect.anything(), hourlyDeleted.r2Key);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("external/system mount text materialization (Phase D)", () => {
	// Capture R2 PUT bodies by key so we can assert the single content asset was written and is
	// addressable for hard-delete cleanup (Phase E). Mirrors the snapshot-restore test's capture setup.
	function install_r2_object_capture() {
		const r2Objects = new Map<string, BodyInit>();
		generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
			const key = customKey ?? "test-upload-key";
			return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
		});
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
				if (urlString.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
					const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
					r2Objects.set(key, init.body ?? "");
					return new Response(null, { status: 200 });
				}
				return new Response(null, { status: 404 });
			}),
		);
		return r2Objects;
	}

	// Same line/word/char accounting the production materializer applies, replicated locally so the
	// expected file_stats are derived from the source rather than hard-coded.
	function expected_wc_counts(text: string) {
		let lineCount = 0;
		let charCount = 0;
		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code === 10) lineCount++;
			if (code < 0xdc00 || code > 0xdfff) charCount++;
		}
		const trimmed = text.trim();
		const wordCount = trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
		return { lineCount, wordCount, charCount };
	}

	// Markdown-hostile, plus a final line with no trailing newline and a non-ASCII line, to prove the
	// plain-text chunker round-trips raw bytes unchanged (no markdown parsing, no normalization).
	// Stored reserved-scope paths are `/<mount-name>/<rel>` — the `/.mounts` prefix is a bash-VFS mount
	// point only, never persisted (see Phase F prefix knob).
	const MOUNT_FILE_PATH = "/t3-chat/docs/notes.md";
	const MOUNT_RAW_TEXT = [
		"# heading-like but stored as plain text",
		"```ts",
		'const broken = "<unterminated string',
		"| col_a | col_b |",
		"plain Zorptelemetry marker line",
		"\ttab-indented literal not code",
		"",
		"final line with no trailing newline",
	].join("\n");

	test("rejects a mount write atomically after the mount is deleted", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const mountId = await ctx.db.insert("github_mounts", {
				name: "reset-race",
				owner: "owner",
				repo: "repo",
				defaultBranch: "main",
				ref: "main",
				lastCommitSha: null,
				lastTreeSha: null,
				lastSyncedAt: null,
				status: "running",
				startedAt: Date.now(),
				producerFinishedAt: null,
				finishedAt: null,
				lastError: null,
				syncRunId: "reset-race-run",
				pendingCommitSha: "abc123",
			});
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: organizations_GLOBAL_ORGANIZATION_ID,
				workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
				kind: "content",
				r2Bucket: "test-files-bucket",
				size: 4,
				createdBy: users_SYSTEM_AUTHOR,
				updatedAt: Date.now(),
			});
			await ctx.db.delete("github_mounts", mountId);
			return { mountId, assetId };
		});

		const result = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: users_SYSTEM_AUTHOR,
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			parentId: files_ROOT_ID,
			path: "/reset-race/abc123/file.txt",
			contentType: "text/plain;charset=utf-8",
			assetId: seeded.assetId,
			textContent: "test",
			// The mount literal: a read-only file has no Yjs document, so the insert ignores it.
			rootKind: "plain_text",
			readOnly: true,
			mountId: seeded.mountId,
			syncRunId: "reset-race-run",
		});
		expect(result._nay?.message).toBe("External mount sync was superseded");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").first())).toBeNull();
	});

	test("materializes a SYSTEM-authored reserved-scope text node readable byte-identical", async () => {
		const t = test_convex();
		const r2Objects = install_r2_object_capture();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: MOUNT_FILE_PATH,
			rawText: MOUNT_RAW_TEXT,
		});
		if (created._nay) {
			throw new Error(`Expected external text node creation to succeed: ${created._nay.message}`);
		}

		// Full read reconstructs the source exactly (markdown-hostile content, no trailing newline).
		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			path: MOUNT_FILE_PATH,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(full?.content).toBe(MOUNT_RAW_TEXT);

		// Line-range read matches the same window computed directly from the source.
		const lineRange = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			path: MOUNT_FILE_PATH,
			mode: { kind: "lines", startLine: 4, maxLines: 2 },
		});
		expect(lineRange?.content).toBe(
			files_line_range_from_text({ content: MOUNT_RAW_TEXT, startLine: 4, maxLines: 2 }).content,
		);

		// Exact wc/stat from file_stats (read O(1), not estimated).
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			path: MOUNT_FILE_PATH,
		});
		const expectedCounts = expected_wc_counts(MOUNT_RAW_TEXT);
		expect(stats).toMatchObject({
			usable: true,
			lineCount: expectedCounts.lineCount,
			wordCount: expectedCounts.wordCount,
			charCount: expectedCounts.charCount,
			byteCount: files_get_utf8_byte_size(MOUNT_RAW_TEXT),
		});

		// Node + intermediate folders are reserved-scope and SYSTEM-authored; the content asset is keyed
		// (so Phase E hard-delete can clean its R2 object) and holds the exact bytes.
		const docs = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", created._yay.nodeId);
			const asset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
			const [textChunks, plainTextChunks, metadataDocs, yjsSnapshots, yjsLastSequences] = await Promise.all([
				ctx.db
					.query("files_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
							.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
							.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
						q
							.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
							.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
				ctx.db.query("files_yjs_snapshots").collect(),
				ctx.db.query("files_yjs_docs_last_sequences").collect(),
			]);
			const mountFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("moveCohortId", undefined)
						.eq("path", "/t3-chat")
						.eq("archiveOperationId", null),
				)
				.first();
			const docsFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("moveCohortId", undefined)
						.eq("path", "/t3-chat/docs")
						.eq("archiveOperationId", null),
				)
				.first();
			return {
				fileNode,
				asset,
				mountFolder,
				docsFolder,
				textChunks,
				plainTextChunks,
				metadataDocs,
				yjsSnapshots,
				yjsLastSequences,
			};
		});
		expect(docs.fileNode).toMatchObject({
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			kind: "file",
			contentType: "text/plain;charset=utf-8",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
		});
		expect(docs.fileNode?.yjsSnapshotId).toBeNull();
		expect(docs.fileNode?.yjsLastSequenceId).toBeNull();
		expect(docs.mountFolder).toMatchObject({
			kind: "folder",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
		});
		expect(docs.docsFolder).toMatchObject({
			kind: "folder",
			createdBy: users_SYSTEM_AUTHOR,
			updatedBy: users_SYSTEM_AUTHOR,
		});
		expect(docs.asset?.kind).toBe("content");
		expect(docs.asset?.size).toBe(files_get_utf8_byte_size(MOUNT_RAW_TEXT));
		const liveR2Key = docs.asset?.r2Key;
		if (!liveR2Key) {
			throw new Error("Expected external content asset to be keyed");
		}
		expect(r2Objects.get(liveR2Key)).toBe(MOUNT_RAW_TEXT);
		expect(docs.textChunks.map((chunk) => chunk.textChunk).join("")).toBe(MOUNT_RAW_TEXT);
		expect(docs.plainTextChunks.map((chunk) => chunk.plainTextChunk).join("")).toBe(MOUNT_RAW_TEXT);
		expect(docs.textChunks.every((chunk) => chunk.sourceKind === "committed" && chunk.yjsSequence === undefined)).toBe(
			true,
		);
		expect(
			docs.plainTextChunks.every((chunk) => chunk.sourceKind === "committed" && chunk.yjsSequence === undefined),
		).toBe(true);
		// A mount file indexes no frontmatter. Its only entry is the stamp that records where the
		// file came from.
		expect(docs.metadataDocs.map((doc) => doc.fieldPath)).toEqual(["metadata.source", "metadata.source"]);
		expect(docs.metadataDocs.find((doc) => doc.docKind === "value")?.stringValue).toBe("github-mount");
		expect(docs.yjsSnapshots).toEqual([]);
		expect(docs.yjsLastSequences).toEqual([]);
	});

	// The stamp value is one ternary on the workspace, and the test above only walks the GitHub
	// side of it. Swapping the two words would leave every test green while `meta search` for
	// plugin sources returned mount files instead.
	test("stamps a plugin source file with its own source value", async () => {
		const t = test_convex();
		install_r2_object_capture();

		// The publish stores each file under the version id, the way plugins.publish_version does.
		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
			path: "/plugin_version_1/src/main.ts",
			rawText: "export const main = () => {};",
		});
		if (created._nay) {
			throw new Error(`Expected plugin source node creation to succeed: ${created._nay.message}`);
		}

		const metadataDocs = await t.run(async (ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_PLUGINS_WORKSPACE_ID)
						.eq("fileNodeId", created._yay.nodeId),
				)
				.collect(),
		);
		expect(metadataDocs.map((doc) => doc.fieldPath)).toEqual(["metadata.source", "metadata.source"]);
		expect(metadataDocs.find((doc) => doc.docKind === "value")?.stringValue).toBe("plugin-source");
	});

	test("grep-style line matching maps to raw source line numbers", async () => {
		const t = test_convex();
		install_r2_object_capture();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: MOUNT_FILE_PATH,
			rawText: MOUNT_RAW_TEXT,
		});
		if (created._nay) {
			throw new Error(`Expected external text node creation to succeed: ${created._nay.message}`);
		}

		const plainMatch = await t.query(internal.files_nodes.match_plain_text_file_lines, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			target: { kind: "saved", id: created._yay.nodeId },
			pattern: "Zorptelemetry",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		const plainMatchedLines = plainMatch?.lines.filter((line) => line.matched) ?? [];
		expect(plainMatchedLines.map((line) => line.lineNumber)).toEqual([5]);
		expect(plainMatchedLines[0]?.line).toContain("Zorptelemetry");

		const markdownMatch = await t.query(internal.files_nodes.match_text_file_lines, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			target: { kind: "saved", id: created._yay.nodeId },
			pattern: "Zorptelemetry",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
			before: 0,
			after: 0,
		});
		const markdownMatchedLines = markdownMatch?.lines.filter((line) => line.matched) ?? [];
		expect(markdownMatchedLines.map((line) => line.lineNumber)).toEqual([5]);
	});

	test("search finds external chunks under pathPrefix and stays isolated from tenant scope", async () => {
		const t = test_convex();
		install_r2_object_capture();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: MOUNT_FILE_PATH,
			rawText: MOUNT_RAW_TEXT,
		});
		if (created._nay) {
			throw new Error(`Expected external text node creation to succeed: ${created._nay.message}`);
		}

		const reservedHit = await t.query(internal.files_nodes.text_search_files, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "Zorptelemetry",
			pathPrefix: "/t3-chat",
			numItems: 20,
			cursor: null,
		});
		expect(reservedHit.items.map((item) => item.path)).toContain(MOUNT_FILE_PATH);

		// A real tenant cannot see reserved-scope mount content.
		const tenantMiss = await t.query(internal.files_nodes.text_search_files, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			hasWorkspaceRead: true,
			query: "Zorptelemetry",
			numItems: 20,
			cursor: null,
		});
		expect(tenantMiss.items).toEqual([]);
	});

	test("oversize external file is skipped (returns _nay) rather than thrown", async () => {
		const t = test_convex();
		install_r2_object_capture();

		const oversizePath = "/t3-chat/big.txt";
		const result = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: oversizePath,
			rawText: "a".repeat(files_MAX_TEXT_CONTENT_BYTES + 1),
		});
		expect(result._nay).toBeTruthy();

		const leaked = await t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID)
						.eq("moveCohortId", undefined)
						.eq("path", oversizePath)
						.eq("archiveOperationId", null),
				)
				.first();
			const assets = await ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q
						.eq("organizationId", organizations_GLOBAL_ORGANIZATION_ID)
						.eq("workspaceId", organizations_GLOBAL_GITHUB_WORKSPACE_ID),
				)
				.collect();
			return { node, assetCount: assets.length };
		});
		expect(leaked.node).toBeNull();
		expect(leaked.assetCount).toBe(0);
	});
});

describe("producer shape pairs", () => {
	// A node born with a `yjsRootKind` that does not match its first Yjs snapshot is invisible to
	// every later guard: no push happened and no structure is wrong. These tests read both sides
	// of the producer's own write, so a born-inconsistent pair fails here.
	test("a writable file node records the shape of the snapshot created beside it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));

		const markdownContent = "# Producer pair";
		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
			text: markdownContent,
			rootKind: "rich_text",
		});
		if (snapshotUpdate._nay) {
			throw new Error(`Expected the snapshot creator to succeed: ${snapshotUpdate._nay.message}`);
		}

		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const [assetId, yjsSnapshotAssetId] = await Promise.all([
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-files-bucket",
					size: files_get_utf8_byte_size(markdownContent),
					createdBy: db.userId,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-files-bucket",
					size: snapshotUpdate._yay.byteLength,
					createdBy: db.userId,
					updatedAt: now,
				}),
			]);
			return { assetId, yjsSnapshotAssetId };
		});

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "/producer-pair.md",
			contentType: "text/markdown;charset=utf-8",
			assetId: seeded.assetId,
			yjsSnapshotAssetId: seeded.yjsSnapshotAssetId,
			textContent: markdownContent,
			rootKind: "rich_text",
			readOnly: false,
		});
		if (created._nay) {
			throw new Error(`Expected writable node creation to succeed: ${created._nay.message}`);
		}

		// Both sides of the pair: the node names the shape, and the snapshot document's only root
		// is the rich text one.
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.textKind).toBe("rich_text");

		const snapshotDoc = new YjsDoc();
		applyUpdate(snapshotDoc, new Uint8Array(snapshotUpdate._yay));
		expect([...snapshotDoc.share.keys()]).toEqual([files_YJS_DOC_KEYS.richText]);
	});

	test("a read-only mount node gets no yjsRootKind because it has no Yjs document", async () => {
		const t = test_convex();
		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: "/pair-mount/abc123/data.txt",
			rawText: "plain mount content",
		});
		if (created._nay) {
			throw new Error(`Expected mount node creation to succeed: ${created._nay.message}`);
		}

		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.kind).toBe("file");
		expect(node?.textKind).toBeNull();
	});

	test("a read-only mount chunks to the same boundaries as the pre-slice baseline", async () => {
		const t = test_convex();

		// The deterministic markdown-hostile fixture from `capture-mount-boundary-baseline.mjs`
		// (plain-text-docs planning folder), mirrored here so the test needs no external file.
		// Lines stay far under the 1200-unit chunk cap on purpose: this control must only catch
		// the mount branch being re-routed to the Markdown chunker, never the intended mid-line
		// split of over-cap lines.
		const lines: string[] = [];
		for (let index = 0; index < 120; index++) {
			lines.push(`# heading-like line ${index} but stored as plain text`);
			lines.push("```ts");
			lines.push(`const broken_${index} = "<unterminated string`);
			lines.push(`| col_a_${index} | col_b_${index} |`);
			lines.push(`\ttab-indented literal ${index} not code`);
			lines.push("");
		}
		lines.push("final line with no trailing newline");
		const mountText = lines.join("\n");
		expect(mountText.length).toBe(18445);

		const created = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: "/mount-boundary/abc123/baseline.txt",
			rawText: mountText,
		});
		if (created._nay) {
			throw new Error(`Expected mount node creation to succeed: ${created._nay.message}`);
		}

		const chunks = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!node) {
				throw new Error("Expected the mount node to exist");
			}
			return await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", node.organizationId).eq("workspaceId", node.workspaceId).eq("fileNodeId", node._id),
				)
				.collect();
		});

		// The exact boundaries `mount-boundary-baseline.json` recorded on the pre-change tree
		// (16 chunks over 18,445 chars). A mount routed through the Markdown chunker, or a changed
		// whole-line packing rule, moves these numbers.
		const baselineBoundaries = [
			{ chunkIndex: 0, startIndex: 0, endIndex: 1184, lineStart: 1, lineEnd: 48 },
			{ chunkIndex: 1, startIndex: 1184, endIndex: 2363, lineStart: 49, lineEnd: 94 },
			{ chunkIndex: 2, startIndex: 2363, endIndex: 3563, lineStart: 95, lineEnd: 141 },
			{ chunkIndex: 3, startIndex: 3563, endIndex: 4747, lineStart: 142, lineEnd: 188 },
			{ chunkIndex: 4, startIndex: 4747, endIndex: 5917, lineStart: 189, lineEnd: 234 },
			{ chunkIndex: 5, startIndex: 5917, endIndex: 7106, lineStart: 235, lineEnd: 280 },
			{ chunkIndex: 6, startIndex: 7106, endIndex: 8306, lineStart: 281, lineEnd: 327 },
			{ chunkIndex: 7, startIndex: 8306, endIndex: 9490, lineStart: 328, lineEnd: 374 },
			{ chunkIndex: 8, startIndex: 9490, endIndex: 10660, lineStart: 375, lineEnd: 420 },
			{ chunkIndex: 9, startIndex: 10660, endIndex: 11849, lineStart: 421, lineEnd: 466 },
			{ chunkIndex: 10, startIndex: 11849, endIndex: 13049, lineStart: 467, lineEnd: 513 },
			{ chunkIndex: 11, startIndex: 13049, endIndex: 14233, lineStart: 514, lineEnd: 560 },
			{ chunkIndex: 12, startIndex: 14233, endIndex: 15408, lineStart: 561, lineEnd: 606 },
			{ chunkIndex: 13, startIndex: 15408, endIndex: 16569, lineStart: 607, lineEnd: 650 },
			{ chunkIndex: 14, startIndex: 16569, endIndex: 17742, lineStart: 651, lineEnd: 694 },
			{ chunkIndex: 15, startIndex: 17742, endIndex: 18445, lineStart: 695, lineEnd: 721 },
		];
		const sortedChunks = [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex);
		expect(
			sortedChunks.map((chunk) => ({
				chunkIndex: chunk.chunkIndex,
				startIndex: chunk.startIndex,
				endIndex: chunk.endIndex,
				lineStart: chunk.lineStart,
				lineEnd: chunk.lineEnd,
			})),
		).toEqual(baselineBoundaries);
		expect(sortedChunks.map((chunk) => chunk.plainTextChunk).join("")).toBe(mountText);
	});
});

describe("plain text file stats and delete-all", () => {
	/**
	 * Seed an editable plain-text node the way the upload conversion will: the node starts as a
	 * stored upload (whose creation writes the -1 stats sentinel), then gains its Yjs pointers
	 * and `yjsRootKind: "plain_text"` with the content in the stored Yjs snapshot. Committed
	 * chunks and real stats only appear at the first materialization.
	 */
	async function seed_editable_plain_text_upload(args: {
		t: ReturnType<typeof test_convex>;
		asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		r2Writes: Map<string, BodyInit>;
		filename: string;
		text: string;
	}) {
		const { t, asUser, db, r2Writes, filename, text } = args;
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename,
			contentType: "text/plain;charset=utf-8",
			size: files_get_utf8_byte_size(text),
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		const nodeId = upload._yay.nodeId;

		const plainDoc = files_yjs_doc_create_from_text({ rootKind: "plain_text", text });
		if ("_nay" in plainDoc) {
			throw new Error(plainDoc._nay.message);
		}
		const snapshotBytes = encodeStateAsUpdate(plainDoc);

		await t.run(async (ctx) => {
			const now = Date.now();
			const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-files-bucket",
				size: snapshotBytes.byteLength,
				createdBy: db.userId,
				updatedAt: now,
			});
			const yjsSnapshotR2Key = r2_create_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: yjsSnapshotAssetId,
			});
			await ctx.db.patch("files_r2_assets", yjsSnapshotAssetId, { r2Key: yjsSnapshotR2Key });
			r2Writes.set(yjsSnapshotR2Key, files_u8_to_array_buffer(snapshotBytes));
			const yjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				assetId: yjsSnapshotAssetId,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
			});
			const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				lastSequence: 0,
				unmaterializedUpdateCount: 0,
				unmaterializedUpdateBytes: 0,
				lineageGeneration: 0,
			});
			await ctx.db.patch("files_nodes", nodeId, {
				yjsSnapshotId,
				yjsLastSequenceId,
				textKind: "plain_text",
			});
		});

		return { nodeId, plainDoc };
	}

	async function read_file_stats(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
		return await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			return node?.statsId ? await ctx.db.get("file_stats", node.statsId) : null;
		});
	}

	// Counts stay at -1 until the first materialization, then hold the exact values.
	test("file_stats keeps the -1 sentinel until a plain-text materialization writes exact counts", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Plain Stats User",
		});
		const r2Writes = test_setup_r2_capture();

		const text = "alpha beta\ngamma delta epsilon\n\nzeta\n";
		const { nodeId, plainDoc } = await seed_editable_plain_text_upload({
			t,
			asUser,
			db,
			r2Writes,
			filename: "wc-notes.txt",
			text,
		});
		plainDoc.destroy();

		// Pre-materialization: every count is the -1 unprocessable sentinel from the node's
		// creation; nothing has processed the text yet.
		const statsBefore = await read_file_stats(t, nodeId);
		expect(statsBefore).toMatchObject({ lineCount: -1, wordCount: -1, charCount: -1 });

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}

		// Post-materialization: the exact line/word/character counts of the fixture.
		const statsAfter = await read_file_stats(t, nodeId);
		expect(statsAfter).toMatchObject({ lineCount: 4, wordCount: 6, charCount: text.length });
	});

	// Do not refuse a legitimate delete-all: emptied is a normal state, not corruption.
	test("a delete-all on a plain-text file materializes to empty without a refusal", async () => {
		const t = test_convex();
		// This test seeds its file by uploading it, so the user has to be on a paying plan. It only
		// needs credits, which the fixture's plan has.
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Plain Delete All User",
		});
		const r2Writes = test_setup_r2_capture();

		const text = "line one\nline two\n";
		const { nodeId, plainDoc } = await seed_editable_plain_text_upload({
			t,
			asUser,
			db,
			r2Writes,
			filename: "delete-all.txt",
			text,
		});

		const firstMaterialize = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (firstMaterialize._nay) {
			throw new Error(firstMaterialize._nay.message);
		}
		const chunkCountBefore = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("files_plain_text_chunks")
						.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
						)
						.collect()
				).length,
		);
		expect(chunkCountBefore).toBeGreaterThan(0);

		// Empty the file the way the editor does: apply "" through the shape-aware setter and push
		// the diff against the stored lineage.
		const emptiedDoc = files_yjs_doc_clone({ yjsDoc: plainDoc });
		const emptied = files_yjs_doc_update_from_text({ mut_yjsDoc: emptiedDoc, text: "", rootKind: "plain_text" });
		if (emptied._nay) {
			throw new Error(emptied._nay.message);
		}
		const deleteAllDiff = files_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: emptiedDoc,
			yjsBeforeDoc: plainDoc,
		});
		if (!deleteAllDiff) {
			throw new Error("Expected the delete-all to produce a diff update");
		}
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(deleteAllDiff),
			sessionId: "plain-delete-all",
		});
		plainDoc.destroy();
		emptiedDoc.destroy();
		if (pushed._nay) {
			throw new Error(pushed._nay.message);
		}

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: pushed._yay.newSequence,
		});
		// The named non-refusal: a legitimate delete-all settles as success, never as a shape or
		// content refusal.
		expect(materialized._nay).toBeUndefined();

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			const stats = node?.statsId ? await ctx.db.get("file_stats", node.statsId) : null;
			return { node, chunks, stats };
		});
		expect(after.chunks).toEqual([]);
		expect(after.stats).toMatchObject({ lineCount: 0, wordCount: 0, charCount: 0 });
		expect(after.node?.contentShapeMismatchAt).toBeNull();
		expect(after.node?.contentTooLargeByteSize).toBeNull();
	});
});

// #region door 1 and materialization guards
describe("files_db_yjs_push_update door 1", () => {
	async function create_door_fixture(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path,
		});
		return { db, nodeId: createdId };
	}

	async function read_log_state(args: {
		t: ReturnType<typeof test_convex>;
		db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> };
		nodeId: Id<"files_nodes">;
	}) {
		const { t, db, nodeId } = args;

		return await t.run(async (ctx) => {
			const rows = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			return { rowCount: rows.length, lastSequence: lastSequenceDoc?.lastSequence };
		});
	}

	async function push_bytes(args: {
		t: ReturnType<typeof test_convex>;
		db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> };
		nodeId: Id<"files_nodes">;
		update: Uint8Array;
		rootKind: "rich_text" | "plain_text";
	}) {
		const { t, db, nodeId, update, rootKind } = args;

		return await t.run(async (ctx) => {
			const result = await files_db_yjs_push_update(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
				update: files_u8_to_array_buffer(update),
				sessionId: "door-1-test-session",
				userId: db.userId,
				rootKind,
				materializeImmediately: false,
			});
			// `t.run` serializes its return value as a Convex value, and a decode refusal carries a
			// raw Error in `_nay.cause`. Strip to the message the way the registered boundary does.
			return result._nay ? { _nay: { message: result._nay.message } } : result;
		});
	}

	function encoded_attack_state(build: (yjsDoc: YjsDoc) => void) {
		const yjsDoc = new YjsDoc();
		yjsDoc.transact(() => build(yjsDoc));
		return encodeStateAsUpdate(yjsDoc);
	}

	// Control 6's named assertion, all three clauses. The third clause — `lastSequence`
	// unchanged — is what distinguishes "first statement" from "before the insert": a scan
	// placed between the sequence increment and the insert still refuses and still inserts no
	// row, but leaks a bumped sequence on every refusal (control 7).
	test.each([
		{
			title: "a crafted update carrying a child type (ContentType)",
			update: () => encoded_attack_state((d) => d.getXmlFragment("plain_text").insert(0, [new YXmlElement("p")])),
			message: "Update does not match the file shape",
		},
		{
			title: "an embed into an existing root (ContentEmbed)",
			update: () =>
				encoded_attack_state((d) => {
					d.getText("plain_text").insert(0, "base");
					d.getText("plain_text").insertEmbed(2, { x: 1 });
				}),
			message: "Update does not match the file shape",
		},
		{
			title: "a Y.Map named plain_text (ContentAny in a map slot)",
			update: () => encoded_attack_state((d) => d.getMap("plain_text").set("k", "v")),
			message: "Update does not match the file shape",
		},
		{
			title: "a Skip struct merged across a gap",
			update: () => {
				const yjsDoc = new YjsDoc();
				const ytext = yjsDoc.getText("plain_text");
				ytext.insert(0, "a");
				const updateA = encodeStateAsUpdate(yjsDoc);
				ytext.insert(1, "b");
				const stateVectorAfterB = encodeStateVector(yjsDoc);
				ytext.insert(2, "c");
				const updateC = encodeStateAsUpdate(yjsDoc, stateVectorAfterB);
				return mergeUpdates([updateA, updateC]);
			},
			message: "Update does not match the file shape",
		},
		{
			title: "a V2-encoded update",
			update: () => {
				const yjsDoc = new YjsDoc();
				yjsDoc.getText("plain_text").insert(0, "v2 payload");
				return encodeStateAsUpdateV2(yjsDoc);
			},
			message: "Unsupported update encoding",
		},
	])(
		"refuses $title into a plain-text node, inserts no row, and leaves lastSequence unchanged",
		async ({ update, message }) => {
			const t = test_convex();
			const { db, nodeId } = await create_door_fixture(t, `/door-refusal-${Math.random().toString(36).slice(2)}.md`);
			const before = await read_log_state({ t, db, nodeId });

			const result = await push_bytes({ t, db, nodeId, update: update(), rootKind: "plain_text" });

			expect(result._nay?.message).toBe(message);
			const after = await read_log_state({ t, db, nodeId });
			expect(after.rowCount).toBe(before.rowCount);
			expect(after.lastSequence).toBe(before.lastSequence);
		},
	);

	test("refuses zero bytes before decode with no sequence or update write", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-zero-byte.md");
		const before = await read_log_state({ t, db, nodeId });

		const result = await push_bytes({ t, db, nodeId, update: new Uint8Array(0), rootKind: "plain_text" });

		expect(result._nay?.message).toBe("Empty update");
		const after = await read_log_state({ t, db, nodeId });
		expect(after.rowCount).toBe(before.rowCount);
		expect(after.lastSequence).toBe(before.lastSequence);
	});

	test("refuses raw bytes over the wire cap before decode with no sequence or update write", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-over-cap.md");
		const before = await read_log_state({ t, db, nodeId });

		// Garbage bytes: if the size check did not run before the decode, the refusal would be
		// "Malformed update" instead of the size message. Fill with 0xff — zero-filled bytes
		// decode cleanly as a v1 no-op, which would let the reserve gate's row cap answer
		// "Update too large" even with the pre-decode check gone.
		const result = await push_bytes({
			t,
			db,
			nodeId,
			update: new Uint8Array(files_MAX_YJS_WIRE_BYTES + 1).fill(255),
			rootKind: "plain_text",
		});

		expect(result._nay?.message).toBe("Update too large");
		const after = await read_log_state({ t, db, nodeId });
		expect(after.rowCount).toBe(before.rowCount);
		expect(after.lastSequence).toBe(before.lastSequence);
	});

	test("stores the canonical two-byte v1 no-op and advances the sequence", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-canonical-noop.md");
		const before = await read_log_state({ t, db, nodeId });

		const result = await push_bytes({
			t,
			db,
			nodeId,
			update: encodeStateAsUpdate(new YjsDoc()),
			rootKind: "plain_text",
		});

		expect(result._nay).toBeUndefined();
		const after = await read_log_state({ t, db, nodeId });
		expect(after.rowCount).toBe(before.rowCount + 1);
		expect(after.lastSequence).toBe((before.lastSequence ?? -1) + 1);
	});

	test("accepts a legal plain-text incremental edit", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-legal-edit.md");
		const before = await read_log_state({ t, db, nodeId });

		const result = await push_bytes({
			t,
			db,
			nodeId,
			update: encoded_attack_state((d) => d.getText("plain_text").insert(0, "legal plain text")),
			rootKind: "plain_text",
		});

		expect(result._nay).toBeUndefined();
		const after = await read_log_state({ t, db, nodeId });
		expect(after.rowCount).toBe(before.rowCount + 1);
	});

	test("refuses every writer while a durable repair marker is set on the node", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_door_fixture(t, "/door-marker-refusal.md");
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});
		const before = await read_log_state({ t, db, nodeId });

		const result = await push_bytes({
			t,
			db,
			nodeId,
			update: encoded_attack_state((d) => d.getText("plain_text").insert(0, "blocked")),
			rootKind: "plain_text",
		});

		expect(result._nay?.message).toBe("File is not accepting new edits until an operator repairs it");
		const after = await read_log_state({ t, db, nodeId });
		expect(after.rowCount).toBe(before.rowCount);
		expect(after.lastSequence).toBe(before.lastSequence);
	});
});

describe("yjs_reserve_and_increment_last_sequence", () => {
	async function create_reserve_fixture(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path,
		});
		return { db, nodeId: createdId };
	}

	test("refuses when the aggregate update-count budget would be crossed and schedules compaction instead of writing", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-count-budget.md");

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateCount: files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
			});
		});

		const result = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);

		expect(result._nay?.message).toBe("File updates are being compacted, retry in a moment");
	});

	test("refuses when the aggregate byte budget would be crossed", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-byte-budget.md");

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateBytes: files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES,
			});
		});

		const result = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);

		expect(result._nay?.message).toBe("File updates are being compacted, retry in a moment");
	});

	test("a budget trip on a settle-marked file returns the repair message instead of retry-in-a-moment", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-settled-marker.md");

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateCount: files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
			});
			// A settled materialization: while the marker is set, compaction completes without
			// advancing the committed content, so the counters can never shrink.
			await ctx.db.patch("files_nodes", nodeId, {
				contentFrontmatterTooLargeFieldCount: files_metadata_MAX_FRONTMATTER_FIELDS + 1,
				contentFrontmatterTooLargeIndexDocumentCount: files_metadata_MAX_FRONTMATTER_FIELDS + 2,
			});
		});
		const jobCountBefore = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("files_content_materialization_jobs")
						.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
						.collect()
				).length,
		);

		const result = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);
		// "Retry in a moment" would be permanently false here; the repair path is the only exit.
		expect(result._nay?.message).toBe("File is not accepting new edits until an operator repairs it");

		// The honest branch enqueues no materialization: it would settle again without freeing budget.
		const jobCountAfter = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query("files_content_materialization_jobs")
						.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
						.collect()
				).length,
		);
		expect(jobCountAfter).toBe(jobCountBefore);

		// The too-large-text marker takes the same honest branch.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, {
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				contentTooLargeByteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
			});
		});
		const tooLargeResult = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
				userId: db.userId,
				updateByteLength: 10,
			}),
		);
		expect(tooLargeResult._nay?.message).toBe("File is not accepting new edits until an operator repairs it");
	});

	test("rejects empty and over-cap rows for the trusted writers too", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-row-caps.md");

		const emptyResult = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
				userId: db.userId,
				updateByteLength: 0,
			}),
		);
		expect(emptyResult._nay?.message).toBe("Empty update");

		const overCapResult = await t.run(async (ctx) =>
			yjs_reserve_and_increment_last_sequence(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				nodeId,
				expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
				userId: db.userId,
				updateByteLength: files_MAX_YJS_WIRE_BYTES + 1,
			}),
		);
		expect(overCapResult._nay?.message).toBe("Update too large");
	});

	test("the public fill writer goes through the same reserve gate", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/reserve-fill-writer.md");
		const staged = await t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			kind: "public_fill",
			update: files_u8_to_array_buffer(
				encodeStateAsUpdate(files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "fill" }) as YjsDoc),
			),
		});
		if (staged._nay) throw new Error(staged._nay.message);

		await t.run(async (ctx) => {
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			if (!lastSequenceDoc) {
				throw new Error("Expected a last-sequence doc");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", lastSequenceDoc._id, {
				unmaterializedUpdateCount: files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
			});
		});

		// The fill helper throws on a reserve refusal because its earlier writes must roll back.
		await expect(
			t.run(async (ctx) => {
				const fileNode = await ctx.db.get("files_nodes", nodeId);
				if (!files_node_has_editable_yjs_state(fileNode)) {
					throw new Error("Expected an editable file node");
				}
				const contentSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-files-bucket",
					size: 4,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				return files_nodes_db_fill_text_node_content(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNode,
					userId: db.userId,
					textContent: "fill",
					contentSnapshotAssetId,
					contentSize: 4,
					fillUpdateStageId: staged._yay.stageId,
					expectedYjsLastSequenceId: fileNode.yjsLastSequenceId,
				});
			}),
		).rejects.toThrow(/compacted/);
	});

	test("files_nodes_db_fill_text_node_content syncs the updater sort doc", async () => {
		const t = test_convex();
		const { db, nodeId } = await create_reserve_fixture(t, "/fill-sync.md");
		const staged = await t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId,
			kind: "public_fill",
			update: files_u8_to_array_buffer(
				encodeStateAsUpdate(files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "fill" }) as YjsDoc),
			),
		});
		if (staged._nay) throw new Error(staged._nay.message);
		await t.run(async (ctx) => {
			await files_updated_by_db_delete_for_node(ctx, { nodeId });
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc).toBeNull();
		});

		// Its only caller is `public_api.publish_file_fill`, so call the writer the same way the
		// reserve-gate test above does.
		await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			const contentSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-files-bucket",
				size: 4,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			await files_nodes_db_fill_text_node_content(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNode,
				userId: db.userId,
				textContent: "fill",
				contentSnapshotAssetId,
				contentSize: 4,
				fillUpdateStageId: staged._yay.stageId,
				expectedYjsLastSequenceId: fileNode.yjsLastSequenceId,
			});
		});

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc, "files_nodes_db_fill_text_node_content syncs the updater doc").toMatchObject({
				userId: node?.updatedBy,
				name: node?.name,
				parentId: node?.parentId,
				nodeKind: node?.kind,
			});
			expect(doc?.archiveOperationId).toBeUndefined();
		});
	});
});

describe("files_nodes.get_file_next_yjs_update", () => {
	async function seed_update_rows(t: ReturnType<typeof test_convex>, sequences: number[]) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: `/next-update-${sequences.join("-")}.md`,
		});
		await t.run(async (ctx) => {
			for (const sequence of sequences) {
				await ctx.db.insert("files_yjs_updates", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					sequence,
					update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
					origin: { type: "USER_EDIT", sessionId: "next-update-seed" },
					createdBy: db.userId,
					createdAt: Date.now(),
				});
			}
		});
		const node = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		if (!node?.yjsLastSequenceId) throw new Error("Expected a Yjs sequence head");
		const head = await t.run((ctx) => ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId!));
		if (!head) throw new Error("Expected a Yjs sequence head");
		return { db, nodeId, expectedLastSequenceId: head._id, expectedLineageGeneration: head.lineageGeneration };
	}

	test("returns exactly the next row and ignores a concurrent S+1 past the frozen throughSequence", async () => {
		const t = test_convex();
		const { db, nodeId, expectedLastSequenceId, expectedLineageGeneration } = await seed_update_rows(t, [1, 2, 3]);

		// The frozen bound is 2; row 3 (the concurrent S+1 push) must be invisible to this run.
		const first = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			expectedLastSequenceId,
			expectedLineageGeneration,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 0,
			throughSequence: 2,
		});
		expect(first.kind).toBe("row");
		if (first.kind === "row") {
			expect(first.row.sequence).toBe(1);
		}

		const second = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			expectedLastSequenceId,
			expectedLineageGeneration,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 1,
			throughSequence: 2,
		});
		expect(second.kind).toBe("row");
		if (second.kind === "row") {
			expect(second.row.sequence).toBe(2);
		}

		const done = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			expectedLastSequenceId,
			expectedLineageGeneration,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 2,
			throughSequence: 2,
		});
		expect(done.kind).toBe("done");
	});

	test("refuses a sequence gap instead of silently skipping it", async () => {
		const t = test_convex();
		const { db, nodeId, expectedLastSequenceId, expectedLineageGeneration } = await seed_update_rows(t, [1, 3]);

		const result = await t.query(internal.files_nodes.get_file_next_yjs_update, {
			expectedLastSequenceId,
			expectedLineageGeneration,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			afterSequence: 1,
			throughSequence: 3,
		});
		expect(result).toMatchObject({ kind: "gap", expectedSequence: 2, foundSequence: 3 });
	});
});

describe("materialization guards", () => {
	test("snapshot-size preflight settles the state marker without any GET", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/preflight-no-fetch.md",
		});

		// Pretend the stored Yjs snapshot is over the 4 MiB cap.
		await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
			if (!yjsSnapshotDoc) {
				throw new Error("Expected a Yjs snapshot doc");
			}
			await ctx.db.patch("files_r2_assets", yjsSnapshotDoc.assetId, { size: 5 * 1024 * 1024 });
		});

		const getUrlSpy = vi.spyOn(R2.prototype, "getUrl");
		getUrlSpy.mockClear();
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});

		expect(materialized._nay?.message).toContain("Yjs state exceeds");
		// No GET happened: the refusal was decided from the stored asset size alone.
		expect(getUrlSpy).not.toHaveBeenCalled();
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node?.contentYjsStateTooLargeByteSize).toBe(5 * 1024 * 1024);
	});

	test("the incremental reconstructed-state check settles the marker while applying the log", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/incremental-reconstructed-cap.md",
		});

		// Six legal ~900,000-byte inserts: each wire row stays under the 930,000-byte cap and the
		// aggregate stays under the 8 MiB budget, but the reconstructed state crosses the 4 MiB cap
		// while the rows are applied — the snapshot-size preflight cannot see it (the stored base
		// snapshot is still tiny), so only the incremental check can refuse. Like the door-1
		// fixtures above, the log is built plain-shaped with a test-level `rootKind` shortcut on a
		// Markdown node: only sizes matter here, and the cap runs before any shape logic.
		const yjsDoc = new YjsDoc();
		let lastPushedSequence = 0;
		for (let i = 0; i < 6; i++) {
			const stateVectorBefore = encodeStateVector(yjsDoc);
			yjsDoc.transact(() => {
				const ytext = yjsDoc.getText(files_YJS_DOC_KEYS.plainText);
				ytext.insert(ytext.length, "a".repeat(900_000));
			});
			const update = encodeStateAsUpdate(yjsDoc, stateVectorBefore);
			const pushed = await t.run(async (ctx) => {
				const result = await files_db_yjs_push_update(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId,
					expectedYjsLastSequenceId: (await ctx.db.get("files_nodes", nodeId))!.yjsLastSequenceId!,
					update: files_u8_to_array_buffer(update),
					sessionId: "incremental-cap-test-session",
					userId: db.userId,
					rootKind: "plain_text",
					materializeImmediately: false,
				});
				return result._nay ? { _nay: { message: result._nay.message } } : result;
			});
			if (pushed._nay) {
				throw new Error(pushed._nay.message);
			}
			lastPushedSequence = pushed._yay.newSequence;
		}

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: lastPushedSequence,
		});

		expect(materialized._nay?.message).toContain("Yjs state exceeds");
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node?.contentYjsStateTooLargeByteSize).toBeGreaterThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
	});

	test("successful finalization recomputes the aggregate counters exactly", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/finalize-exact-counters.md",
			textContent: "counter fixture\n",
		});

		// Drift the counters the way an uncounted legacy file would look. The staleness gate lets
		// only the run whose frozen target equals the current lastSequence finalize, so every
		// covered row is behind the new snapshot and the exact recomputed values here are 0/0.
		await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId, {
				unmaterializedUpdateCount: 7,
				unmaterializedUpdateBytes: 999_999,
			});
		});

		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}

		const lastSequenceDoc = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			return await ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId);
		});
		expect(lastSequenceDoc?.unmaterializedUpdateCount).toBe(0);
		expect(lastSequenceDoc?.unmaterializedUpdateBytes).toBe(0);
	});
});
// #endregion door 1 and materialization guards

// #region yjs repair
describe("files_nodes_content.repair_file_yjs_state_from_visible_text", () => {
	test("refuses the default source without a durable marker", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-no-marker.md",
		});

		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: createdId,
			authorUserId: db.userId,
		});
		expect(result._nay?.message).toBe("File carries no durable repair marker");
	});

	test("refuses an author who is not a member of the node's tenant", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-outside-author.md",
		});
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", createdId, { contentShapeMismatchAt: Date.now() });
		});

		// A real user id with no membership in this tenant: the repair must refuse instead of
		// recording a forged author on the new version.
		const outsiderUserId = await t.run(async (ctx) => ctx.db.insert("users", { clerkUserId: null }));
		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: createdId,
			authorUserId: outsiderUserId,
		});
		expect(result._nay?.message).toBe("Not found");
	});

	test("refuses last_committed without the explicit acknowledgement flag", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-no-ack.md",
		});

		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: createdId,
			authorUserId: db.userId,
			source: "last_committed",
		});
		expect(result._nay?.message).toContain("acknowledgement");
	});

	test("refuses a base over the 16 MiB repair cap before any GET", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-over-16mib.md",
		});

		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentYjsStateTooLargeByteSize: 17 * 1024 * 1024 });
			const fileNode = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(fileNode)) {
				throw new Error("Expected an editable file node");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
			if (!yjsSnapshotDoc) {
				throw new Error("Expected a Yjs snapshot doc");
			}
			await ctx.db.patch("files_r2_assets", yjsSnapshotDoc.assetId, { size: 17 * 1024 * 1024 });
		});

		const getUrlSpy = vi.spyOn(R2.prototype, "getUrl");
		getUrlSpy.mockClear();
		const result = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		expect(result._nay?.message).toContain("repair limit");
		expect(getUrlSpy).not.toHaveBeenCalled();
	});

	test("finalize refuses a stale target sequence, and cleanup durably owns the fresh assets", async () => {
		const t = test_convex();
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-stale-finalize.md",
		});
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});

		const [yjsSnapshotAssetId, contentSnapshotAssetId, supersededYjsAssetId] = await t.run(async (ctx) => {
			const now = Date.now();
			return await Promise.all([
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-files-bucket",
					size: 2,
					createdBy: db.userId,
					unfinalizedExpiresAt: now + 1000,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-files-bucket",
					size: 6,
					createdBy: db.userId,
					unfinalizedExpiresAt: now + 1000,
					updatedAt: now,
				}),
				ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "yjs_snapshot",
					r2Bucket: "test-files-bucket",
					size: 2,
					createdBy: db.userId,
					updatedAt: now,
				}),
			]);
		});

		// The file advanced past the repair's frozen target: the final mutation must refuse.
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		const finalized = await t.mutation(internal.files_nodes_content.finalize_file_yjs_repair, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
			source: "latest_state",
			acknowledgeDiscardUnmaterialized: false,
			targetSequence: 999,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			text: "stale.",
			textByteSize: files_get_utf8_byte_size("stale."),
			yjsSnapshotAssetId,
			yjsSnapshotSize: 2,
			contentSnapshotAssetId,
			supersededYjsAssetId,
		});
		expect(finalized._nay?.message).toBe("Stale repair: the file advanced");

		// The refused fresh uploads move to durable cleanup; the node's real assets are untouched.
		await t.mutation(internal.files_nodes_content.delete_unfinalized_repair_assets, {
			assetIds: [yjsSnapshotAssetId, contentSnapshotAssetId],
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", contentSnapshotAssetId)).toBeNull();
		});
		const cleanupJobs = await read_deletion_jobs(t);
		expect(cleanupJobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
		expect(cleanupJobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [yjsSnapshotAssetId, contentSnapshotAssetId]),
		);
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("default repair rebuilds the document from its visible text, bumps the lineage, clears markers, and records the author", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const r2Writes = new Map<string, BodyInit>();
		generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
			const key = customKey ?? "test-upload-key";
			return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
		});
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
				if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
					const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
					r2Writes.set(key, init.body ?? "");
					return new Response(null, { status: 200 });
				}
				if (urlString.startsWith("https://r2.test/object?key=")) {
					const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
					const body = r2Writes.get(key);
					return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
				}
				return new Response(null, { status: 404 });
			}),
		);

		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-happy-path.md",
			textContent: "# Repair me\n\nBody text\n",
		});

		// Materialize once so the Yjs snapshot bytes exist in (mocked) R2.
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}

		// Poison: pretend materialization refused durably.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});

		// Capture the pre-repair committed content asset: it must survive the repair because the
		// older files_snapshots history row owns it and old-version restore reads it back.
		const preRepairPointers = await test_get_file_yjs_pointers(t, nodeId);
		const preRepairAssets = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const snapshot = node?.yjsSnapshotId ? await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId) : null;
			const snapshotAsset = snapshot ? await ctx.db.get("files_r2_assets", snapshot.assetId) : null;
			if (!node?.assetId || !snapshotAsset?.r2Key) {
				throw new Error("Expected committed content and Yjs assets before the repair");
			}
			return { contentAssetId: node.assetId, yjsR2Key: snapshotAsset.r2Key };
		});

		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}
		expect(repaired._yay.lineageGeneration).toBe(1);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the repaired node to stay editable");
			}
			// Markers cleared, author recorded.
			expect(node.contentShapeMismatchAt).toBeNull();
			expect(node.contentYjsStateTooLargeByteSize).toBeNull();
			expect(node.updatedBy).toBe(db.userId);

			// The lineage generation advanced and the counters were reset.
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			expect(node.yjsLastSequenceId).not.toBe(preRepairPointers.yjsLastSequenceId);
			expect(await ctx.db.get("files_yjs_docs_last_sequences", preRepairPointers.yjsLastSequenceId)).toBeNull();
			expect(lastSequenceDoc?.lineageGeneration).toBe(1);
			expect(lastSequenceDoc?.unmaterializedUpdateCount).toBe(0);
			expect(lastSequenceDoc?.unmaterializedUpdateBytes).toBe(0);

			// The newest version snapshot is the repair's content asset, authored by the repair author.
			const newestSnapshot = await ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", nodeId)
						.eq("archivedAt", -1),
				)
				.order("desc")
				.first();
			expect(newestSnapshot?.assetId).toBe(node.assetId);
			expect(newestSnapshot?.createdBy).toBe(db.userId);
			expect(newestSnapshot).toMatchObject({
				contentType: "text/markdown;charset=utf-8",
				yjsRootKind: "rich_text",
				collaborationEnabled: true,
			});

			// Retention: the superseded content asset and its object key survive for old-version
			// restore; only the superseded Yjs asset is removed by the cleanup continuation.
			const preRepairAsset = await ctx.db.get("files_r2_assets", preRepairAssets.contentAssetId);
			expect(preRepairAsset).not.toBeNull();
			expect(preRepairAsset?.r2Key).toBeTruthy();

			// Committed chunks were replaced with the repaired plain text.
			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			expect(chunks.length).toBeGreaterThan(0);
			expect(chunks.map((chunk) => chunk.plainTextChunk).join("")).toContain("Repair me");
		});

		const stalePush = await t.run(async (ctx) =>
			files_db_yjs_push_update(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId,
				expectedYjsLastSequenceId: preRepairPointers.yjsLastSequenceId,
				rootKind: "rich_text",
				update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				sessionId: "stale-pre-repair",
				materializeImmediately: false,
			}),
		);
		expect(stalePush._nay?.message).toBe(
			"This file changed while you were editing. Copy your local changes before reloading, then try again.",
		);

		for (let round = 0; round < 5; round += 1) {
			await delay(0);
			await t.finishInProgressScheduledFunctions();
		}
		const repairDeletionJob = (await read_deletion_jobs(t)).find((job) => job.r2Key === preRepairAssets.yjsR2Key);
		expect(repairDeletionJob?.putMayArriveUntil).toBeGreaterThan(Date.now());
	});

	// Seed a file whose frontmatter marker settled: create, materialize once (so the Yjs snapshot
	// bytes exist in mocked R2), push over-cap frontmatter, and materialize again so the marker
	// pair lands. Returns the node id and the live over-cap doc for follow-up diff pushes.
	async function seed_frontmatter_marked_file(args: {
		t: ReturnType<typeof test_convex>;
		asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		path: string;
	}) {
		const { t, asUser, db, path } = args;

		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path,
		});
		const seededMaterialize = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (seededMaterialize._nay) {
			throw new Error(seededMaterialize._nay.message);
		}

		const overCapMarkdown = `---\n${Array.from({ length: files_metadata_MAX_FRONTMATTER_FIELDS + 1 }, (_, index) => `field_${index}: ${index}`).join("\n")}\n---\n\n# Body\n`;
		const overCapYjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: overCapMarkdown });
		if ("_nay" in overCapYjsDoc) {
			throw new Error(overCapYjsDoc._nay.message);
		}
		const pushResult = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(overCapYjsDoc)),
			sessionId: "frontmatter-repair-session",
		});
		if (pushResult._nay) {
			throw new Error(pushResult._nay.message);
		}
		const settled = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: pushResult._yay.newSequence,
		});
		expect(settled._nay).toMatchObject({ message: "Frontmatter exceeds the index caps" });

		return { nodeId, overCapYjsDoc };
	}

	test("a frontmatter-marked file repairs from latest_state; still-over-cap frontmatter keeps the marker pair and skips the metadata index", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Frontmatter Repair User",
		});
		test_setup_r2_capture();

		const { nodeId, overCapYjsDoc } = await seed_frontmatter_marked_file({
			t,
			asUser,
			db,
			path: "/repair-frontmatter-over.md",
		});
		overCapYjsDoc.destroy();

		// The frontmatter marker alone qualifies for the default source: no acknowledgement flag.
		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}
		expect(repaired._yay.lineageGeneration).toBe(1);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the repaired node to stay editable");
			}
			// The visible text still carries over-cap frontmatter, so the marker pair stays set
			// with the fresh counts. Clearing it would hide the deliberately empty metadata index.
			expect(node.contentFrontmatterTooLargeFieldCount).toBe(files_metadata_MAX_FRONTMATTER_FIELDS + 1);
			expect(node.contentFrontmatterTooLargeIndexDocumentCount).toBeGreaterThan(
				files_metadata_MAX_FRONTMATTER_FIELDS + 1,
			);

			// The deadlock is resolved: the counters reset, so the user can push the fitting edit.
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			expect(lastSequenceDoc?.lineageGeneration).toBe(1);
			expect(lastSequenceDoc?.unmaterializedUpdateCount).toBe(0);
			expect(lastSequenceDoc?.unmaterializedUpdateBytes).toBe(0);

			// The chunks hold the newest text (the repair is lossless) while the metadata index
			// stays empty instead of throwing the insert helper's over-cap backstop.
			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			expect(chunks.map((chunk) => chunk.plainTextChunk).join("")).toContain("Body");
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", nodeId),
				)
				.collect();
			expect(metadataDocs).toHaveLength(0);
		});
	});

	test("a frontmatter-marked file whose newest text fits repairs from latest_state and clears the marker pair", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Frontmatter Repair Fits User",
		});
		test_setup_r2_capture();

		const { nodeId, overCapYjsDoc } = await seed_frontmatter_marked_file({
			t,
			asUser,
			db,
			path: "/repair-frontmatter-fits.md",
		});

		// The user reduced the frontmatter, but the marker still stands because the fitting
		// push's materialization has not run (convex-test never runs scheduled functions; in
		// production this is the budget-tripped state where that materialization cannot help).
		const fittingDoc = files_yjs_doc_clone({ yjsDoc: overCapYjsDoc });
		const fitted = files_yjs_doc_update_from_text({
			mut_yjsDoc: fittingDoc,
			text: "---\ntitle: Kept\n---\n\n# Small again\n",
			rootKind: "rich_text",
		});
		if (fitted._nay) {
			throw new Error(fitted._nay.message);
		}
		const fittingDiff = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: fittingDoc, yjsBeforeDoc: overCapYjsDoc });
		if (!fittingDiff) {
			throw new Error("Expected the fitting content to produce a diff update");
		}
		const fittingPush = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(fittingDiff),
			sessionId: "frontmatter-repair-session",
		});
		overCapYjsDoc.destroy();
		fittingDoc.destroy();
		if (fittingPush._nay) {
			throw new Error(fittingPush._nay.message);
		}

		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			// The repaired text's frontmatter fits, so the marker pair clears and the metadata
			// index is rebuilt.
			expect(node?.contentFrontmatterTooLargeFieldCount).toBeNull();
			expect(node?.contentFrontmatterTooLargeIndexDocumentCount).toBeNull();
			// The repair points the node at a new content snapshot, so its byte size must follow it.
			const contentAsset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			expect(contentAsset?.size).toBeGreaterThan(0);
			expect(node?.contentByteSize).toBe(contentAsset?.size);
			const metadataDocs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_source_fileNode_fieldPath", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", nodeId),
				)
				.collect();
			expect(metadataDocs.some((doc) => doc.fieldPath.includes("title"))).toBe(true);

			const chunks = await ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			expect(chunks.map((chunk) => chunk.plainTextChunk).join("")).toContain("Small again");
		});
	});

	test("finalize_file_yjs_repair syncs the updater sort doc", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const r2Writes = new Map<string, BodyInit>();
		generateUploadUrlSpy.mockImplementation(async (customKey?: string) => {
			const key = customKey ?? "test-upload-key";
			return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
		});
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
				if (urlString.startsWith("https://r2.test/upload") && init?.method === "PUT") {
					const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
					r2Writes.set(key, init.body ?? "");
					return new Response(null, { status: 200 });
				}
				if (urlString.startsWith("https://r2.test/object?key=")) {
					const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
					const body = r2Writes.get(key);
					return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
				}
				return new Response(null, { status: 404 });
			}),
		);

		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-sync.md",
			textContent: "# Repair me\n\nBody text\n",
		});
		const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			targetSequence: 0,
		});
		if (materialized._nay) {
			throw new Error(materialized._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
			await files_updated_by_db_delete_for_node(ctx, { nodeId });
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc).toBeNull();
		});

		// The repair action reaches the writer through `finalize_file_yjs_repair`.
		const repaired = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			authorUserId: db.userId,
		});
		if (repaired._nay) {
			throw new Error(repaired._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc, "finalize_file_yjs_repair syncs the updater doc").toMatchObject({
				userId: node?.updatedBy,
				name: node?.name,
				parentId: node?.parentId,
				nodeKind: node?.kind,
			});
			expect(doc?.archiveOperationId).toBeUndefined();
		});
	});
});
// #endregion yjs repair

describe("files_nodes.yjs_prepare_doc_last_snapshot", () => {
	test("returns the textKind beside the snapshot", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/prepare-root-kind.md",
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Prepare Root Kind User",
			email: "prepare-root-kind@example.com",
		});
		const prepared = await asUser.action(api.files_nodes.yjs_prepare_doc_last_snapshot, {
			membershipId: db.membershipId,
			nodeId: createdId,
		});
		// The response carries the stored shape so the client opens the matching editor.
		expect(prepared?.textKind).toBe("rich_text");
	});
});
