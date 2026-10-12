import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
import type { FunctionReturnType } from "convex/server";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import {
	files_line_range_from_text,
	files_nodes_db_require_writable,
	files_nodes_db_set_write_policy,
	files_nodes_db_get_write_policy_management_state,
	type files_nodes_WriteContext,
	files_nodes_db_get_content_version,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_hard_delete_node,
	files_tail_lines_from_text,
} from "./files_nodes.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	db_insert_file_text_content,
	files_nodes_create_yjs_snapshot_update_from_text,
} from "./files_nodes_content.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import {
	test_apply_file_pending_move,
	test_convex,
	test_finish_pending_update_run,
	test_rename_node,
	test_move_nodes,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { advance as advance_move_cohort } from "./files_move_cohorts.ts";
import { files_subtree_ops_STEP_MAX_NODES } from "./files_subtree_ops.ts";
import {
	files_MAX_UPLOADS_BYTES,
	files_node_has_editable_yjs_state,
	files_ROOT_ID,
	files_INITIAL_CONTENT,
	files_UPLOAD_PATH_TAKEN_MESSAGE,
	files_db_get_visible_node_by_path,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { delay } from "../shared/async-utils.ts";
import { r2_confirmed_object_delete, r2_create_asset_key } from "./r2_client.ts";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { files_WRITE_POLICY_INVALID_WRITERS_MESSAGE } from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	insert_tree_node,
	seed_tree_access_fixture,
	seed_folder_table,
	seed_billing_snapshot_for_user,
	propose_move_for_test,
	test_setup_r2_capture,
	test_materialize_markdown_file,
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

describe("bounded read line helpers", () => {
	test("files_line_range_from_text slices a 1-based line range", () => {
		const content = "a\nb\nc\nd\ne\n";
		expect(files_line_range_from_text({ content, startLine: 1, maxLines: 2 })).toMatchObject({
			content: "a\nb\n",
			linesReturned: 2,
			moreLines: true,
		});
		expect(files_line_range_from_text({ content, startLine: 3, maxLines: 2 })).toMatchObject({
			content: "c\nd\n",
			linesReturned: 2,
			moreLines: true,
		});
		expect(files_line_range_from_text({ content, startLine: 5, maxLines: 2 })).toMatchObject({
			content: "e\n",
			linesReturned: 1,
			moreLines: false,
		});
		// Range entirely past the end → empty, no more lines.
		expect(files_line_range_from_text({ content, startLine: 10, maxLines: 2 })).toMatchObject({
			content: "",
			linesReturned: 0,
			moreLines: false,
		});
		// No trailing newline: the final unterminated line still counts.
		expect(files_line_range_from_text({ content: "x\ny", startLine: 1, maxLines: 5 })).toMatchObject({
			content: "x\ny\n",
			linesReturned: 2,
			moreLines: false,
		});
	});

	test("line pages stop at a UTF-8 byte boundary without skipping the next line", () => {
		const lines = Array.from({ length: 500 }, (_, index) => `${index}: ${"é".repeat(500)}\n`);
		const content = lines.join("");
		const first = files_line_range_from_text({ content, startLine: 1, maxLines: 500 });
		const second = files_line_range_from_text({ content, startLine: first.linesReturned + 1, maxLines: 500 });

		expect(new TextEncoder().encode(first.content).byteLength).toBeLessThanOrEqual(64 * 1024);
		expect(first.linesReturned).toBeGreaterThan(0);
		expect(first.linesReturned).toBeLessThan(500);
		expect(first.content).toBe(lines.slice(0, first.linesReturned).join(""));
		expect(second.content.startsWith(lines[first.linesReturned])).toBe(true);
		expect(first.moreLines).toBe(true);
	});

	test("files_line_range_from_text truncates a pathologically long line with a marker", () => {
		const longLine = "Z".repeat(50000);
		const content = `short\n${longLine}\nafter\n`;

		const result = files_line_range_from_text({ content, startLine: 2, maxLines: 1 });
		expect(result.linesReturned).toBe(1);
		// Truncated to the display cap (8000), not the full 50000 chars.
		expect(result.content.length).toBeLessThan(50000);
		expect(result.content.startsWith("Z".repeat(8000))).toBe(true);
		expect(result.content).toContain("[line truncated to 8000 chars");
		// A normal-length line is returned untouched.
		expect(files_line_range_from_text({ content, startLine: 1, maxLines: 1 }).content).toBe("short\n");
	});

	test("files_tail_lines_from_text returns the last lines and truncates long ones", () => {
		expect(files_tail_lines_from_text("a\nb\nc\nd\n", 2)).toMatchObject({ content: "c\nd\n" });
		const out = files_tail_lines_from_text(`p\n${"Q".repeat(20000)}\n`, 1);
		expect(out.content).toContain("[line truncated to 8000 chars");
		expect(out.content.length).toBeLessThan(20000);
	});
});

async function seed_paginated_bash_listing_fixture(ctx: MutationCtx) {
	const membership = await test_mocks_fill_db_with.membership(ctx);
	const docsFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: files_ROOT_ID,
		name: "docs",
		kind: "folder",
		path: "/docs",
		treePath: "/docs/",
		pathDepth: 1,
		updatedAt: 1,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "a.md",
		kind: "file",
		path: "/docs/a.md",
		treePath: "/docs/a.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		updatedAt: 2,
		contentType: "text/markdown;charset=utf-8",
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "b.md",
		kind: "file",
		path: "/docs/b.md",
		treePath: "/docs/b.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		updatedAt: 3,
	});
	const nestedFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "nested",
		kind: "folder",
		path: "/docs/nested",
		treePath: "/docs/nested/",
		pathDepth: 2,
		updatedAt: 4,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: nestedFolderId,
		name: "c.md",
		kind: "file",
		path: "/docs/nested/c.md",
		treePath: "/docs/nested/c.md",
		pathDepth: 3,
		lowercaseExtension: "md",
		updatedAt: 5,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: docsFolderId,
		name: "z-archived.md",
		kind: "file",
		path: "/docs/z-archived.md",
		treePath: "/docs/z-archived.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		archiveOperationId: "archive-operation-test",
		updatedAt: 6,
	});
	const siblingPrefixFolderId = await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: files_ROOT_ID,
		name: "docs-archive",
		kind: "folder",
		path: "/docs-archive",
		treePath: "/docs-archive/",
		pathDepth: 1,
		updatedAt: 7,
	});
	await ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		createdBy: membership.userId,
		updatedBy: membership.userId,
		parentId: siblingPrefixFolderId,
		name: "outside.md",
		kind: "file",
		path: "/docs-archive/outside.md",
		treePath: "/docs-archive/outside.md",
		pathDepth: 2,
		lowercaseExtension: "md",
		updatedAt: 8,
	});

	return { ...membership, docsFolderId };
}

describe("list_tree_children", () => {
	const REFUSED = { page: [], isDone: true, continueCursor: "" };

	test("pages folders then files in the folder table name order, capped at 200 per page", async () => {
		const t = test_convex();
		const fileNames = Array.from(
			{ length: 450 },
			(_, index) => `${index % 3 === 0 ? "B" : "a"}-${String(index).padStart(3, "0")}.md`,
		);
		const db = await t.run(async (ctx) => {
			const owner = await test_mocks_fill_db_with.membership(ctx);
			const bigId = await insert_tree_node({ ctx, owner, parentId: files_ROOT_ID, path: "/big", kind: "folder" });
			for (const name of ["zeta", "Alpha", "10", "9"]) {
				await insert_tree_node({ ctx, owner, parentId: bigId, path: `/big/${name}`, kind: "folder" });
			}
			await Promise.all(
				fileNames.map((name) => insert_tree_node({ ctx, owner, parentId: bigId, path: `/big/${name}`, kind: "file" })),
			);
			return { ...owner, bigId };
		});
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const list_page = (kind: "folder" | "file", cursor: string | null) =>
			asOwner.query(api.files_nodes.list_tree_children, {
				membershipId: db.membershipId,
				parentId: db.bigId,
				kind,
				archived: false,
				restricted: false,
				paginationOpts: { numItems: 1000, cursor },
			});

		const folders = await list_page("folder", null);
		// The `(sortName, name)` order: numbers by value and no case, like the folder table.
		expect(folders.page.map((row) => row.name)).toEqual(["9", "10", "Alpha", "zeta"]);
		expect(folders.isDone).toBe(true);

		const first = await list_page("file", null);
		const second = await list_page("file", first.continueCursor);
		const third = await list_page("file", second.continueCursor);
		expect([first.page.length, second.page.length, third.page.length]).toEqual([200, 200, 50]);
		expect([first.isDone, second.isDone, third.isDone]).toEqual([false, false, true]);

		const names = [...first.page, ...second.page, ...third.page].map((row) => row.name);
		// Every name has its own key here, so the key alone gives the order.
		expect(names).toEqual([...fileNames].sort((a, b) => (files_sort_text_key(a) < files_sort_text_key(b) ? -1 : 1)));
		expect(new Set(names).size).toBe(450);
	});

	test("archived mode returns only archived children of the requested kind", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const list = (kind: "folder" | "file", archived: boolean) =>
			f.asOwner.query(api.files_nodes.list_tree_children, {
				membershipId: f.owner.membershipId,
				parentId: f.nodes.openId,
				kind,
				archived,
				restricted: false,
				paginationOpts: { numItems: 50, cursor: null },
			});

		const [activeFiles, activeFolders, archivedFiles, archivedFolders] = await Promise.all([
			list("file", false),
			list("folder", false),
			list("file", true),
			list("folder", true),
		]);
		expect(activeFiles.page.map((row) => row._id)).toEqual([f.nodes.openFileId]);
		expect(activeFolders.page.map((row) => row._id)).toEqual([f.nodes.openSubId]);
		expect(archivedFiles.page.map((row) => row._id)).toEqual([f.nodes.archivedFileId]);
		expect(archivedFolders.page.map((row) => row._id)).toEqual([f.nodes.archivedFolderId]);
		// A row carries the computed write fields, not the raw `writePolicy` field.
		expect(activeFiles.page[0]).toMatchObject({ canWrite: true, writeBlockedReason: null, writePolicyState: "none" });
		expect("writePolicy" in activeFiles.page[0]).toBe(false);
	});

	test("archived mode does not read the archived children of the other kind", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const owner = await test_mocks_fill_db_with.membership(ctx);
			const binId = await insert_tree_node({ ctx, owner, parentId: files_ROOT_ID, path: "/bin", kind: "folder" });
			// One archive operation, so "file" sorts before "folder" inside it.
			for (let index = 0; index < 1001; index++)
				await insert_tree_node({
					ctx,
					owner,
					parentId: binId,
					path: `/bin/f${index}.md`,
					kind: "file",
					archiveOperationId: "op",
				});
			const folderId = await insert_tree_node({
				ctx,
				owner,
				parentId: binId,
				path: "/bin/old",
				kind: "folder",
				archiveOperationId: "op",
			});
			return { ...owner, binId, folderId };
		});

		const folders = await t
			.withIdentity({ issuer: "https://clerk.test", external_id: db.userId })
			.query(api.files_nodes.list_tree_children, {
				membershipId: db.membershipId,
				parentId: db.binId,
				kind: "folder",
				archived: true,
				restricted: false,
				paginationOpts: { numItems: 50, cursor: null },
			});

		expect(folders.page.map((row) => row._id)).toEqual([db.folderId]);
		expect(folders.isDone).toBe(true);
	});

	test("a folder whose only child is hidden lists nothing, and only the owner reads the restricted twin", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const list = (as: typeof f.asAdmin, membershipId: Id<"organizations_workspaces_users">, restricted: boolean) =>
			as.query(api.files_nodes.list_tree_children, {
				membershipId,
				parentId: f.nodes.boxId,
				kind: "folder",
				archived: false,
				restricted,
				paginationOpts: { numItems: 50, cursor: null },
			});

		const adminPage = await list(f.asAdmin, f.admin.membershipId, false);
		expect(adminPage.page).toEqual([]);
		expect(adminPage.isDone).toBe(true);
		expect(await list(f.asAdmin, f.admin.membershipId, true)).toEqual(REFUSED);

		// The open stream never holds a restricted root, so the owner gets it from the twin only.
		expect((await list(f.asOwner, f.owner.membershipId, false)).page).toEqual([]);
		const ownerPage = await list(f.asOwner, f.owner.membershipId, true);
		expect(ownerPage.page.map((row) => row._id)).toEqual([f.nodes.boxSecretId]);
	});

	test("the owner reads an archived restricted child in the archived restricted twin only", async () => {
		const { t, db, asOwner, parentId, insert_child } = await seed_folder_table();
		const nodeId = await insert_child({ name: "gone", kind: "folder", updatedAt: 1, restricted: true });
		await t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { archiveOperationId: "archive-1" }));
		const list = (archived: boolean, restricted: boolean) =>
			asOwner.query(api.files_nodes.list_tree_children, {
				membershipId: db.membershipId,
				parentId,
				kind: "folder",
				archived,
				restricted,
				paginationOpts: { numItems: 50, cursor: null },
			});

		expect((await list(true, true)).page.map((row) => row._id)).toEqual([nodeId]);
		expect((await list(true, false)).page).toEqual([]);
		expect((await list(false, true)).page).toEqual([]);
	});

	test("refuses a member's restricted twin before reading the folder", async () => {
		const { parentId, add_member } = await seed_folder_table();
		const member = await add_member("clerk_tree_twin_refusal", "member");
		// The root has no folder to read, so a refusal at the folder costs the same only when it reads
		// no folder.
		const read_cost = (at: Id<"files_nodes"> | typeof files_ROOT_ID) =>
			member.as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_nodes.list_tree_children, {
					membershipId: member.membershipId,
					parentId: at,
					kind: "folder",
					archived: false,
					restricted: true,
					paginationOpts: { numItems: 50, cursor: null },
				});
				const after = await ctx.meta.getTransactionMetrics();
				return { result, ranges: after.databaseQueries.used - before.databaseQueries.used };
			});

		const atRoot = await read_cost(files_ROOT_ID);
		const atFolder = await read_cost(parentId);
		expect([atRoot.result, atFolder.result]).toEqual([REFUSED, REFUSED]);
		expect(atFolder.ranges).toBe(atRoot.ranges);
	});

	// convex-test marks any page that reads more than `numItems` + 1 rows, so this proves the split
	// runs before any row read, not the 1,000 guard: a page asks for at most 200 rows.
	test("an owner restricted page whose end cursor holds more rows than it asks for asks for a split and reads no row", async () => {
		const { t, db, asOwner, parentId, insert_children } = await seed_folder_table();
		const ids = await insert_children(
			Array.from({ length: 103 }, (_, index) => ({
				name: `r-${String(index).padStart(4, "0")}`,
				kind: "folder" as const,
				updatedAt: 1,
				restricted: true,
			})),
		);
		const read = (paginationOpts: { numItems: number; cursor: string | null; endCursor?: string }) =>
			asOwner.query(api.files_nodes.list_tree_children, {
				membershipId: db.membershipId,
				parentId,
				kind: "folder",
				archived: false,
				restricted: true,
				paginationOpts,
			});

		// 100 rows and 2 more put the end cursor after row 102: one more than `numItems` + 1.
		const first = await read({ numItems: 100, cursor: null });
		const endCursor = (await read({ numItems: 2, cursor: first.continueCursor })).continueCursor;

		// A SYSTEM author makes the tree rows throw, so this page proves the guard runs before any row read.
		await t.run((ctx) => ctx.db.patch("files_nodes", ids[101]!, { createdBy: users_SYSTEM_AUTHOR }));
		expect(await read({ numItems: 100, cursor: null, endCursor })).toEqual({
			page: [],
			isDone: false,
			continueCursor: endCursor,
			splitCursor: expect.any(String),
			pageStatus: "SplitRequired",
		});
		// A pinned page under the guard gives its rows.
		const small = await read({ numItems: 200, cursor: null, endCursor: first.continueCursor });
		expect(small.page).toHaveLength(100);
	});

	test("an unreadable, foreign, or missing parent gives the same empty answer", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const list = (parentId: Id<"files_nodes">) =>
			f.asAdmin.query(api.files_nodes.list_tree_children, {
				membershipId: f.admin.membershipId,
				parentId,
				kind: "folder",
				archived: false,
				restricted: false,
				paginationOpts: { numItems: 50, cursor: null },
			});

		// A readable parent lists its children, so the empty answers below come from the gate.
		expect((await list(f.nodes.openId)).page.map((row) => row._id)).toEqual([f.nodes.openSubId]);

		// The admin can read `/top/hidden/granted` but not its parent. Listing the parent must not
		// show the granted child, or it would confirm what the hidden folder holds.
		expect(await list(f.nodes.hiddenId)).toEqual(REFUSED);
		expect(await list(f.nodes.foreignFolderId)).toEqual(REFUSED);
		expect(await list(f.nodes.missingNodeId)).toEqual(REFUSED);
	});

	test("a grant-only member gets an empty root and no open folder", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const list = (parentId: Id<"files_nodes"> | typeof files_ROOT_ID, kind: "folder" | "file") =>
			f.asGrantOnly.query(api.files_nodes.list_tree_children, {
				membershipId: f.grantOnly.membershipId,
				parentId,
				kind,
				archived: false,
				restricted: false,
				paginationOpts: { numItems: 50, cursor: null },
			});

		// `/shared` is a root child shared with this member. It comes from `list_tree_children_shared`.
		expect(await list(files_ROOT_ID, "folder")).toEqual(REFUSED);
		expect(await list(files_ROOT_ID, "file")).toEqual(REFUSED);
		// An open folder needs workspace read, which this member lacks.
		expect(await list(f.nodes.openId, "file")).toEqual(REFUSED);
		// Inside a granted scope the member lists normally.
		expect((await list(f.nodes.sharedId, "file")).page.map((row) => row._id)).toEqual([f.nodes.sharedFileId]);
	});

	test("refuses missing auth, an inactive membership, and a deleted user", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const args = {
			membershipId: f.grantOnly.membershipId,
			parentId: f.nodes.sharedId,
			kind: "file" as const,
			archived: false,
			restricted: false,
			paginationOpts: { numItems: 50, cursor: null },
		};
		await expect(t.query(api.files_nodes.list_tree_children, args)).rejects.toThrow("Unauthenticated");
		expect((await f.asGrantOnly.query(api.files_nodes.list_tree_children, args)).page).toHaveLength(1);

		// Only "Permission denied" means grant-only mode. A deleted user must not keep reading grants.
		await t.run(async (ctx) => {
			await ctx.db.patch("users", f.grantOnly.userId, { deletedAt: Date.now() });
		});
		expect(await f.asGrantOnly.query(api.files_nodes.list_tree_children, args)).toEqual(REFUSED);

		await t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", f.admin.membershipId, { active: false });
		});
		expect(
			await f.asAdmin.query(api.files_nodes.list_tree_children, {
				...args,
				membershipId: f.admin.membershipId,
				parentId: f.nodes.openId,
			}),
		).toEqual(REFUSED);
	});
});

describe("get_tree_ancestors", () => {
	test("returns the node and its folders from the top down", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);

		const result = await f.asOwner.query(api.files_nodes.get_tree_ancestors, {
			membershipId: f.owner.membershipId,
			nodeId: String(f.nodes.deepFileId),
		});
		expect(result?.node._id).toBe(f.nodes.deepFileId);
		expect(result?.ancestors.map((row) => row.path)).toEqual(["/open", "/open/sub"]);
	});

	test("stops at the granted scope and never returns the hidden folder or anything above it", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const ancestors_of = async (args: {
			as: typeof f.asAdmin;
			membershipId: Id<"organizations_workspaces_users">;
			nodeId: Id<"files_nodes">;
		}) => {
			const { as, nodeId, membershipId } = args;

			return (
				await as.query(api.files_nodes.get_tree_ancestors, { membershipId, nodeId: String(nodeId) })
			)?.ancestors.map((row) => row.path);
		};

		// The owner shows the full walk, so the shorter answers below come from the stop.
		expect(
			await ancestors_of({ as: f.asOwner, membershipId: f.owner.membershipId, nodeId: f.nodes.grantedFileId }),
		).toEqual(["/top", "/top/hidden", "/top/hidden/granted"]);
		// `/top` is readable for the admin, but it sits above the hidden folder, so it stays out too.
		expect(
			await ancestors_of({ as: f.asAdmin, membershipId: f.admin.membershipId, nodeId: f.nodes.grantedFileId }),
		).toEqual(["/top/hidden/granted"]);
		expect(
			await ancestors_of({ as: f.asGrantOnly, membershipId: f.grantOnly.membershipId, nodeId: f.nodes.grantedFileId }),
		).toEqual(["/top/hidden/granted"]);
		expect(
			await ancestors_of({ as: f.asGrantOnly, membershipId: f.grantOnly.membershipId, nodeId: f.nodes.sharedFileId }),
		).toEqual(["/shared"]);
	});

	test("returns null for an unreadable, foreign, missing, malformed, or root node id", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const get = (nodeId: string) =>
			f.asAdmin.query(api.files_nodes.get_tree_ancestors, { membershipId: f.admin.membershipId, nodeId });

		expect(await get(String(f.nodes.hiddenId))).toBeNull();
		expect(await get(String(f.nodes.boxSecretId))).toBeNull();
		expect(await get(String(f.nodes.foreignFolderId))).toBeNull();
		expect(await get(String(f.nodes.missingNodeId))).toBeNull();
		// The client passes the route's `?nodeId` as is, so a bad id must not throw.
		expect(await get("not-a-node-id")).toBeNull();
		expect(await get(files_ROOT_ID)).toBeNull();
		await expect(
			t.query(api.files_nodes.get_tree_ancestors, {
				membershipId: f.admin.membershipId,
				nodeId: String(f.nodes.openId),
			}),
		).rejects.toThrow("Unauthenticated");
	});
});

