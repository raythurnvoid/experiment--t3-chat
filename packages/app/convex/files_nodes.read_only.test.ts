// The tests from the upload plan gate on, most of them read-only and write policy tests, split from
// files_nodes.test.ts so the two files can run at the same time. Keep the mocks the same as in that file.
// No test here reads the enqueueAction spy, so this file does not keep it in a variable.
import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import { files_content_sources_action_prepare } from "./files_content_sources.ts";
import { files_nodes_db_hard_delete_node } from "./files_nodes.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes_create_db.ts";
import { files_nodes_db_require_writable, type files_nodes_WriteContext } from "../server/files-write-policy.ts";
import { files_nodes_create_yjs_snapshot_update_from_text } from "./files_nodes_content.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import {
	test_apply_file_pending_move,
	test_convex,
	test_rename_node,
	test_move_nodes,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_finish_archive_jobs,
} from "./setup.test.ts";
import {
	files_node_has_editable_yjs_state,
	files_ROOT_ID,
	files_INITIAL_CONTENT,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
import type { Id } from "./_generated/dataModel.js";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	seed_billing_snapshot_for_user,
	propose_move_for_test,
	test_setup_r2_capture,
	test_materialize_markdown_file,
	seed_unpublished_asset_pair,
	read_deletion_jobs,
	expected_ledger_keys,
} from "./files_nodes.setup.test.ts";
import { accept_move_proposals_for_test } from "./files_nodes.move_nodes.setup.test.ts";

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

let generateUploadUrlSpy: ReturnType<typeof vi.fn<(customKey?: string) => Promise<{ key: string; url: string }>>>;
const test = baseTest;

beforeEach(() => {
	generateTextMock.mockReset();
	streamTextMock.mockReset();
	inlineAiProvider.model = null;
	// Keep file tests focused on file behavior; billing event enqueue behavior is
	// covered in billing tests.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
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

describe("upload plan gate", () => {
	const PLAN_REFUSAL = "File uploads need a paid plan";

	async function read_upload_docs(t: ReturnType<typeof test_convex>) {
		return await t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			assets: await ctx.db.query("files_r2_assets").collect(),
		}));
	}

	test("create_upload_node refuses a Free payer and writes nothing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx, { plan: "Free" }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const before = await read_upload_docs(t);

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		expect(upload._nay?.message).toBe(PLAN_REFUSAL);

		// The refusal has to land before the node and the asset are written, because a mutation that
		// returns `_nay` still commits whatever it wrote first.
		const after = await read_upload_docs(t);
		expect(after.nodes).toHaveLength(before.nodes.length);
		expect(after.assets).toHaveLength(before.assets.length);
	});

	test("create_upload_node refuses a payer with no billing state at all", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx, { plan: null }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		expect(upload._nay?.message).toBe(PLAN_REFUSAL);
	});

	test("create_upload_nodes refuses a Free payer and imports nothing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx, { plan: "Free" }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const before = await read_upload_docs(t);

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "docs/report.pdf", contentType: "application/pdf", size: 1234 },
				{ relativePath: "docs/img/logo.png", contentType: "image/png", size: 10 },
			],
		});
		expect(imported._nay?.message).toBe(PLAN_REFUSAL);

		// The whole import is refused, not reported as two skipped items, so the folders on the way
		// must not be created either.
		const after = await read_upload_docs(t);
		expect(after.nodes).toHaveLength(before.nodes.length);
		expect(after.assets).toHaveLength(before.assets.length);
	});

	test("an owner-billed organization reads the owner's plan, not the acting member's", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx, { plan: "Free" }));
		const ownerUserId = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			// Ownership carries every permission, so the acting member needs a role of their own once the
			// organization belongs to someone else. `admin` is the role that has everything except billing.
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				role: "admin",
				now,
			});
			await ctx.db.patch("organizations", db.organizationId, {
				billingMode: "organization_owner",
				ownerUserId: userId,
			});
			return userId;
		});
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: ownerUserId, plan: "Pro" }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		// The member is on Free and the owner pays, so the upload is allowed.
		const allowed = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "allowed.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		expect(allowed._nay).toBeUndefined();

		// Move the owner to Free. The member's own plan never changed, so a refusal here can only come
		// from reading the owner.
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: ownerUserId, plan: "Free" }));
		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "refused.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		expect(refused._nay?.message).toBe(PLAN_REFUSAL);
	});

	test("a Free payer can still create a text file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx, { plan: "Free" }));

		// The gate is on uploads, not on writes. Text files answer to the credit gate instead, and
		// `Free` passes it while it still has credits.
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "notes.md",
		});
		expect(created._nay).toBeUndefined();
	});
});

describe("files_nodes.get_upload_conflicts", () => {
	test("reports nodes on the target paths with their kind", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (uploaded._nay) {
			throw new Error(uploaded._nay.message);
		}
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "docs",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const conflicts = await asUser.query(api.files_nodes.get_upload_conflicts, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			relativePaths: ["dup.pdf", "docs", "missing.pdf"],
		});
		expect(conflicts).toEqual([
			{ relativePath: "dup.pdf", kind: "file" },
			{ relativePath: "docs", kind: "folder" },
		]);
	});

	test("throws on more paths than one import call accepts", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		await expect(
			asUser.query(api.files_nodes.get_upload_conflicts, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				relativePaths: Array.from({ length: 51 }, (_, index) => `f${index}.pdf`),
			}),
		).rejects.toThrow("Too many paths");
	});
});

describe("files_nodes.discard_failed_upload_node", () => {
	test("removes an unfinalized upload and keeps its exact-key job through URL expiry", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "temp.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		const nodeId = imported._yay.created[0]!.nodeId;
		const assetId = imported._yay.created[0]!.assetId;
		const liveKey = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${assetId}`;

		// The object may exist even when its event has not stored `r2Key` yet.
		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay.removed).toBe(true);

		const docs = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			asset: await ctx.db.get("files_r2_assets", assetId),
		}));
		expect(docs.node).toBeNull();
		expect(docs.asset).toBeNull();
		const cleanupJobs = await t.run(async (ctx) => await ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(cleanupJobs).toHaveLength(1);
		expect(cleanupJobs.find((job) => job.r2Key === liveKey)).toMatchObject({
			reason: "untracked_asset_event",
			generation: 1,
			putMayArriveUntil: expect.any(Number),
		});
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("keeps the node once the R2 event recorded the object", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "temp.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		const nodeId = imported._yay.created[0]!.nodeId;
		const assetId = imported._yay.created[0]!.assetId;
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", assetId, {
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${assetId}`,
			});
		});

		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay.removed).toBe(false);

		const node = await t.run(async (ctx) => await ctx.db.get("files_nodes", nodeId));
		expect(node).not.toBeNull();
		expect(deleteObjectSpy).not.toHaveBeenCalled();
	});

	test("answers Not found for a folder node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "keep",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId: folder._yay.nodeId,
		});
		expect(discarded._nay).toMatchObject({ message: "Not found" });
	});
});

describe("files_nodes_db_hard_delete_node", () => {
	test("keeps the cleanup deadline when deleting a file before its history worker runs", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		test_setup_r2_capture();
		const nodeId = await test_materialize_markdown_file({
			t,
			asUser,
			db,
			path: "/delete-cleanup.md",
			markdown: "# Kept until deletion\n",
		});

		// Hold the scheduled worker so deletion must take ownership of its asset.
		vi.useFakeTimers();
		try {
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			const task = await t.run(async (ctx) =>
				ctx.db
					.query("files_yjs_cleanup_tasks")
					.withIndex("by_organization_workspace_fileNode_historyPending", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", nodeId)
							.eq("historyPending", true),
					)
					.unique(),
			);
			if (!task) throw new Error("Missing cleanup task");
			expect(task.putMayArriveUntil).toBeGreaterThan(Date.now());
			const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", task.supersededYjsAssetId));
			if (!asset?.r2Key) throw new Error("Missing cleanup asset key");
			const r2Key = asset.r2Key;

			await t.run(async (ctx) =>
				files_nodes_db_hard_delete_node(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId,
				}),
			);
			const deleted = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				task: await ctx.db.get("files_yjs_cleanup_tasks", task._id),
				asset: await ctx.db.get("files_r2_assets", task.supersededYjsAssetId),
				job: await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
					.unique(),
			}));
			expect(deleted.node).toBeNull();
			expect(deleted.task).toBeNull();
			expect(deleted.asset).toBeNull();
			expect(deleted.job).toMatchObject({ r2Key, putMayArriveUntil: task.putMayArriveUntil });
			await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		} finally {
			vi.useRealTimers();
		}
	});
});

test("rename_node returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		path: db.files.file_root_1.name,
	});
	if (!("_nay" in renameResult)) {
		throw new Error("Expected rename to fail with path conflict");
	}

	const renameError = renameResult._nay;
	if (!renameError) {
		throw new Error("Expected rename error details");
	}
	expect(renameError.message).toContain("Path already exists");

	await t.run(async (ctx) => {
		const fileRoot2 = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(fileRoot2?.name).toBe(db.files.file_root_2.name);
		expect(fileRoot2?.path).toBe(`/${db.files.file_root_2.name}`);
	});
});

test("rename_node preserves caller-provided file names", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rename-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "renamed-extensionless",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to preserve caller-provided file name", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(fileNode?.name).toBe("renamed-extensionless");
		expect(fileNode?.path).toBe("/renamed-extensionless");
	});
});

test("rename_node creates missing folders for nested file paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "rename-path-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "notes/workspaces/plan.md",
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to create the nested file path", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(fileNode?.name).toBe("plan.md");
		expect(fileNode?.path).toBe("/notes/workspaces/plan.md");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/notes/workspaces"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), null))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(fileNode?.parentId).toBe(parentFolder?._id);
	});
});

test.each([
	["readme", "README.md"],
	["README", "README.md"],
	["readme.md", "README.md"],
	["agents.md", "AGENTS.md"],
	["skill.md", "SKILL.md"],
])("rename_node normalizes special nested name %s", async (input, name) => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	// Use the supported editable file flow so this checks naming without a stored-type conflict.
	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: db.files.file_root_1._id,
		path: "yo.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected nested file creation to succeed", {
			cause: createdFile._nay,
		});
	}
	const nestedFileId = createdFile._yay.nodeId;

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: nestedFileId,
		path: `.AGENTS/${input}`,
	});
	if (renameResult._nay) {
		throw new Error("Expected rename_node to preserve nested README file name", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", nestedFileId);
		expect(fileNode?.name).toBe(name);
		expect(fileNode?.path).toBe(`/${db.files.file_root_1.name}/.agents/${name}`);
	});
});

test("rename_node keeps the stored type when the extension changes", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "unsupported-source.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected source file creation to succeed", {
			cause: createdFile._nay,
		});
	}

	// A rename never converts content and never changes the stored type. A Markdown file may
	// take any extension and stays Markdown.
	const crossingResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "renamed-source.txt",
	});
	if (crossingResult._nay) {
		throw new Error("Expected the extension change to succeed", {
			cause: crossingResult._nay,
		});
	}

	const afterCrossing = await t.run(async (ctx) => ctx.db.get("files_nodes", createdFile._yay.nodeId));
	expect(afterCrossing?.name).toBe("renamed-source.txt");
	expect(afterCrossing?.contentType).toBe("text/markdown;charset=utf-8");
	expect(afterCrossing?.textKind).toBe("rich_text");

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		path: "renamed-source.md",
	});
	if (renameResult._nay) {
		throw new Error("Expected the basename rename to succeed", {
			cause: renameResult._nay,
		});
	}

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", createdFile._yay.nodeId));
	expect(after?.name).toBe("renamed-source.md");
	expect(after?.path).toBe("/renamed-source.md");
	expect(after?.contentType).toBe("text/markdown;charset=utf-8");
});

test("rename_node creates missing folders for nested folder paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		path: "invalid/name",
	});

	if (renameResult._nay) {
		throw new Error("Expected rename_node to create the nested folder path", {
			cause: renameResult._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(folderFileNode?.name).toBe("name");
		expect(folderFileNode?.path).toBe("/invalid/name");

		const parentFolder = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/invalid"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), null))
			.first();
		expect(parentFolder?.kind).toBe("folder");
		expect(folderFileNode?.parentId).toBe(parentFolder?._id);
	});
});

test("move_nodes returns conflict and keeps original path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const conflictingSibling = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: db.files.file_root_2._id,
		path: db.files.file_root_1_child_1.name,
		membershipId: db.membershipId,
	});
	if (conflictingSibling._nay) {
		throw new Error("Expected conflicting sibling creation to succeed");
	}

	const moveResult = await test_move_nodes(t, asUser, {
		itemIds: [db.files.file_root_1_child_1._id],
		targetParentId: db.files.file_root_2._id,
		membershipId: db.membershipId,
	});
	if (!("_nay" in moveResult)) {
		throw new Error("Expected move to fail with path conflict");
	}

	const moveError = moveResult._nay;
	if (!moveError) {
		throw new Error("Expected move error details");
	}
	expect(moveError.name).toBe("name_conflict");

	await t.run(async (ctx) => {
		const child1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1._id);
		expect(child1?.parentId).toBe(db.files.file_root_1._id);
		expect(child1?.path).toBe(`/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`);
	});
});

test("create_folder_node allows tenant files under /.mounts", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: ".mounts",
		membershipId: db.membershipId,
	});
	if (result._nay) {
		throw new Error("Expected creating tenant /.mounts to succeed", { cause: result._nay });
	}

	const node = await asUser.query(internal.files_nodes.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		visibilityUserId: db.userId,
		subject: { kind: "user", userId: db.userId, plugin: null },
		path: "/.mounts",
	});
	expect(node?._id).toBe(result._yay.nodeId);
	expect(node?.name).toBe(".mounts");
});

test("unarchive_nodes waits for a choice when an active file already has the same path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await t.run(async (ctx) =>
		ctx.db.patch("files_nodes", db.files.file_root_2._id, {
			archiveOperationId: "unarchive-conflict-test",
			name: db.files.file_root_1.name,
			path: `/${db.files.file_root_1.name}`,
		}),
	);

	const unarchiveResult = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});
	expect(unarchiveResult._nay).toBeUndefined();

	await t.run(async (ctx) => {
		const fileRoot2 = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(fileRoot2?.archiveOperationId).toBe("unarchive-conflict-test");

		const run = await ctx.db.get("files_archive_runs", unarchiveResult._yay!.runId);
		expect(run?.conflict).toEqual({ nodeId: db.files.file_root_2._id, occupantId: db.files.file_root_1._id });
		const activity = await ctx.db.get("activities", unarchiveResult._yay!.activityId);
		expect(activity?.status).toBe("awaiting_input");
	});
});

test("archive_nodes and unarchive_nodes leave root generated siblings independent from the source", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const { sourceNodeId, generatedNodeId } = await test_run_with_flush(t, async (ctx) => {
		const sharedNode = {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			sortName: files_sort_text_key("report.pdf"),
			path: "/report.pdf",
			treePath: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			sortName: files_sort_text_key("report.pdf.md"),
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [sourceNodeId],
	});

	const archivedDocs = await t.run(async (ctx) => {
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { sourceFileNode, generatedFileNode };
	});
	expect(archivedDocs.sourceFileNode?.archiveOperationId).toEqual(expect.any(String));
	expect(archivedDocs.generatedFileNode?.archiveOperationId).toBeNull();

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [sourceNodeId],
	});

	const unarchivedDocs = await t.run(async (ctx) => {
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { sourceFileNode, generatedFileNode };
	});
	expect(unarchivedDocs.sourceFileNode?.archiveOperationId).toBeNull();
	expect(unarchivedDocs.generatedFileNode?.archiveOperationId).toBeNull();
});

