// The snapshot, restore, Yjs update and repair tests, split from files_nodes.content_yjs.test.ts so the two
// files can run at the same time.
import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import { getFunctionName } from "convex/server";
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
import { api, components, internal } from "./_generated/api.js";
import { files_content_sources_action_prepare } from "./files_content_sources.ts";
import { files_pending_update_runs_db_delete_run_batch } from "./files_pending_update_runs.ts";
import { upsert_file_pending_update_public_for_test } from "./files_pending_updates.setup.test.ts";
import {
	files_db_yjs_push_update,
	files_line_range_from_text,
	yjs_reserve_and_increment_last_sequence,
} from "./files_nodes.ts";
import {
	files_nodes_create_yjs_snapshot_update_from_text,
	files_nodes_db_fill_text_node_content,
} from "./files_nodes_content.ts";
import {
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_create_saved_text_file,
	test_finish_file_index,
	test_finish_pending_update_run,
	test_get_file_yjs_pointers,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_BYTES,
	files_MAX_UNMATERIALIZED_YJS_UPDATE_COUNT,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_node_has_editable_yjs_state,
	files_ROOT_ID,
	files_YJS_DOC_KEYS,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import { files_yjs_doc_create_from_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../shared/files-yjs.ts";
import { delay } from "../shared/async-utils.ts";
import { r2_server_side_copy } from "./r2_client.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
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
import { files_content_heads_db_wrap } from "../server/files-content-heads.ts";
import {
	seed_billing_snapshot_for_user,
	test_setup_r2_capture,
	test_materialize_markdown_file,
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
		subject: { kind: "user", userId: db.userId, plugin: null },
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
			subject: { kind: "user", userId: db.userId, plugin: null },
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
			subject: { kind: "user", userId: db.userId, plugin: null },
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
					subject: { kind: "user", userId: db.userId, plugin: null },
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
					subject: { kind: "user", userId: db.userId, plugin: null },
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
				extendedScopeNodeId: null,
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
				pendingContentVersion: 1,
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

	// Live typing sends a push after each short pause, so the bucket allows a burst of 30.
	for (let i = 0; i < 30; i++) {
		const result = await asUser.mutation(api.files_nodes.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected initial push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asUser.mutation(api.files_nodes.yjs_push_update, pushArgs);
	if (!blocked._nay) {
		throw new Error("Expected push 31 to be rate limited");
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
	expect(stateAfterBlock.updateCount).toBe(30);
	expect(stateAfterBlock.lastSequence).toBe(30);
	expect(stateAfterBlock.createdByList).toEqual(Array.from({ length: 30 }, () => db.userId));
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

	for (let i = 0; i < 30; i++) {
		const result = await asAnonymous.mutation(api.files_nodes.yjs_push_update, pushArgs);
		if (result._nay) {
			throw new Error(`Expected anonymous push #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	const blocked = await asAnonymous.mutation(api.files_nodes.yjs_push_update, pushArgs);
	if (!blocked._nay) {
		throw new Error("Expected anonymous push 31 to be rate limited");
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
		preparedSourceHeadId: (await t.run((ctx) => ctx.db.get("files_nodes", createdFileId)))!.contentHeadId!,
		membershipId: db.membershipId,
		nodeId: createdFileId,
		expectedPendingContentVersion: (await asUser.run((ctx) => ctx.db.get("files_nodes", createdFileId)))!
			.pendingContentVersion,
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
	// The charges wait in the usage event outbox and go to Polar in one batch.
	await test_drain_billing_usage_event_outbox(t);
	const usageEvents = enqueueActionSpy.mock.calls.flatMap((call) => {
		const args = call[2] as {
			events: Array<{
				externalId: string;
				metadata: { modelCallId: string; purpose: string };
			}>;
		};
		return args.events;
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
	const prepared = await t.action((ctx) => files_content_sources_action_prepare(ctx, {
		nodeId: createdFileId, assetId: restoreAssets.restoredSnapshotAssetId, text: restoredMarkdown,
	}));
	if (prepared._nay) throw new Error(prepared._nay.message);
	const restoreResult = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
		preparedSourceHeadId: prepared._yay,
		membershipId: db.membershipId,
		nodeId: createdFileId,
		expectedPendingContentVersion: (await asUser.run((ctx) => ctx.db.get("files_nodes", createdFileId)))!
			.pendingContentVersion,
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

		const result = await t.mutation(internal.files_nodes_create.create_file_node, {
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
			subject: { kind: "user", userId: db.userId, plugin: null },
			path: MOUNT_FILE_PATH,
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(full?.content).toBe(MOUNT_RAW_TEXT);

		// Line-range read matches the same window computed directly from the source.
		const lineRange = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			subject: { kind: "user", userId: db.userId, plugin: null },
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
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
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
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
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

		const created = await t.mutation(internal.files_nodes_create.create_file_node, {
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
			// Direct fixtures keep the same content owners as registered mutations.
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
		await test_finish_file_index(t, nodeId);
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
		await test_finish_file_index(t, nodeId);

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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
				ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
	test("Review history cleanup keeps the live log owner after materialization", async () => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const objects = test_setup_r2_capture();
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId, path: "/review-log.txt", textContent: "Original\n",
		});
		expect(await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: db.membershipId, nodeId, stagedMarkdown: "Reviewed\n", unstagedMarkdown: "Reviewed\n",
		})).toHaveProperty("_yay");
		const proposal = (await t.run((ctx) => ctx.db.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.unique()))!;
		const started = await asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId, requestId: crypto.randomUUID(), kind: "accept", expectedItemCount: 1,
			items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: proposal.content!.stagedStateId }],
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toHaveProperty("_yay");
		await test_finish_pending_update_run(asUser, runId);
		const reviewed = await t.run(async (ctx) => {
			const node = (await ctx.db.get("files_nodes", nodeId))!;
			const head = (await ctx.db.get("files_saved_content_heads", node.contentHeadId!))!;
			const snapshot = (await ctx.db.get("files_yjs_snapshots", head.yjsSnapshotId!))!;
			const cohort = (await ctx.db.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId)).first())!;
			return { head, cohort, asset: (await ctx.db.get("files_r2_assets", snapshot.assetId))! };
		});
		expect(reviewed.cohort.phase).toBe("complete");
		expect(reviewed.head.yjsContentHeadId).toBe(reviewed.head._id);
		const editor = new YjsDoc();
		const stored = objects.get(reviewed.asset.r2Key!);
		if (!stored) throw new Error("Expected the reviewed editor bytes");
		applyUpdate(editor, new Uint8Array(await new Response(stored).arrayBuffer()));
		const text = editor.getText(files_YJS_DOC_KEYS.plainText);
		const push = async (addition: string) => {
			const before = encodeStateVector(editor);
			text.insert(text.length, addition);
			const result = await asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId: db.membershipId, nodeId, expectedYjsLastSequenceId: reviewed.head.yjsLastSequenceId!,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, before)), sessionId: "review-log-editor",
			});
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.newSequence;
		};
		const cleaned = new Set<string>();
		const cleanup_sources = async () => {
			for (let step = 0; step < 100; step++) {
				const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
				const job = jobs.find((job) => !cleaned.has(job._id) && job.state.kind === "pending" && job.scheduledTime <= Date.now() &&
					[getFunctionName(internal.files_content_saves.retire), getFunctionName(internal.files_content_saves.discard)].includes(job.name));
				if (!job) return;
				cleaned.add(job._id);
				await t.mutation(job.name === getFunctionName(internal.files_content_saves.retire)
					? internal.files_content_saves.retire : internal.files_content_saves.discard,
					job.args[0] as { headId: Id<"files_saved_content_heads"> });
			}
			throw new Error("Source cleanup did not finish");
		};
		try {
			const sequence = await push("Before cleanup\n");
			expect(await t.action(internal.files_nodes_content.materialize_file_content, {
				organizationId: db.organizationId, workspaceId: db.workspaceId, nodeId, userId: db.userId, targetSequence: sequence,
			})).toHaveProperty("_yay");
			await test_finish_file_index(t, nodeId);
			await cleanup_sources();
			const current = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
			expect(current.contentHeadId).not.toBe(reviewed.head._id);
			expect(await t.run((ctx) => ctx.db.get("files_saved_content_heads", current.contentHeadId!)))
				.toMatchObject({ yjsContentHeadId: reviewed.head._id });
			expect(await t.run((ctx) => ctx.db.get("files_saved_content_heads", reviewed.head._id)))
				.toMatchObject({ retired: true, statsId: null });
			for (let step = 0; step < 100; step++) {
				const content = await t.run((ctx) => ctx.db.query("files_move_cohort_content")
					.withIndex("by_cohort_node", (q) => q.eq("cohortId", reviewed.cohort._id).eq("nodeId", nodeId)).first());
				if (content?.storageResourceCount === 0) break;
				await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
				if (step === 99) throw new Error("Review resource cleanup did not finish");
			}
			for (let step = 0; step < 100; step++) {
				const removed = await test_run_with_flush(t, (ctx) => files_pending_update_runs_db_delete_run_batch(ctx, { runId }));
				if (removed.done) break;
				if (step === 99) throw new Error("Review history cleanup did not finish");
			}
			await t.mutation(internal.files_move_cohorts.cleanup, { cohortId: reviewed.cohort._id });
			expect(await t.run((ctx) => ctx.db.query("files_move_cohort_content")
				.withIndex("by_cohort_node", (q) => q.eq("cohortId", reviewed.cohort._id).eq("nodeId", nodeId)).first())).toBeNull();
			await cleanup_sources();
			expect(await t.run((ctx) => ctx.db.get("files_saved_content_heads", reviewed.head._id)),
				"history cleanup keeps the live Yjs owner").toMatchObject({ retired: true, statsId: null });
			expect(await t.run((ctx) => ctx.db.query("files_text_chunks")
				.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", reviewed.head._id)).first()),
				"retired source chunks are removed while the live log owner stays").toBeNull();
			await push("After cleanup\n");
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
				subject: { kind: "user", userId: db.userId, plugin: null }, path: "/review-log.txt", includePending: false,
			});
			expect(read?.content, "later edits remain readable after Review history cleanup")
				.toBe("Reviewed\nBefore cleanup\nAfter cleanup\n");

			const nextSequence = await t.run(async (ctx) =>
				(await ctx.db.get("files_yjs_docs_last_sequences", reviewed.head.yjsLastSequenceId!))!.lastSequence);
			expect(await t.action(internal.files_nodes_content.materialize_file_content, {
				organizationId: db.organizationId, workspaceId: db.workspaceId, nodeId, userId: db.userId,
				targetSequence: nextSequence,
			})).toHaveProperty("_yay");
			await test_finish_file_index(t, nodeId);
			await cleanup_sources();
			expect(await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId, nodeId, acknowledgeDropCollaborativeHistory: true,
			})).toHaveProperty("_yay");
			for (let step = 0; step < 100; step++) {
				const task = await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").first());
				if (!task) break;
				await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
				if (step === 99) throw new Error("OFF cleanup did not finish");
			}
			await cleanup_sources();
			expect(await t.run((ctx) => ctx.db.get("files_saved_content_heads", reviewed.head._id)),
				"turning collaboration off releases its unused log owner").toBeNull();
		} finally {
			editor.destroy();
		}
	});

	test.each([false, true])("materialization keeps a later editor update across source rotation: migrated %s", async (migrate) => {
		vi.useFakeTimers();
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const objects = test_setup_r2_capture();
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId, path: "/materialization-tail.txt", textContent: "Original\n",
		});
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		const original = await t.run(async (ctx) => {
			const node = (await ctx.db.get("files_nodes", nodeId))!;
			const snapshot = (await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId))!;
			return { headId: node.contentHeadId!, asset: (await ctx.db.get("files_r2_assets", snapshot.assetId))! };
		});
		const editor = new YjsDoc();
		const stored = objects.get(original.asset.r2Key!);
		if (!stored) throw new Error("Expected the saved editor bytes");
		applyUpdate(editor, new Uint8Array(await new Response(stored).arrayBuffer()));
		const text = editor.getText(files_YJS_DOC_KEYS.plainText);
		const firstVector = encodeStateVector(editor);
		text.insert(text.length, "First edit\n");
		const first = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId, nodeId, expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, firstVector)), sessionId: "first-editor",
		});
		if (first._nay) throw new Error(first._nay.message);
		if (migrate) {
			migrations_test.register(t as unknown as Parameters<typeof migrations_test.register>[0]);
			const rows = await t.run((ctx) => ctx.db.query("files_yjs_updates").collect());
			await t.run((ctx) => ctx.db.patch("files_saved_content_heads", original.headId, { yjsContentHeadId: undefined }));
			await t.run((ctx) => runToCompletion(ctx, components.migrations, internal.migrations.backfill_saved_content_yjs_owner));
			expect(await t.run((ctx) => ctx.db.query("files_yjs_updates").collect()), "migration keeps every stored update and owner ID").toEqual(rows);
			expect(await t.run((ctx) => ctx.db.get("files_saved_content_heads", original.headId))).toMatchObject({ yjsContentHeadId: original.headId });
		}
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const capturedFetch = fetch;
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "PUT" && init.body === "Original\nFirst edit\n") {
				entered.resolve();
				await resume.promise;
			}
			return await capturedFetch(input, init);
		}));
		const materializing = t.action(internal.files_nodes_content.materialize_file_content, {
			organizationId: db.organizationId, workspaceId: db.workspaceId, nodeId, userId: db.userId,
			targetSequence: first._yay.newSequence,
		});
		await entered.promise;
		try {
			const laterVector = encodeStateVector(editor);
			text.insert(text.length, "Later edit\n");
			const laterBytes = files_u8_to_array_buffer(encodeStateAsUpdate(editor, laterVector));
			const later = await asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId: db.membershipId, nodeId, expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
				update: laterBytes, sessionId: "later-editor",
			});
			if (later._nay) throw new Error(later._nay.message);
			resume.resolve();
			expect(await materializing, "the captured source may publish while later edits wait").toHaveProperty("_yay");
			const current = await t.run(async (ctx) => ({
				node: (await ctx.db.get("files_nodes", nodeId))!,
				sequence: await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId),
			}));
			expect(current.node.contentHeadId, "source publication selects a new exact-text owner").not.toBe(original.headId);
			expect(current.sequence, "the later update stays counted after the covered edits publish").toMatchObject({
				lastSequence: later._yay.newSequence, unmaterializedUpdateCount: 1, unmaterializedUpdateBytes: laterBytes.byteLength,
			});
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
				subject: { kind: "user", userId: db.userId, plugin: null }, path: "/materialization-tail.txt", includePending: false,
			});
			expect(read?.content, "direct reads keep the later edit after source rotation").toBe("Original\nFirst edit\nLater edit\n");
			const head = await t.run((ctx) => ctx.db.get("files_saved_content_heads", current.node.contentHeadId!));
			expect(head?.yjsContentHeadId, "the new source keeps the live update owner").toBe(original.headId);
		} finally {
			resume.resolve();
			await materializing;
			editor.destroy();
		}
	});

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
				ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
			preparedSourceHeadId: (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!.contentHeadId!,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			expectedPendingContentVersion: (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!.pendingContentVersion,
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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
	// bytes exist in mocked R2), then seed the old marker for a migration-era repair.
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
		expect(settled._nay).toBeUndefined();
		// This marker can remain on data saved before background indexing was introduced.
		await t.run(async (ctx) => {
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
			await ctx.db.patch("files_nodes", nodeId, {
				contentFrontmatterTooLargeFieldCount: files_metadata_MAX_FRONTMATTER_FIELDS + 1,
				contentFrontmatterTooLargeIndexDocumentCount: (files_metadata_MAX_FRONTMATTER_FIELDS + 1) * 2,
			});
		});

		return { nodeId, overCapYjsDoc };
	}

	test("a frontmatter-marked file repairs from latest_state and indexes all fields", async () => {
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
		await test_finish_file_index(t, nodeId);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the repaired node to stay editable");
			}
			expect(node.contentFrontmatterTooLargeFieldCount).toBeNull();
			expect(node.contentFrontmatterTooLargeIndexDocumentCount).toBeNull();

			// The deadlock is resolved: the counters reset, so the user can push the fitting edit.
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			expect(lastSequenceDoc?.lineageGeneration).toBe(1);
			expect(lastSequenceDoc?.unmaterializedUpdateCount).toBe(0);
			expect(lastSequenceDoc?.unmaterializedUpdateBytes).toBe(0);

			// Both the complete text and every metadata value survive repair.
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
			expect(metadataDocs.filter((doc) => doc.docKind === "value"))
				.toHaveLength(files_metadata_MAX_FRONTMATTER_FIELDS + 1);
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

		await test_finish_file_index(t, nodeId);
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
			ctx = { ...ctx, db: files_content_heads_db_wrap(ctx).db };
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

describe("files_yjs_load.yjs_prepare_doc_last_snapshot", () => {
	test("returns the textKind beside the snapshot", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
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
		const prepared = await asUser.action(api.files_yjs_load.yjs_prepare_doc_last_snapshot, {
			membershipId: db.membershipId,
			nodeId: createdId,
		});
		// The response carries the stored shape so the client opens the matching editor.
		expect(prepared?.textKind).toBe("rich_text");
	});
});