describe("list_tree_shared_roots", () => {
	/**
	 * Read every page of each principal stream, like the "Shared with you" group. Returns the paths of
	 * each stream: the member's own shares, then the shares of their 2 roles.
	 */
	const read_shared_roots = async (args: {
		as: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		membershipId: Id<"organizations_workspaces_users">;
		archived: boolean;
		numItems?: number;
	}) => {
		const streams: string[][] = [];
		for (const principalIndex of [0, 1, 2] as const) {
			const paths: string[] = [];
			let cursor: string | null = null;
			for (let index = 0; index < 100; index++) {
				const result: FunctionReturnType<typeof api.files_nodes.list_tree_shared_roots> = await args.as.query(
					api.files_nodes.list_tree_shared_roots,
					{
						membershipId: args.membershipId,
						archived: args.archived,
						principalIndex,
						paginationOpts: { numItems: args.numItems ?? 50, cursor },
					},
				);
				paths.push(...result.page.map((row) => row.path));
				if (result.isDone) break;
				cursor = result.continueCursor;
			}
			streams.push(paths);
		}
		return streams;
	};

	test("lists every share of a member, by principal and in name order, across pages", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);

		// `granted`, `inner` and `/shared` come from user grants, `ops` from the workspace role and
		// `team` from the organization role. `inner` sits under the readable `granted`, and `/shared` is
		// a root child the admin also reads at the root: the group lists every share all the same.
		// `plugin` has a grant from an old membership lifetime, so it is not readable.
		const active = [
			["/top/hidden/granted", "/top/hidden/granted/inner", "/shared"],
			["/top/hidden/ops"],
			["/top/hidden/team"],
		];
		expect(await read_shared_roots({ as: f.asAdmin, membershipId: f.admin.membershipId, archived: false })).toEqual(
			active,
		);
		// One row per page walks the same rows.
		expect(
			await read_shared_roots({ as: f.asAdmin, membershipId: f.admin.membershipId, archived: false, numItems: 1 }),
		).toEqual(active);
		expect(await read_shared_roots({ as: f.asAdmin, membershipId: f.admin.membershipId, archived: true })).toEqual([
			["/top/hidden/old"],
			[],
			[],
		]);
	});

	test("gives a grant-only member their shares, root children included", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);

		expect(
			await read_shared_roots({ as: f.asGrantOnly, membershipId: f.grantOnly.membershipId, archived: false }),
		).toEqual([["/top/hidden/granted", "/shared"], [], []]);
	});

	test("gives the owner, a missing role and refused callers nothing", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const REFUSED = { page: [], isDone: true, continueCursor: "" };
		const args = { archived: false, principalIndex: 0 as const, paginationOpts: { numItems: 50, cursor: null } };
		// The owner shares a node with themselves, so their own stream has a share row to skip.
		await test_run_with_flush(t, async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				resourceKind: "file",
				resourceId: String(f.nodes.sharedId),
				principalKind: "user",
				userId: f.owner.userId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
		});

		expect(
			await f.asOwner.query(api.files_nodes.list_tree_shared_roots, { ...args, membershipId: f.owner.membershipId }),
		).toEqual(REFUSED);
		// Another user's membership.
		expect(
			await f.asAdmin.query(api.files_nodes.list_tree_shared_roots, {
				...args,
				membershipId: f.grantOnly.membershipId,
			}),
		).toEqual(REFUSED);
		// The grant-only member has no role.
		expect(
			await f.asGrantOnly.query(api.files_nodes.list_tree_shared_roots, {
				...args,
				principalIndex: 1,
				membershipId: f.grantOnly.membershipId,
			}),
		).toEqual(REFUSED);
		await expect(
			t.query(api.files_nodes.list_tree_shared_roots, { ...args, membershipId: f.admin.membershipId }),
		).rejects.toThrow("Unauthenticated");
	});

	test("a plugin grant from an ended membership shows nothing after a re-invite, even when a role share keeps the node readable", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		await test_run_with_flush(t, async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				resourceKind: "file",
				resourceId: String(f.nodes.pluginId),
				principalKind: "role",
				role: "admin",
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
		});
		const read = () => read_shared_roots({ as: f.asAdmin, membershipId: f.admin.membershipId, archived: false });

		// The admin reads `plugin` through the role, so only the old lifetime keeps it out of their own stream.
		expect(await read()).toEqual([
			["/top/hidden/granted", "/top/hidden/granted/inner", "/shared"],
			["/top/hidden/ops", "/top/hidden/plugin"],
			["/top/hidden/team"],
		]);

		// With the grant's lifetime live again, the user stream gives it too.
		await t.run(async (ctx) => {
			const lifetime = await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.owner.workspaceId).eq("userId", f.admin.userId))
				.unique();
			await ctx.db.patch("organizations_membership_lifetimes", lifetime!._id, { lifetime: 1 });
		});
		expect((await read())[0]).toEqual([
			"/top/hidden/granted",
			"/top/hidden/granted/inner",
			"/top/hidden/plugin",
			"/shared",
		]);
	});

	test("a share row whose node was archived, made open or unshared shows nothing", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		// Plain `t.run` skips the flush, so the share rows keep the old copy.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", f.nodes.innerId, { archiveOperationId: "archive-stale" });
			await ctx.db.patch("files_nodes", f.nodes.sharedId, { restrictedScopeNodeId: null });
			const grants = await ctx.db.query("access_control_permission_grants").collect();
			const grant = grants.find((doc) => doc.resourceId === String(f.nodes.grantedId) && doc.userId === f.admin.userId);
			await ctx.db.delete("access_control_permission_grants", grant!._id);
		});

		expect(await read_shared_roots({ as: f.asAdmin, membershipId: f.admin.membershipId, archived: false })).toEqual([
			[],
			["/top/hidden/ops"],
			["/top/hidden/team"],
		]);
		// The archived node has no archived share row yet, so the archived read does not show it either.
		expect(await read_shared_roots({ as: f.asAdmin, membershipId: f.admin.membershipId, archived: true })).toEqual([
			["/top/hidden/old"],
			[],
			[],
		]);
		expect(consoleError).toHaveBeenCalledWith("files_share_rows copy is mismatched", {
			shareRowId: expect.any(String),
			nodeId: f.nodes.innerId,
		});
	});

	// convex-test marks any page that reads more than `numItems` + 1 rows, so this proves the split
	// runs before any row read, not the 187 guard. A cost test under `list_tree_children_shared`
	// checks the guard number.
	test("a page whose end cursor holds more rows than it asks for asks for a split and reads no row", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const ids = await test_run_with_flush(t, async (ctx) => {
			const now = Date.now();
			const nodeIds: Array<Id<"files_nodes">> = [];
			for (let index = 0; index < 102; index++) {
				const nodeId = await insert_tree_node({
					ctx,
					owner: f.owner,
					parentId: f.nodes.openId,
					path: `/open/s-${String(index).padStart(3, "0")}`,
					kind: "folder",
					scope: "self",
				});
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: f.owner.organizationId,
					workspaceId: f.owner.workspaceId,
					resourceKind: "file",
					resourceId: String(nodeId),
					principalKind: "user",
					userId: f.grantOnly.userId,
					permission: "content.read",
					createdAt: now,
					updatedAt: now,
				});
				nodeIds.push(nodeId);
			}
			return nodeIds;
		});
		const read_page = (paginationOpts: { numItems: number; cursor: string | null; endCursor?: string }) =>
			f.asGrantOnly.query(api.files_nodes.list_tree_shared_roots, {
				membershipId: f.grantOnly.membershipId,
				archived: false,
				principalIndex: 0,
				paginationOpts,
			});

		// The member's shares by name: `granted`, the 102 new ones, then `shared`. Read 100 rows and 2
		// more to get the cursor right after row 102: one more than `numItems` + 1.
		const first = await read_page({ numItems: 100, cursor: null });
		const endCursor = (await read_page({ numItems: 2, cursor: first.continueCursor })).continueCursor;

		// A SYSTEM author makes the tree rows throw, so this page proves the guard runs before any row read.
		await t.run((ctx) => ctx.db.patch("files_nodes", ids[100]!, { createdBy: users_SYSTEM_AUTHOR }));
		expect(await read_page({ numItems: 100, cursor: null, endCursor })).toEqual({
			page: [],
			isDone: false,
			continueCursor: endCursor,
			splitCursor: expect.any(String),
			pageStatus: "SplitRequired",
		});
		// A pinned page under the guard gives its rows.
		const small = await read_page({ numItems: 200, cursor: null, endCursor: first.continueCursor });
		expect(small.page).toHaveLength(100);
	});
});

describe("archive_nodes", () => {
	test("a grant-only member hears Not found for an open node, like for a missing id", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const archive = (nodeId: Id<"files_nodes">) =>
			f.asGrantOnly.mutation(api.files_nodes.archive_nodes, {
				membershipId: f.grantOnly.membershipId,
				nodeIds: [nodeId],
			});

		// The member reads `/shared/note.md` through a grant but cannot change it, so the job refuses it.
		expect((await archive(f.nodes.sharedFileId))._nay?.message).not.toBe("Not found");
		// An open node needs workspace read, which this member lacks, so it must answer like a missing id.
		expect((await archive(f.nodes.openFileId))._nay?.message).toBe("Not found");
		expect((await archive(f.nodes.missingNodeId))._nay?.message).toBe("Not found");
		const openFile = await t.run(async (ctx) => await ctx.db.get("files_nodes", f.nodes.openFileId));
		expect(openFile?.archiveOperationId).toBeNull();
	});
});

describe("get_folder_readme", () => {
	test("finds the README in any letter case and prefers byte order", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const ids = await t.run(async (ctx) => {
			const node = (args: Omit<Parameters<typeof insert_tree_node>[0], "ctx" | "owner">) =>
				insert_tree_node({ ctx, owner: f.owner, ...args });
			await node({ parentId: f.nodes.openId, path: "/open/reading-list.md", kind: "file" });
			await node({ parentId: f.nodes.openId, path: "/open/readme.md", kind: "file" });
			const expectedId = await node({ parentId: f.nodes.openId, path: "/open/Readme.md", kind: "file" });
			// Archived files and folders are never the README.
			await node({
				parentId: f.nodes.openId,
				path: "/open/README.md",
				kind: "file",
				archiveOperationId: "archive-operation-readme",
			});
			await node({ parentId: f.nodes.openId, path: "/open/README.md", kind: "folder" });
			const rootReadmeId = await node({ parentId: files_ROOT_ID, path: "/README.md", kind: "file" });
			return { expectedId, rootReadmeId };
		});
		const get = (folderId: Id<"files_nodes"> | typeof files_ROOT_ID) =>
			f.asOwner.query(api.files_nodes.get_folder_readme, { membershipId: f.owner.membershipId, folderId });

		expect((await get(f.nodes.openId))?._id).toBe(ids.expectedId);
		expect((await get(files_ROOT_ID))?._id).toBe(ids.rootReadmeId);
		expect(await get(f.nodes.openSubId)).toBeNull();
	});

	test("skips a hidden README and refuses a hidden folder like a missing one", async () => {
		const t = test_convex();
		const f = await seed_tree_access_fixture(t);
		const ids = await t.run(async (ctx) => {
			const node = (args: Omit<Parameters<typeof insert_tree_node>[0], "ctx" | "owner">) =>
				insert_tree_node({ ctx, owner: f.owner, ...args });
			const hiddenReadmeId = await node({
				parentId: f.nodes.boxId,
				path: "/box/README.md",
				kind: "file",
				scope: f.nodes.boxSecretId,
			});
			const openReadmeId = await node({ parentId: f.nodes.boxId, path: "/box/readme.md", kind: "file" });
			// The admin may read this README, but not the folder that holds it.
			const grantedReadmeId = await node({
				parentId: f.nodes.hiddenId,
				path: "/top/hidden/README.md",
				kind: "file",
				scope: "self",
			});
			const now = Date.now();
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				resourceKind: "file",
				resourceId: String(grantedReadmeId),
				principalKind: "user",
				userId: f.admin.userId,
				permission: "content.read",
				createdAt: now,
				updatedAt: now,
			});
			return { hiddenReadmeId, openReadmeId, grantedReadmeId };
		});
		const get = (args: {
			as: typeof f.asAdmin;
			membershipId: Id<"organizations_workspaces_users">;
			folderId: Id<"files_nodes">;
		}) => {
			const { as, folderId, membershipId } = args;

			return as.query(api.files_nodes.get_folder_readme, { membershipId, folderId });
		};

		expect((await get({ as: f.asOwner, membershipId: f.owner.membershipId, folderId: f.nodes.boxId }))?._id).toBe(
			ids.hiddenReadmeId,
		);
		expect((await get({ as: f.asAdmin, membershipId: f.admin.membershipId, folderId: f.nodes.boxId }))?._id).toBe(
			ids.openReadmeId,
		);

		expect((await get({ as: f.asOwner, membershipId: f.owner.membershipId, folderId: f.nodes.hiddenId }))?._id).toBe(
			ids.grantedReadmeId,
		);
		expect(await get({ as: f.asAdmin, membershipId: f.admin.membershipId, folderId: f.nodes.hiddenId })).toBeNull();
		expect(
			await get({ as: f.asAdmin, membershipId: f.admin.membershipId, folderId: f.nodes.foreignFolderId }),
		).toBeNull();
		expect(
			await get({ as: f.asAdmin, membershipId: f.admin.membershipId, folderId: f.nodes.missingNodeId }),
		).toBeNull();
		await expect(
			t.query(api.files_nodes.get_folder_readme, { membershipId: f.admin.membershipId, folderId: f.nodes.boxId }),
		).rejects.toThrow("Unauthenticated");
	});

	test("finds a README that an active Move holds, before and after the switch", async () => {
		const f = await test_create_saved_placement_fixture({ normalPaths: ["/target/README.md"] });
		const readmeId = f.normalNodes.get("/target/README.md")!;
		const get = () =>
			f.asUser.query(api.files_nodes.get_folder_readme, { membershipId: f.db.membershipId, folderId: f.parentId });

		await f.stageNode(readmeId);
		expect((await get())?._id).toBe(readmeId);
		await f.publish();
		expect((await get())?._id).toBe(readmeId);
	});
});

describe("paginated bash listing queries", () => {
	test("paginates direct children without descendants or archived nodes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 2,
			cursor: null,
			orderBy: "name",
		});
		const secondPage = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 2,
			cursor: firstPage.continueCursor,
			orderBy: "name",
		});

		expect(firstPage.isDone).toBe(false);
		expect(firstPage.items.map((item) => item.name)).toEqual(["a.md", "b.md"]);
		expect(secondPage.items.map((item) => item.name)).toEqual(["nested"]);
		expect(secondPage.isDone).toBe(true);
		expect([...firstPage.items, ...secondPage.items].map((item) => item.path)).not.toContain("/docs/nested/c.md");
		expect([...firstPage.items, ...secondPage.items].map((item) => item.path)).not.toContain("/docs/z-archived.md");
	});

	test("paginates direct children by parent id in ascending and descending name order with metadata", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const ascending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
			order: "asc",
		});
		const descending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
			order: "desc",
		});

		expect(ascending.items.map((item) => item.name)).toEqual(["a.md", "b.md", "nested"]);
		expect(descending.items.map((item) => item.name)).toEqual(["nested", "b.md", "a.md"]);
		expect(ascending.items[0]).toMatchObject({
			name: "a.md",
			path: "/docs/a.md",
			kind: "file",
			updatedAt: 2,
			updatedBy: db.userId,
			contentType: "text/markdown;charset=utf-8",
		});
	});

	test("paginates direct children by parent id in updatedAt order", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const descending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "updatedAt",
		});
		const ascending = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "updatedAt",
			order: "asc",
		});

		expect(descending.items.map((item) => item.path)).toEqual(["/docs/nested", "/docs/b.md", "/docs/a.md"]);
		expect(descending.items.map((item) => item.updatedAt)).toEqual([4, 3, 2]);
		expect(ascending.items.map((item) => item.path)).toEqual(["/docs/a.md", "/docs/b.md", "/docs/nested"]);
		expect(descending.items.map((item) => item.path)).not.toContain("/docs/nested/c.md");
		expect(descending.items.map((item) => item.path)).not.toContain("/docs/z-archived.md");
	});

	test("paginates a recursive subtree without sibling-prefix leakage", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 2,
			cursor: null,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: firstPage.continueCursor,
		});
		const paths = [...firstPage.page, ...secondPage.page].map((item) => item.path);

		expect(firstPage.isDone).toBe(false);
		expect(new Set(paths).size).toBe(paths.length);
		expect(paths).toEqual(
			expect.arrayContaining(["/docs", "/docs/a.md", "/docs/b.md", "/docs/nested", "/docs/nested/c.md"]),
		);
		expect(paths).not.toContain("/docs/z-archived.md");
		expect(paths).not.toContain("/docs-archive");
		expect(paths).not.toContain("/docs-archive/outside.md");
	});

	test("paginates recursive subtrees in ascending and descending path order with metadata", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const ascending = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			order: "asc",
		});
		const descending = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			order: "desc",
		});

		expect(ascending.page.map((item) => item.path)).toEqual([
			"/docs",
			"/docs/a.md",
			"/docs/b.md",
			"/docs/nested",
			"/docs/nested/c.md",
		]);
		expect(descending.page.map((item) => item.path)).toEqual([
			"/docs/nested/c.md",
			"/docs/nested",
			"/docs/b.md",
			"/docs/a.md",
			"/docs",
		]);
		expect(ascending.page[0]).toMatchObject({
			path: "/docs",
			kind: "folder",
			updatedAt: 1,
			updatedBy: db.userId,
		});
	});

	test("filters recursive descendants by kind and depth before pagination", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const filesAtDepthOne = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			kind: "file",
			maxDepth: 1,
		});
		const foldersAtDepthOne = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 10,
			cursor: null,
			kind: "folder",
			minDepth: 1,
			maxDepth: 1,
		});

		expect(filesAtDepthOne.page.map((item) => item.path)).toEqual(["/docs/a.md", "/docs/b.md"]);
		expect(foldersAtDepthOne.page.map((item) => item.path)).toEqual(["/docs/nested"]);
		expect(filesAtDepthOne.page.map((item) => item.path)).not.toContain("/docs/nested/c.md");
	});

	test("lists direct children without reading deeper items", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const owner = await test_mocks_fill_db_with.membership(ctx);
			const docsId = await insert_tree_node({ ctx, owner, parentId: files_ROOT_ID, path: "/docs", kind: "folder" });
			const deepId = await insert_tree_node({ ctx, owner, parentId: docsId, path: "/docs/a", kind: "folder" });
			// More deep items than one page. And `/docs/a.md` sorts before `/docs/a/` in the subtree range
			// but after `a` by name, so a subtree read filtered by depth would also return the wrong order.
			for (let index = 0; index < 11; index++)
				await insert_tree_node({ ctx, owner, parentId: deepId, path: `/docs/a/f${index}.md`, kind: "file" });
			await insert_tree_node({ ctx, owner, parentId: docsId, path: "/docs/a.md", kind: "file" });
			return owner;
		});
		const list = (extension?: string) =>
			t.query(internal.files_nodes.list_subtree, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				visibilityUserId: db.userId,
				folderPath: "/docs",
				numItems: 10,
				cursor: null,
				lowercaseExtension: extension,
				minDepth: 1,
				maxDepth: 1,
			});

		const children = await list();
		const markdownChildren = await list("md");

		expect(children.page.map((item) => item.path), "direct children come from the parent range, in name order").toEqual([
			"/docs/a",
			"/docs/a.md",
		]);
		expect(children.isDone).toBe(true);
		expect(markdownChildren.page.map((item) => item.path)).toEqual(["/docs/a.md"]);
		expect(markdownChildren.isDone).toBe(true);
	});

	test("reads the root only, the root and its children, or the whole subtree, and refuses other depths", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => {
			const owner = await test_mocks_fill_db_with.membership(ctx);
			const docsId = await insert_tree_node({ ctx, owner, parentId: files_ROOT_ID, path: "/docs", kind: "folder" });
			const nestedId = await insert_tree_node({ ctx, owner, parentId: docsId, path: "/docs/a", kind: "folder" });
			await insert_tree_node({ ctx, owner, parentId: nestedId, path: "/docs/a/deep.md", kind: "file" });
			await insert_tree_node({ ctx, owner, parentId: docsId, path: "/docs/z.md", kind: "file" });
			return owner;
		});
		const list = async (depth: { minDepth?: number; maxDepth?: number }) =>
			(
				await t.query(internal.files_nodes.list_subtree, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					folderPath: "/docs",
					numItems: 10,
					cursor: null,
					...depth,
				})
			).page.map((item) => item.path);

		expect(await list({ maxDepth: 0 })).toEqual(["/docs"]);
		expect(await list({ maxDepth: 1 })).toEqual(["/docs", "/docs/a", "/docs/z.md"]);
		expect(await list({ minDepth: 1, maxDepth: 1 })).toEqual(["/docs/a", "/docs/z.md"]);
		expect(await list({})).toEqual(["/docs", "/docs/a", "/docs/a/deep.md", "/docs/z.md"]);
		// `minDepth: 1` starts the subtree range after the root row.
		expect(await list({ minDepth: 1 })).toEqual(["/docs/a", "/docs/a/deep.md", "/docs/z.md"]);
		await expect(list({ maxDepth: 2 })).rejects.toThrow("list_subtree takes minDepth 0 or 1");
		await expect(list({ minDepth: 2 })).rejects.toThrow("list_subtree takes minDepth 0 or 1");
	});

	test("paginates extension-filtered recursive descendants through the extension index", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			kind: "file",
			lowercaseExtension: "md",
			numItems: 1,
			cursor: null,
			maxDepth: 1,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			kind: "file",
			lowercaseExtension: "md",
			numItems: 10,
			cursor: firstPage.continueCursor,
			maxDepth: 1,
		});
		const paths = [...firstPage.page, ...secondPage.page].map((item) => item.path);

		expect(firstPage.isDone).toBe(false);
		expect(paths).toEqual(["/docs/a.md", "/docs/b.md"]);
		expect(paths).not.toContain("/docs/nested/c.md");
		expect(paths).not.toContain("/docs/z-archived.md");
		expect(paths).not.toContain("/docs-archive/outside.md");
	});

	test("paginates folder subtrees without sibling-prefix matches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs/",
			numItems: 20,
			cursor: null,
		});
		const paths = result.page.map((item) => item.path);

		expect(result.isDone).toBe(true);
		expect(paths).toEqual(expect.arrayContaining(["/docs", "/docs/a.md", "/docs/nested/c.md"]));
		expect(paths).not.toContain("/docs-archive");
		expect(paths).not.toContain("/docs-archive/outside.md");
		expect(paths).not.toContain("/docs/z-archived.md");
	});

	test("filters folder subtrees by kind before pagination", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const result = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs",
			numItems: 20,
			cursor: null,
			kind: "file",
		});
		const paths = result.page.map((item) => item.path);

		expect(paths).toEqual(expect.arrayContaining(["/docs/a.md", "/docs/b.md", "/docs/nested/c.md"]));
		expect(paths).not.toContain("/docs");
		expect(paths).not.toContain("/docs/nested");
	});

	test("returns no docs when a folder subtree scan receives a file path", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs/a.md",
			numItems: 1,
			cursor: null,
		});
		const secondPage = await asUser.query(internal.files_nodes.list_subtree, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			folderPath: "/docs/a.md",
			numItems: 1,
			cursor: firstPage.continueCursor,
		});

		expect(firstPage.page).toEqual([]);
		expect(firstPage.isDone).toBe(true);
		expect(secondPage.page).toEqual([]);
		expect(secondPage.isDone).toBe(true);
	});

	test("list_children returns workspace recency newest-first and paginates without gaps", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const desc = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			numItems: 50,
			cursor: null,
			orderBy: "updatedAt",
		});
		const asc = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			numItems: 50,
			cursor: null,
			orderBy: "updatedAt",
			order: "asc",
		});

		// Newest-first, archived node (updatedAt 6) excluded.
		expect(desc.items[0]?.path).toBe("/docs-archive/outside.md");
		expect(desc.items.map((item) => item.updatedAt)).toEqual([8, 7, 5, 4, 3, 2, 1]);
		expect(desc.items.map((item) => item.path)).not.toContain("/docs/z-archived.md");
		expect(asc.items[0]?.path).toBe("/docs");
		expect(asc.items.map((item) => item.updatedAt)).toEqual([1, 2, 3, 4, 5, 7, 8]);

		// Full multi-page cursor walk: no gaps, no dupes, terminal isDone.
		const seen: string[] = [];
		let cursor: string | null = null;
		let done = false;
		for (let page = 0; page < 20 && !done; page++) {
			// Explicit type: `cursor` is both an input and derived from the output, which
			// otherwise trips TS circular inference on the query result.
			const result: { items: Array<{ path: string }>; continueCursor: string; isDone: boolean } = await asUser.query(
				internal.files_nodes.list_children,
				{
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					numItems: 3,
					cursor,
					orderBy: "updatedAt",
				},
			);
			seen.push(...result.items.map((item) => item.path));
			cursor = result.continueCursor;
			done = result.isDone;
		}
		expect(done).toBe(true);
		expect(new Set(seen).size).toBe(seen.length);
		expect([...seen].sort()).toEqual(desc.items.map((item) => item.path).sort());
	});

	test("list_children returns empty done pages for unsupported or invalid scopes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const workspaceNameOrder = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
		});
		const invalidParent = await asUser.query(internal.files_nodes.list_children, {
			organizationId: db.organizationId,
			workspaceId: "GITHUB",
			visibilityUserId: db.userId,
			parentId: db.docsFolderId,
			numItems: 10,
			cursor: null,
			orderBy: "name",
		});

		expect(workspaceNameOrder).toEqual({ items: [], continueCursor: "", isDone: true });
		expect(invalidParent).toEqual({ items: [], continueCursor: "", isDone: true });
	});

	test("get_by_path resolves active paths and excludes archived or root paths", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => seed_paginated_bash_listing_fixture(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const fileNode = await asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: "/docs/a.md",
		});
		const archived = await asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: "/docs/z-archived.md",
		});
		const root = await asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: "/",
		});

		expect(fileNode).toMatchObject({ path: "/docs/a.md", kind: "file" });
		expect(archived).toBeNull();
		expect(root).toBeNull();
	});
});