test("archive_nodes and unarchive_nodes include generated siblings as normal folder descendants", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const { folderId, sourceNodeId, generatedNodeId } = await test_run_with_flush(t, async (ctx) => {
		const folderId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "folder",
			kind: "folder",
			path: "/folder",
			treePath: "/folder/",
		});
		const sharedNode = {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: folderId,
			kind: "file" as const,
		};
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf",
			sortName: files_sort_text_key("report.pdf"),
			path: "/folder/report.pdf",
			treePath: "/folder/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			sortName: files_sort_text_key("report.pdf.md"),
			path: "/folder/report.pdf.md",
			treePath: "/folder/report.pdf.md",
		});

		return { folderId, sourceNodeId, generatedNodeId };
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [folderId],
	});
	await test_finish_archive_jobs(t);

	const archivedDocs = await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", folderId);
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { folderFileNode, sourceFileNode, generatedFileNode };
	});
	expect(archivedDocs.folderFileNode?.archiveOperationId).toEqual(expect.any(String));
	expect(archivedDocs.sourceFileNode?.archiveOperationId).toBe(archivedDocs.folderFileNode?.archiveOperationId);
	expect(archivedDocs.generatedFileNode?.archiveOperationId).toBe(archivedDocs.folderFileNode?.archiveOperationId);

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [folderId],
	});

	const unarchivedDocs = await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", folderId);
		const sourceFileNode = await ctx.db.get("files_nodes", sourceNodeId);
		const generatedFileNode = await ctx.db.get("files_nodes", generatedNodeId);
		return { folderFileNode, sourceFileNode, generatedFileNode };
	});
	expect(unarchivedDocs.folderFileNode?.archiveOperationId).toBeNull();
	expect(unarchivedDocs.sourceFileNode?.archiveOperationId).toBeNull();
	expect(unarchivedDocs.generatedFileNode?.archiveOperationId).toBeNull();
});

test("unarchive_nodes restores the whole archive operation of a named child", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1._id],
	});
	await test_finish_archive_jobs(t);

	const unarchiveResult = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1_child_1._id],
	});
	expect(unarchiveResult).toEqual({ _yay: null });

	// The folder and the child were archived together, so naming the child brings both back in place.
	await t.run(async (ctx) => {
		const fileRoot1 = await ctx.db.get("files_nodes", db.files.file_root_1._id);
		const fileRoot1Child1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1._id);
		const fileRoot1Child1Deep1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id);

		expect(fileRoot1?.archiveOperationId).toBeNull();
		expect(fileRoot1Child1?.archiveOperationId).toBeNull();
		expect(fileRoot1Child1Deep1?.archiveOperationId).toBeNull();
		expect(fileRoot1Child1?.parentId).toBe(db.files.file_root_1._id);
		expect(fileRoot1Child1?.path).toBe(`/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`);
		expect(fileRoot1Child1Deep1?.parentId).toBe(db.files.file_root_1_child_1._id);
	});
});

test("get_by_path ignores archived files with duplicate path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});

	const renameArchived = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_2._id,
		path: db.files.file_root_1.name,
	});
	if (renameArchived._nay) {
		throw new Error("Expected archived rename to succeed");
	}

	const resolvedRoot1 = await asUser.query(internal.files_nodes.get_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		visibilityUserId: db.userId,
		subject: { kind: "user", userId: db.userId, plugin: null },
		path: `/${db.files.file_root_1.name}`,
	});

	expect(resolvedRoot1?._id).toBe(db.files.file_root_1._id);
});

test("private file publication creates active ancestors instead of reusing archived nodes", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});

	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: `/${db.files.file_root_2.name}/new-leaf.md`,
	});

	await t.run(async (ctx) => {
		const root2Path = `/${db.files.file_root_2.name}`;
		const filesAtRoot2Path = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", root2Path),
			)
			.collect();
		expect(filesAtRoot2Path).toHaveLength(2);

		const activeRoot2 = filesAtRoot2Path.find((fileNode) => fileNode.archiveOperationId === null);
		if (!activeRoot2) {
			throw new Error("Expected active root2 file to exist");
		}

		expect(activeRoot2._id).not.toBe(db.files.file_root_2._id);

		const createdLeaf = await ctx.db.get("files_nodes", nodeId);
		expect(createdLeaf?.parentId).toBe(activeRoot2._id);
		expect(createdLeaf?.path).toBe(`/${db.files.file_root_2.name}/new-leaf.md`);
	});
});

test("N07 rename_node idempotency: same name no-op", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const before = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id));

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		path: db.files.file_root_1.name,
	});
	expect(renameResult).not.toHaveProperty("_nay");

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id));
	expect(after?.path).toBe(before?.path);
	expect(after?.name).toBe(before?.name);
});

test("N08 move_nodes idempotency: same parent no-op", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const before = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1._id));

	const moveResult = await test_move_nodes(t, asUser, {
		itemIds: [db.files.file_root_1_child_1._id],
		targetParentId: db.files.file_root_1._id,
		membershipId: db.membershipId,
	});
	expect(moveResult).not.toHaveProperty("_nay");

	const after = await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1._id));
	expect(after?.parentId).toBe(before?.parentId);
	expect(after?.path).toBe(before?.path);
	// A same-parent drop is a full no-op: no updatedBy/updatedAt stamp.
	expect(after?.updatedBy).toBe(before?.updatedBy);
	expect(after?.updatedAt, "same-parent Move keeps the saved timestamp").toBe(before?.updatedAt);
});

test("N09 archive idempotency", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await t.run(async (ctx) =>
		ctx.db.patch("files_nodes", db.files.file_root_2._id, {
			archiveOperationId: "archive-idempotency-test",
		}),
	);

	const archiveAgain = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});
	expect(archiveAgain).not.toHaveProperty("_nay");

	await t.run(async (ctx) => {
		const p = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(p?.archiveOperationId).toBe("archive-idempotency-test");
	});
});

test("N09 unarchive idempotency", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const unarchiveAgain = await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_2._id],
	});
	expect(unarchiveAgain).not.toHaveProperty("_nay");

	await t.run(async (ctx) => {
		const p = await ctx.db.get("files_nodes", db.files.file_root_2._id);
		expect(p?.archiveOperationId).toBeNull();
	});
});

test("N02 archive child then parent then unarchive parent keeps the child's own archive", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	// Seed the pre-archived child subtree so this test spends rate-limit writes
	// on the parent archive and unarchive behavior under test.
	await t.run(async (ctx) => {
		const childArchiveOperationId = "test_child_archive_operation";
		await Promise.all([
			ctx.db.patch("files_nodes", db.files.file_root_1_child_1._id, {
				archiveOperationId: childArchiveOperationId,
			}),
			ctx.db.patch("files_nodes", db.files.file_root_1_child_1_deep_1._id, {
				archiveOperationId: childArchiveOperationId,
			}),
		]);
	});

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1._id],
	});
	await test_finish_archive_jobs(t);

	await asUser.mutation(api.files_nodes.unarchive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [db.files.file_root_1._id],
	});

	await t.run(async (ctx) => {
		const fileRoot1 = await ctx.db.get("files_nodes", db.files.file_root_1._id);
		const fileRoot1Child1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1._id);
		const fileRoot1Child1Deep1 = await ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id);

		// Restore brings back one archive operation. The child was archived on its own before, so it stays
		// archived under its folder and can be restored with its own operation.
		expect(fileRoot1?.archiveOperationId).toBeNull();
		expect(fileRoot1Child1?.archiveOperationId).toBe("test_child_archive_operation");
		expect(fileRoot1Child1Deep1?.archiveOperationId).toBe("test_child_archive_operation");
		expect(fileRoot1Child1?.parentId).toBe(fileRoot1?._id);
		expect(fileRoot1Child1Deep1?.parentId).toBe(fileRoot1Child1?._id);
	});
});

test("membership-scoped file and yjs APIs reject cross-user membership ids", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const ownerIdentity = {
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Owner User",
	};
	const asOwner = t.withIdentity(ownerIdentity);

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

	const unauthorizedRename = await test_rename_node(t, asOtherUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		path: "should-not-rename",
	});
	if (!unauthorizedRename._nay) {
		throw new Error("Expected rename_node to reject cross-user membership access");
	}
	expect(unauthorizedRename._nay.message).toBe("Unauthorized");

	const createdFile = await asOwner.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "membership-yjs-regression.md",
	});
	if (createdFile._nay) {
		throw new Error("Expected owner to create regression file");
	}

	const snapshotsResult = await asOtherUser.query(api.files_nodes.get_file_snapshots_list, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		showArchived: false,
	});
	expect(snapshotsResult.snapshots).toEqual([]);

	const unauthorizedYjsUpdates = await asOtherUser.query(api.files_yjs_load.yjs_get_incremental_updates, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
	});
	expect(unauthorizedYjsUpdates).toBeNull();

	const unauthorizedYjsPush = await asOtherUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId: createdFile._yay.nodeId,
		expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFile._yay.nodeId)).yjsLastSequenceId,
		update: new ArrayBuffer(0),
		sessionId: "cross-user-membership",
	});
	expect(unauthorizedYjsPush).toEqual({ _nay: { message: "Unauthorized" } });
});

test("files_tree_write rate limit runs before membership validation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const otherDb = await t.run(async (ctx) => {
		const otherUserId = await ctx.db.insert("users", {
			clerkUserId: null,
		});

		return await test_mocks_fill_db_with.membership(ctx, {
			userId: otherUserId,
			organizationName: "rl-other-ws",
			workspaceName: "rl-other-prj",
		});
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Tree Rate User",
	});
	const createdNodeIds: Array<Id<"files_nodes">> = [];

	for (let i = 0; i < 2; i++) {
		const result = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: `tree-rate-limit-${i}.md`,
		});
		if (result._nay) {
			throw new Error(`Expected tree write #${i + 1} to succeed, got: ${result._nay.message}`);
		}

		createdNodeIds.push(result._yay.nodeId);
	}

	// `files_tree_write` is a BULK_FILES_WRITE bucket (capacity 50), so drain it with cheap
	// wrong-membership renames: each consumes a token before membership validation fails,
	// until the limiter answers first — which is the ordering this test pins.
	let blockedMessage: string | undefined;
	for (let i = 0; i < 60 && blockedMessage == null; i++) {
		const result = await test_rename_node(t, asUser, {
			membershipId: otherDb.membershipId,
			nodeId: createdNodeIds[0],
			path: "should-rate-limit-before-membership.md",
		});
		if (result._nay?.message === "Rate limit exceeded") {
			blockedMessage = result._nay.message;
		} else {
			expect(result._nay?.message).toBe("Unauthorized");
		}
	}

	expect(blockedMessage).toBe("Rate limit exceeded");
});

test("files_snapshot_write rate limit runs before restore snapshot validation", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const preparedNodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId, path: "/snapshot-rate-source.md",
	});
	const restoreAssets = await t.run(async (ctx) => {
		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/snapshot-rate-limit`,
				size: 0,
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
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: db.files.file_root_1._id,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});

		const expectedYjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: db.files.file_root_1._id,
			lastSequence: 0,
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: 0,
		});
		const expectedYjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: db.files.file_root_1._id,
			sequence: 0,
			assetId: currentSnapshotAssetId,
			createdBy: db.userId,
			updatedBy: db.userId,
			updatedAt: Date.now(),
		});

		return {
			snapshotId,
			currentSnapshotAssetId,
			restoredSnapshotAssetId,
			expectedYjsLastSequenceId,
			expectedYjsSnapshotId,
		};
	});
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Snapshot Rate User",
	});

	for (let i = 0; i < 2; i++) {
		const result = await asUser.mutation(api.files_nodes.archive_snapshot, {
			membershipId: db.membershipId,
			snapshotId: restoreAssets.snapshotId,
		});
		if (result._nay) {
			throw new Error(`Expected snapshot write #${i + 1} to succeed, got: ${result._nay.message}`);
		}
	}

	// The rate limit must win before any file or lineage validation.
	const blocked = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
		preparedSourceHeadId: (await t.run((ctx) => ctx.db.get("files_nodes", preparedNodeId)))!.contentHeadId!,
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		expectedPendingContentVersion: (await asUser.run((ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id)))!
			.pendingContentVersion,
		expectedYjsLastSequenceId: restoreAssets.expectedYjsLastSequenceId,
		expectedLastSequence: 0,
		snapshotId: restoreAssets.snapshotId,
		sessionId: "snapshot-rate-limit",
		snapshotMarkdownContent: "",
		currentSnapshotAssetId: restoreAssets.currentSnapshotAssetId,
		currentSnapshotSize: 0,
		restoredSnapshotAssetId: restoreAssets.restoredSnapshotAssetId,
		restoredSnapshotSize: 0,
	});

	expect(blocked._nay?.message).toBe("Rate limit exceeded");
});

describe("get_visible_target_by_path", () => {
	async function seed_paths() {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const owner = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const folder = async (path: string) => {
			const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...owner, path });
			if (created._nay) throw new Error(created._nay.message);
			return created._yay.nodeId;
		};
		const file = (parentId: Id<"files_nodes">, parentPath: string, name: string) =>
			test_run_with_flush(t, (ctx) =>
				ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId,
					name,
					sortName: files_sort_text_key(name),
					kind: "file",
					path: `${parentPath}/${name}`,
					treePath: `${parentPath}/${name}`,
					pathDepth: 2,
					lowercaseExtension: "md",
				}),
			);
		const by_path = (path: string, as = asOwner, membershipId = db.membershipId) =>
			as.query(api.files_nodes.get_visible_target_by_path, { membershipId, path });
		return { t, db, asOwner, owner, folder, file, by_path };
	}

	test("opens the saved row first, then the caller's drafts", async () => {
		const { t, owner, folder, file, by_path } = await seed_paths();
		const a = await folder("/a");
		const b = await folder("/b");
		const x = await file(a, "/a", "x.md");
		const y = await file(a, "/a", "y.md");
		const saved = (id: Id<"files_nodes">) => ({ target: { kind: "saved", id }, kind: "file" });

		// After a draft move of /a/x.md to /b/, both paths open the saved file: the old one as saved,
		// the new one through the draft.
		await propose_move_for_test(t, { ...owner, nodeId: x, destParent: { kind: "saved", id: b }, destName: "x.md" });
		expect(await by_path("/a/x.md")).toEqual(saved(x));
		expect(await by_path("/b/x.md")).toEqual(saved(x));

		// A private draft opens by its path.
		const draft = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...owner,
			path: "/b/draft.md",
			kind: "file",
		});
		if (draft._nay) throw new Error(draft._nay.message);
		expect(await by_path("/b/draft.md")).toEqual({ target: draft._yay.target, kind: "file" });

		// A saved file with a draft delete still opens, so its page can show the pending notice.
		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...owner,
					target: { kind: "saved", id: y },
				})
			)._nay,
		).toBeUndefined();
		expect(await by_path("/a/y.md")).toEqual(saved(y));
		expect(await by_path("/a/none.md")).toBeNull();
	});

	test("a restricted path is null for a member, and the member's own draft at that path opens for them", async () => {
		const { t, db, asOwner, folder, file, by_path } = await seed_paths();
		const a = await folder("/a");
		const secretId = await file(a, "/a", "secret.md");
		expect(
			await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: secretId }),
		).toEqual({ _yay: null });
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_path_member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });

		expect(await by_path("/a/secret.md")).toEqual({ target: { kind: "saved", id: secretId }, kind: "file" });
		expect(await by_path("/a/secret.md", asMember, member.membershipId)).toBeNull();

		const draft = await t.run((ctx) =>
			files_pending_nodes_db_create(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: member.userId,
				parent: { kind: "saved", id: a },
				name: "secret.md",
				kind: "file",
			}),
		);
		if (draft._nay) throw new Error(draft._nay.message);
		expect(await by_path("/a/secret.md", asMember, member.membershipId)).toEqual({
			target: { kind: "private", id: draft._yay.privateNodeId },
			kind: "file",
		});
		// The owner still opens the saved row.
		expect(await by_path("/a/secret.md")).toEqual({ target: { kind: "saved", id: secretId }, kind: "file" });
	});
});