describe("get_path_by_id", () => {
	test("returns paths for folders, text files, and read-only binary files", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const [textId, binaryId] = await t.run(async (ctx) => {
			const base = {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				kind: "file" as const,
			};
			const textId = await ctx.db.insert("files_nodes", {
				...base,
				name: "notes.txt",
				sortName: files_sort_text_key("notes.txt"),
				path: "/notes.txt",
				treePath: "/notes.txt",
				contentType: "text/plain",
			});
			const binaryId = await ctx.db.insert("files_nodes", {
				...base,
				name: "report.pdf",
				sortName: files_sort_text_key("report.pdf"),
				path: "/report.pdf",
				treePath: "/report.pdf",
				contentType: "application/pdf",
			});
			await ctx.db.patch("files_nodes", binaryId, {
				writePolicy: { mode: "read_only" },
			});
			return [textId, binaryId];
		});

		const paths = await Promise.all(
			[db.files.file_root_1._id, textId, binaryId].map((nodeId) =>
				t.query(internal.files_nodes.get_path_by_id, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					nodeId,
				}),
			),
		);
		expect(paths).toEqual([db.files.file_root_1.path, "/notes.txt", "/report.pdf"]);
	});

	test("returns null for invalid, missing, archived, and out-of-scope IDs", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const unavailableIds = await t.run(async (ctx) => {
			const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" });
			const organization = await ctx.db.get("organizations", db.organizationId);
			if (!organization?.defaultWorkspaceId) throw new Error("Expected the default workspace");
			const base = {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
			};
			const otherWorkspaceNodeId = await ctx.db.insert("files_nodes", {
				...base,
				workspaceId: organization.defaultWorkspaceId,
			});
			const otherOrganizationNodeId = await ctx.db.insert("files_nodes", {
				...base,
				organizationId: other.organizationId,
				workspaceId: other.workspaceId,
				createdBy: other.userId,
				updatedBy: other.userId,
			});
			const reservedNodeId = await ctx.db.insert("files_nodes", {
				...base,
				organizationId: organizations_GLOBAL_ORGANIZATION_ID,
				workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
				createdBy: users_SYSTEM_AUTHOR,
				updatedBy: users_SYSTEM_AUTHOR,
			});
			await ctx.db.delete("files_nodes", db.files.file_root_2._id);
			await ctx.db.patch("files_nodes", db.files.file_root_1_child_2._id, {
				archiveOperationId: "test-archive",
			});
			return [
				"",
				"not-a-node-id",
				db.userId,
				db.files.file_root_2._id,
				db.files.file_root_1_child_2._id,
				otherWorkspaceNodeId,
				otherOrganizationNodeId,
				reservedNodeId,
			];
		});

		const paths = await Promise.all(
			unavailableIds.map((nodeId) =>
				t.query(internal.files_nodes.get_path_by_id, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					nodeId,
				}),
			),
		);
		expect(paths).toEqual(unavailableIds.map(() => null));
	});

	test("hides a restricted folder and its child until the member receives a grant", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const memberId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_resolve_member" });
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
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
				role: "viewer",
				now,
			});
			return userId;
		});
		const nodes = [db.files.file_root_1, db.files.file_root_1_child_1];
		const read = (visibilityUserId: Id<"users">) =>
			Promise.all(
				nodes.map((node) =>
					t.query(internal.files_nodes.get_path_by_id, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						visibilityUserId,
						nodeId: node._id,
					}),
				),
			);

		expect(
			(
				await asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: db.membershipId,
					nodeId: db.files.file_root_1._id,
				})
			)._nay,
		).toBeUndefined();
		expect(await read(db.userId)).toEqual(nodes.map((node) => node.path));
		expect(await read(memberId)).toEqual([null, null]);

		expect(
			(
				await asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: db.membershipId,
					nodeId: db.files.file_root_1._id,
					principal: { kind: "user", userId: memberId },
					level: "read",
				})
			)._nay,
		).toBeUndefined();
		expect(await read(memberId)).toEqual(nodes.map((node) => node.path));
	});

	test("uses the caller's pending folder move and hides a pending folder delete", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const otherUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_resolve_other" });
			const now = Date.now();
			await ctx.db.insert("organizations_workspaces_users", {
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
				role: "viewer",
				now,
			});
			return userId;
		});
		const nodes = [db.files.file_root_1, db.files.file_root_1_child_1];
		const read = (visibilityUserId: Id<"users">) =>
			Promise.all(
				nodes.map((node) =>
					t.query(internal.files_nodes.get_path_by_id, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						visibilityUserId,
						nodeId: node._id,
					}),
				),
			);

		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "saved", id: db.files.file_root_1._id },
					destParent: { kind: "root" },
					destName: "moved",
				})
			)._nay,
		).toBeUndefined();
		expect(await read(db.userId)).toEqual(["/moved", `/moved/${db.files.file_root_1_child_1.name}`]);
		expect(await read(otherUserId)).toEqual(nodes.map((node) => node.path));

		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "saved", id: db.files.file_root_1._id },
				})
			)._nay,
		).toBeUndefined();
		expect(await read(db.userId)).toEqual([null, null]);
		expect(await read(otherUserId)).toEqual(nodes.map((node) => node.path));
	});

	test("does not return a replaced node's saved path", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "saved", id: db.files.file_root_1._id },
					destParent: { kind: "root" },
					destName: db.files.file_root_2.name,
					replace: true,
				})
			)._nay,
		).toBeUndefined();

		const paths = await Promise.all(
			[db.files.file_root_1._id, db.files.file_root_2._id].map((nodeId) =>
				t.query(internal.files_nodes.get_path_by_id, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					visibilityUserId: db.userId,
					nodeId,
				}),
			),
		);
		expect(paths).toEqual([db.files.file_root_2.path, null]);
	});
});

test("generated sibling file is visible in the tree query", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const { sourceNodeId, markdownNodeId } = await t.run(async (ctx) => {
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
		const markdownNodeId = await ctx.db.insert("files_nodes", {
			...sharedNode,
			name: "report.pdf.md",
			sortName: files_sort_text_key("report.pdf.md"),
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
		});

		return { sourceNodeId, markdownNodeId };
	});

	const { page: treeNodesList } = await asUser.query(api.files_nodes.list_tree_children, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		kind: "file",
		archived: false,
		restricted: false,
		paginationOpts: { numItems: 50, cursor: null },
	});

	const treeNodeIds = treeNodesList.map((fileNode) => fileNode._id);
	expect(treeNodeIds).toContain(sourceNodeId);
	expect(treeNodeIds).toContain(markdownNodeId);
	expect(treeNodesList.map((fileNode) => fileNode.path)).toEqual(
		expect.arrayContaining(["/report.pdf", "/report.pdf.md"]),
	);
});

test("get_by_path uses materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const root1Path = `/${db.files.file_root_1.name}`;
	const child1Path = `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}`;
	const deep1Path = `/${db.files.file_root_1.name}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`;

	const [root1, child1, deep1] = await Promise.all([
		asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: root1Path,
		}),
		asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: child1Path,
		}),
		asUser.query(internal.files_nodes.get_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: db.userId,
			path: deep1Path,
		}),
	]);

	expect(root1?._id).toBe(db.files.file_root_1._id);
	expect(child1?._id).toBe(db.files.file_root_1_child_1._id);
	expect(deep1?._id).toBe(db.files.file_root_1_child_1_deep_1._id);
});

test("rename_node accepts immutable input and replays after publication", async () => {
	vi.useFakeTimers();
	try {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId, name: "Rename User" });
		const args = {
			membershipId: db.membershipId,
			requestId: "rename-replay",
			nodeId: db.files.file_root_1._id,
			path: "renamed",
		};
		const accepted = await asUser.mutation(api.files_nodes.rename_node, args);
		expect(accepted._yay, "rename returns an accepted durable run").toMatchObject({
			runId: expect.any(String),
			activityId: expect.any(String),
		});
		if (!accepted._yay) throw new Error("Rename was not accepted");
		expect((await t.run((ctx) => ctx.db.get("files_nodes", args.nodeId)))?.name).toBe(db.files.file_root_1.name);
		expect(await asUser.mutation(api.files_nodes.rename_node, args)).toEqual(accepted);
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1000), 5000);
		expect(
			(await t.run((ctx) => ctx.db.get("files_nodes", args.nodeId)))?.path,
			"accepted rename publishes through the cohort worker",
		).toBe("/renamed");
		expect(
			await asUser.mutation(api.files_nodes.rename_node, args),
			"a lost completion reply keeps the same request",
		).toEqual(accepted);
		const activity = await t.run((ctx) => ctx.db.get("activities", accepted._yay!.activityId));
		expect(activity).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
	} finally {
		vi.useRealTimers();
	}
});

test("rename_node resolves more than 32 missing parents in worker steps", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId, name: "Rename User" });
	const path = [...Array.from({ length: 35 }, (_, index) => `folder-${index}`), "renamed"].join("/");
	const accepted = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		path,
	});
	if (!accepted._yay) throw new Error("Rename was not accepted", { cause: accepted._nay });
	const activity = await t.run((ctx) => ctx.db.get("activities", accepted._yay!.activityId));
	expect(activity, "deep rename completes without a total parent cap").toMatchObject({
		status: "succeeded",
		progress: { completed: 1 },
	});
	expect((await t.run((ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id)))?.path).toBe(`/${path}`);
}, 120_000);

test("rename_node Stop removes staged parents and keeps the old name visible", async () => {
	vi.useFakeTimers();
	try {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId, name: "Rename User" });
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "original",
		});
		if (!created._yay) throw new Error("Source was not created");
		const accepted = await asUser.mutation(api.files_nodes.rename_node, {
			membershipId: db.membershipId,
			requestId: "rename-stop",
			nodeId: created._yay.nodeId,
			path: "new/deep/renamed",
		});
		if (!accepted._yay) throw new Error("Rename was not accepted", { cause: accepted._nay });
		await t.mutation(internal.files_transfer.advance, { runId: accepted._yay.runId });
		let staged = false;
		for (let index = 0; index < 100; index++) {
			const slot = await t.run((ctx) =>
				ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
					.unique(),
			);
			if (!slot?.cohortId) throw new Error("Rename cohort is missing");
			const cohort = (await t.run((ctx) => ctx.db.get("files_move_cohorts", slot.cohortId!)))!;
			await t.mutation(internal.files_move_cohorts.advance, { cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, join: false });
			staged = await t.run(async (ctx) =>
				(
					await ctx.db
						.query("files_move_cohort_nodes")
						.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohort._id))
						.collect()
				).some((record) => record.role === "derived"),
			);
			if (staged) break;
		}
		expect(staged, "Rename stages a new parent before publication").toBe(true);
		expect(
			await asUser.query(internal.files_nodes.get_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				visibilityUserId: db.userId,
				path: "/new",
			}),
			"a staged parent stays out of the normal names",
		).toBeNull();
		expect((await t.run((ctx) => ctx.db.get("files_nodes", created._yay!.nodeId)))?.name).toBe("original");
		expect(
			(
				await asUser.mutation(api.activities.request_stop, {
					membershipId: db.membershipId,
					activityId: accepted._yay.activityId,
				})
			)._nay,
		).toBeUndefined();
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1000), 5000);
		expect(await t.run((ctx) => ctx.db.get("activities", accepted._yay!.activityId))).toMatchObject({
			status: "canceled",
			progress: { completed: 0 },
		});
		expect((await t.run((ctx) => ctx.db.get("files_nodes", created._yay!.nodeId)))?.path).toBe("/original");
		expect(
			await asUser.query(internal.files_nodes.get_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				visibilityUserId: db.userId,
				path: "/new",
			}),
		).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