/**
 * A small tree for the read-only pointer tests:
 * /outer, /outer/inner, /outer/inner/deep, /outer/sibling, plus /outer/frozen archived before any
 * lock exists, so the cascade tests can prove archived descendants are covered too.
 */
async function seed_read_only_lock_tree(t: ReturnType<typeof test_convex>) {
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Read Only Test User",
	});

	const outer = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "outer",
	});
	if (outer._nay) {
		throw new Error(outer._nay.message);
	}
	const inner = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: outer._yay.nodeId,
		path: "inner",
	});
	if (inner._nay) {
		throw new Error(inner._nay.message);
	}
	const deep = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: inner._yay.nodeId,
		path: "deep",
	});
	if (deep._nay) {
		throw new Error(deep._nay.message);
	}
	const sibling = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: outer._yay.nodeId,
		path: "sibling",
	});
	if (sibling._nay) {
		throw new Error(sibling._nay.message);
	}
	const frozen = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: outer._yay.nodeId,
		path: "frozen",
	});
	if (frozen._nay) {
		throw new Error(frozen._nay.message);
	}
	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [frozen._yay.nodeId],
	});
	if (archived._nay) {
		throw new Error(archived._nay.message);
	}

	return {
		db,
		asUser,
		outerId: outer._yay.nodeId,
		innerId: inner._yay.nodeId,
		deepId: deep._yay.nodeId,
		siblingId: sibling._yay.nodeId,
		frozenId: frozen._yay.nodeId,
	};
}

/**
 * Create an archived `/docs` tree with a locked, restricted child, then create a new active
 * `/docs` tree. The two roots share paths but not parent lineage.
 */
async function seed_reused_read_only_path_tree(t: ReturnType<typeof test_convex>) {
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Read Only Path Reuse Owner",
	});

	const archivedRoot = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "docs",
	});
	if (archivedRoot._nay) {
		throw new Error(archivedRoot._nay.message);
	}
	const archivedChild = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: archivedRoot._yay.nodeId,
		path: "secret",
	});
	if (archivedChild._nay) {
		throw new Error(archivedChild._nay.message);
	}
	const restricted = await asUser.mutation(api.files_sharing.restrict_node, {
		membershipId: db.membershipId,
		nodeId: archivedChild._yay.nodeId,
	});
	if (restricted._nay) {
		throw new Error(restricted._nay.message);
	}
	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [archivedRoot._yay.nodeId],
	});
	if (archived._nay) {
		throw new Error(archived._nay.message);
	}
	await test_finish_archive_jobs(t);
	await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: archivedChild._yay.nodeId });

	const activeRoot = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "docs",
	});
	if (activeRoot._nay) {
		throw new Error(activeRoot._nay.message);
	}
	const activeChild = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: activeRoot._yay.nodeId,
		path: "current",
	});
	if (activeChild._nay) {
		throw new Error(activeChild._nay.message);
	}
	const target = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "target",
	});
	if (target._nay) {
		throw new Error(target._nay.message);
	}

	return {
		db,
		asUser,
		archivedRootId: archivedRoot._yay.nodeId,
		archivedChildId: archivedChild._yay.nodeId,
		activeRootId: activeRoot._yay.nodeId,
		activeChildId: activeChild._yay.nodeId,
		targetId: target._yay.nodeId,
	};
}

function read_lock_node(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
	return t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
}

describe("files_nodes.read_only_set", () => {
	test("locks a folder and leaves other items unchanged", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId, frozenId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();

		const outer = await read_lock_node(t, outerId);
		expect(outer).toMatchObject({ readOnly: true });

		for (const nodeId of [innerId, deepId, siblingId]) {
			const node = await read_lock_node(t, nodeId);
			expect(node).toMatchObject({ readOnly: false });
		}

		const frozen = await read_lock_node(t, frozenId);
		expect(frozen?.archiveOperationId).toBeDefined();
		expect(frozen).toMatchObject({ readOnly: false });
	});

	test("locking a parent does not change a child lock", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);

		const innerLocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(innerLocked._nay).toBeUndefined();
		const outerLocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerLocked._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, siblingId)).toMatchObject({ readOnly: false });
		expect(await read_lock_node(t, innerId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, deepId)).toMatchObject({ readOnly: false });
	});

	test("unlocking a parent does not change a child lock", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);

		const outerLocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerLocked._nay).toBeUndefined();
		const innerLocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(innerLocked._nay).toBeUndefined();

		expect(await read_lock_node(t, innerId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, deepId)).toMatchObject({ readOnly: false });

		const outerUnlocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: false,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerUnlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ readOnly: false });
		expect(await read_lock_node(t, siblingId)).toMatchObject({ readOnly: false });
		expect(await read_lock_node(t, innerId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, deepId)).toMatchObject({ readOnly: false });
	});

	test("locking is idempotent", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();
		const lockedAgain = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(lockedAgain._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, innerId)).toMatchObject({ readOnly: false });
	});

	test("locks an archived explicit root", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Test User",
		});

		const cold = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "cold",
		});
		if (cold._nay) {
			throw new Error(cold._nay.message);
		}
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [cold._yay.nodeId],
		});
		expect(archived._nay).toBeUndefined();

		const locked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();

		expect(await read_lock_node(t, cold._yay.nodeId)).toMatchObject({ readOnly: true });
	});

	test("locking a new active folder ignores a restricted archived tree with the same path", async () => {
		const t = test_convex();
		const { db, asUser, archivedChildId, activeRootId, activeChildId } = await seed_reused_read_only_path_tree(t);
		const manager = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_read_only_path_reuse_manager" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
				displayName: "",
				sortDisplayName: "",
			});
			return { userId, membershipId };
		});
		const role = await asUser.mutation(api.access_control.create_role, {
			organizationId: db.organizationId,
			name: "Path Reuse Lock Manager",
			description: "",
			permissions: ["content.read", "content.write", "content.permissions.manage"],
		});
		if (role._nay) {
			throw new Error(role._nay.message);
		}
		const assigned = await asUser.mutation(api.access_control.set_user_role, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: manager.userId,
			role: role._yay.roleId,
		});
		if (assigned._nay) {
			throw new Error(assigned._nay.message);
		}
		const asManager = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: manager.userId,
			name: "Read Only Path Reuse Manager",
		});

		const locked = await asManager.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: manager.membershipId,
			nodeId: activeRootId,
		});
		expect(locked._nay).toBeUndefined();
		expect(await read_lock_node(t, activeRootId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, activeChildId)).toMatchObject({ readOnly: false });
		expect(await read_lock_node(t, archivedChildId)).toMatchObject({ readOnly: true });
	});
	test("unlocks a folder and leaves other items unchanged", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId, frozenId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: false,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(unlocked._nay).toBeUndefined();

		for (const nodeId of [outerId, innerId, deepId, siblingId, frozenId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ readOnly: false });
		}
	});

	test("unlocking a child does not change the parent lock", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId } = await seed_read_only_lock_tree(t);

		for (const nodeId of [outerId, innerId]) {
			const locked = await asUser.mutation(api.files_nodes.read_only_set, {
				readOnly: true,
				membershipId: db.membershipId,
				nodeId,
			});
			expect(locked._nay).toBeUndefined();
		}
		const unlocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: false,
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(unlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, innerId)).toMatchObject({ readOnly: false });
		expect(await read_lock_node(t, deepId)).toMatchObject({ readOnly: false });
	});

	test("unlocking a child that has no lock is a no-op", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();

		const refused = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: false,
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(refused._nay).toBeUndefined();

		expect(await read_lock_node(t, innerId)).toMatchObject({ readOnly: false });
		expect(await read_lock_node(t, outerId)).toMatchObject({ readOnly: true });

		// Use the same path to prove the direct lock can be removed.
		const unlocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: false,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(unlocked._nay).toBeUndefined();
	});

	test("unlocking a writable node is an idempotent no-op", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);

		const unlocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: false,
			membershipId: db.membershipId,
			nodeId: siblingId,
		});
		expect(unlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, siblingId)).toMatchObject({ readOnly: false });
	});

	test("locks and unlocks an archived root", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Test User",
		});

		const cold = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "cold",
		});
		if (cold._nay) {
			throw new Error(cold._nay.message);
		}
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [cold._yay.nodeId],
		});
		expect(archived._nay).toBeUndefined();

		const locked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: true,
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await asUser.mutation(api.files_nodes.read_only_set, {
			readOnly: false,
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(unlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, cold._yay.nodeId)).toMatchObject({ readOnly: false });
	});
});

describe("files_nodes.read_only_get", () => {
	test("a node with no lock above it reports the writable state", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);

		// Properties shows this node's own lock and write access.
		// An open node has no local lock.
		const state = await asUser.query(api.files_nodes.read_only_get, {
			membershipId: db.membershipId,
			nodeId: siblingId,
		});
		expect(state).toEqual({
			nodeId: siblingId,
			canEdit: true,
			readOnly: false,
		});
	});

	test("a direct lock reports the local read-only state", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		// This node's own lock is read-only. Clearing that local lock makes it writable.
		// There is no inherit choice and no parent lock to open.
		const state = await asUser.query(api.files_nodes.read_only_get, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(state).toEqual({
			nodeId: outerId,
			canEdit: true,
			readOnly: true,
		});
	});
});

describe("service account write scope", () => {
	async function seed_account(t: ReturnType<typeof test_convex>) {
		const fixture = await seed_read_only_lock_tree(t);
		const created = await fixture.asUser.mutation(api.access_control.create_service_account, {
			membershipId: fixture.db.membershipId,
			name: "File Writer",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const serviceAccountId = created._yay.serviceAccountId;
		const writeContext: files_nodes_WriteContext = {
			subject: { kind: "service_account", serviceAccountId },
			actorUserId: fixture.db.userId,
			resourceScope: { kind: "workspace" },
			force: false,
		};

		return { ...fixture, serviceAccountId, writeContext };
	}

	test("a moved node no longer belongs to the allowed subtree", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);
		const check = async () =>
			await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", fixture.deepId);
				if (!node) {
					throw new Error("Missing moved folder");
				}
				return await files_nodes_db_require_writable(ctx, {
					organizationId: fixture.db.organizationId,
					workspaceId: fixture.db.workspaceId,
					writeContext: { ...fixture.writeContext, resourceScope: { kind: "subtree", nodeId: fixture.innerId } },
					target: { kind: "node", node },
				});
			});

		expect((await check())._nay).toBeUndefined();

		expect(
			(
				await test_move_nodes(t, fixture.asUser, {
					membershipId: fixture.db.membershipId,
					itemIds: [fixture.deepId],
					targetParentId: files_ROOT_ID,
				})
			)._nay,
		).toBeUndefined();
		expect((await check())._nay?.message).toBe("Permission denied");
	});
});

describe("files_nodes.get_user_file_write_access", () => {
	test("a node with no policy is writable", async () => {
		const t = test_convex();
		const { db, siblingId } = await seed_read_only_lock_tree(t);

		expect(
			(
				await t.query(internal.files_nodes.get_user_file_write_access, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					nodeId: siblingId,
				})
			)._nay,
		).toBeUndefined();
	});

	test("a read-only policy keeps the stable refusal classification", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		const refused = await t.query(internal.files_nodes.get_user_file_write_access, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: outerId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
	});
});

describe("new-node write policy defaults", () => {
	test("a normal creation starts unlocked", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Test User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "fresh",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const node = await read_lock_node(t, folder._yay.nodeId);
		expect(node).toMatchObject({ readOnly: false });
	});

	test("trusted creation does not copy the parent lock onto missing segments", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		const created = await t.run(async (ctx) => {
			return await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: users_SYSTEM_AUTHOR,
				parentId: outerId,
				path: "new/deep",
				kind: "folder",

				now: Date.now(),
			});
		});
		expect(created._nay).toBeUndefined();
		const parent = await read_active_child({ t, db, parentId: outerId, name: "new" });
		if (!parent) {
			throw new Error("Expected new parent folder");
		}
		const child = await read_active_child({ t, db, parentId: parent._id, name: "deep" });
		for (const node of [parent, child]) {
			expect(node).toMatchObject({
				readOnly: false,
			});
		}
	});
});

/** Lock a node through the public mutation. Fail the test when the mutation refuses. */
async function set_read_only_or_throw(args: {
	asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
	membershipId: Id<"organizations_workspaces_users">;
	nodeId: Id<"files_nodes">;
}) {
	const { asUser, membershipId, nodeId } = args;

	const locked = await asUser.mutation(api.files_nodes.read_only_set, {
		readOnly: true,
		membershipId,
		nodeId,
	});
	if (locked._nay) {
		throw new Error(locked._nay.message);
	}
}

/** Unlock a node through the public mutation. Fail the test when the mutation refuses. */
async function set_writable_or_throw(args: {
	asUser: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
	membershipId: Id<"organizations_workspaces_users">;
	nodeId: Id<"files_nodes">;
}) {
	const { asUser, membershipId, nodeId } = args;

	const unlocked = await asUser.mutation(api.files_nodes.read_only_set, {
		readOnly: false,
		membershipId,
		nodeId,
	});
	if (unlocked._nay) {
		throw new Error(unlocked._nay.message);
	}
}

/** The active child with this name under the parent, or null when none exists. */
function read_active_child(args: {
	t: ReturnType<typeof test_convex>;
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> };
	parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
	name: string;
}) {
	const { t, db, parentId, name } = args;

	return t.run(async (ctx) =>
		ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", parentId)
					.eq("name", name)
					.eq("archiveOperationId", null),
			)
			.first(),
	);
}

describe("files_nodes.create_folder_node read-only gates", () => {
	test("creating inside a locked folder is refused, writes nothing, and succeeds after unlock", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		// The caller is the organization owner: locks bind owners too (RO-03).
		const refused = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: innerId,
			path: "blocked",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(await read_active_child({ t, db, parentId: innerId, name: "blocked" })).toBeNull();

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: innerId,
			path: "blocked",
		});
		expect(created._nay).toBeUndefined();
		expect(await read_active_child({ t, db, parentId: innerId, name: "blocked" })).not.toBeNull();
	});

	test("an unlocked folder with a locked descendant still accepts a new sibling", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			path: "fresh-sib",
		});
		expect(created._nay).toBeUndefined();
		expect(await read_active_child({ t, db, parentId: outerId, name: "fresh-sib" })).not.toBeNull();
	});

	test("a nested path through a locked segment is refused before any intermediate folder exists", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		// The path crosses unlocked `/outer`, then stops at read-only `/outer/inner`.
		const refusedThroughSegment = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "outer/inner/deep2",
		});
		expect(refusedThroughSegment._nay?.name).toBe("read_only");
		expect(await read_active_child({ t, db, parentId: innerId, name: "deep2" })).toBeNull();

		// A missing chain directly under the locked parent is refused before the first insert, so no
		// partial "a" folder is committed.
		const refusedMissingChain = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: innerId,
			path: "a/b",
		});
		expect(refusedMissingChain._nay?.name).toBe("read_only");
		expect(await read_active_child({ t, db, parentId: innerId, name: "a" })).toBeNull();
	});

	test("the internal mkdir door refuses a locked path segment", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		const refused = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/outer/inner/made-by-agent",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await read_active_child({ t, db, parentId: innerId, name: "made-by-agent" })).toBeNull();
	});
});

describe("file parent create doors", () => {
	test("create_folder_node refuses a file as parent and writes nothing", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		const file = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			path: "notes.md",
		});
		if (file._nay) throw new Error(file._nay.message);

		const refused = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: file._yay.nodeId,
			path: "probe/deep",
		});
		expect(refused._nay?.message).toBe("Not found");
		expect(await read_active_child({ t, db, parentId: file._yay.nodeId, name: "probe" })).toBeNull();
	});

	test("create_text_node refuses a file as parent", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		const file = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			path: "notes.md",
		});
		if (file._nay) throw new Error(file._nay.message);

		const refused = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: file._yay.nodeId,
			path: "probe.md",
		});
		expect(refused._nay?.message).toBe("Not found");
		expect(await read_active_child({ t, db, parentId: file._yay.nodeId, name: "probe.md" })).toBeNull();
	});
});

describe("archived parent create doors", () => {
	test("create_folder_node refuses an archived parent and writes nothing", async () => {
		const t = test_convex();
		const { db, asUser, frozenId } = await seed_read_only_lock_tree(t);

		const refused = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: frozenId,
			path: "probe/deep",
		});
		expect(refused._nay?.message).toBe("Not found");
		expect(await read_active_child({ t, db, parentId: frozenId, name: "probe" })).toBeNull();
	});

	test("create_text_node refuses an archived parent before any R2 work", async () => {
		const t = test_convex();
		const { db, asUser, frozenId } = await seed_read_only_lock_tree(t);

		const refused = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: frozenId,
			path: "probe.md",
		});
		expect(refused._nay?.message).toBe("Not found");
		expect(await read_active_child({ t, db, parentId: frozenId, name: "probe.md" })).toBeNull();
		// The preflight refuses before the action creates asset docs, so nothing needs cleanup.
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("create_upload_node refuses an archived parent", async () => {
		const t = test_convex();
		const { db, asUser, frozenId } = await seed_read_only_lock_tree(t);

		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: frozenId,
			filename: "probe.pdf",
			contentType: "application/pdf",
			size: 1234,
		});
		expect(refused._nay?.message).toBe("Not found");
		expect(await read_active_child({ t, db, parentId: frozenId, name: "probe.pdf" })).toBeNull();
	});
});

describe("files_nodes destination conflict privacy", () => {
	test("rename and move authorize a restricted destination occupant before reporting its conflict", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const fixture = await test_run_with_flush(t, async (ctx) => {
			const now = Date.now();
			const memberUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_destination_conflict_member",
			});
			const memberMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: memberUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
				displayName: "",
				sortDisplayName: "",
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: memberUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});

			const commonFile = {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				kind: "file" as const,
				lowercaseExtension: "md",
				contentType: "text/markdown;charset=utf-8",
				updatedAt: now,
			};
			const renameSourceId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: files_ROOT_ID,
				name: "rename-source.md",
				sortName: files_sort_text_key("rename-source.md"),
				path: "/rename-source.md",
				treePath: "/rename-source.md",
				pathDepth: 1,
			});
			const renameConflictId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: files_ROOT_ID,
				name: "rename-hidden.md",
				sortName: files_sort_text_key("rename-hidden.md"),
				path: "/rename-hidden.md",
				treePath: "/rename-hidden.md",
				pathDepth: 1,
			});
			const moveTargetId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "move-target",
				kind: "folder",
				path: "/move-target",
				treePath: "/move-target/",
				pathDepth: 1,
				lowercaseExtension: null,
				updatedAt: now,
			});
			const moveSourceId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: files_ROOT_ID,
				name: "move-source.md",
				sortName: files_sort_text_key("move-source.md"),
				path: "/move-source.md",
				treePath: "/move-source.md",
				pathDepth: 1,
			});
			const moveConflictId = await ctx.db.insert("files_nodes", {
				...commonFile,
				parentId: moveTargetId,
				name: "move-source.md",
				sortName: files_sort_text_key("move-source.md"),
				path: "/move-target/move-source.md",
				treePath: "/move-target/move-source.md",
				pathDepth: 2,
			});
			await ctx.db.patch("files_nodes", renameConflictId, { restrictedScopeNodeId: renameConflictId });
			await ctx.db.patch("files_nodes", moveConflictId, { restrictedScopeNodeId: moveConflictId });

			return {
				memberUserId,
				memberMembershipId,
				renameSourceId,
				renameConflictId,
				moveTargetId,
				moveSourceId,
				moveConflictId,
			};
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: fixture.memberUserId,
			name: "Destination Conflict Member",
		});

		const hiddenRename = await test_rename_node(t, asMember, {
			membershipId: fixture.memberMembershipId,
			nodeId: fixture.renameSourceId,
			path: "rename-hidden.md",
		});
		expect(hiddenRename._nay).toMatchObject({ name: "nay", message: "Permission denied" });

		const hiddenMove = await test_move_nodes(t, asMember, {
			membershipId: fixture.memberMembershipId,
			itemIds: [fixture.moveSourceId],
			targetParentId: fixture.moveTargetId,
		});
		expect(hiddenMove._nay).toMatchObject({ message: "Permission denied" });
		expect(await read_lock_node(t, fixture.renameSourceId)).toMatchObject({ path: "/rename-source.md" });
		expect(await read_lock_node(t, fixture.moveSourceId)).toMatchObject({
			parentId: files_ROOT_ID,
			path: "/move-source.md",
		});

		// Once both conflicting nodes are visible, rename and move return the normal path conflict.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", fixture.renameConflictId, { restrictedScopeNodeId: null });
			await ctx.db.patch("files_nodes", fixture.moveConflictId, { restrictedScopeNodeId: null });
		});
		const visibleRename = await test_rename_node(t, asMember, {
			membershipId: fixture.memberMembershipId,
			nodeId: fixture.renameSourceId,
			path: "rename-hidden.md",
		});
		expect(visibleRename._nay).toMatchObject({ name: "nay", message: "Path already exists" });

		const visibleMove = await test_move_nodes(t, asMember, {
			membershipId: fixture.memberMembershipId,
			itemIds: [fixture.moveSourceId],
			targetParentId: fixture.moveTargetId,
		});
		expect(visibleMove._nay).toMatchObject({ name: "name_conflict" });
	});
});

describe("files_nodes.rename_node read-only gates", () => {
	test("a locked node cannot be renamed and renames after unlock (owner gets no bypass)", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		const refused = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: innerId,
			path: "inner2",
		});
		expect(refused._nay?.name).toBe("read_only");
		const innerAfterRefusal = await read_lock_node(t, innerId);
		expect(innerAfterRefusal?.name).toBe("inner");
		expect(innerAfterRefusal?.path).toBe("/outer/inner");

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });
		const renamed = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: innerId,
			path: "inner2",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await read_lock_node(t, innerId))?.path).toBe("/outer/inner2");
	});

	test("a locked parent refuses renaming a child", async () => {
		const t = test_convex();
		const { db, asUser, outerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		const refused = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: siblingId,
			path: "sibling2",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, siblingId))?.path).toBe("/outer/sibling");
	});

	test("a writable ancestor folder can be renamed while a descendant stays locked", async () => {
		const t = test_convex();
		const { db, asUser, outerId, deepId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });

		const renamed = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: outerId,
			path: "outer2",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await read_lock_node(t, outerId))?.path).toBe("/outer2");
		expect((await read_lock_node(t, deepId))?.path).toBe("/outer2/inner/deep");
		expect(await read_lock_node(t, deepId)).toMatchObject({ readOnly: true });

		const renamedSibling = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: siblingId,
			path: "sibling2",
		});
		expect(renamedSibling._nay).toBeUndefined();
		expect((await read_lock_node(t, siblingId))?.path).toBe("/outer2/sibling2");
	});

	test("a writable folder can be renamed while an archived descendant stays locked", async () => {
		const t = test_convex();
		const { db, asUser, outerId, frozenId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: frozenId });

		const renamed = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: outerId,
			path: "outer3",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await read_lock_node(t, outerId))?.path).toBe("/outer3");
		const frozen = await read_lock_node(t, frozenId);
		expect(frozen?.path).toBe("/outer3/frozen");
		expect(frozen?.archiveOperationId).toBeDefined();
		expect(frozen).toMatchObject({ readOnly: true });
	});

	test("a locked archived tree with the same path does not block renaming the new active tree", async () => {
		const t = test_convex();
		const { db, asUser, archivedChildId, activeRootId, activeChildId } = await seed_reused_read_only_path_tree(t);

		const renamed = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: activeRootId,
			path: "docs-renamed",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await read_lock_node(t, activeRootId))?.path).toBe("/docs-renamed");
		expect((await read_lock_node(t, activeChildId))?.path).toBe("/docs-renamed/current");
		expect((await read_lock_node(t, archivedChildId))?.path).toBe("/docs/secret");
	});

	test("renaming into a locked destination folder is refused", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		const refused = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: siblingId,
			path: "inner/sibling",
		});
		if (!refused._yay) throw new Error("Rename was not accepted", { cause: refused._nay });
		expect(await t.run((ctx) => ctx.db.get("activities", refused._yay!.activityId))).toMatchObject({
			status: "failed",
			errorMessage: "This item is read-only.",
		});
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.parentId).toBe(outerId);
		expect(sibling?.path).toBe("/outer/sibling");
	});

	test("a writable folder can be renamed into a new parent while a descendant stays locked", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });

		const renamed = await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId: innerId,
			path: "made/inner2",
		});
		expect(renamed._nay).toBeUndefined();
		expect(await read_active_child({ t, db, parentId: outerId, name: "made" })).not.toBeNull();
		expect((await read_lock_node(t, innerId))?.path).toBe("/outer/made/inner2");
		expect((await read_lock_node(t, deepId))?.path).toBe("/outer/made/inner2/deep");
	});
});

describe("files_nodes.move_nodes read-only gates", () => {
	test("keeps a completed Move when a later node is locked", async () => {
		const t = test_convex();
		const { db, asUser, outerId, deepId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: siblingId });

		const refused = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [deepId, siblingId],
			targetParentId: files_ROOT_ID,
		});
		expect(refused._nay?.name).toBe("read_only");
		const deep = await read_lock_node(t, deepId);
		expect(deep?.parentId).toBe(files_ROOT_ID);
		expect(deep?.path).toBe("/deep");
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.parentId).toBe(outerId);
		expect(sibling?.path).toBe("/outer/sibling");
	});

	test("moving into a locked destination folder is refused", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		const refused = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [siblingId],
			targetParentId: innerId,
		});
		expect(refused._nay?.name).toBe("read_only");
		const sibling = await read_lock_node(t, siblingId);
		expect(sibling?.parentId).toBe(outerId);
		expect(sibling?.path).toBe("/outer/sibling");
	});

	test("a writable ancestor folder can be moved while a descendant stays locked", async () => {
		const t = test_convex();
		const { db, asUser, deepId, innerId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });

		const moved = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [innerId],
			targetParentId: files_ROOT_ID,
		});
		expect(moved._nay).toBeUndefined();
		expect((await read_lock_node(t, innerId))?.path).toBe("/inner");
		expect((await read_lock_node(t, deepId))?.path).toBe("/inner/deep");
		expect(await read_lock_node(t, deepId)).toMatchObject({ readOnly: true });

		const movedSibling = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [siblingId],
			targetParentId: files_ROOT_ID,
		});
		expect(movedSibling._nay).toBeUndefined();
		expect((await read_lock_node(t, siblingId))?.path).toBe("/sibling");
		expect(await read_lock_node(t, siblingId)).toMatchObject({ readOnly: false });
	});

	test("a writable folder can be moved while an archived descendant stays locked", async () => {
		const t = test_convex();
		const { db, asUser, innerId, deepId } = await seed_read_only_lock_tree(t);

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [deepId],
		});
		expect(archived._nay).toBeUndefined();
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });

		const moved = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [innerId],
			targetParentId: files_ROOT_ID,
		});
		expect(moved._nay).toBeUndefined();
		expect((await read_lock_node(t, innerId))?.path).toBe("/inner");
		const deep = await read_lock_node(t, deepId);
		expect(deep?.path).toBe("/inner/deep");
		expect(deep?.archiveOperationId).toBeDefined();
		expect(deep).toMatchObject({ readOnly: true });
	});

	test("a locked archived tree with the same path does not block moving the new active tree", async () => {
		const t = test_convex();
		const { db, asUser, archivedChildId, activeRootId, activeChildId, targetId } =
			await seed_reused_read_only_path_tree(t);

		const moved = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [activeRootId],
			targetParentId: targetId,
		});
		expect(moved._nay).toBeUndefined();
		expect((await read_lock_node(t, activeRootId))?.path).toBe("/target/docs");
		expect((await read_lock_node(t, activeChildId))?.path).toBe("/target/docs/current");
		expect((await read_lock_node(t, archivedChildId))?.path).toBe("/docs/secret");
	});
});