test("rename_node updates descendants materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const renamedRootName = "renamed_root";
	await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		path: renamedRootName,
	});

	await t.run(async (ctx) => {
		const [renamedRoot, renamedChild, renamedDeep] = await Promise.all([
			ctx.db.get("files_nodes", db.files.file_root_1._id),
			ctx.db.get("files_nodes", db.files.file_root_1_child_1._id),
			ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id),
		]);

		expect(renamedRoot?.path).toBe(`/${renamedRootName}`);
		expect(renamedChild?.path).toBe(`/${renamedRootName}/${db.files.file_root_1_child_1.name}`);
		expect(renamedDeep?.path).toBe(
			`/${renamedRootName}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		);
	});
});

test("rename_node leaves generated siblings independent from the source", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			name: "report.pdf",
			kind: "file",
			path: "/report.pdf",
			treePath: "/report.pdf",
			// Every production producer fills the indexed extension from the name; the rename
			// rule reads it, so the fixture must carry it too.
			lowercaseExtension: "pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID as typeof files_ROOT_ID,
			name: "report.pdf.md",
			kind: "file",
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
			lowercaseExtension: "md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	const renameResult = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: sourceNodeId,
		path: "renamed.pdf",
	});
	if (renameResult._nay) {
		throw new Error("Expected source rename with generated sibling to succeed", {
			cause: renameResult._nay,
		});
	}

	const docs = await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { source, generated };
	});
	expect(docs.source?.path).toBe("/renamed.pdf");
	expect(docs.generated).toMatchObject({
		parentId: files_ROOT_ID,
		name: "report.pdf.md",
		path: "/report.pdf.md",
	});
});

// #region move nodes

async function accept_move_proposals_for_test(
	t: ReturnType<typeof test_convex>,
	db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>,
	proposalIds: Id<"files_pending_updates">[],
) {
	const hadFakeTimers = vi.isFakeTimers();
	if (!hadFakeTimers) vi.useFakeTimers();
	try {
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const proposals = await t.run((ctx) =>
			Promise.all(proposalIds.map((id) => ctx.db.get("files_pending_updates", id))),
		);
		const started = await asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: proposals.length,
			items: proposals.map((proposal) => ({
				pendingUpdateId: proposal!._id,
				reviewedRevision: proposal!.revision,
				selectedContentStateId: proposal!.content?.stagedStateId ?? null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await asUser.mutation(api.files_pending_update_runs.seal, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		await test_finish_pending_update_run(asUser, started._yay.runId);
		return await t.run(async (ctx) => ({
			activity: await ctx.db.get("activities", started._yay.activityId),
			units: await ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.collect(),
		}));
	} finally {
		if (!hadFakeTimers) vi.useRealTimers();
	}
}

describe("reviewed Move graph", () => {
	test("creates shared private parents with the moving anchor's final scopes", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const anchor = db.files.file_root_1;
		const target = db.files.file_root_2;
		const sources = [db.files.file_root_1_child_1, db.files.file_root_1_child_2];
		const archivedChild = db.files.file_root_1_child_1_deep_1;
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_nodes", target._id, {
				restrictedScopeNodeId: target._id,
				isRestrictedScopeRoot: true,
				writePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
			});
			await ctx.db.patch("files_nodes", archivedChild._id, { archiveOperationId: "old-archive" });
		});
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: anchor.path + "/new/shared",
			kind: "folder",
		});
		if (created._nay) throw new Error(created._nay.message);
		if (created._yay.target.kind !== "private") throw new Error("Expected a private parent");
		const sharedTarget = created._yay.target;
		const ids = await t.run(async (ctx) => {
			const ids: Id<"files_pending_updates">[] = [];
			let target: typeof sharedTarget | { kind: "saved"; id: Id<"files_nodes"> } | { kind: "root" } = sharedTarget;
			while (target.kind === "private") {
				const node: Doc<"files_pending_nodes"> = (await ctx.db.get("files_pending_nodes", target.id))!;
				const proposal = await ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) =>
						q.eq("userId", db.userId).eq("target.kind", "private").eq("target.id", node._id),
					)
					.unique();
				ids.push(proposal!._id);
				target = node.parent;
			}
			return ids;
		});
		for (const source of sources) {
			const proposed = await propose_move_for_test(t, {
				...db,
				nodeId: source._id,
				destParent: sharedTarget,
				destName: source.name,
			});
			ids.push(proposed.pendingUpdateId);
		}
		ids.push(
			(
				await propose_move_for_test(t, {
					...db,
					nodeId: anchor._id,
					destParent: { kind: "saved", id: target._id },
					destName: anchor.name,
				})
			).pendingUpdateId,
		);
		expect((await accept_move_proposals_for_test(t, db, ids)).activity?.status).toBe("succeeded");
		await t.run(async (ctx) => {
			const shared = await files_db_get_visible_node_by_path(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				path: target.path + "/" + anchor.name + "/new/shared",
			});
			expect(shared).toMatchObject({ restrictedScopeNodeId: target._id });
			for (const source of sources)
				expect(await ctx.db.get("files_nodes", source._id)).toMatchObject({
					parentId: shared!._id,
					path: target.path + "/" + anchor.name + "/new/shared/" + source.name,
					restrictedScopeNodeId: target._id,
				});
			expect(await ctx.db.get("files_nodes", archivedChild._id)).toMatchObject({
				archiveOperationId: "old-archive",
				path: target.path + "/" + anchor.name + "/new/shared/" + sources[0]!.name + "/" + archivedChild.name,
				restrictedScopeNodeId: target._id,
			});
		});
	});

	test("reuses an existing destination parent during Rename", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const source = db.files.file_root_1_child_1;
		const parent = db.files.file_root_1_child_2;
		expect(
			(
				await test_rename_node(t, asUser, {
					membershipId: db.membershipId,
					nodeId: source._id,
					path: parent.name + "/leaf",
				})
			)._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toMatchObject({
			parentId: parent._id,
			path: parent.path + "/leaf",
		});
	});

	test.each(["planned-parent", "same-leaf", "cycle"] as const)(
		"refuses a draft Move with a %s conflict before saved writes",
		async (conflict) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const source = db.files.file_root_1_child_1;
			const other = db.files.file_root_1_child_2;
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: db.files.file_root_1.path + "/new",
				kind: "folder",
			});
			if (created._nay) throw new Error(created._nay.message);
			if (created._yay.target.kind !== "private") throw new Error("Expected a private parent");
			if (conflict !== "cycle")
				await propose_move_for_test(t, {
					...db,
					nodeId: source._id,
					destParent: created._yay.target,
					destName: "leaf",
				});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const result = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				target: { kind: "saved", id: conflict === "cycle" ? source._id : other._id },
				destParent:
					conflict === "planned-parent"
						? { kind: "saved", id: db.files.file_root_1._id }
						: conflict === "cycle"
							? { kind: "saved", id: source._id }
							: created._yay.target,
				destName: conflict === "planned-parent" ? "new" : "leaf",
			});
			expect(result._nay).toBeDefined();
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test("swaps parents and keeps an explicit child move in the final graph", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const first = db.files.file_root_1;
		const second = db.files.file_root_2;
		const child = db.files.file_root_1_child_1;
		await test_run_with_flush(t, (ctx) =>
			ctx.db.patch("files_nodes", second._id, {
				restrictedScopeNodeId: second._id,
				isRestrictedScopeRoot: true,
				writePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
			}),
		);
		await propose_move_for_test(t, {
			...db,
			nodeId: first._id,
			destParent: { kind: "root" },
			destName: "temporary-draft-name",
		});
		const secondMove = await propose_move_for_test(t, {
			...db,
			nodeId: second._id,
			destParent: { kind: "root" },
			destName: first.name,
		});
		const firstMove = await propose_move_for_test(t, {
			...db,
			nodeId: first._id,
			destParent: { kind: "root" },
			destName: second.name,
		});
		const childMove = await propose_move_for_test(t, {
			...db,
			nodeId: child._id,
			destParent: { kind: "saved", id: second._id },
			destName: "explicit-child",
		});
		expect(
			(
				await accept_move_proposals_for_test(t, db, [
					firstMove.pendingUpdateId,
					secondMove.pendingUpdateId,
					childMove.pendingUpdateId,
				])
			).activity?.status,
		).toBe("succeeded");
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", child._id)).toMatchObject({
				parentId: second._id,
				path: first.path + "/explicit-child",
				restrictedScopeNodeId: second._id,
			});
			expect(await ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id)).toMatchObject({
				parentId: child._id,
				path: first.path + "/explicit-child/" + db.files.file_root_1_child_1_deep_1.name,
				restrictedScopeNodeId: second._id,
			});
			expect(await ctx.db.get("files_nodes", db.files.file_root_1_child_2._id)).toMatchObject({
				parentId: first._id,
				path: second.path + "/" + db.files.file_root_1_child_2.name,
				restrictedScopeNodeId: null,
			});
		});
	});

	test("uses the final parent graph when a current child becomes a parent", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const parent = db.files.file_root_1;
		const child = db.files.file_root_1_child_1;
		const childMove = await propose_move_for_test(t, {
			...db,
			nodeId: child._id,
			destParent: { kind: "root" },
			destName: child.name,
		});
		const parentMove = await propose_move_for_test(t, {
			...db,
			nodeId: parent._id,
			destParent: { kind: "saved", id: child._id },
			destName: parent.name,
		});
		expect(
			(await accept_move_proposals_for_test(t, db, [parentMove.pendingUpdateId, childMove.pendingUpdateId])).activity
				?.status,
		).toBe("succeeded");
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", parent._id)).toMatchObject({
				parentId: child._id,
				path: "/" + child.name + "/" + parent.name,
			});
			expect(await ctx.db.get("files_nodes", db.files.file_root_1_child_2._id)).toMatchObject({
				path: "/" + child.name + "/" + parent.name + "/" + db.files.file_root_1_child_2.name,
			});
		});
	});

	test.each(["asset", "sequence", "lineage", "mode", "newcomer"] as const)(
		"refuses a reviewed replacement after its %s changes",
		async (changed) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const source = db.files.file_root_1_child_2;
			const occupant = db.files.file_root_2;
			const lastSequenceId = await test_run_with_flush(t, async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "upload",
					r2Bucket: "test-bucket",
					r2Key: "approved",
					size: 5,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: occupant._id,
					lastSequence: 4,
					lineageGeneration: 2,
					unmaterializedUpdateCount: 0,
					unmaterializedUpdateBytes: 0,
				});
				await ctx.db.patch("files_nodes", source._id, { kind: "file", treePath: source.path });
				await ctx.db.patch("files_nodes", occupant._id, {
					kind: "file",
					treePath: occupant.path,
					assetId,
					contentType: "text/plain",
					textKind: "plain_text",
					collaborationEnabled: changed !== "asset",
					yjsLastSequenceId: lastSequenceId,
					contentShapeMismatchAt: Date.now(),
				});
				return lastSequenceId;
			});
			const move = await propose_move_for_test(t, {
				...db,
				nodeId: source._id,
				destParent: { kind: "root" },
				destName: occupant.name,
				replace: true,
			});
			await test_run_with_flush(t, async (ctx) => {
				if (changed === "sequence" || changed === "lineage") {
					await ctx.db.patch(
						"files_yjs_docs_last_sequences",
						lastSequenceId,
						changed === "sequence" ? { lastSequence: 5 } : { lineageGeneration: 3 },
					);
				} else if (changed === "mode") {
					await ctx.db.patch("files_nodes", occupant._id, { collaborationEnabled: false });
				} else if (changed === "asset") {
					const assetId = await ctx.db.insert("files_r2_assets", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						kind: "upload",
						r2Bucket: "test-bucket",
						r2Key: "changed",
						size: 5,
						createdBy: db.userId,
						updatedAt: Date.now(),
					});
					await ctx.db.patch("files_nodes", occupant._id, { assetId });
				} else {
					await ctx.db.patch("files_nodes", occupant._id, { archiveOperationId: "old-occupant" });
					await ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						createdBy: db.userId,
						updatedBy: db.userId,
						kind: "file",
						parentId: files_ROOT_ID,
						name: occupant.name,
						sortName: files_sort_text_key(occupant.name),
						path: occupant.path,
						treePath: occupant.path,
					});
				}
			});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const review = await accept_move_proposals_for_test(t, db, [move.pendingUpdateId]);
			expect(review.activity?.status).toBe("failed");
			expect(review.units.some((unit) => unit.errorCode === "destination_changed")).toBe(true);
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
		},
	);

	test.each([false, true])(
		"archives an exact occupant under a moving parent (collaborative: %s)",
		async (collaborative) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const parent = db.files.file_root_1;
			const source = db.files.file_root_2;
			const occupant = db.files.file_root_1_child_2;
			const assetId = await test_run_with_flush(t, async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "upload",
					r2Bucket: "test-bucket",
					r2Key: "replacement",
					size: 5,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: occupant._id,
					lastSequence: 4,
					lineageGeneration: 2,
					unmaterializedUpdateCount: 0,
					unmaterializedUpdateBytes: 0,
				});
				for (const node of [source, occupant]) {
					await ctx.db.patch("files_nodes", node._id, {
						kind: "file",
						treePath: node.path,
						assetId,
						contentType: "text/plain",
						textKind: "plain_text",
						collaborationEnabled: node._id === occupant._id && collaborative,
						yjsLastSequenceId: node._id === occupant._id && collaborative ? lastSequenceId : null,
					});
					const inserted = await db_insert_file_text_content(ctx, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						nodeId: node._id,
						path: node.path,
						rootKind: "plain_text",
						textContent: "saved text",
					});
					if (inserted._nay) throw new Error(inserted._nay.message);
					await ctx.db.insert("files_metadata_docs", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: node._id,
						sourceKind: "committed",
						docKind: "field",
						fieldPath: "metadata.tag",
						path: node.path,
						treePath: node.path,
					});
				}
				return assetId;
			});
			const replace = await propose_move_for_test(t, {
				...db,
				nodeId: source._id,
				destParent: { kind: "saved", id: parent._id },
				destName: occupant.name,
				replace: true,
			});
			const parentMove = await propose_move_for_test(t, {
				...db,
				nodeId: parent._id,
				destParent: { kind: "root" },
				destName: "moved-parent",
			});
			const review = await accept_move_proposals_for_test(t, db, [replace.pendingUpdateId, parentMove.pendingUpdateId]);
			expect(review.activity?.status, JSON.stringify(review.units)).toBe("succeeded");
			await t.run(async (ctx) => {
				const archived = (await ctx.db.get("files_nodes", occupant._id))!;
				const path = "/moved-parent/" + occupant.name;
				expect(archived).toMatchObject({ path, assetId });
				expect(archived.archiveOperationId).toEqual(expect.any(String));
				expect(await ctx.db.get("files_nodes", source._id)).toMatchObject({ path, assetId, archiveOperationId: null });
				for (const table of ["files_plain_text_chunks", "files_metadata_docs"] as const) {
					const docs = await ctx.db.query(table).collect();
					expect(docs).toHaveLength(2);
					for (const doc of docs) {
						expect(doc.path).toBe(path);
						expect(doc.archiveOperationId).toBe(
							doc.sourceKind === "committed" && doc.fileNodeId === occupant._id
								? archived.archiveOperationId
								: undefined,
						);
					}
				}
			});
		},
	);

	test.each(["active", "read_only", "archived"] as const)(
		"checks a replacement folder's %s descendants before writing",
		async (childState) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const occupant = db.files.file_root_1_child_1;
			const child = db.files.file_root_1_child_1_deep_1;
			const source = db.files.file_root_2;
			await test_run_with_flush(t, async (ctx) => {
				if (childState !== "active") {
					await ctx.db.patch("files_nodes", child._id, {
						archiveOperationId: "earlier-archive",
						sortName: files_sort_text_key(child.name),
						...(childState === "read_only" ? { writePolicy: { mode: "read_only" as const } } : {}),
					});
					await ctx.db.patch("files_nodes", child._id, {
						ancestor1: db.files.file_root_1._id,
						ancestor2: occupant._id,
					});
				}
			});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const result = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				target: { kind: "saved", id: source._id },
				destParent: { kind: "saved", id: occupant.parentId as Id<"files_nodes"> },
				destName: occupant.name,
				replace: true,
			});
			if (childState === "archived") {
				expect(result._nay).toBeUndefined();
				const proposal = await t.run((ctx) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", source._id),
						)
						.unique(),
				);
				const parentMove = await propose_move_for_test(t, {
					...db,
					nodeId: db.files.file_root_1._id,
					destParent: { kind: "root" },
					destName: "moved-parent",
				});
				expect(
					(await accept_move_proposals_for_test(t, db, [proposal!._id, parentMove.pendingUpdateId])).activity?.status,
				).toBe("succeeded");
				const path = "/moved-parent/" + occupant.name + "/" + child.name;
				expect(await t.run((ctx) => ctx.db.get("files_nodes", child._id))).toEqual({
					...before.find((node) => node._id === child._id),
					path,
					treePath: path + "/",
				});
			} else {
				if (result._yay) {
					const proposal = await t.run((ctx) =>
						ctx.db
							.query("files_pending_updates")
							.withIndex("by_user_target", (q) =>
								q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", source._id),
							)
							.unique(),
					);
					const parentMove = await propose_move_for_test(t, {
						...db,
						nodeId: db.files.file_root_1._id,
						destParent: { kind: "root" },
						destName: "moved-parent",
					});
					const review = await accept_move_proposals_for_test(t, db, [proposal!._id, parentMove.pendingUpdateId]);
					expect(review.activity?.status).toBe("failed");
					expect(review.units.some((unit) => unit.errorMessage === "This item is read-only.")).toBe(true);
				} else
					expect(result._nay.message).toBe(childState === "active" ? "Directory not empty" : "This item is read-only.");
				expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			}
		},
	);

	test("refuses moving an occupant already claimed by a replacement", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const occupant = db.files.file_root_1_child_2;
		const source = db.files.file_root_2;
		const replacement = await propose_move_for_test(t, {
			...db,
			nodeId: source._id,
			destParent: { kind: "saved", id: db.files.file_root_1._id },
			destName: occupant.name,
			replace: true,
		});
		const movedOccupant = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: occupant._id },
			destParent: { kind: "root" },
			destName: occupant.name,
		});
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(movedOccupant._nay?.message).toBe("Not found");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", replacement.pendingUpdateId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});

	test.each([
		{ label: "file over a folder", sourceKind: "file" as const, occupantKind: "folder" as const },
		{ label: "folder over a file", sourceKind: "folder" as const, occupantKind: "file" as const },
	])("refuses a replacement of a $label", async ({ sourceKind, occupantKind }) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const source = db.files.file_root_2;
		const occupant = db.files.file_root_1_child_2;
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_nodes", source._id, {
				kind: sourceKind,
				treePath: source.path + (sourceKind === "folder" ? "/" : ""),
			});
			await ctx.db.patch("files_nodes", occupant._id, {
				kind: occupantKind,
				treePath: occupant.path + (occupantKind === "folder" ? "/" : ""),
			});
		});
		const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const result = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: source._id },
			destParent: { kind: "saved", id: db.files.file_root_1._id },
			destName: occupant.name,
			replace: true,
		});
		expect(result._nay?.message).toBe("Path already exists");
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
	});
});

describe("existing service-account writer policy", () => {
	test.each([
		{ policyReach: "none", lockedParent: "current" },
		{ policyReach: "direct", lockedParent: "current" },
		{ policyReach: "ancestors", lockedParent: "current" },
		{ policyReach: "none", lockedParent: "final" },
		{ policyReach: "direct", lockedParent: "final" },
		{ policyReach: "ancestors", lockedParent: "final" },
	] as const)(
		"checks local rules with $policyReach reach on the $lockedParent parent",
		async ({ policyReach, lockedParent }) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const created = await asUser.mutation(api.access_control.create_service_account, {
				membershipId: db.membershipId,
				name: "Move writer",
			});
			if (created._nay) throw new Error(created._nay.message);
			const serviceAccountId = created._yay.serviceAccountId;
			const grant = await asUser.mutation(api.access_control.set_service_account_grant, {
				membershipId: db.membershipId,
				serviceAccountId,
				resource: { kind: "workspace" },
				level: "write",
			});
			if (grant._nay) throw new Error(grant._nay.message);
			const policyNode = lockedParent === "current" ? db.files.file_root_1 : db.files.file_root_2;
			await t.run(async (ctx) => {
				await ctx.db.patch("files_nodes", policyNode._id, {
					writePolicy: { mode: "writer", writers: [{ kind: "service_account", serviceAccountId }] },
				});
				const before = await ctx.db.query("files_nodes").collect();
				const writeContext: files_nodes_WriteContext = {
					writer: { kind: "service_account", serviceAccountId },
					actorUserId: db.userId,
					resourceScope: { kind: "workspace" },
					policyReach,
				};
				// Existing-node writes check each named local rule. Create reach is separate.
				for (const nodeId of [db.files.file_root_1_child_2._id, db.files.file_root_1._id, db.files.file_root_2._id]) {
					const node = (await ctx.db.get("files_nodes", nodeId))!;
					expect(
						await files_nodes_db_require_writable(ctx, {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							writeContext,
							target: { kind: "node", node },
						}),
					).toEqual({ _yay: null });
				}
				expect(await ctx.db.query("files_nodes").collect()).toEqual(before);
				const locked = {
					...(await ctx.db.get("files_nodes", policyNode._id))!,
					writePolicy: { mode: "read_only" as const },
				};
				expect(
					(
						await files_nodes_db_require_writable(ctx, {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							writeContext,
							target: { kind: "node", node: locked },
						})
					)._nay?.name,
				).toBe("read_only");
			});
		},
	);
});

describe("paged folder moves and scope jobs", () => {
	/**
	 * Insert `/source` with `childCount` child folders and `/target`. Every node gets
	 * `metadataPerNode` metadata docs, so a test can see that the side docs follow their node.
	 */
	async function seed_wide_source(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		childCount: number;
		metadataPerNode: number;
	}) {
		const { t, db } = args;

		return await t.run(async (ctx) => {
			const base = {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
			};
			const sourceId = await ctx.db.insert("files_nodes", {
				...base,
				name: "source",
				sortName: files_sort_text_key("source"),
				path: "/source",
				treePath: "/source/",
			});
			const targetId = await ctx.db.insert("files_nodes", {
				...base,
				name: "target",
				sortName: files_sort_text_key("target"),
				path: "/target",
				treePath: "/target/",
			});
			const nodeIds = [sourceId];
			for (let index = 0; index < args.childCount; index += 1) {
				nodeIds.push(
					await ctx.db.insert("files_nodes", {
						...base,
						parentId: sourceId,
						name: `child-${index}`,
						sortName: files_sort_text_key(`child-${index}`),
						path: `/source/child-${index}`,
						treePath: `/source/child-${index}/`,
						pathDepth: 2,
						archiveOperationId: index === args.childCount - 1 ? "earlier-archive" : null,
					}),
				);
			}
			for (const nodeId of nodeIds) {
				const node = (await ctx.db.get("files_nodes", nodeId))!;
				for (let index = 0; index < args.metadataPerNode; index += 1) {
					await ctx.db.insert("files_metadata_docs", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: node._id,
						sourceKind: "committed",
						docKind: "field",
						fieldPath: `metadata.key-${index}`,
						path: node.path,
						treePath: node.treePath,
						archiveOperationId: node.archiveOperationId ?? undefined,
					});
				}
			}
			return {
				source: (await ctx.db.get("files_nodes", sourceId))!,
				target: (await ctx.db.get("files_nodes", targetId))!,
			};
		});
	}

	/**
	 * 65 children need several descendant pages even when one transaction joins small steps.
	 */
	const BIG_FOLDER_CHILDREN = 65;

	/**
	 * Count descendant transactions that leave more walking work for the next transaction.
	 */
	function count_paged_moves() {
		const paged = { count: 0 };
		test_spy_handler(advance_move_cohort, async (handler, ctx, args) => {
			const { cohortId, step } = args as { cohortId: Id<"files_move_cohorts">; step: number };
			const cohort = await ctx.db.get("files_move_cohorts", cohortId);
			const result = await handler(ctx, args);
			const after = await ctx.db.get("files_move_cohorts", cohortId);
			if (cohort?.step === step && cohort.workPhase === "descendants" && after?.workPhase === "descendants" && after.step > step)
				paged.count++;
			return result;
		});
		return paged;
	}

	test("reviews a big folder and repairs every descendant's metadata", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const { source, target } = await seed_wide_source({ t, db, childCount: BIG_FOLDER_CHILDREN, metadataPerNode: 3 });
		const pagedMoves = count_paged_moves();
		const move = await propose_move_for_test(t, {
			...db,
			nodeId: source._id,
			destParent: { kind: "saved", id: target._id },
			destName: source.name,
		});
		const review = await accept_move_proposals_for_test(t, db, [move.pendingUpdateId]);
		expect(review.activity?.status, JSON.stringify(review.units)).toBe("succeeded");
		expect(review.units).toHaveLength(1);
		expect(review.units[0]?.itemCount).toBe(1);
		await t.run(async (ctx) => {
			const nodes = await ctx.db.query("files_nodes").collect();
			const children = nodes.filter((node) => node.parentId === source._id);
			expect(children).toHaveLength(BIG_FOLDER_CHILDREN);
			expect(children.every((node) => node.path.startsWith("/target/source/"))).toBe(true);
			expect(children.filter((node) => node.archiveOperationId !== null).map((node) => node.name)).toEqual([
				`child-${BIG_FOLDER_CHILDREN - 1}`,
			]);
			const paths = new Map(nodes.map((node) => [node._id, node.path]));
			const metadata = await ctx.db.query("files_metadata_docs").collect();
			expect(metadata).toHaveLength((BIG_FOLDER_CHILDREN + 1) * 3);
			expect(metadata.every((doc) => doc.sourceKind === "committed" && doc.path === paths.get(doc.fileNodeId))).toBe(
				true,
			);
		});
		expect(pagedMoves.count, "the folder needs more than one Move page").toBeGreaterThan(0);
	});

	test("a public Move finishes every child path in a big folder", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const { source, target } = await seed_wide_source({ t, db, childCount: BIG_FOLDER_CHILDREN, metadataPerNode: 1 });
		const pagedMoves = count_paged_moves();

		expect(
			await test_move_nodes(t, asUser, {
				membershipId: db.membershipId,
				itemIds: [source._id],
				targetParentId: target._id,
			}),
		).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toMatchObject({
			parentId: target._id,
			path: "/target/source",
		});
		// The public helper waits for publication and physical path repair.
		const lookup = (path: string) =>
			t.run(
				async (ctx) =>
					(
						await files_db_get_visible_node_by_path(ctx, {
							organizationId: db.organizationId,
							workspaceId: db.workspaceId,
							path,
						})
					)?.name ?? null,
			);
		const child = await t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).find((node) => node.name === "child-1"),
		);
		expect(child?.path).toBe("/target/source/child-1");
		expect(await lookup("/target/source/child-1")).toBe("child-1");
		expect(await lookup("/source/child-1")).toBeNull();
		expect(
			await asUser.query(api.files_nodes.get_authorized_by_path, {
				membershipId: db.membershipId,
				path: "/target/source/child-1",
			}),
		).toMatchObject({ nodeId: child!._id });
		expect(
			await asUser.query(api.files_nodes.get_authorized_by_path, {
				membershipId: db.membershipId,
				path: "/source/child-1",
			}),
		).toBeNull();

		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		const children = nodes.filter((node) => node.parentId === source._id);
		expect(children).toHaveLength(BIG_FOLDER_CHILDREN);
		expect(children.filter((node) => !node.path.startsWith("/target/source/child-"))).toEqual([]);
		// The walk writes paths, never the archive stamp.
		expect(children.filter((node) => node.archiveOperationId !== null).map((node) => node.name)).toEqual([
			`child-${BIG_FOLDER_CHILDREN - 1}`,
		]);
		const metadata = await t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
		const pathById = new Map(nodes.map((node) => [node._id, node.path]));
		expect(
			metadata.filter((doc) => doc.sourceKind !== "committed" || doc.path !== pathById.get(doc.fileNodeId)),
		).toEqual([]);
		expect(pagedMoves.count, "the folder needs more than one Move page").toBeGreaterThan(0);
	});

	test("a public Move finishes a big group of archived items with one name", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const { source, target } = await seed_wide_source({ t, db, childCount: 0, metadataPerNode: 0 });
		// Each replace of `report.md` archives the old one, so a folder can collect many items with one name.
		await t.run(async (ctx) => {
			for (let index = 0; index < BIG_FOLDER_CHILDREN; index += 1) {
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId: source._id,
					kind: "file",
					name: "report.md",
					sortName: files_sort_text_key("report.md"),
					path: "/source/report.md",
					treePath: "/source/report.md",
					pathDepth: 2,
					archiveOperationId: `replace-${index}`,
				});
			}
		});
		const moved = async () =>
			(await t.run((ctx) => ctx.db.query("files_nodes").collect())).filter(
				(node) => node.path === "/target/source/report.md",
			).length;
		const pagedMoves = count_paged_moves();

		expect(
			await test_move_nodes(t, asUser, {
				membershipId: db.membershipId,
				itemIds: [source._id],
				targetParentId: target._id,
			}),
		).toEqual({ _yay: null });
		expect(await moved()).toBe(BIG_FOLDER_CHILDREN);
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		expect(pagedMoves.count, "the group needs more than one Move page").toBeGreaterThan(0);
	});

	test("a restrict of a big folder commits now and a job gives every child the new scope", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		// `child-0` below keeps its own scope, so the step writes the other children. One more than
		// a step writes leaves work for the job.
		const childCount = files_subtree_ops_STEP_MAX_NODES + 2;
		const { source } = await seed_wide_source({ t, db, childCount, metadataPerNode: 0 });
		// A restricted child keeps its own scope. The walk still goes inside it.
		const nested = await t.run(async (ctx) => {
			const node = (await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/source/child-0")!;
			await ctx.db.patch("files_nodes", node._id, { isRestrictedScopeRoot: true, restrictedScopeNodeId: node._id });
			return node;
		});
		const drain = async () => {
			for (let round = 0; round < 20; round += 1) {
				await delay(0);
				await t.finishInProgressScheduledFunctions();
			}
		};
		const scopes = async () =>
			new Map(
				(await t.run((ctx) => ctx.db.query("files_nodes").collect()))
					.filter((node) => node.parentId === source._id)
					.map((node) => [node.name, node.restrictedScopeNodeId]),
			);

		expect(
			(await asUser.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: source._id }))
				._nay,
		).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").first())).toMatchObject({ kind: "scope" });
		const activity = await t.run((ctx) => ctx.db.query("activities").first());
		expect(activity).toMatchObject({ source: { kind: "files_subtree_op", opKind: "scope" }, feedVisible: false });
		expect(
			[...(await scopes())].filter(([name, scope]) => name !== "child-0" && scope !== source._id),
			"the first step leaves one child for the job",
		).toHaveLength(1);

		await drain();
		expect(await t.run((ctx) => ctx.db.query("files_subtree_ops").collect())).toEqual([]);
		const restricted = await scopes();
		expect(restricted.size).toBe(childCount);
		expect([...restricted].filter(([name, scope]) => name !== "child-0" && scope !== source._id)).toEqual([]);
		expect(restricted.get("child-0")).toBe(nested._id);

		expect(
			(await asUser.mutation(api.files_sharing.unrestrict_node, { membershipId: db.membershipId, nodeId: source._id }))
				._nay,
		).toBeUndefined();
		await drain();
		const open = await scopes();
		expect([...open].filter(([name, scope]) => name !== "child-0" && scope !== null)).toEqual([]);
		expect(open.get("child-0")).toBe(nested._id);
	});

	// Each pair below fills one budget to its cap, then crosses that one only. The success case
	// reports every counter, so it shows which limit refused the next step.
});

describe("files_nodes_db_get_content_version", () => {
	test("reads the Yjs sequence without needing a materialized snapshot", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		await t.run(async (ctx) => {
			const node = db.files.file_root_2;
			expect(await files_nodes_db_get_content_version(ctx, node)).toBeNull();
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				r2Key: "version",
				size: 5,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			const lastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: node._id,
				lastSequence: 42,
				lineageGeneration: 3,
				unmaterializedUpdateCount: 20,
				unmaterializedUpdateBytes: 1000,
			});
			await ctx.db.patch("files_nodes", node._id, {
				kind: "file",
				assetId,
				contentType: "text/plain",
				textKind: "plain_text",
				collaborationEnabled: true,
				yjsLastSequenceId: lastSequenceId,
				contentShapeMismatchAt: Date.now(),
			});
			expect(await files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", node._id))!)).toEqual({
				kind: "yjs",
				lastSequenceId,
				lineageGeneration: 3,
				sequence: 42,
				contentType: "text/plain",
				textKind: "plain_text",
				collaborationEnabled: true,
			});
			await ctx.db.patch("files_nodes", node._id, { collaborationEnabled: false });
			expect(await files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", node._id))!)).toEqual({
				kind: "asset",
				assetId,
				contentType: "text/plain",
				textKind: "plain_text",
				collaborationEnabled: false,
			});
		});
	});
});

describe("move_nodes", () => {
	test.each([
		{ access: "none", archived: false },
		{ access: "read", archived: false },
		{ access: "write", archived: false },
		{ access: "owner", archived: false },
		{ access: "none", archived: true },
		{ access: "read", archived: true },
		{ access: "write", archived: true },
		{ access: "owner", archived: true },
	] as const)(
		"checks nested restricted descendants with $access access (archived: $archived)",
		async ({ access, archived }) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const member = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "nested-move-member" });
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
				return { userId, membershipId };
			});
			const source = db.files.file_root_1;
			const restricted = db.files.file_root_1_child_1;
			const child = db.files.file_root_1_child_1_deep_1;
			const target = db.files.file_root_2;
			const other = await asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				path: "other-source",
			});
			if (other._nay) throw new Error(other._nay.message);
			expect(
				(
					await asOwner.mutation(api.files_sharing.restrict_node, {
						membershipId: db.membershipId,
						nodeId: restricted._id,
					})
				)._nay,
			).toBeUndefined();
			if (access === "read" || access === "write") {
				expect(
					(
						await asOwner.mutation(api.files_sharing.set_node_share_grant, {
							membershipId: db.membershipId,
							nodeId: restricted._id,
							principal: { kind: "user", userId: member.userId },
							level: access,
						})
					)._nay,
				).toBeUndefined();
			}
			if (archived) {
				expect(
					(
						await asOwner.mutation(api.files_nodes.archive_nodes, {
							membershipId: db.membershipId,
							nodeIds: [restricted._id],
						})
					)._nay,
				).toBeUndefined();
			}
			const asUser =
				access === "owner" ? asOwner : t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
			const membershipId = access === "owner" ? db.membershipId : member.membershipId;
			const sourceBefore = await t.run((ctx) => ctx.db.get("files_nodes", source._id));
			// An unchanged parent does not act on its hidden descendants.
			expect(
				(
					await test_move_nodes(t, asUser, {
						membershipId,
						itemIds: [source._id],
						targetParentId: files_ROOT_ID,
					})
				)._nay,
			).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toMatchObject({
				parentId: sourceBefore!.parentId,
				path: sourceBefore!.path,
				updatedAt: sourceBefore!.updatedAt,
			});
			const before = await t.run((ctx) => ctx.db.query("files_nodes").collect());
			const result = await test_move_nodes(t, asUser, {
				membershipId,
				itemIds: [other._yay.nodeId, source._id],
				targetParentId: target._id,
			});
			if (access === "none" || access === "read") {
				expect(result._nay?.message).toBe("Permission denied");
				expect(JSON.stringify(result)).not.toContain(restricted.name);
				expect(await t.run((ctx) => ctx.db.get("files_nodes", source._id))).toEqual(
					before.find((node) => node._id === source._id),
				);
				for (const node of [restricted, child]) {
					expect(await t.run((ctx) => ctx.db.get("files_nodes", node._id))).toEqual(
						before.find((saved) => saved._id === node._id),
					);
				}
				expect(await t.run((ctx) => ctx.db.get("files_nodes", other._yay.nodeId))).toMatchObject({
					parentId: target._id,
					path: `${target.path}/other-source`,
				});
			} else {
				expect(result._nay).toBeUndefined();
				for (const node of [restricted, child]) {
					expect(await t.run((ctx) => ctx.db.get("files_nodes", node._id))).toMatchObject({
						path: `${target.path}${node.path}`,
						restrictedScopeNodeId: restricted._id,
						archiveOperationId: before.find((saved) => saved._id === node._id)!.archiveOperationId,
					});
				}
				expect(await t.run((ctx) => ctx.db.get("files_nodes", other._yay.nodeId))).toMatchObject({
					parentId: target._id,
					path: `${target.path}/other-source`,
				});
			}
		},
	);

	test("moves only the selected ancestor when a child and duplicate ids are selected", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const source = db.files.file_root_1_child_1;
		const child = db.files.file_root_1_child_1_deep_1;
		const target = db.files.file_root_2;

		const result = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [child._id, source._id, source._id],
			targetParentId: target._id,
		});
		expect(result._yay).toBe(null);
		const moved = await t.run(async (ctx) => ctx.db.get("files_nodes", child._id));
		expect(moved).toMatchObject({ parentId: source._id, path: `${target.path}/${source.name}/${child.name}` });
	});

	test.each(["self", "descendant"])(
		"refuses a %s destination before moving another selected item",
		async (targetKind) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const result = await test_move_nodes(t, asUser, {
				membershipId: db.membershipId,
				itemIds: [db.files.file_root_2._id, db.files.file_root_1._id],
				targetParentId: targetKind === "self" ? db.files.file_root_1._id : db.files.file_root_1_child_1._id,
			});
			expect(result._nay?.message).toBe("A folder cannot be transferred inside itself");
			expect(await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_2._id))).toEqual(
				db.files.file_root_2,
			);
		},
	);

	test.each(["missing", "archived"])("refuses a %s source without moving the other source", async (sourceKind) => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const unavailable = db.files.file_root_1_child_2;
		await t.run(async (ctx) => {
			if (sourceKind === "missing") {
				await ctx.db.delete("files_nodes", unavailable._id);
			} else {
				await ctx.db.patch("files_nodes", unavailable._id, { archiveOperationId: "archived-source" });
			}
		});
		const result = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [db.files.file_root_1_child_1._id, unavailable._id],
			targetParentId: db.files.file_root_2._id,
		});
		expect(result._nay?.message).toBe("Permission denied");
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1._id))).toEqual(
			db.files.file_root_1_child_1,
		);
	});

	test("refuses an archived destination", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [db.files.file_root_2._id],
		});
		const result = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [db.files.file_root_1._id],
			targetParentId: db.files.file_root_2._id,
		});
		expect(result._nay?.message).toBe("Destination changed");
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", db.files.file_root_1._id))).toEqual(
			db.files.file_root_1,
		);
	});
});

describe("reviewed Move names and paths", () => {
	test("moves 41 mixed files with final counter names and keeps their assets", async () => {
		vi.useFakeTimers();
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
		const sources = await t.run(async (ctx) => {
			const files: Array<{
				nodeId: Id<"files_nodes">;
				assetId: Id<"files_r2_assets">;
				destName: string;
			}> = [];
			const extensions = ["md", "txt", "png", "pdf", "mp4", "json"];
			for (let index = 0; index < 41; index += 1) {
				const name = `file-${index}.${extensions[index % extensions.length]}`;
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "upload",
					r2Bucket: "test-bucket",
					r2Key: `test-assets/${index}`,
					size: 100,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const nodeId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					kind: "file",
					parentId: files_ROOT_ID,
					name,
					sortName: files_sort_text_key(name),
					path: `/${name}`,
					treePath: `/${name}/`,
					pathDepth: 1,
					assetId,
				});
				files.push({
					nodeId,
					assetId,
					destName: `file-${index}-copy-1.${extensions[index % extensions.length]}`,
				});
			}
			return files;
		});
		const proposalIds: Id<"files_pending_updates">[] = [];
		for (const source of sources) {
			const proposal = await propose_move_for_test(t, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId: source.nodeId,
				destParent: { kind: "saved", id: db.files.file_root_2._id },
				destName: source.destName,
			});
			proposalIds.push(proposal.pendingUpdateId);
		}
		const review = await accept_move_proposals_for_test(t, db, proposalIds);
		expect(review.activity?.status).toBe("succeeded");
		expect(review.activity?.progress?.completed).toBe(41);
		await t.run(async (ctx) => {
			for (const source of sources) {
				expect(await ctx.db.get("files_nodes", source.nodeId)).toMatchObject({
					_id: source.nodeId,
					assetId: source.assetId,
					name: source.destName,
					parentId: db.files.file_root_2._id,
					path: `${db.files.file_root_2.path}/${source.destName}`,
				});
				expect((await ctx.db.get("files_r2_assets", source.assetId))?.size).toBe(100);
			}
		});
	}, 7_200_000);

	test.each([
		{ changed: "source", afterPlanning: false },
		{ changed: "destination", afterPlanning: false },
		{ changed: "destination", afterPlanning: true },
	] as const)(
		"pins the reviewed $changed path before publication (planned: $afterPlanning)",
		async ({ changed, afterPlanning }) => {
			vi.useFakeTimers();
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.nested_files(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const source = db.files.file_root_1_child_1;
			const target = db.files.file_root_2;
			const move = await propose_move_for_test(t, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				nodeId: source._id,
				destParent: { kind: "saved", id: target._id },
				destName: "copied-folder-1",
			});
			const started = await asUser.mutation(api.files_pending_update_runs.start, {
				membershipId: db.membershipId,
				requestId: crypto.randomUUID(),
				kind: "accept",
				expectedItemCount: 1,
				items: [
					{
						pendingUpdateId: move.pendingUpdateId,
						reviewedRevision: move.reviewedRevision,
						selectedContentStateId: null,
					},
				],
			});
			if (started._nay) throw new Error(started._nay.message);
			const review = started._yay;
			if (afterPlanning) {
				expect(
					await asUser.mutation(api.files_pending_update_runs.seal, {
						membershipId: db.membershipId,
						runId: review.runId,
					}),
				).toEqual({ _yay: null });
				for (let pass = 0; pass < 1_000; pass++) {
					const job = await t.run((ctx) =>
						ctx.db
							.query("files_pending_overlay_jobs")
							.withIndex("by_org_ws", (q) =>
								q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
							)
							.first(),
					);
					if (job)
						await t.mutation(internal.files_pending_overlay.run_job, {
							kind: job.kind,
							key: job.key,
							nextAttemptAt: job.nextAttemptAt,
						});
					else await asUser.action(internal.files_pending_update_runs.plan, { runId: review.runId, fence: 0 });
					const run = await t.run((ctx) => ctx.db.get("files_pending_update_runs", review.runId));
					if (run?.step !== "planning") break;
					if (pass === 999) throw new Error("Review planning did not finish");
				}
			}

			const renamed = await asUser.mutation(api.files_nodes.rename_node, {
				membershipId: db.membershipId,
				requestId: crypto.randomUUID(),
				nodeId: changed === "source" ? db.files.file_root_1._id : target._id,
				path: `changed-${changed}`,
			});
			if (!renamed._yay) throw new Error(renamed._nay?.message ?? "Expected the Rename job");
			const rename = renamed._yay;
			// Drive only Rename. The other job must keep its reviewed paths until its own worker starts.
			for (let pass = 0; pass < 5_000; pass++) {
				const activity = await t.run((ctx) => ctx.db.get("activities", rename.activityId));
				if (activity?.status === "succeeded") break;
				expect(activity?.status, "the concurrent Rename stays valid").not.toBe("failed");
				const job = await t.run(async (ctx) =>
					(
						await ctx.db
							.query("files_pending_overlay_jobs")
							.withIndex("by_org_ws", (q) =>
								q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
							)
							.collect()
					).find((entry) => !entry.blockedByCohortId),
				);
				if (job) {
					await t.mutation(internal.files_pending_overlay.run_job, {
						kind: job.kind,
						key: job.key,
						nextAttemptAt: job.nextAttemptAt,
					});
					continue;
				}
				const cohort = await t.run((ctx) =>
					ctx.db
						.query("files_move_cohorts")
						.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", rename.runId))
						.order("desc")
						.first(),
				);
				if (cohort && cohort.phase !== "complete")
					await asUser.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, mode: "step" });
				else if (cohort) await t.mutation(internal.files_transfer.settle_cohort, { cohortId: cohort._id });
				await t.mutation(internal.files_transfer.advance, { runId: rename.runId });
				if (pass === 4_999) throw new Error("Rename did not finish");
			}
			if (!afterPlanning)
				expect(
					await asUser.mutation(api.files_pending_update_runs.seal, {
						membershipId: db.membershipId,
						runId: review.runId,
					}),
				).toEqual({ _yay: null });
			await test_finish_pending_update_run(asUser, review.runId);
			const activity = await t.run((ctx) => ctx.db.get("activities", review.activityId));
			expect(activity?.status, "a reviewed path change needs a new review").toBe("failed");
			expect(activity?.progress?.completed).toBe(0);
			const current = await t.run((ctx) => ctx.db.get("files_nodes", source._id));
			expect(current).toMatchObject({
				name: source.name,
				parentId: source.parentId,
				path: changed === "source" ? `/changed-source/${source.name}` : source.path,
			});
			expect((await t.run((ctx) => ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id)))?.path).toBe(
				`${current!.path}/${db.files.file_root_1_child_1_deep_1.name}`,
			);
		},
	);
});
test("move_nodes updates descendants materialized paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await test_move_nodes(t, asUser, {
		itemIds: [db.files.file_root_1_child_1._id],
		targetParentId: db.files.file_root_2._id,
		membershipId: db.membershipId,
	});

	await t.run(async (ctx) => {
		const [movedChild, movedDeep] = await Promise.all([
			ctx.db.get("files_nodes", db.files.file_root_1_child_1._id),
			ctx.db.get("files_nodes", db.files.file_root_1_child_1_deep_1._id),
		]);

		expect(movedChild?.path).toBe(`/${db.files.file_root_2.name}/${db.files.file_root_1_child_1.name}`);
		expect(movedDeep?.path).toBe(
			`/${db.files.file_root_2.name}/${db.files.file_root_1_child_1.name}/${db.files.file_root_1_child_1_deep_1.name}`,
		);
	});
});

test("move_nodes leaves generated siblings independent from the source", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const targetFolder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "received",
	});
	if (targetFolder._nay) {
		throw new Error(targetFolder._nay.message);
	}
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
		const sourceNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf",
			kind: "file",
			path: "/report.pdf",
			treePath: "/report.pdf",
		});
		const generatedNodeId = await ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "report.pdf.md",
			kind: "file",
			path: "/report.pdf.md",
			treePath: "/report.pdf.md",
		});

		return { sourceNodeId, generatedNodeId };
	});

	const moveResult = await test_move_nodes(t, asUser, {
		membershipId: db.membershipId,
		itemIds: [sourceNodeId],
		targetParentId: targetFolder._yay.nodeId,
	});
	if (moveResult._nay) {
		throw new Error("Expected source move with generated sibling to succeed", {
			cause: moveResult._nay,
		});
	}

	const docs = await t.run(async (ctx) => {
		const source = await ctx.db.get("files_nodes", sourceNodeId);
		const generated = await ctx.db.get("files_nodes", generatedNodeId);
		return { source, generated };
	});
	expect(docs.source?.path).toBe("/received/report.pdf");
	expect(docs.generated).toMatchObject({
		parentId: files_ROOT_ID,
		name: "report.pdf.md",
		path: "/report.pdf.md",
	});
});

test("home file can be renamed and moved like any file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const homeNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
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

			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "README.md",
			sortName: files_sort_text_key("README.md"),
			kind: "file",
			path: "/README.md",
			treePath: "/README.md",
			pathDepth: 1,
			lowercaseExtension: "md",
			archiveOperationId: null,
			newChildWritePolicy: null,
		}),
	);

	await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: homeNodeId,
		path: "renamed-home.md",
	});

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.name).toBe("renamed-home.md");
		expect(homeFileNode?.path).toBe("/renamed-home.md");
	});

	await test_move_nodes(t, asUser, {
		itemIds: [homeNodeId],
		targetParentId: db.files.file_root_1._id,
		membershipId: db.membershipId,
	});

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.name).toBe("renamed-home.md");
		expect(homeFileNode?.path).toBe(`/${db.files.file_root_1.name}/renamed-home.md`);
		expect(homeFileNode?.parentId).toBe(db.files.file_root_1._id);
	});
});

test("home file can be archived like any file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const homeNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
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

			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedAt: Date.now(),
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "README.md",
			sortName: files_sort_text_key("README.md"),
			kind: "file",
			path: "/README.md",
			treePath: "/README.md",
			pathDepth: 1,
			lowercaseExtension: "md",
			archiveOperationId: null,
			newChildWritePolicy: null,
		}),
	);

	const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [homeNodeId],
	});
	if (archived._nay) {
		throw new Error(archived._nay.message);
	}

	await t.run(async (ctx) => {
		const homeFileNode = await ctx.db.get("files_nodes", homeNodeId);
		expect(homeFileNode?.archiveOperationId).toBeDefined();
	});
});

test("create_folder_node rejects duplicate active path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const duplicateCreation = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: db.files.file_root_1.name,
		membershipId: db.membershipId,
	});

	if (duplicateCreation._yay) {
		throw new Error("Expected duplicate creation to fail");
	}

	expect(duplicateCreation._nay.message).toBe("This folder already exists.");
});

test("create_folder_node rejects active file at leaf path", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
			treePath: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes",
	});

	if (result._yay) {
		throw new Error("Expected folder creation to fail when a file already owns the path");
	}
	expect(result._nay.message).toBe("This folder already exists.");
});

test("create_folder_node rejects active file at intermediate path without creating descendants", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const fileNodeId = await t.run(async (ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			createdBy: db.userId,
			updatedBy: db.userId,
			parentId: files_ROOT_ID,
			name: "notes",
			kind: "file",
			path: "/notes",
			treePath: "/notes",
		}),
	);

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes/child",
	});

	if (result._yay) {
		throw new Error("Expected folder creation to fail when an intermediate path is a file");
	}
	expect(result._nay.message).toBe("This folder already exists.");

	await t.run(async (ctx) => {
		const existingFile = await ctx.db.get("files_nodes", fileNodeId);
		const child = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/notes/child")
					.eq("archiveOperationId", null),
			)
			.first();

		expect(existingFile?.kind).toBe("file");
		expect(child).toBeNull();
	});
});

test("create_folder_node reuses active intermediate folders", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: `${db.files.file_root_1.name}/new-child`,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to reuse the existing intermediate folder", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
		const rootFolders = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", files_ROOT_ID)
					.eq("name", db.files.file_root_1.name)
					.eq("archiveOperationId", null),
			)
			.collect()
			.then((fileNodes) => fileNodes.filter((fileNode) => fileNode.kind === "folder"));

		expect(folderFileNode).toMatchObject({
			name: "new-child",
			path: `/${db.files.file_root_1.name}/new-child`,
			parentId: db.files.file_root_1._id,
			kind: "folder",
		});
		expect(rootFolders).toHaveLength(1);
		expect(rootFolders[0]?._id).toBe(db.files.file_root_1._id);
	});
});

test("create_text_node preserves caller-provided file names", async () => {
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
		path: "extensionless-create-file",
	});
	if (createdFile._nay) {
		throw new Error("Expected create_text_node to preserve caller-provided file name", {
			cause: createdFile._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		expect(fileNode?.name).toBe("extensionless-create-file");
		expect(fileNode?.path).toBe("/extensionless-create-file");
	});
});

test("create_text_node stores Markdown file properties", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "properties.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		const asset = fileNode?.assetId ? await ctx.db.get("files_r2_assets", fileNode.assetId) : null;
		const assetKinds = (await ctx.db.query("files_r2_assets").collect()).map((doc) => doc.kind).sort();
		return { fileNode, asset, assetKinds };
	});
	expect(saved.fileNode).toMatchObject({
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		contentType: "text/markdown;charset=utf-8",
		assetId: saved.asset?._id,
	});
	// Editable files have no content asset row: the node points at its first version snapshot.
	expect(saved.asset).toMatchObject({
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		kind: "content_snapshot",
		r2Bucket: "test-files-bucket",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.assetKinds).toEqual(["content_snapshot", "yjs_snapshot"]);
	expect(saved.asset?.r2Key).toBe(
		`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.asset?._id}`,
	);
});

test("create_text_node seeds initial Yjs content on the server", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial Content User",
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "server-initial.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsLastSequenceId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected server-seeded Markdown node docs");
		}

		const [asset, lastSequence, yjsSnapshot, yjsUpdates, textChunks, plainTextChunks] = await Promise.all([
			ctx.db.get("files_r2_assets", fileNode.assetId),
			ctx.db.get("files_yjs_docs_last_sequences", fileNode.yjsLastSequenceId),
			ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId),
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.order("asc")
				.collect(),
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.collect(),
			ctx.db
				.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("fileNodeId", createdFile._yay.nodeId),
				)
				.collect(),
		]);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const stats = fileNode.statsId ? await ctx.db.get("file_stats", fileNode.statsId) : null;

		return {
			fileNode,
			asset,
			lastSequence,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			textChunks,
			plainTextChunks,
			stats,
		};
	});

	expect(saved.fileNode.contentType).toBe("text/markdown;charset=utf-8");
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.lastSequence?.lastSequence).toBe(0);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		kind: "yjs_snapshot",
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.textChunks.length).toBeGreaterThan(0);
	expect(saved.textChunks.every((chunk) => chunk.sourceKind === "committed" && chunk.yjsSequence === 0)).toBe(true);
	expect(saved.plainTextChunks.length).toBe(saved.textChunks.length);
	expect(saved.plainTextChunks.every((chunk) => chunk.sourceKind === "committed" && chunk.yjsSequence === 0)).toBe(
		true,
	);
	expect(saved.stats).toMatchObject({
		lineCount: 2,
		wordCount: 9,
		charCount: files_INITIAL_CONTENT.length,
	});
});

test("create_text_node writes server-seeded initial content to R2", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial Materialize User",
		email: "initial-materialize-user@example.com",
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

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "server-initial-materialized.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", createdFile._yay.nodeId);
		if (!fileNode?.assetId || !fileNode.yjsSnapshotId) {
			throw new Error("Expected materialized server-seeded file docs");
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
		const yjsSnapshotAsset = yjsSnapshot?.assetId ? await ctx.db.get("files_r2_assets", yjsSnapshot.assetId) : null;
		const yjsUpdates = await ctx.db
			.query("files_yjs_updates")
			.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId),
			)
			.collect();
		const versionSnapshot = await ctx.db
			.query("files_snapshots")
			.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("fileNodeId", createdFile._yay.nodeId)
					.eq("archivedAt", -1),
			)
			.first();
		const versionSnapshotAsset = versionSnapshot?.assetId
			? await ctx.db.get("files_r2_assets", versionSnapshot.assetId)
			: null;

		return {
			asset,
			yjsSnapshot,
			yjsSnapshotAsset,
			yjsUpdates,
			versionSnapshot,
			versionSnapshotAsset,
		};
	});

	// Editable files do not store their current content in R2: only the Yjs snapshot and the
	// version snapshot are uploaded, and the node points at the version snapshot.
	expect(saved.asset).toMatchObject({
		kind: "content_snapshot",
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	expect(saved.asset?._id).toBe(saved.versionSnapshot?.assetId);
	expect(saved.yjsSnapshot?.sequence).toBe(0);
	expect(saved.yjsSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.yjsSnapshotAsset?._id}`,
	});
	expect(saved.yjsUpdates).toHaveLength(0);
	expect(saved.versionSnapshot?.fileNodeId).toBe(createdFile._yay.nodeId);
	expect(saved.versionSnapshotAsset).toMatchObject({
		r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${saved.versionSnapshotAsset?._id}`,
		size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	const versionSnapshotR2Key = saved.versionSnapshotAsset?.r2Key;
	const yjsSnapshotR2Key = saved.yjsSnapshotAsset?.r2Key;
	if (!versionSnapshotR2Key || !yjsSnapshotR2Key) {
		throw new Error("Expected version and Yjs snapshot R2 keys");
	}
	expect(r2Writes.get(versionSnapshotR2Key)).toBe(files_INITIAL_CONTENT);
	expect(r2Writes.has(yjsSnapshotR2Key)).toBe(true);
});

test("create_text_node does not publish a file node when initial R2 writes fail", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial R2 Failure User",
	});
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	let releaseSecondPut: (() => void) | undefined;
	const secondPutBlocked = new Promise<void>((resolve) => {
		releaseSecondPut = resolve;
	});
	let announceSecondPut: (() => void) | undefined;
	const secondPutStarted = new Promise<void>((resolve) => {
		announceSecondPut = resolve;
	});
	let putCount = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			putCount += 1;
			if (putCount === 1) {
				return new Response(null, { status: 500 });
			}
			announceSecondPut?.();
			await secondPutBlocked;
			return new Response(null, { status: 200 });
		}),
	);

	const creatingFile = asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "broken.md",
	});
	await secondPutStarted;
	// Give an early-rejecting Promise.all path time to start cleanup while its sibling PUT is
	// still blocked. The fixed path waits for both results, so both asset docs remain owned here.
	await delay(50);
	const preparedAssetIds = await t.run(async (ctx) =>
		(await ctx.db.query("files_r2_assets").collect()).map((asset) => asset._id),
	);
	expect(preparedAssetIds).toHaveLength(2);
	expect(await read_deletion_jobs(t)).toEqual([]);
	expect(deleteObjectSpy).not.toHaveBeenCalled();

	releaseSecondPut?.();
	const createdFile = await creatingFile;

	expect(createdFile._nay?.message).toBe("Failed to create file");
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/broken.md")
					.eq("archiveOperationId", null),
			)
			.first();
		const assets = await ctx.db.query("files_r2_assets").collect();

		return { assets, fileNode };
	});
	expect(saved.fileNode).toBeNull();
	expect(saved.assets).toHaveLength(0);
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	const jobs = await read_deletion_jobs(t);
	expect(jobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
	expect(jobs.map((job) => job.r2Key).sort()).toEqual(expected_ledger_keys(db, preparedAssetIds));
});

test("create_text_node cleans up R2 objects when initial metadata sync fails", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Initial R2 Sync Failure User",
	});
	const r2Writes = test_setup_r2_capture();
	vi.spyOn(R2.prototype, "syncMetadata").mockRejectedValueOnce(new Error("sync failed"));
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "sync-failure.md",
	});

	expect(createdFile._nay?.message).toBe("Failed to create file");
	const saved = await t.run(async (ctx) => {
		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", "/sync-failure.md")
					.eq("archiveOperationId", null),
			)
			.first();
		const assets = await ctx.db.query("files_r2_assets").collect();

		return { assets, fileNode };
	});
	expect(saved.fileNode).toBeNull();
	expect(saved.assets).toHaveLength(0);
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	const jobs = await read_deletion_jobs(t);
	expect(jobs.map((job) => job.reason)).toEqual(["failed_create", "failed_create"]);
	expect(jobs.map((job) => job.r2Key).sort()).toEqual(Array.from(r2Writes.keys()).sort());
});

test("create_text_node refuses a duplicate path at capture, before any upload", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Duplicate R2 Cleanup User",
	});
	const r2Writes = test_setup_r2_capture();
	const deleteObjectSpy = vi.spyOn(R2.prototype, "deleteObject").mockImplementation(async (_ctx, key) => {
		r2Writes.delete(key);
	});

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "duplicate.md",
	});
	if (createdFile._nay) {
		throw new Error(createdFile._nay.message);
	}

	const beforeDuplicate = await t.run(async (ctx) => {
		return {
			assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
			fileCount: (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("path", "/duplicate.md")
							.eq("archiveOperationId", null),
					)
					.collect()
			).length,
		};
	});
	const baselineKeys = Array.from(r2Writes.keys()).sort();

	const duplicate = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "duplicate.md",
	});

	expect(duplicate._nay?.message).toBe("This file already exists.");
	const afterDuplicate = await t.run(async (ctx) => {
		return {
			assetCount: (await ctx.db.query("files_r2_assets").collect()).length,
			fileCount: (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("path", "/duplicate.md")
							.eq("archiveOperationId", null),
					)
					.collect()
			).length,
		};
	});

	expect(afterDuplicate).toEqual(beforeDuplicate);
	expect(Array.from(r2Writes.keys()).sort()).toEqual(baselineKeys);
	// The preflight sees the occupied target before any asset doc or R2 upload exists.
	// A separate test covers a target that appears after the uploads.
	expect(deleteObjectSpy).not.toHaveBeenCalled();
	expect(await read_deletion_jobs(t)).toEqual([]);
});

test("create_folder_node creates missing folders for nested folder paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const result = await asUser.mutation(api.files_nodes.create_folder_node, {
		parentId: files_ROOT_ID,
		path: "invalid/name",
		membershipId: db.membershipId,
	});

	if (result._nay) {
		throw new Error("Expected create_folder_node to create the nested folder path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const folderFileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
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

test("create_text_node creates missing folders for nested file paths", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});

	const result = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: "notes/workspaces/plan.md",
	});
	if (result._nay) {
		throw new Error("Expected create_text_node to create the nested file path", {
			cause: result._nay,
		});
	}

	await t.run(async (ctx) => {
		const fileNode = await ctx.db.get("files_nodes", result._yay.nodeId);
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

test("archived nodes can share path with a new active node", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: db.userId,
		name: "Test User",
	});
	const duplicateName = "archived-duplicate-allowed.md";

	const createdFile = await asUser.action(api.files_nodes_content.create_text_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		path: duplicateName,
	});
	if (createdFile._nay) {
		throw new Error("Expected initial file creation to succeed");
	}

	await asUser.mutation(api.files_nodes.archive_nodes, {
		membershipId: db.membershipId,
		nodeIds: [createdFile._yay.nodeId],
	});

	const recreatedFile = await asUser.action(api.files_nodes_content.create_text_node, {
		parentId: files_ROOT_ID,
		path: duplicateName,
		membershipId: db.membershipId,
	});
	if (recreatedFile._nay) {
		throw new Error("Expected recreated file creation to succeed");
	}

	await t.run(async (ctx) => {
		const path = `/${duplicateName}`;
		const filesAtPath = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("path", path),
			)
			.collect();

		expect(filesAtPath).toHaveLength(2);
		expect(filesAtPath.filter((fileNode) => fileNode.archiveOperationId !== null)).toHaveLength(1);
		expect(filesAtPath.filter((fileNode) => fileNode.archiveOperationId === null)).toHaveLength(1);
	});
});

test("create_private_node_by_path can reuse an existing private file", async () => {
	const t = test_convex();
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const path = "/existing-by-path.md";

	const createdFile = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
		kind: "file",
	});
	if (createdFile._nay) {
		throw new Error("Expected initial file creation to succeed");
	}
	if (!createdFile._yay.created) {
		throw new Error("Expected initial file creation to create a node");
	}

	const reusedFile = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path,
		kind: "file",
	});
	if (reusedFile._nay) {
		throw new Error("Expected existing file reuse to succeed");
	}
	if (reusedFile._yay.created) {
		throw new Error("Expected existing file reuse not to create a node");
	}

	expect(createdFile._yay.target.kind).toBe("private");
	expect(reusedFile._yay.target).toEqual(createdFile._yay.target);
	expect(reusedFile._yay.created).toBe(false);
});

// #endregion move nodes

describe("files_nodes.get_authorized_by_path", () => {
	test("returns active nodes by path and ignores archived nodes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "lookup.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const active = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/lookup.md",
		});
		expect(active).toEqual({
			nodeId: created._yay.nodeId,
			name: "lookup.md",
			kind: "file",
			assetId: expect.any(String),
		});

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [created._yay.nodeId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}

		const missing = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/lookup.md",
		});
		expect(missing).toBeNull();
	});

	test("returns null for a member without content.read", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const created = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "gated.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const allowed = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/gated.md",
		});
		expect(allowed?.nodeId).toBe(created._yay.nodeId);

		// Every permission check answers "yes" for the organization owner, so we give ownership to
		// somebody else and delete this user's role assignments. What is left is a member with no
		// `content.read`.
		await t.run(async (ctx) => {
			const otherOwnerId = await ctx.db.insert("users", { clerkUserId: null });
			await ctx.db.patch("organizations", db.organizationId, { ownerUserId: otherOwnerId });

			const roleAssignments = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) => q.eq("organizationId", db.organizationId))
				.collect();
			await Promise.all(
				roleAssignments
					.filter((assignment) => assignment.userId === db.userId)
					.map((assignment) => ctx.db.delete("access_control_role_assignments", assignment._id)),
			);
		});

		const denied = await asUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: db.membershipId,
			path: "/gated.md",
		});
		expect(denied).toBeNull();
	});

	test("resolves the path inside the membership tenant only", async () => {
		const t = test_convex();
		const first = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const second = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" }),
		);

		const asFirstUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: first.userId,
			name: "First User",
		});
		const asSecondUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: second.userId,
			name: "Second User",
		});

		const firstCreated = await asFirstUser.action(api.files_nodes_content.create_text_node, {
			membershipId: first.membershipId,
			parentId: files_ROOT_ID,
			path: "shared-name.md",
		});
		const secondCreated = await asSecondUser.action(api.files_nodes_content.create_text_node, {
			membershipId: second.membershipId,
			parentId: files_ROOT_ID,
			path: "shared-name.md",
		});
		if (firstCreated._nay || secondCreated._nay) {
			throw new Error(firstCreated._nay?.message ?? secondCreated._nay?.message);
		}

		const resolvedForFirst = await asFirstUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: first.membershipId,
			path: "/shared-name.md",
		});
		const resolvedForSecond = await asSecondUser.query(api.files_nodes.get_authorized_by_path, {
			membershipId: second.membershipId,
			path: "/shared-name.md",
		});

		expect(resolvedForFirst?.nodeId).toBe(firstCreated._yay.nodeId);
		expect(resolvedForSecond?.nodeId).toBe(secondCreated._yay.nodeId);
	});
});

describe("files_nodes.create_upload_node", () => {
	test.each([-1, NaN, 0.5])("refuses invalid %s bytes before a node, asset, or quota write", async (size) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const before = await t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			assets: await ctx.db.query("files_r2_assets").collect(),
			quotas: await ctx.db.query("quotas").collect(),
		}));
		const result = await t
			.withIdentity({ issuer: "https://clerk.test", external_id: db.userId })
			.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename: "bad.bin",
				size,
			});
		expect(result._nay?.message).toBe("File too large");
		expect(
			await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				assets: await ctx.db.query("files_r2_assets").collect(),
				quotas: await ctx.db.query("quotas").collect(),
			})),
		).toEqual(before);
	});

	test("creates a visible R2 node and uses its id in the R2 key", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
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
		if (upload._nay) {
			throw new Error(upload._nay.message);
		}

		expect(upload._yay).toMatchObject({
			url: "https://r2.test/upload",
			headers: { "Content-Type": "application/pdf" },
		});

		const docs = await t.run(async (ctx) => {
			const source = await ctx.db.get("files_nodes", upload._yay.nodeId);
			const asset = await ctx.db.get("files_r2_assets", upload._yay.assetId);
			const stats = source?.statsId ? await ctx.db.get("file_stats", source.statsId) : null;
			const [textChunks, plainTextChunks] = await Promise.all([
				ctx.db
					.query("files_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", upload._yay.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", upload._yay.nodeId),
					)
					.collect(),
			]);
			return { asset, source, stats, textChunks, plainTextChunks };
		});
		expect(docs.source).toMatchObject({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			name: "annual-report.pdf",
			kind: "file",
			contentType: "application/pdf",
			assetId: upload._yay.assetId,
		});
		expect(docs.source?.archiveOperationId).toBeNull();
		expect(docs.asset).toMatchObject({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "upload",
			createdBy: db.userId,
			r2Bucket: "test-files-bucket",
			size: 1234,
		});
		expect(docs.asset?.r2Key).toBeUndefined();
		expect(docs.stats).toMatchObject({
			lineCount: -1,
			wordCount: -1,
			charCount: -1,
		});
		expect(docs.textChunks).toEqual([]);
		expect(docs.plainTextChunks).toEqual([]);
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${upload._yay.assetId}`,
			{ createOnly: true, expiresIn: 15 * 60 },
		);
	});

	test("rejects folder path conflicts before creating a source file node or upload doc", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const existing = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "annual-report.pdf",
		});
		if (existing._nay) {
			throw new Error(existing._nay.message);
		}

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "annual-report.pdf",
			contentType: "application/pdf",
			size: 1234,
		});

		expect(upload._nay).toMatchObject({ message: "The path cannot point to a folder" });
		const docs = await t.run(async (ctx) => {
			const uploadAssets = await ctx.db
				.query("files_r2_assets")
				.collect()
				.then((assets) =>
					assets.filter(
						(asset) =>
							asset.organizationId === db.organizationId &&
							asset.workspaceId === db.workspaceId &&
							asset.kind === "upload",
					),
				);
			const uploadedSources = await ctx.db
				.query("files_nodes")
				.collect()
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
					),
				);
			return { uploadAssets, uploadedSources };
		});
		expect(docs.uploadAssets).toHaveLength(0);
		expect(docs.uploadedSources).toHaveLength(0);
	});

	test("rejects oversized uploads before creating a visible node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const upload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "too-large.pdf",
			contentType: "application/pdf",
			size: files_MAX_UPLOADS_BYTES + 1,
		});

		expect(upload._nay).toMatchObject({ message: "File too large" });
		const uploadedSources = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.collect()
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
					),
				),
		);
		expect(uploadedSources).toHaveLength(0);
	});

	test("replace archives only the conflicting upload source", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const oldUpload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "replace-me.pdf",
			contentType: "application/pdf",
			size: 1024,
		});
		if (oldUpload._nay) {
			throw new Error(oldUpload._nay.message);
		}
		const generatedNodeId = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "content",
				r2Bucket: "test-files-bucket",
				r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/generated-test-asset`,
				size: 0,
				createdBy: db.userId,
				updatedAt: Date.now(),
			});
			return await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				createdBy: db.userId,
				updatedBy: db.userId,
				parentId: files_ROOT_ID,
				name: "replace-me.pdf.md",
				kind: "file",
				path: "/replace-me.pdf.md",
				treePath: "/replace-me.pdf.md",
				contentType: "text/markdown;charset=utf-8",
				assetId,
			});
		});

		const replacement = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "replace-me.pdf",
			contentType: "application/pdf",
			size: 2048,
		});
		if (replacement._nay) {
			throw new Error(replacement._nay.message);
		}

		const docs = await t.run(async (ctx) => {
			const oldSource = await ctx.db.get("files_nodes", oldUpload._yay.nodeId);
			const generated = await ctx.db.get("files_nodes", generatedNodeId);
			const newSource = await ctx.db.get("files_nodes", replacement._yay.nodeId);
			const newAsset = await ctx.db.get("files_r2_assets", replacement._yay.assetId);
			return { oldSource, generated, newSource, newAsset };
		});
		expect(docs.oldSource?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.generated).toMatchObject({
			name: "replace-me.pdf.md",
			path: "/replace-me.pdf.md",
		});
		expect(docs.generated?.archiveOperationId).toBeNull();
		expect(docs.newSource).toMatchObject({
			name: "replace-me.pdf",
			assetId: replacement._yay.assetId,
		});
		expect(docs.newSource?.archiveOperationId).toBeNull();
		expect(docs.newAsset).toMatchObject({
			kind: "upload",
			size: 2048,
		});
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${replacement._yay.assetId}`,
			{ createOnly: true, expiresIn: 15 * 60 },
		);
	});

	test("fail leaves the file holding the path alone and creates nothing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const firstUpload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "photo.png",
			contentType: "image/png",
			size: 1024,
		});
		if (firstUpload._nay) {
			throw new Error(firstUpload._nay.message);
		}

		const secondUpload = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "photo.png",
			contentType: "image/png",
			size: 2048,
			onConflict: "fail",
		});

		expect(secondUpload._nay).toMatchObject({ message: files_UPLOAD_PATH_TAKEN_MESSAGE });
		const docs = await t.run(async (ctx) => {
			const firstSource = await ctx.db.get("files_nodes", firstUpload._yay.nodeId);
			const uploadAssets = await ctx.db
				.query("files_r2_assets")
				.collect()
				.then((assets) =>
					assets.filter(
						(asset) =>
							asset.organizationId === db.organizationId &&
							asset.workspaceId === db.workspaceId &&
							asset.kind === "upload",
					),
				);
			return { firstSource, uploadAssets };
		});
		// A document embedding the first upload keeps working: refusing must not archive it.
		expect(docs.firstSource?.archiveOperationId).toBeNull();
		expect(docs.uploadAssets).toHaveLength(1);
		expect(docs.uploadAssets[0]?._id).toBe(firstUpload._yay.assetId);
	});
});