describe("files_nodes.archive_nodes read-only gates", () => {
	test("archiving a locked node is refused and archives after unlock", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: siblingId });

		const refused = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [siblingId],
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, siblingId))?.archiveOperationId).toBeNull();

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: siblingId });
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [siblingId],
		});
		expect(archived._nay).toBeUndefined();
		expect((await read_lock_node(t, siblingId))?.archiveOperationId).toBeDefined();
	});

	test("a locked active descendant blocks archiving the folder", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });

		const refused = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [outerId],
		});
		expect(refused._nay?.name).toBe("read_only");
		for (const nodeId of [outerId, innerId, deepId, siblingId]) {
			expect((await read_lock_node(t, nodeId))?.archiveOperationId).toBeNull();
		}
	});

	test("a locked archived tree with the same path does not block archiving the new active tree", async () => {
		const t = test_convex();
		const { db, asUser, archivedRootId, archivedChildId, activeRootId, activeChildId } =
			await seed_reused_read_only_path_tree(t);
		const archivedRootBefore = await read_lock_node(t, archivedRootId);
		const archivedChildBefore = await read_lock_node(t, archivedChildId);

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [activeRootId],
		});
		expect(archived._nay).toBeUndefined();
		await test_finish_archive_jobs(t);
		const activeRoot = await read_lock_node(t, activeRootId);
		const activeChild = await read_lock_node(t, activeChildId);
		expect(activeRoot?.archiveOperationId).toBeDefined();
		expect(activeChild?.archiveOperationId).toBe(activeRoot?.archiveOperationId);
		expect((await read_lock_node(t, archivedRootId))?.archiveOperationId).toBe(archivedRootBefore?.archiveOperationId);
		expect((await read_lock_node(t, archivedChildId))?.archiveOperationId).toBe(
			archivedChildBefore?.archiveOperationId,
		);
	});

	test("archived descendants do not block deleting their active parent", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Owner",
		});

		// Three parents, each with one archived child in a different lock/visibility state.
		const parentIds: Array<Id<"files_nodes">> = [];
		const childIds: Array<Id<"files_nodes">> = [];
		for (const index of [1, 2, 3]) {
			const parent = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path: `arch${index}`,
			});
			if (parent._nay) {
				throw new Error(parent._nay.message);
			}
			const child = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: parent._yay.nodeId,
				path: `c${index}`,
			});
			if (child._nay) {
				throw new Error(child._nay.message);
			}
			parentIds.push(parent._yay.nodeId);
			childIds.push(child._yay.nodeId);
		}
		const [arch1Id, arch2Id, arch3Id] = parentIds;
		const [c1Id, c2Id, c3Id] = childIds;
		if (!arch1Id || !arch2Id || !arch3Id || !c1Id || !c2Id || !c3Id) {
			throw new Error("Expected three parents and three children");
		}

		const archivedChildren = await asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [c1Id, c2Id, c3Id],
		});
		expect(archivedChildren._nay).toBeUndefined();
		await set_read_only_or_throw({ asUser: asOwner, membershipId: db.membershipId, nodeId: c2Id });
		await set_read_only_or_throw({ asUser: asOwner, membershipId: db.membershipId, nodeId: c3Id });

		// Restrict c1 and c3 so a plain member cannot read them. The member has no grant on these
		// scopes, so both children are hidden to them.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", c1Id, { restrictedScopeNodeId: c1Id });
			await ctx.db.patch("files_nodes", c3Id, { restrictedScopeNodeId: c3Id });
		});

		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_read_only_archived_member",
			});
			const now = Date.now();
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: otherUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
				displayName: "",
				sortDisplayName: "",
			});
			// Archiving needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			return { otherUserId, otherMembershipId };
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Read Only Member",
		});

		// Hidden but unlocked: the archive call will not write the archived child, so it is ignored
		// and the ordinary ACL scope does not widen.
		const c1Before = await read_lock_node(t, c1Id);
		const archivedArch1 = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch1Id],
		});
		expect(archivedArch1._nay).toBeUndefined();
		expect((await read_lock_node(t, arch1Id))?.archiveOperationId).toBeDefined();
		expect((await read_lock_node(t, c1Id))?.archiveOperationId).toBe(c1Before?.archiveOperationId);

		// Read-only items already in Trash keep their original archive stamp.
		const c2Before = await read_lock_node(t, c2Id);
		const archivedVisible = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch2Id],
		});
		expect(archivedVisible._nay).toBeUndefined();
		expect((await read_lock_node(t, arch2Id))?.archiveOperationId).not.toBeNull();
		expect((await read_lock_node(t, c2Id))?.archiveOperationId).toBe(c2Before?.archiveOperationId);

		const c3Before = await read_lock_node(t, c3Id);
		const archivedHidden = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch3Id],
		});
		expect(archivedHidden._nay).toBeUndefined();
		expect((await read_lock_node(t, arch3Id))?.archiveOperationId).not.toBeNull();
		expect((await read_lock_node(t, c3Id))?.archiveOperationId).toBe(c3Before?.archiveOperationId);
	});
});

describe("files_nodes.unarchive_nodes read-only gates", () => {
	test("restoring one archived lineage ignores a locked archived tree that reused its path", async () => {
		const t = test_convex();
		const { db, asUser, archivedRootId, archivedChildId, activeRootId, activeChildId } =
			await seed_reused_read_only_path_tree(t);

		const archivedSecondTree = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [activeRootId],
		});
		expect(archivedSecondTree._nay).toBeUndefined();
		await test_finish_archive_jobs(t);
		const secondArchiveOperationId = (await read_lock_node(t, activeRootId))?.archiveOperationId;
		expect(secondArchiveOperationId).toBeDefined();

		const restoredSecondTree = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [activeRootId],
		});
		expect(restoredSecondTree._nay).toBeUndefined();
		expect((await read_lock_node(t, activeRootId))?.archiveOperationId).toBeNull();
		expect((await read_lock_node(t, activeChildId))?.archiveOperationId).toBeNull();

		// The first archived `/docs` tree has different parent ids.
		// Its lock does not block this restore, and none of its nodes are restored.
		const firstRoot = await read_lock_node(t, archivedRootId);
		const firstChild = await read_lock_node(t, archivedChildId);
		expect(firstRoot?.archiveOperationId).toBeDefined();
		expect(firstChild?.archiveOperationId).toBeDefined();
		expect(firstChild).toMatchObject({ readOnly: true });
	});

	test("Restore preserves Read-only on the restored folder and its children", async () => {
		const t = test_convex();
		const { db, asUser, innerId, deepId } = await seed_read_only_lock_tree(t);

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(archived._nay).toBeUndefined();
		await test_finish_archive_jobs(t);
		const innerArchivedOperationId = (await read_lock_node(t, innerId))?.archiveOperationId;
		expect(innerArchivedOperationId).toBeDefined();

		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });
		const innerDecision = (await read_lock_node(t, innerId))?.readOnlyDecisionId;
		const deepDecision = (await read_lock_node(t, deepId))?.readOnlyDecisionId;
		const restored = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(restored._nay).toBeUndefined();
		await test_finish_archive_jobs(t);
		const inner = await read_lock_node(t, innerId);
		expect(inner?.archiveOperationId).toBeNull();
		expect(inner?.path).toBe("/outer/inner");
		expect(inner).toMatchObject({ readOnly: true, readOnlyDecisionId: innerDecision });
		const deep = await read_lock_node(t, deepId);
		expect(deep?.archiveOperationId).toBeNull();
		expect(deep?.path).toBe("/outer/inner/deep");
		expect(deep).toMatchObject({ readOnly: true, readOnlyDecisionId: deepDecision });
	});
});

/**
 * A file node with one stored snapshot for the snapshot archive-state gates. `archivedAt` seeds the
 * snapshot's starting state. Each caller gets a fresh convex-test instance because the
 * `files_snapshot_write` bucket only allows two writes per window, and every gate test spends both.
 */
async function seed_read_only_snapshot(t: ReturnType<typeof test_convex>, archivedAt: number) {
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Read Only Snapshot User",
	});
	const snapshotId = await t.run(async (ctx) => {
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			r2Bucket: "test-bucket",
			r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/read-only-snapshot`,
			size: 0,
			createdBy: db.userId,
			updatedAt: Date.now(),
		});
		return await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: db.files.file_root_1._id,
			assetId,
			createdBy: db.userId,
			archivedAt,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});
	});

	return { db, asUser, snapshotId, fileNodeId: db.files.file_root_1._id };
}

describe("files_nodes.archive_snapshot and unarchive_snapshot read-only gates", () => {
	test("archiving a snapshot of a locked file is refused while browsing stays allowed", async () => {
		const t = test_convex();
		const { db, asUser, snapshotId, fileNodeId } = await seed_read_only_snapshot(t, 0);

		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: fileNodeId });
		const refused = await asUser.mutation(api.files_nodes.archive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBe(0);

		// Browsing the version list stays allowed on a read-only file.
		const listed = await asUser.query(api.files_nodes.get_file_snapshots_list, {
			membershipId: db.membershipId,
			nodeId: fileNodeId,
			showArchived: false,
		});
		expect(listed.snapshots).toHaveLength(1);

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: fileNodeId });
		const archivedSnapshot = await asUser.mutation(api.files_nodes.archive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(archivedSnapshot._nay).toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBeGreaterThan(0);
	});

	test("restoring a snapshot of a locked file is refused and succeeds after unlock", async () => {
		const t = test_convex();
		const seededArchivedAt = Date.now();
		const { db, asUser, snapshotId, fileNodeId } = await seed_read_only_snapshot(t, seededArchivedAt);

		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: fileNodeId });
		const refused = await asUser.mutation(api.files_nodes.unarchive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBe(seededArchivedAt);

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: fileNodeId });
		const restoredSnapshot = await asUser.mutation(api.files_nodes.unarchive_snapshot, {
			membershipId: db.membershipId,
			snapshotId,
		});
		expect(restoredSnapshot._nay).toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get("files_snapshots", snapshotId)))?.archivedAt).toBe(0);
	});
});

describe("files_nodes.yjs_push_update read-only gates", () => {
	async function seed_yjs_push_file(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Yjs User",
		});
		const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path,
		});
		if (createdFile._nay) {
			throw new Error(createdFile._nay.message);
		}
		return { db, asUser, nodeId: createdFile._yay.nodeId };
	}

	/** The file's Yjs write state: stored update docs and the reserved sequence counter. */
	function read_yjs_write_state(args: {
		t: ReturnType<typeof test_convex>;
		db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> };
		nodeId: Id<"files_nodes">;
	}) {
		const { t, db, nodeId } = args;

		return t.run(async (ctx) => {
			const updates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.collect();
			const lastSequence = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
				)
				.first();
			return { updateCount: updates.length, lastSequence: lastSequence?.lastSequence ?? null };
		});
	}

	test("a direct lock refuses the push before any sequence reserve and unlock lets it through", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_yjs_push_file(t, "read-only-push-direct.md");
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId });

		const before = await read_yjs_write_state({ t, db, nodeId });
		// The current lock refuses the write.
		const refused = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-direct",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		// The refusal reserved no sequence and stored no update doc.
		expect(await read_yjs_write_state({ t, db, nodeId })).toEqual(before);

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId });
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-direct",
		});
		if (pushed._nay) {
			throw new Error(pushed._nay.message);
		}
		expect(pushed._yay.newSequence).toBe(1);
	});

	test("a parent lock does not refuse a push on a writable child", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Yjs User",
		});
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "locked-folder",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: folder._yay.nodeId,
			path: "inside.md",
		});
		if (createdFile._nay) {
			throw new Error(createdFile._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: folder._yay.nodeId });

		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId: createdFile._yay.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, createdFile._yay.nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-parent",
		});
		if (pushed._nay) {
			throw new Error(pushed._nay.message);
		}
		expect(pushed._yay.newSequence).toBe(1);
	});

	test("a push succeeds after a lock is removed", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_yjs_push_file(t, "read-only-push-stale.md");
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId });
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId });

		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, nodeId)).yjsLastSequenceId,
			update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
			sessionId: "read-only-push-stale",
		});
		if (pushed._nay) {
			throw new Error(pushed._nay.message);
		}
		expect(pushed._yay.newSequence).toBe(1);
	});
});

describe("files_nodes read-only reads", () => {
	test("a locked file still reads its content", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Read User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "locked-source",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const source = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: folder._yay.nodeId,
			path: "source.md",
		});
		if (source._nay) {
			throw new Error(source._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: folder._yay.nodeId });

		// A lock stops writes, never reads. Copying a locked file out starts with this read, so a
		// lock check added here would break copy-out and every agent read as well.
		const read = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			subject: { kind: "user", userId: db.userId, plugin: null },
			path: "/locked-source/source.md",
			mode: { kind: "full", maxBytes: files_get_utf8_byte_size(files_INITIAL_CONTENT) + 1000 },
		});
		expect(read?.content).toBe(files_INITIAL_CONTENT);
	});
});

/** Every unfinalized upload asset doc in the workspace. */
function read_upload_assets(
	t: ReturnType<typeof test_convex>,
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	return t.run(async (ctx) =>
		ctx.db
			.query("files_r2_assets")
			.collect()
			.then((assets) =>
				assets.filter(
					(asset) =>
						asset.organizationId === db.organizationId &&
						asset.workspaceId === db.workspaceId &&
						asset.kind === "upload",
				),
			),
	);
}

describe("files_nodes.create_upload_node read-only gates", () => {
	test("refuses a locked destination folder before any asset or node write", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			filename: "report.pdf",
			contentType: "application/pdf",
			size: 10,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(await read_active_child({ t, db, parentId: outerId, name: "report.pdf" })).toBeNull();
		expect(await read_upload_assets(t, db)).toHaveLength(0);

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			filename: "report.pdf",
			contentType: "application/pdf",
			size: 10,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		// The accepted upload stores its temporary R2 key and the upload URL expiry time.
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload._yay.assetId));
		expect(upload._yay.headers["If-None-Match"]).toBe("*");
		expect(asset?.uploadUrlExpiresAt).toEqual(expect.any(Number));
	});

	test("refuses a filename that walks through a locked existing folder", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "outer/nested.pdf",
			contentType: "application/pdf",
			size: 10,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await read_upload_assets(t, db)).toHaveLength(0);
	});

	test("refuses replacing a locked occupant and leaves it active", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Upload User",
		});

		const first = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: first._yay.nodeId });

		const refused = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		expect(refused._nay?.name).toBe("read_only");
		// The locked occupant kept its path and no second asset doc was written.
		const occupant = await t.run(async (ctx) => ctx.db.get("files_nodes", first._yay.nodeId));
		expect(occupant?.archiveOperationId).toBeNull();
		expect(await read_upload_assets(t, db)).toHaveLength(1);

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: first._yay.nodeId });
		const replaced = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}
		const docs = await t.run(async (ctx) => ({
			oldNode: await ctx.db.get("files_nodes", first._yay.nodeId),
			newAsset: await ctx.db.get("files_r2_assets", replaced._yay.assetId),
		}));
		expect(docs.oldNode?.archiveOperationId).toBeDefined();
		expect(replaced._yay.headers["If-None-Match"]).toBe("*");
	});
});

describe("files_nodes.create_upload_nodes read-only gates", () => {
	test("a locked common destination refuses the whole call before any write", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		const refused = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: outerId,
			onConflict: "skip",
			items: [
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "b.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(await read_upload_assets(t, db)).toHaveLength(0);
	});

	test("locked occupants and locked folders skip their items without archiving while others import", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);

		const occupant = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "taken.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (occupant._nay) {
			throw new Error(occupant._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: occupant._yay.nodeId });
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [
				{ relativePath: "taken.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "outer/blocked.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "fresh.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		// Locked items report the same generic conflict as restricted ones, and only they skip.
		expect(imported._yay.skipped).toEqual([
			{ relativePath: "taken.pdf", reason: "conflict" },
			{ relativePath: "outer/blocked.pdf", reason: "conflict" },
		]);
		expect(imported._yay.created).toHaveLength(1);
		expect(imported._yay.created[0]).toMatchObject({ relativePath: "fresh.pdf" });

		const docs = await t.run(async (ctx) => ({
			occupantNode: await ctx.db.get("files_nodes", occupant._yay.nodeId),
			freshAsset: await ctx.db.get("files_r2_assets", imported._yay.created[0]!.assetId),
		}));
		// The locked occupant was skipped, not archived.
		expect(docs.occupantNode?.archiveOperationId).toBeNull();
		expect(imported._yay.created[0]!.headers["If-None-Match"]).toBe("*");
		expect(docs.freshAsset?.uploadUrlExpiresAt).toEqual(expect.any(Number));
	});
});

describe("files_nodes.discard_failed_upload_node locks", () => {
	test("cancel removes the failed placeholder even while it is locked", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Discard User",
		});
		vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "failed.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: upload._yay.nodeId });

		// Cancel is cleanup of an upload that never landed, not a delete. The lock stops
		// new writes, so it does not keep an empty placeholder alive.
		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId: upload._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay.removed).toBe(true);
		const gone = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", upload._yay.nodeId),
			asset: await ctx.db.get("files_r2_assets", upload._yay.assetId),
		}));
		expect(gone.node).toBeNull();
		expect(gone.asset).toBeNull();
	});

	test("a parent lock does not keep an unprotected failed placeholder", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Discard User",
		});

		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "uploads",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: folder._yay.nodeId,
			filename: "refused.pdf",
			contentType: "application/pdf",
			size: 1,
		});
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: folder._yay.nodeId });
		const discarded = await asUser.mutation(api.files_nodes.discard_failed_upload_node, {
			membershipId: db.membershipId,
			nodeId: upload._yay.nodeId,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		expect(discarded._yay.removed).toBe(true);
	});
});

describe("apply_file_pending_move", () => {
	async function seed_apply_move_file(t: ReturnType<typeof test_convex>, path: string) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read Only Apply Move User",
		});
		const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path,
		});
		if (createdFile._nay) {
			throw new Error(createdFile._nay.message);
		}
		return { db, asUser, nodeId: createdFile._yay.nodeId };
	}

	test("a locked source refuses the apply and unlock lets the same move through", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_apply_move_file(t, "pending-src.md");
		const move = await propose_move_for_test(t, {
			...db,
			nodeId,
			destParent: { kind: "root" },
			destName: "pending-src-moved.md",
		});
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId });

		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: db.membershipId,
			...move,
		});
		expect(applied._nay).toMatchObject({ name: "read_only" });
		expect((await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/pending-src.md");

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId });
		const appliedAfterUnlock = await test_apply_file_pending_move(asUser, {
			membershipId: db.membershipId,
			...move,
		});
		expect(appliedAfterUnlock._nay).toBeUndefined();
		expect((await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/pending-src-moved.md");
	});

	test("a locked destination folder refuses the apply", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_apply_move_file(t, "pending-src-dest.md");
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "pending-dest",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const move = await propose_move_for_test(t, {
			...db,
			nodeId,
			destParent: { kind: "saved", id: folder._yay.nodeId },
			destName: "pending-src-dest.md",
		});
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: folder._yay.nodeId });

		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: db.membershipId,
			...move,
		});
		expect(applied._nay).toMatchObject({ name: "read_only" });
		expect((await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/pending-src-dest.md");
	});

	test("a locked replacement occupant refuses the apply and stays active", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_apply_move_file(t, "pending-src-replace.md");
		const occupant = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "occupied.md",
		});
		if (occupant._nay) {
			throw new Error(occupant._nay.message);
		}
		const move = await propose_move_for_test(t, {
			...db,
			nodeId,
			destParent: { kind: "root" },
			destName: "occupied.md",
			replace: true,
		});
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: occupant._yay.nodeId });

		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: db.membershipId,
			...move,
		});
		expect(applied._nay).toMatchObject({ name: "read_only" });
		const docs = await t.run(async (ctx) => ({
			source: await ctx.db.get("files_nodes", nodeId),
			occupantNode: await ctx.db.get("files_nodes", occupant._yay.nodeId),
		}));
		expect(docs.source?.path).toBe("/pending-src-replace.md");
		expect(docs.occupantNode?.archiveOperationId).toBeNull();
	});

	test.each(["unchanged", "edited", "replaced"] as const)(
		"binds replacement to the reviewed %s occupant",
		async (change) => {
			const t = test_convex();
			const { db, asUser, nodeId } = await seed_apply_move_file(t, "source.md");
			const occupant = await asUser.action(api.files_nodes_content.create_text_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path: "occupied.txt",
			});
			if (occupant._nay) throw new Error(occupant._nay.message);
			const move = await propose_move_for_test(t, {
				...db,
				nodeId,
				destParent: { kind: "root" },
				destName: "occupied.txt",
				replace: true,
			});
			let laterNodeId: Id<"files_nodes"> | null = null;
			if (change === "edited") {
				const yjsDoc = files_yjs_doc_create_from_text({ rootKind: "rich_text", text: "New saved text" });
				if ("_nay" in yjsDoc) throw new Error(yjsDoc._nay.message);
				const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId: occupant._yay.nodeId,
					expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, occupant._yay.nodeId)).yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
					sessionId: "changed-replacement",
				});
				yjsDoc.destroy();
				expect(pushed._nay).toBeUndefined();
			} else if (change === "replaced") {
				const renamed = await test_rename_node(t, asUser, {
					membershipId: db.membershipId,
					nodeId: occupant._yay.nodeId,
					path: "previous.txt",
				});
				expect(renamed._nay).toBeUndefined();
				const later = await asUser.action(api.files_nodes_content.create_text_node, {
					membershipId: db.membershipId,
					parentId: files_ROOT_ID,
					path: "occupied.txt",
				});
				if (later._nay) throw new Error(later._nay.message);
				laterNodeId = later._yay.nodeId;
			}
			const accepted = await test_apply_file_pending_move(asUser, {
				membershipId: db.membershipId,
				...move,
			});
			const after = await t.run(async (ctx) => ({
				source: await ctx.db.get("files_nodes", nodeId),
				occupant: await ctx.db.get("files_nodes", occupant._yay.nodeId),
				later: laterNodeId ? await ctx.db.get("files_nodes", laterNodeId) : null,
				proposal: await ctx.db.get("files_pending_updates", move.pendingUpdateId),
			}));
			if (change === "unchanged") {
				expect(accepted._nay).toBeUndefined();
				expect(after.source?.path).toBe("/occupied.txt");
				expect(after.occupant?.archiveOperationId).toBeTruthy();
				expect(after.proposal).toBeNull();
			} else {
				expect(accepted._nay?.name).toBe("destination_changed");
				expect(after.source?.path).toBe("/source.md");
				expect(after.occupant?.archiveOperationId).toBeNull();
				expect(after.proposal).toMatchObject({ revision: move.reviewedRevision });
				if (change === "replaced")
					expect(after.later).toMatchObject({ path: "/occupied.txt", archiveOperationId: null });
			}
		},
	);

	test("keeps an unselected replacement error before a later name conflict", async () => {
		const t = test_convex();
		const { db, asUser, nodeId } = await seed_apply_move_file(t, "source.md");
		const occupant = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "occupied.txt",
		});
		if (occupant._nay) throw new Error(occupant._nay.message);
		const occupantId = occupant._yay.nodeId;
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const target = { kind: "saved" as const, id: occupantId };
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			...scope,
			target,
			expectedPendingContentVersion: (await t.run((ctx) => ctx.db.get("files_nodes", target.id)))!.pendingContentVersion,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		expect(
			await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...scope,
				operationBatchId: batch._yay.operationBatchId,
				role: "unstaged",
				text: "Unselected draft text.\n",
			}),
		).toEqual({ _yay: null });
		expect(
			await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target,
				operationBatchId: batch._yay.operationBatchId,
			}),
		).toEqual({ _yay: null });
		const unselected = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", occupantId),
				)
				.unique(),
		);
		if (!unselected) throw new Error("Expected the unselected content draft");
		const move = await propose_move_for_test(t, {
			...db,
			nodeId,
			destParent: { kind: "root" },
			destName: "occupied.txt",
			replace: true,
		});
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_updates", move.pendingUpdateId)))?.pendingMove?.replacesTarget,
		).toEqual({ kind: "saved", id: occupantId });
		expect(
			(await test_rename_node(t, asUser, {
				membershipId: db.membershipId,
				nodeId: occupantId,
				path: "previous.txt",
			}))._nay,
		).toBeUndefined();
		const later = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "occupied.txt",
		});
		if (later._nay) throw new Error(later._nay.message);
		const laterId = later._yay.nodeId;
		const read = () =>
			t.run(async (ctx) => ({
				nodes: await Promise.all([nodeId, occupantId, laterId].map((id) => ctx.db.get("files_nodes", id))),
				proposals: await Promise.all(
					[move.pendingUpdateId, unselected._id].map((id) => ctx.db.get("files_pending_updates", id)),
				),
			}));
		const before = await read();
		const review = await accept_move_proposals_for_test(t, db, [move.pendingUpdateId]);
		expect(review.activity?.status).toBe("failed");
		expect(review.units, "the first unselected-change error stays visible").toMatchObject([
			{
				errorCode: "needs_review",
				errorMessage: "This replacement also affects an unselected change. Review them together.",
			},
		]);
		expect(await read(), "refusal keeps every file and both proposals").toEqual(before);
	});
});

describe("files_nodes public read-only view", () => {
	/**
	 * A workspace where a second member holds a grant on the nested restricted folder but has no
	 * workspace-wide read. The outer folder is both unreadable for them and the lock root.
	 */
	async function seed_hidden_lock_root(t: ReturnType<typeof test_convex>) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Stamp Owner",
		});

		const outer = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "outer",
		});
		if (outer._nay) {
			throw new Error(outer._nay.message);
		}
		const inner = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: outer._yay.nodeId,
			path: "inner",
		});
		if (inner._nay) {
			throw new Error(inner._nay.message);
		}
		const file = await asOwner.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: inner._yay.nodeId,
			path: "secret.md",
		});
		if (file._nay) {
			throw new Error(file._nay.message);
		}

		// The nested folder becomes a restricted scope and the second member gets a direct grant
		// on it. The test inserts the docs, and the flush writes the grant's share row.
		const member = await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_nodes", inner._yay.nodeId, {
				restrictedScopeNodeId: inner._yay.nodeId,
				isRestrictedScopeRoot: true,
			});
			await ctx.db.patch("files_nodes", file._yay.nodeId, {
				restrictedScopeNodeId: inner._yay.nodeId,
			});

			const memberUserId = await ctx.db.insert("users", { clerkUserId: "clerk_stamp_member" });
			const now = Date.now();
			const memberMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: memberUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
				displayName: "",
				sortDisplayName: "",
			});
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				resourceKind: "file",
				resourceId: String(inner._yay.nodeId),
				principalKind: "user",
				userId: memberUserId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			return { memberUserId, memberMembershipId };
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: member.memberUserId,
			name: "Stamp Member",
		});

		// Lock the outer folder: the lock root sits above the member's readable scope.
		await set_read_only_or_throw({ asUser: asOwner, membershipId: db.membershipId, nodeId: outer._yay.nodeId });

		return {
			db,
			asOwner,
			asMember,
			memberMembershipId: member.memberMembershipId,
			outerId: outer._yay.nodeId,
			innerId: inner._yay.nodeId,
			fileId: file._yay.nodeId,
		};
	}

	test("list_tree_children and list_tree_shared_roots report no local lock on children of a hidden locked parent", async () => {
		const t = test_convex();
		const f = await seed_hidden_lock_root(t);
		const list_children = (args: {
			as: typeof f.asOwner;
			membershipId: Id<"organizations_workspaces_users">;
			parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
			kind: "folder" | "file";
			restricted: boolean;
		}) =>
			args.as.query(api.files_tree.list_tree_children, {
				stream: "normal" as const,
				membershipId: args.membershipId,
				parentId: args.parentId,
				kind: args.kind,
				archived: false,
				restricted: args.restricted,
				paginationOpts: { numItems: 50, cursor: null },
			});

		// The member gets the granted folder from their shares and its file from that folder. The root
		// lists nothing for them.
		const member = { as: f.asMember, membershipId: f.memberMembershipId, restricted: false };
		const [{ page: memberRoot }, { page: memberShares }, { page: memberFiles }] = await Promise.all([
			list_children({ ...member, parentId: files_ROOT_ID, kind: "folder" }),
			f.asMember.query(api.files_tree.list_tree_shared_roots, {
				membershipId: f.memberMembershipId,
				archived: false,
				principalIndex: 0,
				paginationOpts: { numItems: 50, cursor: null },
			}),
			list_children({ ...member, parentId: f.innerId, kind: "file" }),
		]);
		const memberTree = [...memberRoot, ...memberShares, ...memberFiles];
		// Only the granted scope is listed; the outer lock root itself never appears.
		expect(memberTree.map((node) => node.path).sort()).toEqual(["/outer/inner", "/outer/inner/secret.md"]);
		for (const node of memberTree) {
			expect(node.locked).toBe(false);
			if (node.locked) continue;
			// Children keep no rule of their own. The hidden outer lock does not apply here.
			expect(node.readOnly).toBe(false);
			// Decision IDs stay on the backend.
			expect("readOnlyDecisionId" in node).toBe(false);
		}

		const owner = { as: f.asOwner, membershipId: f.db.membershipId, kind: "folder" as const };
		const [{ page: ownerRoot }, { page: ownerOuter }] = await Promise.all([
			list_children({ ...owner, parentId: files_ROOT_ID, restricted: false }),
			// The inner folder is its own restricted root, so the owner reads it in the restricted twin.
			list_children({ ...owner, parentId: f.outerId, restricted: true }),
		]);
		const outerRow = ownerRoot.find((node) => node._id === f.outerId);
		const innerRow = ownerOuter.find((node) => node._id === f.innerId);
		expect(outerRow).toMatchObject({
			readOnly: true,
		});
		expect(innerRow).toMatchObject({
			readOnly: false,
		});
	});

	test("get_file_node_for_membership reports no lock on a child of a hidden locked parent", async () => {
		const t = test_convex();
		const f = await seed_hidden_lock_root(t);

		const memberView = await f.asMember.query(api.files_tree.get_file_node_for_membership, {
			membershipId: f.memberMembershipId,
			fileNodeId: f.fileId,
		});
		expect(memberView).toMatchObject({ readOnly: false });
		expect(memberView).not.toHaveProperty("writePolicyScopeNodeId");
		expect(memberView).not.toHaveProperty("writePolicy");

		const ownerView = await f.asOwner.query(api.files_tree.get_file_node_for_membership, {
			membershipId: f.db.membershipId,
			fileNodeId: f.fileId,
		});
		expect(ownerView).toMatchObject({
			readOnly: false,
		});

		const outerView = await f.asOwner.query(api.files_tree.get_file_node_for_membership, {
			membershipId: f.db.membershipId,
			fileNodeId: f.outerId,
		});
		expect(outerView).toMatchObject({
			readOnly: true,
		});
	});

	test("get_file_node_for_membership hides the plugin lock origin while metadata stays readable", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Stamp Privacy User",
		});
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "stamped-privacy",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const nodeId = folder._yay.nodeId;
		expect(
			await asUser.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: "plugin-name: data-probe",
			}),
		).toEqual({ _yay: null });
		expect(
			(
				await asUser.mutation(api.files_nodes.read_only_set, {
					membershipId: db.membershipId,
					nodeId,
					readOnly: true,
				})
			)._nay,
		).toBeUndefined();

		const view = await asUser.query(api.files_tree.get_file_node_for_membership, {
			membershipId: db.membershipId,
			fileNodeId: nodeId,
		});
		expect(view).toMatchObject({ readOnly: true });
		expect(view !== null && "writePolicy" in view).toBe(false);
		expect(
			await asUser.query(api.files_metadata.get_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
			}),
		).toEqual([{ key: "plugin-name", value: "data-probe" }]);
	});

	test("a writable node projects writable state with no source", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Stamp Writable User",
		});
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "plain",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}

		const view = await asUser.query(api.files_tree.get_file_node_for_membership, {
			membershipId: db.membershipId,
			fileNodeId: folder._yay.nodeId,
		});
		expect(view).toMatchObject({ readOnly: false });
		expect(view).not.toHaveProperty("writePolicy");
		expect(view).not.toHaveProperty("writePolicyScopeNodeId");
	});
});

describe("member controls on plugin-labeled nodes", () => {
	async function seed_labeled_folders(t: ReturnType<typeof test_convex>) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId, name: "Folder Owner" });
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/labeled/child/leaf",
		});
		if (created._nay) throw new Error(created._nay.message);
		const list_folders = (parentId: Id<"files_nodes"> | typeof files_ROOT_ID) =>
			asOwner.query(api.files_tree.list_tree_children, {
				stream: "normal" as const,
				membershipId: db.membershipId,
				parentId,
				kind: "folder",
				archived: false,
				restricted: false,
				paginationOpts: { numItems: 50, cursor: null },
			});
		const folderId = (await list_folders(files_ROOT_ID)).page.find((node) => node.path === "/labeled")!._id;
		const childId = (await list_folders(folderId)).page.find((node) => node.path === "/labeled/child")!._id;
		const leafId = created._yay.nodeId;
		expect(
			await asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: folderId,
				metadataYaml: "source: plugin\nplugin-name: chitchat",
			}),
		).toEqual({ _yay: null });
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_labeled_member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			return { userId, membershipId };
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: member.userId,
			name: "Folder Writer",
		});
		return { db, asOwner, asMember, member, folderId, childId, leafId };
	}

	test.each(["labeled", "inherited"] as const)("a manager can share a %s node and unlock its source", async (kind) => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		const nodeId = kind === "labeled" ? f.folderId : f.childId;
		const args = { membershipId: f.db.membershipId, nodeId };
		expect(await f.asOwner.query(api.files_sharing.get_node_share_state, args)).toMatchObject({
			canManage: true,
			canRestrict: true,
			canShareWithRoles: true,
		});
		expect(await f.asOwner.query(api.files_nodes.read_only_get, args)).toMatchObject({
			canEdit: true,
			readOnly: false,
		});
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.read_only_set, {
					readOnly: true,
					membershipId: f.db.membershipId,
					nodeId: f.folderId,
				})
			)._nay,
		).toBeUndefined();
		expect((await f.asOwner.mutation(api.files_sharing.restrict_node, args))._nay).toBeUndefined();
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					...args,
					principal: { kind: "user", userId: f.member.userId },
					level: "read",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.remove_node_share_grant, {
					...args,
					principal: { kind: "user", userId: f.member.userId },
				})
			)._nay,
		).toBeUndefined();
		expect((await f.asOwner.mutation(api.files_sharing.unrestrict_node, args))._nay).toBeUndefined();
		if (kind === "inherited") {
			expect(
				(await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: false }))._nay,
			).toBeUndefined();
		}
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.read_only_set, {
					readOnly: false,
					membershipId: f.db.membershipId,
					nodeId: f.folderId,
				})
			)._nay,
		).toBeUndefined();
		expect(await f.asOwner.query(api.files_nodes.read_only_get, args)).toMatchObject({
			canEdit: true,
			readOnly: false,
		});
		expect((await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: true }))._nay).toBeUndefined();
	});

	test("an editor can edit the label and Read-only flag, but cannot manage sharing", async () => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		const ownerArgs = { membershipId: f.db.membershipId, nodeId: f.folderId };
		expect((await f.asOwner.mutation(api.files_sharing.restrict_node, ownerArgs))._nay).toBeUndefined();
		expect(
			(
				await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					...ownerArgs,
					principal: { kind: "user", userId: f.member.userId },
					level: "write",
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asMember.mutation(api.files_metadata.set_entries, {
				membershipId: f.member.membershipId,
				fileNodeId: f.folderId,
				metadataYaml: "plugin-name: council",
			}),
		).toEqual({ _yay: null });
		const args = { membershipId: f.member.membershipId, nodeId: f.folderId };
		expect(await f.asMember.query(api.files_sharing.get_node_share_state, args)).toMatchObject({
			canManage: false,
			canRestrict: false,
			canShareWithRoles: false,
		});
		expect(await f.asMember.query(api.files_nodes.read_only_get, args)).toMatchObject({
			canEdit: true,
		});
		expect((await f.asMember.mutation(api.files_sharing.restrict_node, args))._nay).toBeDefined();
		expect((await f.asMember.mutation(api.files_sharing.unrestrict_node, args))._nay).toBeDefined();
		expect(
			(
				await f.asMember.mutation(api.files_sharing.set_node_share_grant, {
					...args,
					principal: { kind: "user", userId: f.db.userId },
					level: "read",
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await f.asMember.mutation(api.files_sharing.remove_node_share_grant, {
					...args,
					principal: { kind: "user", userId: f.member.userId },
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await f.asMember.mutation(api.files_nodes.read_only_set, {
					...args,
					readOnly: true,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(await f.asMember.mutation(api.files_nodes.read_only_set, { ...args, readOnly: false }))._nay,
		).toBeUndefined();
	});

	test("changing Read-only keeps descriptive plugin metadata", async () => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		const args = { membershipId: f.db.membershipId, nodeId: f.folderId };
		// Setting Read-only twice must leave the metadata untouched.
		for (let i = 0; i < 2; i += 1) {
			expect(
				(await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: true }))._nay,
			).toBeUndefined();
		}
		expect(await read_lock_node(t, f.folderId)).toMatchObject({ readOnly: true });
		for (const nodeId of [f.childId, f.leafId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ readOnly: false });
		}
		expect(
			(await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: false }))._nay,
		).toBeUndefined();
		for (const nodeId of [f.folderId, f.childId, f.leafId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ readOnly: false });
		}
		expect(
			await f.asOwner.query(api.files_metadata.get_entries, {
				membershipId: f.db.membershipId,
				fileNodeId: f.folderId,
			}),
		).toEqual([
			{ key: "source", value: "plugin" },
			{ key: "plugin-name", value: "chitchat" },
		]);
	});

	test("clearing Read-only leaves the child editable", async () => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.read_only_set, {
					membershipId: f.db.membershipId,
					nodeId: f.folderId,
					readOnly: true,
				})
			)._nay,
		).toBeUndefined();
		const args = { membershipId: f.db.membershipId, nodeId: f.childId };
		expect((await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: true }))._nay).toBeUndefined();
		expect(await read_lock_node(t, f.childId)).toMatchObject({
			readOnly: true,
		});
		expect(
			(await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: false }))._nay,
		).toBeUndefined();
		expect(await read_lock_node(t, f.folderId)).toMatchObject({ readOnly: true });
		for (const nodeId of [f.childId, f.leafId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ readOnly: false });
		}
	});

	test("changing the outer flag preserves a nested Read-only flag", async () => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.read_only_set, {
					membershipId: f.db.membershipId,
					nodeId: f.childId,
					readOnly: true,
				})
			)._nay,
		).toBeUndefined();
		const args = { membershipId: f.db.membershipId, nodeId: f.folderId };
		expect((await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: true }))._nay).toBeUndefined();
		expect(
			(await f.asOwner.mutation(api.files_nodes.read_only_set, { ...args, readOnly: false }))._nay,
		).toBeUndefined();
		expect(await read_lock_node(t, f.folderId)).toMatchObject({ readOnly: false });
		expect(await read_lock_node(t, f.childId)).toMatchObject({ readOnly: true });
		expect(await read_lock_node(t, f.leafId)).toMatchObject({ readOnly: false });
	});
});

describe("files_nodes_create.create_file_node read-only barrier", () => {
	test("waits for both initial PUTs before handing failed uploads to cleanup", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const bothStarted = Promise.withResolvers<void>();
		const latePut = Promise.withResolvers<void>();
		let puts = 0;
		vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== "PUT") throw new Error("Expected only initial PUTs");
			puts++;
			if (puts === 1) return new Response("denied", { status: 403 });
			bothStarted.resolve();
			await latePut.promise;
			return new Response(null, { status: 200 });
		}));
		const creation = asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "failed-upload.md",
		});
		await bothStarted.promise;
		const pending = await t.run(async (ctx) => ({
			assets: await ctx.db.query("files_r2_assets").collect(),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
			nodes: await ctx.db.query("files_nodes").collect(),
		}));
		latePut.resolve();
		const refused = await creation;
		expect(pending.assets).toHaveLength(2);
		expect(pending.jobs).toEqual([]);
		expect(pending.nodes).toEqual([]);
		expect(refused._nay?.message).toBe("Failed to create file");
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
		expect((await read_deletion_jobs(t)).map((job) => job.r2Key).sort()).toEqual(
			pending.assets.map((asset) => r2_create_asset_key({ ...db, assetId: asset._id })).sort(),
		);
	});

	test("the create mutation publishes both assets and the first version snapshot atomically", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const textContent = "# Atomic create";
		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
			text: textContent,
			rootKind: "rich_text",
		});
		if (snapshotUpdate._nay) {
			throw new Error(snapshotUpdate._nay.message);
		}
		const assets = await seed_unpublished_asset_pair(t, db);
		await t.run(async (ctx) => {
			await Promise.all([
				ctx.db.patch("files_r2_assets", assets.yjsSnapshotAssetId, {
					size: snapshotUpdate._yay.byteLength,
				}),
				ctx.db.patch("files_r2_assets", assets.contentSnapshotAssetId, {
					size: files_get_utf8_byte_size(textContent),
				}),
			]);
		});

		const created = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "atomic-create.md",
			contentType: "text/markdown;charset=utf-8",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent,
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected an editable created node");
			}
			const [contentAsset, yjsSnapshot, snapshots] = await Promise.all([
				ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId),
				ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId),
				ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", created._yay.nodeId),
					)
					.collect(),
			]);
			const yjsAsset = yjsSnapshot ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
			expect(contentAsset).toMatchObject({
				r2Key: r2_create_asset_key({
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					assetId: assets.contentSnapshotAssetId,
				}),
			});
			expect(contentAsset?.unfinalizedExpiresAt).toBeUndefined();
			expect(yjsAsset).toMatchObject({
				r2Key: r2_create_asset_key({
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					assetId: assets.yjsSnapshotAssetId,
				}),
			});
			expect(yjsAsset?.unfinalizedExpiresAt).toBeUndefined();
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]?.assetId).toBe(assets.contentSnapshotAssetId);
		});
	});

	test("a fresh barrier publishes the file and clears both creation deadlines", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Barrier Positive User",
		});

		// The public action checks the path, uploads both files, then checks the path again before saving.
		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "barrier-positive.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected an editable created node");
			}

			// The successful final mutation published both assets and cleared both deadlines.
			const contentAsset = node.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			expect(contentAsset?.r2Key).toBeTruthy();
			expect(contentAsset?.unfinalizedExpiresAt).toBeUndefined();
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			const yjsAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			expect(yjsAsset?.r2Key).toBeTruthy();
			expect(yjsAsset?.unfinalizedExpiresAt).toBeUndefined();

			// The initial version snapshot exists.
			const snapshots = await ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", created._yay.nodeId),
				)
				.collect();
			expect(snapshots.length).toBeGreaterThan(0);
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("a newly hidden locked segment returns permission denied before its lock state", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Create Privacy Owner",
		});
		const outer = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "privacy-outer",
		});
		if (outer._nay) {
			throw new Error(outer._nay.message);
		}
		const hidden = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: outer._yay.nodeId,
			path: "hidden",
		});
		if (hidden._nay) {
			throw new Error(hidden._nay.message);
		}

		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_create_privacy_member" });
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
				displayName: "",
				sortDisplayName: "",
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				createdAt: now,
				updatedAt: now,
			});
			return { userId };
		});
		const preflight = await t.query(internal.files_nodes_create_preflight.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: member.userId,
			parentId: files_ROOT_ID,
			path: "privacy-outer/hidden/leaf.md",
		});
		if (!preflight) {
			throw new Error("Expected the member to capture the open destination");
		}
		const assets = await seed_unpublished_asset_pair(t, { ...db, userId: member.userId });

		// The segment becomes a hidden restricted scope and is locked while the action uploads.
		// The final mutation must check access before returning any lock or path conflict.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", hidden._yay.nodeId, {
				restrictedScopeNodeId: hidden._yay.nodeId,
			});
		});
		await set_read_only_or_throw({ asUser: asOwner, membershipId: db.membershipId, nodeId: hidden._yay.nodeId });

		const refused = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: member.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "privacy-outer/hidden/leaf.md",
			contentType: "text/markdown;charset=utf-8",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "hidden",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		expect(refused._nay?.message).toBe("Permission denied");
		expect(refused._nay?.name).not.toBe("read_only");
		expect(await read_active_child({ t, db, parentId: hidden._yay.nodeId, name: "leaf.md" })).toBeNull();
		expect((await read_deletion_jobs(t)).map((job) => job.reason)).toEqual(["read_only_create", "read_only_create"]);
	});

	test("a create publishes when a lock is removed before the final mutation", async () => {
		const t = test_convex();
		const { db, asUser, innerId } = await seed_read_only_lock_tree(t);

		const preflight = await t.query(internal.files_nodes_create_preflight.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: innerId,
			path: "mid-lock.md",
		});
		if (!preflight) {
			throw new Error("Expected the current destination preflight to pass");
		}

		const assets = await seed_unpublished_asset_pair(t, db);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });

		const created = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: innerId,
			path: "mid-lock.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "mid lock",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		expect((await read_active_child({ t, db, parentId: innerId, name: "mid-lock.md" }))?._id).toBe(created._yay.nodeId);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId)).not.toBeNull();
			expect(await ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId)).not.toBeNull();
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("a currently locked destination refuses the prepared create and the action refuses before any upload", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);

		const preflight = await t.query(internal.files_nodes_create_preflight.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: siblingId,
			path: "prepared.md",
		});
		if (!preflight) {
			throw new Error("Expected a barrier for an existing destination");
		}
		const assets = await seed_unpublished_asset_pair(t, db);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: siblingId });

		// The full action refuses at capture time, before creating any asset docs.
		const assetCountBefore = await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length);
		const actionRefused = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: siblingId,
			path: "action-blocked.md",
		});
		expect(actionRefused._nay?.name).toBe("read_only");
		expect(actionRefused._nay?.message).toBe("This item is read-only.");
		expect(await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length)).toBe(assetCountBefore);

		// The prepared create (captured before the lock) refuses on the current lock in the final
		// mutation and hands its uploads to the ledger.
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));
		const refused = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: siblingId,
			path: "prepared.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "prepared",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		await t.finishInProgressScheduledFunctions();

		expect(await read_active_child({ t, db, parentId: siblingId, name: "prepared.md" })).toBeNull();
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId)).toBeNull();
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_create", "read_only_create"]);
	});

	test("a file created at the target during the action refuses the prepared create and hands the uploads to the ledger", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Raced Target User",
		});

		const barrier = await t.query(internal.files_nodes_create_preflight.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: files_ROOT_ID,
			path: "raced.md",
		});
		if (!barrier) {
			throw new Error("Expected a barrier for an absent target");
		}
		expect(barrier.targetNodeId).toBeNull();
		const assets = await seed_unpublished_asset_pair(t, db);

		// Another writer publishes the same path while the action is uploading.
		const winner = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "raced.md",
		});
		if (winner._nay) {
			throw new Error(winner._nay.message);
		}

		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));
		const refused = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "raced.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "raced",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		// The broken expectation is target absence, not a lock: this is a plain conflict.
		expect(refused._nay?.name).toBe("nay");
		expect(refused._nay?.message).toBe("This file already exists.");
		await t.finishInProgressScheduledFunctions();

		// The winner's file survives; only the loser's uploads went to the ledger.
		expect(await read_active_child({ t, db, parentId: files_ROOT_ID, name: "raced.md" })).not.toBeNull();
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", assets.contentSnapshotAssetId)).toBeNull();
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_create", "read_only_create"]);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId]),
		);
	});

	test("a create publishes after an old prefix lock is removed and archived", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "ABA Epoch User",
		});

		const preflight = await t.query(internal.files_nodes_create_preflight.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: files_ROOT_ID,
			path: "aba/mid/leaf.md",
		});
		if (!preflight) {
			throw new Error("Expected the current destination preflight to pass");
		}

		const assets = await seed_unpublished_asset_pair(t, db);

		// While the action uploads, another writer creates, locks, unlocks, and archives the prefix.
		const aba = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "aba",
		});
		if (aba._nay) {
			throw new Error(aba._nay.message);
		}
		const mid = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: aba._yay.nodeId,
			path: "mid",
		});
		if (mid._nay) {
			throw new Error(mid._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: mid._yay.nodeId });
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: mid._yay.nodeId });
		for (const nodeId of [mid._yay.nodeId, aba._yay.nodeId]) {
			const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: db.membershipId,
				nodeIds: [nodeId],
			});
			if (archived._nay) {
				throw new Error(archived._nay.message);
			}
		}
		expect(await read_active_child({ t, db, parentId: files_ROOT_ID, name: "aba" })).toBeNull();

		const created = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "aba/mid/leaf.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "aba",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.path).toBe("/aba/mid/leaf.md");
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("the pending-create policy publishes after a completed lock cycle", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Current Lock Create User",
		});
		const assets = await seed_unpublished_asset_pair(t, db);

		// Simulate a prefix that appeared, locked, unlocked, and disappeared while the pending
		// create prepared its assets. Only the lock state in the final mutation matters here.
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "pending-cycle",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: folder._yay.nodeId });
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: folder._yay.nodeId });
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [folder._yay.nodeId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}

		const created = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			path: "pending-cycle/deep/leaf.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "pending",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", created._yay.nodeId));
		expect(node?.path).toBe("/pending-cycle/deep/leaf.md");
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("lock cycles on an archived folder do not stale creates that reuse its path", async () => {
		const t = test_convex();
		const { db, asUser, outerId, frozenId } = await seed_read_only_lock_tree(t);

		// /outer/frozen is archived, so the create walks past it and would recreate the folder.
		const preflight = await t.query(internal.files_nodes_create_preflight.get_create_file_node_write_preflight, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			parentId: outerId,
			path: "frozen/nested.md",
		});
		if (!preflight) {
			throw new Error("Expected the current destination preflight to pass");
		}

		const assets = await seed_unpublished_asset_pair(t, db);
		// A lock on an archived copy does not affect the new active path after it is removed.
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: frozenId });
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: frozenId });

		const created = await t.mutation(internal.files_nodes_create.create_file_node, {
			userId: db.userId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: outerId,
			path: "frozen/nested.md",
			contentType: "text/markdown",
			assetId: assets.contentSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			textContent: "nested",
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.contentSnapshotAssetId],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay.nodeId);
			expect(node?.path).toBe("/outer/frozen/nested.md");
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});

/**
 * A file with one restorable snapshot and the two unpublished snapshot assets a restore action
 * would have uploaded. The published snapshot asset keeps its r2Key; the current/restored pair
 * has none and still carries the insert-time cleanup deadline.
 */
async function seed_snapshot_restore_target(args: {
	t: ReturnType<typeof test_convex>;
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
	path: string;
}) {
	const { t, db, path } = args;

	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path,
	});

	return await t.run(async (ctx) => {
		const now = Date.now();
		const [snapshotAssetId, currentSnapshotAssetId, restoredSnapshotAssetId] = await Promise.all([
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/restore-gate-snapshot`,
				size: 4,
				createdBy: db.userId,
				updatedAt: now,
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
			ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content_snapshot",
				r2Bucket: "test-bucket",
				size: 4,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 1000,
				updatedAt: now,
			}),
		]);
		const snapshotId = await ctx.db.insert("files_snapshots", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: nodeId,
			assetId: snapshotAssetId,
			createdBy: db.userId,
			archivedAt: 0,
			contentType: "text/markdown;charset=utf-8",
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});
		return { nodeId, snapshotId, currentSnapshotAssetId, restoredSnapshotAssetId };
	});
}