describe("files_nodes.create_upload_nodes", () => {
	test("a full storage cap keeps every replaced file and creates no upload assets", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const original = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "keep.bin",
			size: 5,
		});
		if (original._nay) throw new Error(original._nay.message);
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName: "stored_file_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 10, usedCount: 10 });
		});
		const before = await t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			assets: await ctx.db.query("files_r2_assets").collect(),
			quotas: await ctx.db.query("quotas").collect(),
		}));
		const result = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [
				{ relativePath: "keep.bin", size: 5 },
				{ relativePath: "new.bin", size: 6 },
			],
		});
		expect(result._nay?.name).toBe("storage_full");
		expect(
			await t.run(async (ctx) => ({
				nodes: await ctx.db.query("files_nodes").collect(),
				assets: await ctx.db.query("files_r2_assets").collect(),
				quotas: await ctx.db.query("quotas").collect(),
			})),
		).toEqual(before);
	});

	test("skipped items do not use storage headroom", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const original = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "keep.bin",
			size: 5,
		});
		if (original._nay) throw new Error(original._nay.message);
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName: "stored_file_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 10, usedCount: 5 });
		});
		const result = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "keep.bin", size: 20 },
				{ relativePath: "new.bin", size: 5 },
			],
		});
		expect(result._yay?.created.map((item) => item.relativePath)).toEqual(["new.bin"]);
		expect(result._yay?.skipped).toEqual([{ relativePath: "keep.bin", reason: "conflict" }]);
	});

	test("creates nested files with presigned urls and reuses folders across calls", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "docs/report.pdf", contentType: "application/pdf", size: 1234 },
				{ relativePath: "docs/img/logo.png", contentType: "image/png", size: 10 },
				{ relativePath: "docs/raw.bin", size: 5 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		expect(imported._yay.skipped).toEqual([]);
		expect(imported._yay.created).toHaveLength(3);
		expect(imported._yay.created[0]).toMatchObject({
			relativePath: "docs/report.pdf",
			url: "https://r2.test/upload",
			headers: { "Content-Type": "application/pdf" },
		});
		// No declared type: the file is stored as plain bytes, and the signed PUT pins that type.
		expect(imported._yay.created[2]!.headers).toEqual({
			"Content-Type": "application/octet-stream",
			"If-None-Match": "*",
		});

		const docs = await t.run(async (ctx) => {
			const report = await ctx.db.get("files_nodes", imported._yay.created[0]!.nodeId);
			const reportAsset = await ctx.db.get("files_r2_assets", imported._yay.created[0]!.assetId);
			const docsFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/docs")
						.eq("archiveOperationId", null),
				)
				.first();
			const imgFolder = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/docs/img")
						.eq("archiveOperationId", null),
				)
				.first();
			return { report, reportAsset, docsFolder, imgFolder };
		});
		expect(docs.report).toMatchObject({
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			path: "/docs/report.pdf",
			kind: "file",
			contentType: "application/pdf",
			assetId: imported._yay.created[0]!.assetId,
			createdBy: db.userId,
		});
		expect(docs.reportAsset).toMatchObject({
			kind: "upload",
			size: 1234,
			createdBy: db.userId,
		});
		// Unlike `data_import`, a browser import must run the standard R2 event pipeline, so
		// `processingWorkId` stays unset instead of being settled to null up front.
		expect(docs.reportAsset?.processingWorkId).toBeUndefined();
		expect(docs.docsFolder).toMatchObject({ kind: "folder" });
		expect(docs.imgFolder).toMatchObject({ kind: "folder" });
		expect(generateUploadUrlSpy).toHaveBeenCalledWith(
			`organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${imported._yay.created[0]!.assetId}`,
			{ createOnly: true, expiresIn: 15 * 60 },
		);

		const second = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "docs/img/second.png", contentType: "image/png", size: 20 }],
		});
		if (second._nay) {
			throw new Error(second._nay.message);
		}
		expect(second._yay.created).toHaveLength(1);

		const docsFolders = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/docs")
						.eq("archiveOperationId", null),
				)
				.collect(),
		);
		expect(docsFolders).toHaveLength(1);
	});

	test("imports into a selected folder and prefixes every path with the parent's", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		// The first import creates the destination folder as an intermediate.
		const seeded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dest/seed.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (seeded._nay) {
			throw new Error(seeded._nay.message);
		}
		const destFolder = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", "/dest")
						.eq("archiveOperationId", null),
				)
				.first(),
		);
		if (!destFolder) {
			throw new Error("dest folder missing");
		}

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: destFolder._id,
			onConflict: "skip",
			items: [{ relativePath: "sub/child.pdf", contentType: "application/pdf", size: 2 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		expect(imported._yay.skipped).toEqual([]);
		const child = await t.run(async (ctx) => ctx.db.get("files_nodes", imported._yay.created[0]!.nodeId));
		expect(child).toMatchObject({ path: "/dest/sub/child.pdf", parentId: expect.anything() });

		// The conflict pre-check resolves paths against the same parent.
		const conflicts = await asUser.query(api.files_nodes.get_upload_conflicts, {
			membershipId: db.membershipId,
			parentId: destFolder._id,
			relativePaths: ["sub/child.pdf", "missing.pdf"],
		});
		expect(conflicts).toEqual([{ relativePath: "sub/child.pdf", kind: "file" }]);
	});

	test("accepts boundary sizes of zero and the exact upload cap", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "empty.pdf", contentType: "application/pdf", size: 0 },
				{ relativePath: "max.pdf", contentType: "application/pdf", size: files_MAX_UPLOADS_BYTES },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}
		expect(imported._yay.created).toHaveLength(2);
	});

	test.each([
		["readme", "README.md"],
		["README", "README.md"],
		["readme.md", "README.md"],
		["agents.md", "AGENTS.md"],
		["skill.md", "SKILL.md"],
	])("normalizes special upload name %s and reuses its canonical path", async (input, name) => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		// All callers get the same conventional spelling before collision checks.
		const lowercase = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: `.AGENTS/skills/one/${input}`, contentType: "text/markdown", size: 1 }],
		});
		expect(lowercase._nay).toBeUndefined();
		expect(lowercase._yay?.created).toHaveLength(1);
		expect(lowercase._yay?.created[0]?.relativePath).toBe(`.agents/skills/one/${name}`);

		const normalized = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: `.agents/skills/one/${name}`, contentType: "text/markdown", size: 1 }],
		});
		if (normalized._nay) {
			throw new Error(normalized._nay.message);
		}
		expect(normalized._yay.created).toHaveLength(0);
		expect(normalized._yay.skipped).toHaveLength(1);
		const single = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: input,
			contentType: "text/markdown",
			size: 1,
			onConflict: "fail",
		});
		expect(single._nay).toBeUndefined();
		const uploadedNode = await t.run(async (ctx) => await ctx.db.get("files_nodes", single._yay!.nodeId));
		expect(uploadedNode?.name).toBe(name);
	});

	test("rejects a malformed path and creates nothing, including the valid items", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const cases = [
			{ relativePath: "/abs.pdf", message: "Path must be relative and normalized" },
			{ relativePath: "a//b.pdf", message: "Path must be relative and normalized" },
			{ relativePath: "a.pdf/", message: "Path must be relative and normalized" },
			{ relativePath: "../up.pdf", message: "Path contains an invalid folder name" },
			{ relativePath: "a\\b.pdf", message: "Path ends in an invalid file name" },
		];
		for (const badCase of cases) {
			const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				onConflict: "skip",
				items: [
					{ relativePath: "fine.pdf", contentType: "application/pdf", size: 1 },
					{ relativePath: badCase.relativePath, contentType: "application/pdf", size: 1 },
				],
			});
			expect(imported._nay).toMatchObject({ message: badCase.message, data: { path: badCase.relativePath } });
		}

		// The valid item in each batch must not survive the refused call.
		const docs = await t.run(async (ctx) => {
			const uploadedSources = await ctx.db
				.query("files_nodes")
				.collect()
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
					),
				);
			const uploadAssets = await ctx.db
				.query("files_r2_assets")
				.collect()
				.then((assets) =>
					assets.filter(
						(asset) =>
							asset.organizationId === db.organizationId &&
							asset.workspaceId === db.workspaceId &&
							asset.kind === "upload",
					),
				);
			return { uploadedSources, uploadAssets };
		});
		expect(docs.uploadedSources).toHaveLength(0);
		expect(docs.uploadAssets).toHaveLength(0);
	});

	test("skip mode reports an existing file as a conflict and keeps it", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}

		const again = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "fresh.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (again._nay) {
			throw new Error(again._nay.message);
		}

		expect(again._yay.skipped).toEqual([{ relativePath: "dup.pdf", reason: "conflict" }]);
		expect(again._yay.created).toHaveLength(1);
		expect(again._yay.created[0]).toMatchObject({ relativePath: "fresh.pdf" });

		const original = await t.run(async (ctx) => await ctx.db.get("files_nodes", first._yay.created[0]!.nodeId));
		expect(original?.archiveOperationId).toBeNull();
	});

	test("replace mode archives the existing file and creates a new node", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}

		const replaced = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [{ relativePath: "dup.pdf", contentType: "application/pdf", size: 2 }],
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}

		expect(replaced._yay.skipped).toEqual([]);
		expect(replaced._yay.created).toHaveLength(1);
		expect(replaced._yay.created[0]!.assetId).not.toBe(first._yay.created[0]!.assetId);

		const docs = await t.run(async (ctx) => {
			const oldSource = await ctx.db.get("files_nodes", first._yay.created[0]!.nodeId);
			const newSource = await ctx.db.get("files_nodes", replaced._yay.created[0]!.nodeId);
			return { oldSource, newSource };
		});
		expect(docs.oldSource?.archiveOperationId).toEqual(expect.any(String));
		expect(docs.newSource).toMatchObject({
			path: "/dup.pdf",
			assetId: replaced._yay.created[0]!.assetId,
		});
		expect(docs.newSource?.archiveOperationId).toBeNull();
	});

	test("skips paths blocked by a folder at the target or a file on the way", async () => {
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
			path: "blocked.pdf",
		});
		if (folder._nay) {
			throw new Error(folder._nay.message);
		}
		const ancestorFile = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "ancestor.pdf", contentType: "application/pdf", size: 1 }],
		});
		if (ancestorFile._nay) {
			throw new Error(ancestorFile._nay.message);
		}

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [
				{ relativePath: "blocked.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "ancestor.pdf/child.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		// Both shapes are skips even in replace mode: a folder is never archived by an import, and
		// a file on the way can never become a folder.
		expect(imported._yay.created).toEqual([]);
		expect(imported._yay.skipped).toEqual([
			{ relativePath: "blocked.pdf", reason: "path_blocked" },
			{ relativePath: "ancestor.pdf/child.pdf", reason: "path_blocked" },
		]);
	});

	test("a file and a folder chain on the same batch path resolve to one file and one skip", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "x.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "x.pdf/y.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		expect(imported._yay.created).toHaveLength(1);
		expect(imported._yay.created[0]).toMatchObject({ relativePath: "x.pdf" });
		expect(imported._yay.skipped).toEqual([{ relativePath: "x.pdf/y.pdf", reason: "path_blocked" }]);

		// The skipped item must not leave an orphan asset doc behind.
		const uploadAssets = await t.run(async (ctx) =>
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
		expect(uploadAssets).toHaveLength(1);
	});

	test("duplicates, empty batches, oversize items, and oversized batches fail the whole call", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const empty = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [],
		});
		expect(empty._nay).toMatchObject({ message: "No files to import" });

		const tooMany = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: Array.from({ length: 51 }, (_, index) => ({ relativePath: `f${index}.pdf`, size: 1 })),
		});
		expect(tooMany._nay).toMatchObject({ message: "Too many files" });

		const duplicated = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 2 },
			],
		});
		expect(duplicated._nay).toMatchObject({ message: "Duplicate path in batch", data: { path: "a.pdf" } });

		const oversized = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "big.pdf", contentType: "application/pdf", size: files_MAX_UPLOADS_BYTES + 1 }],
		});
		expect(oversized._nay).toMatchObject({ message: "File too large", data: { path: "big.pdf" } });

		// `v.number()` accepts NaN, so the size guard must catch it along with negatives.
		const nanSize = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "nan.pdf", contentType: "application/pdf", size: Number.NaN }],
		});
		expect(nanSize._nay).toMatchObject({ message: "Invalid file size", data: { path: "nan.pdf" } });

		const negativeSize = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "negative.pdf", contentType: "application/pdf", size: -1 }],
		});
		expect(negativeSize._nay).toMatchObject({ message: "Invalid file size", data: { path: "negative.pdf" } });

		const uploadedSources = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.collect()
				.then((fileNodes) =>
					fileNodes.filter(
						(fileNode) =>
							fileNode.organizationId === db.organizationId &&
							fileNode.workspaceId === db.workspaceId &&
							fileNode.assetId,
					),
				),
		);
		expect(uploadedSources).toHaveLength(0);
	});

	test("charges the bulk import bucket one token per file", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		const checkSpy = vi.spyOn(RateLimiter.prototype, "check");
		const limitSpy = vi.spyOn(RateLimiter.prototype, "limit");

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [
				{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "b.pdf", contentType: "application/pdf", size: 1 },
				{ relativePath: "c.pdf", contentType: "application/pdf", size: 1 },
			],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		expect(checkSpy).toHaveBeenCalledWith(
			expect.anything(),
			"files_bulk_import",
			expect.objectContaining({ count: 3 }),
		);
		expect(limitSpy).toHaveBeenCalledWith(
			expect.anything(),
			"files_bulk_import",
			expect.objectContaining({ count: 3 }),
		);
		expect(limitSpy).toHaveBeenCalledWith(
			expect.anything(),
			"files_tree_write",
			expect.objectContaining({ key: db.userId }),
		);
		// Charge tree-write before the bulk bucket: swapped, a tree-write refusal after a
		// successful bulk charge would burn bulk tokens on every retry.
		expect(limitSpy.mock.calls.map((call) => call[1])).toEqual(["files_tree_write", "files_bulk_import"]);
	});

	test("a refused bulk bucket check burns no tree-write token", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});
		vi.spyOn(RateLimiter.prototype, "check").mockResolvedValue({ ok: false, retryAfter: 1234 } as never);
		const limitSpy = vi.spyOn(RateLimiter.prototype, "limit");

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 }],
		});

		expect(imported._nay).toMatchObject({ message: "Rate limit exceeded", data: { retryAfterMs: 1234 } });
		expect(limitSpy).not.toHaveBeenCalled();
	});

	test("a Markdown upload finalizes through the standard R2 event and starts processing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Test User",
		});

		const imported = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "skip",
			items: [{ relativePath: "notes/plan.md", contentType: "text/markdown;charset=utf-8", size: 64 }],
		});
		if (imported._nay) {
			throw new Error(imported._nay.message);
		}

		const assetId = imported._yay.created[0]!.assetId;
		const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(asset?.processingWorkId).toBeUndefined();
		const assetR2Key = `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${assetId}`;
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (new URL(url).searchParams.get("key") === assetR2Key && init?.method !== "PUT") {
					return new Response(null, {
						status: 200,
						headers: { "Content-Length": "64", ETag: '"etag_browser_import_1"' },
					});
				}
				return new Response(null, { status: 404 });
			}),
		);

		enqueueActionSpy.mockClear();
		const response = await t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: "browser_import_event_1",
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: asset!.r2Bucket,
					object: {
						key: assetR2Key,
						size: 64,
						eTag: "etag_browser_import_1",
					},
					eventTime: "2026-08-01T00:00:00.000Z",
				},
			}),
		});
		expect(response.status).toBe(204);

		const finalized = await t.run(async (ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(finalized?.r2Key).toBe(assetR2Key);
		// Unlike `data_import`, the finalizer must treat this like a single-file upload and enqueue
		// the Markdown conversion work.
		expect(enqueueActionSpy).toHaveBeenCalled();
	});
});

describe("upload plan gate", () => {
	const PLAN_REFUSAL = "This workspace's plan does not include file uploads";

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
	const { sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
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
	const { folderId, sourceNodeId, generatedNodeId } = await t.run(async (ctx) => {
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

	const unauthorizedYjsUpdates = await asOtherUser.query(api.files_nodes.yjs_get_incremental_updates, {
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
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
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
			t.run((ctx) =>
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

describe("files_nodes.set_node_write_policy", () => {
	test("locks a folder and leaves other items unchanged", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId, frozenId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();

		const outer = await read_lock_node(t, outerId);
		expect(outer).toMatchObject({ writePolicy: { mode: "read_only" } });

		for (const nodeId of [innerId, deepId, siblingId]) {
			const node = await read_lock_node(t, nodeId);
			expect(node).toMatchObject({ writePolicy: null });
		}

		const frozen = await read_lock_node(t, frozenId);
		expect(frozen?.archiveOperationId).toBeDefined();
		expect(frozen).toMatchObject({ writePolicy: null });
	});

	test("locking a parent does not change a child lock", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);

		const innerLocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(innerLocked._nay).toBeUndefined();
		const outerLocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerLocked._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ writePolicy: { mode: "read_only" } });
		expect(await read_lock_node(t, siblingId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, innerId)).toMatchObject({ writePolicy: { mode: "read_only" } });
		expect(await read_lock_node(t, deepId)).toMatchObject({ writePolicy: null });
	});

	test("unlocking a parent does not change a child lock", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId } = await seed_read_only_lock_tree(t);

		const outerLocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerLocked._nay).toBeUndefined();
		const innerLocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(innerLocked._nay).toBeUndefined();

		expect(await read_lock_node(t, innerId)).toMatchObject({ writePolicy: { mode: "read_only" } });
		expect(await read_lock_node(t, deepId)).toMatchObject({ writePolicy: null });

		const outerUnlocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(outerUnlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, siblingId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, innerId)).toMatchObject({ writePolicy: { mode: "read_only" } });
		expect(await read_lock_node(t, deepId)).toMatchObject({ writePolicy: null });
	});

	test("locking is idempotent", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();
		const lockedAgain = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(lockedAgain._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ writePolicy: { mode: "read_only" } });
		expect(await read_lock_node(t, innerId)).toMatchObject({ writePolicy: null });
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

		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();

		expect(await read_lock_node(t, cold._yay.nodeId)).toMatchObject({ writePolicy: { mode: "read_only" } });
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

		const locked = await asManager.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: manager.membershipId,
			nodeId: activeRootId,
		});
		expect(locked._nay).toBeUndefined();
		expect(await read_lock_node(t, activeRootId)).toMatchObject({ writePolicy: { mode: "read_only" } });
		expect(await read_lock_node(t, activeChildId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, archivedChildId)).toMatchObject({ writePolicy: { mode: "read_only" } });
	});
	test("unlocks a folder and leaves other items unchanged", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId, siblingId, frozenId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(unlocked._nay).toBeUndefined();

		for (const nodeId of [outerId, innerId, deepId, siblingId, frozenId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ writePolicy: null });
		}
	});

	test("unlocking a child does not change the parent lock", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId } = await seed_read_only_lock_tree(t);

		for (const nodeId of [outerId, innerId]) {
			const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
				writePolicy: { mode: "read_only" },
				membershipId: db.membershipId,
				nodeId,
			});
			expect(locked._nay).toBeUndefined();
		}
		const unlocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(unlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, outerId)).toMatchObject({ writePolicy: { mode: "read_only" } });
		expect(await read_lock_node(t, innerId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, deepId)).toMatchObject({ writePolicy: null });
	});

	test("unlocking a child that has no lock is a no-op", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);

		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();

		const refused = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId: innerId,
		});
		expect(refused._nay).toBeUndefined();

		expect(await read_lock_node(t, innerId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, outerId)).toMatchObject({ writePolicy: { mode: "read_only" } });

		// Use the same path to prove the direct lock can be removed.
		const unlocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(unlocked._nay).toBeUndefined();
	});

	test("unlocking a writable node is an idempotent no-op", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);

		const unlocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId: siblingId,
		});
		expect(unlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, siblingId)).toMatchObject({ writePolicy: null });
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

		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: null,
			membershipId: db.membershipId,
			nodeId: cold._yay.nodeId,
		});
		expect(unlocked._nay).toBeUndefined();

		expect(await read_lock_node(t, cold._yay.nodeId)).toMatchObject({ writePolicy: null });
	});
});