/** Read every value that a refused restore must leave unchanged. */
function read_restore_write_surfaces(args: {
	t: ReturnType<typeof test_convex>;
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
	nodeId: Id<"files_nodes">;
}) {
	const { t, db, nodeId } = args;

	return t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", nodeId);
		const snapshots = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		const chunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect();
		return {
			assetId: node?.assetId,
			snapshotCount: snapshots.length,
			yjsUpdateCount: yjsUpdates.length,
			chunkText: chunks.map((chunk) => chunk.plainTextChunk).join(""),
		};
	});
}

describe("files_nodes_content.restore_snapshot read-only gates", () => {
	test("a locked file refuses the prepared restore before any write and hands both keys to the ledger", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Lock User",
		});
		const seeded = await seed_snapshot_restore_target({ t, db, path: "/restore-lock.md" });
		const before = await read_restore_write_surfaces({ t, db, nodeId: seeded.nodeId });

		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: seeded.nodeId });
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));

		// The live lock refuses the restore.
		const refused = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
			preparedSourceHeadId: (await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.contentHeadId!,
			membershipId: db.membershipId,
			nodeId: seeded.nodeId,
			expectedPendingContentVersion: (await asUser.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.pendingContentVersion,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			expectedLastSequence: 0,
			snapshotId: seeded.snapshotId,
			sessionId: "restore-lock-test",
			snapshotMarkdownContent: "# restored\n",
			currentSnapshotAssetId: seeded.currentSnapshotAssetId,
			currentSnapshotSize: 0,
			restoredSnapshotAssetId: seeded.restoredSnapshotAssetId,
			restoredSnapshotSize: 4,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		await t.finishInProgressScheduledFunctions();

		// Nothing was written: node pointer, snapshot history, Yjs updates, and chunks are as before.
		expect(await read_restore_write_surfaces({ t, db, nodeId: seeded.nodeId })).toEqual(before);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", seeded.currentSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", seeded.restoredSnapshotAssetId)).toBeNull();
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_snapshot_restore", "read_only_snapshot_restore"]);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [seeded.currentSnapshotAssetId, seeded.restoredSnapshotAssetId]),
		);
	});

	test("handed-off ledger jobs survive failed deletes with failures counted", async () => {
		// Fake timers make the runAfter(0) processors start deterministically before the readback.
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const asUser = t.withIdentity({
				issuer: "https://clerk.test",
				external_id: db.userId,
				name: "Restore Retry User",
			});
			const seeded = await seed_snapshot_restore_target({ t, db, path: "/restore-retry.md" });
			await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: seeded.nodeId });

			// Every confirmed delete fails: the exact keys must stay in the ledger for the retry
			// backoff and the hourly sweep, never silently dropped.
			vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));
			const refused = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
				preparedSourceHeadId: (await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.contentHeadId!,
				membershipId: db.membershipId,
				nodeId: seeded.nodeId,
				expectedPendingContentVersion: (await asUser.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.pendingContentVersion,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
				expectedLastSequence: 0,
				snapshotId: seeded.snapshotId,
				sessionId: "restore-retry-test",
				snapshotMarkdownContent: "# restored\n",
				currentSnapshotAssetId: seeded.currentSnapshotAssetId,
				currentSnapshotSize: 0,
				restoredSnapshotAssetId: seeded.restoredSnapshotAssetId,
				restoredSnapshotSize: 4,
			});
			expect(refused._nay?.name).toBe("read_only");

			// Fire the runAfter(0) processors, then wait for their failure records to land.
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();

			const jobs = await read_deletion_jobs(t);
			expect(jobs.length).toBe(2);
			for (const job of jobs) {
				expect(job.reason).toBe("read_only_snapshot_restore");
				expect(job.failureCount).toBe(1);
				expect(job.nextAttemptAt).toBeGreaterThan(Date.now());
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test("restore succeeds after unlock and clears both deadlines", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-restore-readonly-user",
			});
			return await test_mocks_fill_db_with.membership(ctx, { userId });
		});
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Restore Unlocked User",
			email: "restore-readonly-user@example.com",
		});
		const seeded = await seed_snapshot_restore_target({ t, db, path: "/restore-unlocked.md" });

		// Only the lock state in the final mutation matters.
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: seeded.nodeId });
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: seeded.nodeId });

		const restoredMarkdown = "# restored content\n";
		const restoreStage = await t.mutation(internal.files_pending_updates.stage_trusted_yjs_update, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: seeded.nodeId,
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

		await t.run((ctx) => ctx.db.patch("files_r2_assets", seeded.restoredSnapshotAssetId, {
			size: files_get_utf8_byte_size(restoredMarkdown),
		}));
		const prepared = await t.action((ctx) => files_content_sources_action_prepare(ctx, {
			nodeId: seeded.nodeId, assetId: seeded.restoredSnapshotAssetId, text: restoredMarkdown,
		}));
		if (prepared._nay) throw new Error(prepared._nay.message);
		const restored = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
			preparedSourceHeadId: prepared._yay,
			membershipId: db.membershipId,
			nodeId: seeded.nodeId,
			expectedPendingContentVersion: (await asUser.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.pendingContentVersion,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			expectedLastSequence: 0,
			snapshotId: seeded.snapshotId,
			sessionId: "restore-unlocked-test",
			snapshotMarkdownContent: restoredMarkdown,
			currentSnapshotAssetId: seeded.currentSnapshotAssetId,
			currentSnapshotSize: 0,
			restoredSnapshotAssetId: seeded.restoredSnapshotAssetId,
			restoredSnapshotSize: files_get_utf8_byte_size(restoredMarkdown),
			restoreUpdateStageId: restoreStage._yay.stageId,
		});
		if (restored._nay) {
			throw new Error(`Expected restore to succeed, got: ${restored._nay.message}`);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.restoredSnapshotAssetId);
			// The success path published both assets and cleared both cleanup deadlines.
			const currentAsset = await ctx.db.get("files_r2_assets", seeded.currentSnapshotAssetId);
			expect(currentAsset?.r2Key).toBeTruthy();
			expect(currentAsset?.unfinalizedExpiresAt).toBeUndefined();
			const restoredAsset = await ctx.db.get("files_r2_assets", seeded.restoredSnapshotAssetId);
			expect(restoredAsset?.r2Key).toBeTruthy();
			expect(restoredAsset?.unfinalizedExpiresAt).toBeUndefined();
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});