describe("files_nodes.get_node_write_policy_management_state", () => {
	test("a node with no lock above it reports the writable state", async () => {
		const t = test_convex();
		const { db, asUser, siblingId } = await seed_read_only_lock_tree(t);

		// Properties shows this node's own lock and write access.
		// An open node has no local lock.
		const state = await asUser.query(api.files_nodes.get_node_write_policy_management_state, {
			membershipId: db.membershipId,
			nodeId: siblingId,
		});
		expect(state).toEqual({
			nodeId: siblingId,
			canManage: true,
			canWrite: true,
			writeBlockedReason: null,
			localPolicy: null,
			localDefault: null,
		});
	});

	test("a direct lock reports the local read-only state", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: outerId });

		// This node's own lock is read-only. Clearing that local lock makes it writable.
		// There is no inherit choice and no parent lock to open.
		const state = await asUser.query(api.files_nodes.get_node_write_policy_management_state, {
			membershipId: db.membershipId,
			nodeId: outerId,
		});
		expect(state).toEqual({
			nodeId: outerId,
			canManage: true,
			canWrite: false,
			writeBlockedReason: "read_only",
			localPolicy: { mode: "read_only" },
			localDefault: null,
		});
	});
});

describe("files_nodes.get_folder_new_child_write_policy_state", () => {
	test("returns the kind of the folder's own default for new children", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId } = await seed_read_only_lock_tree(t);
		const read_state = async (nodeId: Id<"files_nodes">) =>
			await asUser.query(api.files_nodes.get_folder_new_child_write_policy_state, {
				membershipId: db.membershipId,
				nodeId,
			});

		expect(await read_state(outerId)).toBe("none");

		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: outerId,
					newChildWritePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: innerId,
					newChildWritePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
				})
			)._nay,
		).toBeUndefined();

		// Only the folder's own default counts. The parent's default does not change the child's answer.
		expect(await read_state(outerId)).toBe("read_only");
		expect(await read_state(innerId)).toBe("writer");
	});

	test("returns null for a file", async () => {
		const t = test_convex();
		const { db, asUser, outerId } = await seed_read_only_lock_tree(t);
		const file = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: db.membershipId,
			parentId: outerId,
			path: "note.md",
		});
		if (file._nay) {
			throw new Error(file._nay.message);
		}

		expect(
			await asUser.query(api.files_nodes.get_folder_new_child_write_policy_state, {
				membershipId: db.membershipId,
				nodeId: file._yay.nodeId,
			}),
		).toBeNull();
	});
});

describe("files_nodes.set_node_new_child_write_policy", () => {
	test("copies the folder default onto a brand-new child only", async () => {
		const t = test_convex();
		const { db, asUser } = await seed_read_only_lock_tree(t);
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "defaults",
		});
		expect(folder._nay).toBeUndefined();

		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: folder._yay!.nodeId,
					newChildWritePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		const child = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: folder._yay!.nodeId,
			path: "child",
		});
		expect(child._nay).toBeUndefined();
		expect(await read_lock_node(t, child._yay!.nodeId)).toMatchObject({
			writePolicy: { mode: "read_only" },
			newChildWritePolicy: { mode: "read_only" },
		});

		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: folder._yay!.nodeId,
					newChildWritePolicy: null,
				})
			)._nay,
		).toBeUndefined();
		expect(await read_lock_node(t, child._yay!.nodeId)).toMatchObject({
			writePolicy: { mode: "read_only" },
			newChildWritePolicy: { mode: "read_only" },
		});

		const sibling = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: folder._yay!.nodeId,
			path: "later",
		});
		expect(sibling._nay).toBeUndefined();
		expect(await read_lock_node(t, sibling._yay!.nodeId)).toMatchObject({
			writePolicy: null,
			newChildWritePolicy: null,
		});
	});
});

describe("files_nodes.create_upload_nodes locked defaults", () => {
	test("one call into a locked-default folder succeeds and locks the new files", async () => {
		const t = test_convex();
		const { db, asUser } = await seed_read_only_lock_tree(t);
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "upload-default",
		});
		expect(folder._nay).toBeUndefined();

		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: folder._yay!.nodeId,
					newChildWritePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		const created = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: folder._yay!.nodeId,
			onConflict: "skip",
			items: [{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 }],
		});
		expect(created._nay).toBeUndefined();
		expect(created._yay!.created).toHaveLength(1);

		const node = await t.run((ctx) => ctx.db.get("files_nodes", created._yay!.created[0]!.nodeId));
		expect(node?.writePolicy).toEqual({ mode: "read_only" });
	});

	test("a default change between calls applies live to the next call", async () => {
		const t = test_convex();
		const { db, asUser } = await seed_read_only_lock_tree(t);
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "upload-default-live",
		});
		expect(folder._nay).toBeUndefined();

		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: folder._yay!.nodeId,
					newChildWritePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		const first = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: folder._yay!.nodeId,
			onConflict: "skip",
			items: [{ relativePath: "a.pdf", contentType: "application/pdf", size: 1 }],
		});
		expect(first._nay).toBeUndefined();

		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_new_child_write_policy, {
					membershipId: db.membershipId,
					nodeId: folder._yay!.nodeId,
					newChildWritePolicy: null,
				})
			)._nay,
		).toBeUndefined();

		const second = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: folder._yay!.nodeId,
			onConflict: "skip",
			items: [{ relativePath: "b.pdf", contentType: "application/pdf", size: 1 }],
		});
		expect(second._nay).toBeUndefined();

		const docs = await t.run(async (ctx) => ({
			first: await ctx.db.get("files_nodes", first._yay!.created[0]!.nodeId),
			second: await ctx.db.get("files_nodes", second._yay!.created[0]!.nodeId),
		}));
		expect(docs.first?.writePolicy).toEqual({ mode: "read_only" });
		expect(docs.second?.writePolicy).toBeNull();
	});
});