/**
 * A durably marked file plus the three asset docs a repair action hands to its final mutation:
 * the two fresh unpublished uploads and the superseded Yjs snapshot asset.
 */
async function seed_repair_finalize_target(args: {
	t: ReturnType<typeof test_convex>;
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
	path: string;
}) {
	const { t, db, path } = args;

	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path,
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
	return { nodeId, yjsSnapshotAssetId, contentSnapshotAssetId, supersededYjsAssetId };
}

describe("files_nodes_content.cleanup_file_yjs_covered_rows", () => {
	test("durably deletes the superseded Yjs object after a confirmed delete retry", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-superseded-cleanup.md",
		});

		const superseded = await test_run_with_flush(t, async (ctx) => {
			const node = await ctx.db.get("files_nodes", createdId);
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected an editable repair target");
			}
			const snapshot = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			if (!snapshot) {
				throw new Error("Expected a Yjs snapshot");
			}
			const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
			if (!asset?.r2Key) {
				throw new Error("Expected a published Yjs snapshot asset");
			}

			const replacementAssetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "yjs_snapshot",
				r2Bucket: "test-files-bucket",
				size: 2,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			await ctx.db.patch("files_yjs_snapshots", snapshot._id, { assetId: replacementAssetId });

			const head = (await ctx.db.get("files_saved_content_heads", node.contentHeadId!))!;
			return { assetId: asset._id, key: asset.r2Key, throughSequence: snapshot.sequence, logOwnerId: head.yjsContentHeadId! };
		});

		const finiteDeleteSpy = vi.spyOn(R2.prototype, "deleteObject");
		const confirmedDeleteSpy = vi
			.spyOn(r2_confirmed_object_delete, "delete_object")
			.mockRejectedValueOnce(new Error("simulated R2 outage"));

		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_covered_rows, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: createdId,
			logOwnerId: superseded.logOwnerId,
			throughSequence: superseded.throughSequence,
			supersededYjsAssetId: superseded.assetId,
		});
		expect(finiteDeleteSpy).not.toHaveBeenCalled();
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", superseded.assetId))).toBeNull();

		const [job] = await read_deletion_jobs(t);
		expect(job).toMatchObject({ r2Key: superseded.key, reason: "untracked_asset_event", generation: 1 });
		if (!job) {
			throw new Error("Expected a superseded-object deletion job");
		}
		await t.action(internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		expect((await read_deletion_jobs(t))[0]).toMatchObject({
			r2Key: superseded.key,
			failureCount: 1,
		});

		confirmedDeleteSpy.mockResolvedValue(undefined);
		await t.action(internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});

describe("files_nodes_content.finalize_file_yjs_repair read-only gates", () => {
	test("a locked file refuses finalize before the staleness checks and hands both keys to the ledger", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Repair Lock User",
		});
		const seeded = await seed_repair_finalize_target({ t, db, path: "/repair-gate-lock.md" });
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: seeded.nodeId });
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("simulated R2 outage"));

		// `targetSequence` is deliberately stale. A `read_only` result proves the lock check runs
		// before the staleness checks, so no later check can publish first.
		const pointers = await test_get_file_yjs_pointers(t, seeded.nodeId);
		const refused = await t.mutation(internal.files_nodes_content.finalize_file_yjs_repair, {
			preparedSourceHeadId: (await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.contentHeadId!,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: seeded.nodeId,
			expectedPendingContentVersion: (await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!.pendingContentVersion,
			authorUserId: db.userId,
			source: "latest_state",
			acknowledgeDiscardUnmaterialized: false,
			targetSequence: 999,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			text: "repair.",
			textByteSize: files_get_utf8_byte_size("repair."),
			yjsSnapshotAssetId: seeded.yjsSnapshotAssetId,
			yjsSnapshotSize: 2,
			contentSnapshotAssetId: seeded.contentSnapshotAssetId,
			supersededYjsAssetId: seeded.supersededYjsAssetId,
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		await t.finishInProgressScheduledFunctions();

		// The fresh uploads went to the ledger; the node, its markers, and the superseded asset
		// are untouched.
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", seeded.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", seeded.contentSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", seeded.supersededYjsAssetId)).not.toBeNull();
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.contentShapeMismatchAt).toBeDefined();
			if (!files_node_has_editable_yjs_state(node)) {
				throw new Error("Expected the node to stay editable");
			}
			const lastSequenceDoc = await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId);
			expect(lastSequenceDoc?.lineageGeneration).toBe(0);
		});
		const jobs = await read_deletion_jobs(t);
		expect(jobs.map((job) => job.reason)).toEqual(["read_only_yjs_repair", "read_only_yjs_repair"]);
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			expected_ledger_keys(db, [seeded.yjsSnapshotAssetId, seeded.contentSnapshotAssetId]),
		);
	});

	test("the repair action refuses a locked file before creating any assets", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Repair Early Refusal User",
		});
		const createdId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/repair-early-refusal.md",
		});
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", createdId, { contentShapeMismatchAt: Date.now() });
		});
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: createdId });

		const assetCountBefore = await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length);
		const refused = await t.action(internal.files_nodes_content.repair_file_yjs_state_from_visible_text, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: createdId,
			authorUserId: db.userId,
		});
		expect(refused).toMatchObject({ _nay: { name: "read_only" } });
		expect(refused._nay?.message).toBe("This item is read-only.");

		expect(await t.run(async (ctx) => (await ctx.db.query("files_r2_assets").collect()).length)).toBe(assetCountBefore);
		expect(await read_deletion_jobs(t)).toEqual([]);
	});

	test("repair succeeds after unlock and clears both upload deadlines", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Repair Unlocked User",
		});
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
			path: "/repair-unlocked.md",
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
		await test_run_with_flush(t, (ctx) =>
			ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() }));

		// The operator unlocked before repairing, so the final mutation accepts it.
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId });
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId });

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
			expect(node.contentShapeMismatchAt).toBeNull();

			// The repair's published uploads carry keys and no cleanup deadline.
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId);
			const yjsAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			expect(yjsAsset?.r2Key).toBeTruthy();
			expect(yjsAsset?.unfinalizedExpiresAt).toBeUndefined();
			const contentAsset = node.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			expect(contentAsset?.r2Key).toBeTruthy();
			expect(contentAsset?.unfinalizedExpiresAt).toBeUndefined();
		});
		expect(await read_deletion_jobs(t)).toEqual([]);
	});
});