describe("selected file writers", () => {
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
			writer: { kind: "service_account", serviceAccountId },
			actorUserId: fixture.db.userId,
			resourceScope: { kind: "workspace" },
			policyReach: "direct",
		};

		return { ...fixture, serviceAccountId, writeContext };
	}

	test("a selected human needs ACL permission and only this node's writer rule", async () => {
		const t = test_convex();
		const { db, asUser, outerId, innerId, deepId } = await seed_read_only_lock_tree(t);
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "selected-writer" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "viewer",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
		const selected = { mode: "writer" as const, writers: [{ kind: "user" as const, userId: member.userId }] };

		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: deepId,
					writePolicy: selected,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await asMember.query(api.files_nodes.get_current_user_file_write_permission, {
				membershipId: member.membershipId,
				nodeId: deepId,
			}),
		).toBe(false);

		expect(
			(
				await asUser.mutation(api.access_control.set_user_role, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: member.userId,
					role: "member",
				})
			)._nay,
		).toBeUndefined();
		expect(
			await asMember.query(api.files_nodes.get_current_user_file_write_permission, {
				membershipId: member.membershipId,
				nodeId: deepId,
			}),
		).toBe(true);

		expect(
			(
				await asMember.mutation(api.files_metadata.set_entries, {
					membershipId: member.membershipId,
					fileNodeId: deepId,
					metadataYaml: "writer: selected",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: deepId,
					metadataYaml: "writer: owner",
				})
			)._nay?.name,
		).toBe("read_only");

		// A parent writer rule does not stack onto this node.
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: outerId,
					writePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
				})
			)._nay,
		).toBeUndefined();
		expect(
			await asMember.query(api.files_nodes.get_current_user_file_write_permission, {
				membershipId: member.membershipId,
				nodeId: deepId,
			}),
		).toBe(true);
		expect(
			await asUser.query(api.files_nodes.get_current_user_file_write_permission, {
				membershipId: db.membershipId,
				nodeId: deepId,
			}),
		).toBe(false);

		const [{ page: outerFolders }, { page: innerFolders }] = await Promise.all(
			[outerId, innerId].map((parentId) =>
				asMember.query(api.files_nodes.list_tree_children, {
					membershipId: member.membershipId,
					parentId,
					kind: "folder",
					archived: false,
					restricted: false,
					paginationOpts: { numItems: 50, cursor: null },
				}),
			),
		);
		expect(outerFolders.find((node) => node._id === innerId)).toMatchObject({
			canWrite: true,
			writePolicyState: "none",
		});
		expect(innerFolders.find((node) => node._id === deepId)).toMatchObject({
			canWrite: true,
			writePolicyState: "writer",
		});
	});

	test("direct account reach cannot match a parent rule during creation", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);

		expect(
			(
				await fixture.asUser.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.db.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: fixture.outerId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await fixture.asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.outerId,
					writePolicy: { mode: "writer", writers: [fixture.writeContext.writer] },
				})
			)._nay,
		).toBeUndefined();

		const result = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", fixture.outerId);
			if (!node) {
				throw new Error("Missing folder");
			}

			const direct = await files_nodes_db_require_writable(ctx, {
				organizationId: fixture.db.organizationId,
				workspaceId: fixture.db.workspaceId,
				writeContext: fixture.writeContext,
				target: { kind: "node", node },
			});
			const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: fixture.db.organizationId,
				workspaceId: fixture.db.workspaceId,
				userId: fixture.db.userId,
				parentId: fixture.outerId,
				path: "new/deep",
				kind: "folder",
				now: Date.now(),
				writeContext: {
					...fixture.writeContext,
					resourceScope: { kind: "create", parentNodeId: fixture.outerId, path: "/outer/new/deep" },
				},
			});

			return { direct, created, paths: (await ctx.db.query("files_nodes").collect()).map((item) => item.path) };
		});
		expect(result.direct._nay).toBeUndefined();
		expect(result.created._nay?.name).toBe("read_only");
		expect(result.paths).not.toContain("/outer/new");
		expect(result.paths).not.toContain("/outer/new/deep");
	});

	test("exact folder management changes the folder even with a nested restricted scope", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);
		const policy = { mode: "writer" as const, writers: [fixture.writeContext.writer] };

		expect(
			(
				await fixture.asUser.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.db.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: fixture.outerId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();
		const setPolicy = async (writePolicy: typeof policy | null) =>
			await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", fixture.outerId);
				if (!node) {
					throw new Error("Missing folder");
				}
				return await files_nodes_db_set_write_policy(ctx, { node, writeContext: fixture.writeContext, writePolicy });
			});

		expect((await setPolicy(policy))._nay).toBeUndefined();
		expect(await read_lock_node(t, fixture.deepId)).toMatchObject({
			writePolicy: null,
		});

		expect(
			(
				await fixture.asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.frozenId,
				})
			)._nay,
		).toBeUndefined();
		// The folder's rule is its own. The restricted child needs no grant and keeps its rule.
		expect((await setPolicy(null))._nay).toBeUndefined();
		expect(await read_lock_node(t, fixture.outerId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, fixture.frozenId)).toMatchObject({ writePolicy: null });
	});

	test("exact folder management ignores a restricted scope two levels down", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);
		const policy = { mode: "writer" as const, writers: [fixture.writeContext.writer] };

		expect(
			(
				await fixture.asUser.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.db.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: fixture.outerId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await fixture.asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.deepId,
				})
			)._nay,
		).toBeUndefined();
		const setPolicy = async () =>
			await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", fixture.outerId);
				if (!node) {
					throw new Error("Missing folder");
				}
				return await files_nodes_db_set_write_policy(ctx, {
					node,
					writeContext: fixture.writeContext,
					writePolicy: policy,
				});
			});

		expect((await setPolicy())._nay).toBeUndefined();
		expect(await read_lock_node(t, fixture.outerId)).toMatchObject({ writePolicy: policy });
		expect(await read_lock_node(t, fixture.deepId)).toMatchObject({ writePolicy: null });
	});

	test("creating a local policy uses parent management and adds no child grant", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);

		expect(
			(
				await fixture.asUser.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.db.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: fixture.outerId },
					level: "write",
				})
			)._nay,
		).toBeUndefined();
		const create = async () =>
			await t.run(
				async (ctx) =>
					await files_nodes_db_create_node_recursively_at_path(ctx, {
						organizationId: fixture.db.organizationId,
						workspaceId: fixture.db.workspaceId,
						userId: fixture.db.userId,
						parentId: fixture.outerId,
						path: "new/deep",
						kind: "folder",
						now: Date.now(),
						writeContext: {
							...fixture.writeContext,
							resourceScope: { kind: "create", parentNodeId: fixture.outerId, path: "/outer/new/deep" },
						},
						writePolicy: { mode: "writer", writers: [fixture.writeContext.writer] },
					}),
			);

		expect((await create())._nay?.message).toBe("Permission denied");
		expect(
			await t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).some((node) => node.path.startsWith("/outer/new")),
			),
		).toBe(false);

		expect(
			(
				await fixture.asUser.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.db.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: fixture.outerId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();

		const created = await create();
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const result = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", created._yay);
			if (!node) {
				throw new Error("Missing created folder");
			}
			return {
				node,
				grants: (await ctx.db.query("access_control_permission_grants").collect()).filter(
					(grant) => grant.principalKind === "service_account",
				),
				state: await files_nodes_db_get_write_policy_management_state(ctx, {
					node,
					writeContext: fixture.writeContext,
				}),
			};
		});

		expect(result.node).toMatchObject({
			writePolicy: { mode: "writer", writers: [fixture.writeContext.writer] },
		});
		expect(result.grants.every((grant) => grant.resourceId === fixture.outerId)).toBe(true);
		expect(result.state).toMatchObject({ canWrite: false, canManage: false, writeBlockedReason: "permission" });
	});

	test("creating a folder default checks the named writer", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);
		const strangerId = await t.run(async (ctx) => ctx.db.insert("users", { clerkUserId: "stranger-default-writer" }));

		expect(
			(
				await fixture.asUser.mutation(api.access_control.set_service_account_grant, {
					membershipId: fixture.db.membershipId,
					serviceAccountId: fixture.serviceAccountId,
					resource: { kind: "file", nodeId: fixture.outerId },
					level: "manage",
				})
			)._nay,
		).toBeUndefined();

		const refused = await t.run(
			async (ctx) =>
				await files_nodes_db_create_node_recursively_at_path(ctx, {
					organizationId: fixture.db.organizationId,
					workspaceId: fixture.db.workspaceId,
					userId: fixture.db.userId,
					parentId: fixture.outerId,
					path: "default-only",
					kind: "folder",
					now: Date.now(),
					writeContext: {
						...fixture.writeContext,
						resourceScope: { kind: "create", parentNodeId: fixture.outerId, path: "/outer/default-only" },
					},
					newChildWritePolicy: { mode: "writer", writers: [{ kind: "user", userId: strangerId }] },
				}),
		);
		expect(refused._nay?.message).toBe("Writer is not available");
		expect(
			await t.run(async (ctx) =>
				(await ctx.db.query("files_nodes").collect()).some((node) => node.path === "/outer/default-only"),
			),
		).toBe(false);
	});

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

	test("every listed writer can edit, and a writer left out cannot", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);
		const owner = { kind: "user", userId: fixture.db.userId } as const;
		const set_writers = async (writers: Array<files_nodes_WriteContext["writer"]>) =>
			(
				await fixture.asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.deepId,
					writePolicy: { mode: "writer", writers },
				})
			)._nay;
		const account_can_write = async () =>
			await t.run(async (ctx) => {
				const node = (await ctx.db.get("files_nodes", fixture.deepId))!;
				return !(
					await files_nodes_db_require_writable(ctx, {
						organizationId: fixture.db.organizationId,
						workspaceId: fixture.db.workspaceId,
						writeContext: fixture.writeContext,
						target: { kind: "node", node },
					})
				)._nay;
			});
		const owner_can_write = async () =>
			await fixture.asUser.query(api.files_nodes.get_current_user_file_write_permission, {
				membershipId: fixture.db.membershipId,
				nodeId: fixture.deepId,
			});

		expect(await set_writers([owner, fixture.writeContext.writer])).toBeUndefined();
		expect(await owner_can_write()).toBe(true);
		expect(await account_can_write()).toBe(true);

		expect(await set_writers([fixture.writeContext.writer])).toBeUndefined();
		expect(await owner_can_write()).toBe(false);
		expect(await account_can_write()).toBe(true);
	});

	test("a writer list must hold at least one writer and no duplicates", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);
		const owner = { kind: "user", userId: fixture.db.userId } as const;

		for (const writers of [[], [owner, owner]]) {
			expect(
				(
					await fixture.asUser.mutation(api.files_nodes.set_node_write_policy, {
						membershipId: fixture.db.membershipId,
						nodeId: fixture.deepId,
						writePolicy: { mode: "writer", writers },
					})
				)._nay?.message,
			).toBe(files_WRITE_POLICY_INVALID_WRITERS_MESSAGE);
		}
		expect(await read_lock_node(t, fixture.deepId)).toMatchObject({ writePolicy: null });
	});

	test("a revoked writer is hidden and a manager can replace it", async () => {
		const t = test_convex();
		const fixture = await seed_account(t);
		const args = { membershipId: fixture.db.membershipId, nodeId: fixture.innerId };

		expect(
			(
				await fixture.asUser.mutation(api.files_nodes.set_node_write_policy, {
					...args,
					writePolicy: {
						mode: "writer",
						writers: [{ kind: "user", userId: fixture.db.userId }, fixture.writeContext.writer],
					},
				})
			)._nay,
		).toBeUndefined();

		expect(
			(
				await fixture.asUser.mutation(api.access_control.revoke_service_account, {
					membershipId: fixture.db.membershipId,
					serviceAccountId: fixture.serviceAccountId,
				})
			)._nay,
		).toBeUndefined();
		expect(await fixture.asUser.query(api.files_nodes.get_node_write_policy_management_state, args)).toMatchObject({
			canManage: true,
			canWrite: true,
			localPolicy: {
				mode: "writer",
				writers: [{ kind: "user", userId: fixture.db.userId }],
				hiddenWriterCount: 1,
			},
		});

		expect(
			(
				await fixture.asUser.mutation(api.files_nodes.set_node_write_policy, {
					...args,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		expect(await read_lock_node(t, fixture.innerId)).toMatchObject({ writePolicy: { mode: "read_only" } });
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
		expect(node).toMatchObject({ writePolicy: null });
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
				writePolicy: null,
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

	const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
		writePolicy: { mode: "read_only" },
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

	const unlocked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
		writePolicy: null,
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
		const fixture = await t.run(async (ctx) => {
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
		expect(await read_lock_node(t, deepId)).toMatchObject({ writePolicy: { mode: "read_only" } });

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
		expect(frozen).toMatchObject({ writePolicy: { mode: "read_only" } });
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
		expect(await read_lock_node(t, deepId)).toMatchObject({ writePolicy: { mode: "read_only" } });

		const movedSibling = await test_move_nodes(t, asUser, {
			membershipId: db.membershipId,
			itemIds: [siblingId],
			targetParentId: files_ROOT_ID,
		});
		expect(movedSibling._nay).toBeUndefined();
		expect((await read_lock_node(t, siblingId))?.path).toBe("/sibling");
		expect(await read_lock_node(t, siblingId)).toMatchObject({ writePolicy: null });
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
		expect(deep).toMatchObject({ writePolicy: { mode: "read_only" } });
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
		const activeRoot = await read_lock_node(t, activeRootId);
		const activeChild = await read_lock_node(t, activeChildId);
		expect(activeRoot?.archiveOperationId).toBeDefined();
		expect(activeChild?.archiveOperationId).toBe(activeRoot?.archiveOperationId);
		expect((await read_lock_node(t, archivedRootId))?.archiveOperationId).toBe(archivedRootBefore?.archiveOperationId);
		expect((await read_lock_node(t, archivedChildId))?.archiveOperationId).toBe(
			archivedChildBefore?.archiveOperationId,
		);
	});

	test("archived descendants: hidden unlocked ignored, visible locked refused, hidden locked stays hidden", async () => {
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

		// Visible and locked: the precise read-only refusal, and no write happened.
		const refusedVisible = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch2Id],
		});
		expect(refusedVisible._nay?.name).toBe("read_only");
		expect(refusedVisible._nay?.message).toBe("An item inside it is read-only.");
		expect((await read_lock_node(t, arch2Id))?.archiveOperationId).toBeNull();

		// Hidden and locked: a generic refusal that is not `read_only` and never names the node (RO-10).
		const refusedHidden = await asMember.mutation(api.files_nodes.archive_nodes, {
			membershipId: other.otherMembershipId,
			nodeIds: [arch3Id],
		});
		expect(refusedHidden._nay?.message).toBe("You cannot change an item inside it.");
		expect(refusedHidden._nay?.name).not.toBe("read_only");
		expect((await read_lock_node(t, arch3Id))?.archiveOperationId).toBeNull();
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
		expect(firstChild).toMatchObject({ writePolicy: { mode: "read_only" } });
	});

	test("a locked node anywhere in the restored subtree blocks the restore until unlock", async () => {
		const t = test_convex();
		const { db, asUser, innerId, deepId } = await seed_read_only_lock_tree(t);

		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(archived._nay).toBeUndefined();
		const innerArchivedOperationId = (await read_lock_node(t, innerId))?.archiveOperationId;
		expect(innerArchivedOperationId).toBeDefined();

		// A locked archived descendant blocks restoring its ancestor.
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });
		const refusedByDescendant = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(refusedByDescendant._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, innerId))?.archiveOperationId).toBe(innerArchivedOperationId);
		expect((await read_lock_node(t, deepId))?.archiveOperationId).toBe(innerArchivedOperationId);

		// The named node's own lock blocks too.
		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: deepId });
		await set_read_only_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });
		const refusedByNamedNode = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(refusedByNamedNode._nay?.name).toBe("read_only");
		expect((await read_lock_node(t, innerId))?.archiveOperationId).toBe(innerArchivedOperationId);

		await set_writable_or_throw({ asUser, membershipId: db.membershipId, nodeId: innerId });
		const restored = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [innerId],
		});
		expect(restored._nay).toBeUndefined();
		const inner = await read_lock_node(t, innerId);
		expect(inner?.archiveOperationId).toBeNull();
		expect(inner?.path).toBe("/outer/inner");
		const deep = await read_lock_node(t, deepId);
		expect(deep?.archiveOperationId).toBeNull();
		expect(deep?.path).toBe("/outer/inner/deep");
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
			args.as.query(api.files_nodes.list_tree_children, {
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
			f.asMember.query(api.files_nodes.list_tree_shared_roots, {
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
			// Children keep no rule of their own. The hidden outer lock does not apply here.
			expect(node.writePolicyState).toBe("none");
			// Raw lock fields stay on the backend. Public views only expose writePolicyState.
			expect("writePolicyScopeNodeId" in node).toBe(false);
			expect("writePolicy" in node).toBe(false);
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
			writePolicyState: "read_only",
		});
		expect(innerRow).toMatchObject({
			writePolicyState: "none",
		});
	});

	test("get_file_node_for_membership reports no lock on a child of a hidden locked parent", async () => {
		const t = test_convex();
		const f = await seed_hidden_lock_root(t);

		const memberView = await f.asMember.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: f.memberMembershipId,
			fileNodeId: f.fileId,
		});
		expect(memberView).toMatchObject({ writePolicyState: "none" });
		expect(memberView).not.toHaveProperty("writePolicyScopeNodeId");
		expect(memberView).not.toHaveProperty("writePolicy");

		const ownerView = await f.asOwner.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: f.db.membershipId,
			fileNodeId: f.fileId,
		});
		expect(ownerView).toMatchObject({
			writePolicyState: "none",
		});

		const outerView = await f.asOwner.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: f.db.membershipId,
			fileNodeId: f.outerId,
		});
		expect(outerView).toMatchObject({
			writePolicyState: "read_only",
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
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();

		const view = await asUser.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: db.membershipId,
			fileNodeId: nodeId,
		});
		expect(view).toMatchObject({ writePolicyState: "read_only" });
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

		const view = await asUser.query(api.files_nodes.get_file_node_for_membership, {
			membershipId: db.membershipId,
			fileNodeId: folder._yay.nodeId,
		});
		expect(view).toMatchObject({ writePolicyState: "none" });
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
			asOwner.query(api.files_nodes.list_tree_children, {
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
		expect(await f.asOwner.query(api.files_nodes.get_node_write_policy_management_state, args)).toMatchObject({
			canManage: true,
			canWrite: true,
			localPolicy: null,
		});
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
					writePolicy: { mode: "read_only" },
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
				(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: null }))._nay,
			).toBeUndefined();
		}
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
					writePolicy: null,
					membershipId: f.db.membershipId,
					nodeId: f.folderId,
				})
			)._nay,
		).toBeUndefined();
		expect(await f.asOwner.query(api.files_nodes.get_node_write_policy_management_state, args)).toMatchObject({
			canManage: true,
			canWrite: true,
			localPolicy: null,
		});
		expect(
			(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: { mode: "read_only" } }))
				._nay,
		).toBeUndefined();
	});

	test("a writer can edit the label but cannot use manager sharing or lock controls", async () => {
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
		expect(await f.asMember.query(api.files_nodes.get_node_write_policy_management_state, args)).toMatchObject({
			canManage: false,
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
				await f.asMember.mutation(api.files_nodes.set_node_write_policy, {
					...args,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeDefined();
		expect(
			(await f.asMember.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: null }))._nay,
		).toBeDefined();
	});

	test("changing a selected writer keeps descriptive plugin metadata", async () => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		const args = { membershipId: f.db.membershipId, nodeId: f.folderId };
		const writePolicy = { mode: "writer" as const, writers: [{ kind: "user" as const, userId: f.member.userId }] };
		// Stamp the same writer twice: the repeat must leave the metadata map untouched.
		for (let i = 0; i < 2; i += 1) {
			expect(
				(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy }))._nay,
			).toBeUndefined();
		}
		expect(await read_lock_node(t, f.folderId)).toMatchObject({ writePolicy });
		for (const nodeId of [f.childId, f.leafId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ writePolicy: null });
		}
		expect(
			(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: null }))._nay,
		).toBeUndefined();
		for (const nodeId of [f.folderId, f.childId, f.leafId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ writePolicy: null });
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

	test("removing a local writer leaves the child unlocked", async () => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		const outerPolicy = { mode: "writer" as const, writers: [{ kind: "user" as const, userId: f.db.userId }] };
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: f.db.membershipId,
					nodeId: f.folderId,
					writePolicy: outerPolicy,
				})
			)._nay,
		).toBeUndefined();
		const args = { membershipId: f.db.membershipId, nodeId: f.childId };
		const innerPolicy = { mode: "writer" as const, writers: [{ kind: "user" as const, userId: f.member.userId }] };
		expect(
			(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: innerPolicy }))._nay,
		).toBeUndefined();
		expect(await read_lock_node(t, f.childId)).toMatchObject({
			writePolicy: innerPolicy,
		});
		expect(
			(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: null }))._nay,
		).toBeUndefined();
		expect(await read_lock_node(t, f.folderId)).toMatchObject({ writePolicy: outerPolicy });
		for (const nodeId of [f.childId, f.leafId]) {
			expect(await read_lock_node(t, nodeId)).toMatchObject({ writePolicy: null });
		}
	});

	test("changing the outer policy preserves a nested selected writer", async () => {
		const t = test_convex();
		const f = await seed_labeled_folders(t);
		const writePolicy = { mode: "writer" as const, writers: [{ kind: "user" as const, userId: f.member.userId }] };
		expect(
			(
				await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: f.db.membershipId,
					nodeId: f.childId,
					writePolicy,
				})
			)._nay,
		).toBeUndefined();
		const args = { membershipId: f.db.membershipId, nodeId: f.folderId };
		expect(
			(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: { mode: "read_only" } }))
				._nay,
		).toBeUndefined();
		expect(
			(await f.asOwner.mutation(api.files_nodes.set_node_write_policy, { ...args, writePolicy: null }))._nay,
		).toBeUndefined();
		expect(await read_lock_node(t, f.folderId)).toMatchObject({ writePolicy: null });
		expect(await read_lock_node(t, f.childId)).toMatchObject({ writePolicy });
		expect(await read_lock_node(t, f.leafId)).toMatchObject({ writePolicy: null });
	});
});

describe("files_nodes_content.create_file_node read-only barrier", () => {
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

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
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
		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
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

		const refused = await t.mutation(internal.files_nodes_content.create_file_node, {
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

		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
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

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
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

		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
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
		const refused = await t.mutation(internal.files_nodes_content.create_file_node, {
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

		const barrier = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
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
		const refused = await t.mutation(internal.files_nodes_content.create_file_node, {
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

		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
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

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
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

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
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
		const preflight = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
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

		const created = await t.mutation(internal.files_nodes_content.create_file_node, {
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
			membershipId: db.membershipId,
			nodeId: seeded.nodeId,
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
				membershipId: db.membershipId,
				nodeId: seeded.nodeId,
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

		const restored = await asUser.mutation(internal.files_nodes_content.restore_snapshot, {
			membershipId: db.membershipId,
			nodeId: seeded.nodeId,
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

		const superseded = await t.run(async (ctx) => {
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

			return { assetId: asset._id, key: asset.r2Key, throughSequence: snapshot.sequence };
		});

		const finiteDeleteSpy = vi.spyOn(R2.prototype, "deleteObject");
		const confirmedDeleteSpy = vi
			.spyOn(r2_confirmed_object_delete, "delete_object")
			.mockRejectedValueOnce(new Error("simulated R2 outage"));

		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_covered_rows, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: createdId,
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
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId: seeded.nodeId,
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
		expect(refused._nay?.name).toBe("read_only");
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
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { contentShapeMismatchAt: Date.now() });
		});

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
