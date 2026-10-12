// The tests from the upload plan gate on, most of them read-only and write policy tests, are in
// files_nodes.read_only.test.ts, so the two files can run at the same time.
import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { RateLimiter } from "@convex-dev/rate-limiter";
import type { FunctionReturnType } from "convex/server";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi, type MockInstance } from "vitest";
import { api, internal } from "./_generated/api.js";
import { files_line_range_from_text, files_tail_lines_from_text } from "./files_nodes.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	test_convex,
	test_rename_node,
	test_db_hold_move_slot,
	test_mocks,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_MAX_UPLOADS_BYTES, files_ROOT_ID, files_UPLOAD_PATH_TAKEN_MESSAGE } from "../server/files.ts";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import {
	files_IMPORT_MAX_ITEMS_PER_CALL,
	files_NAME_MAX_LENGTH,
	files_NEW_FOLDER_DEPTH_MAX,
	files_PATH_MAX_LENGTH,
	files_REQUEST_FOLDER_PREFIXES_MAX,
} from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { insert_tree_node, seed_tree_access_fixture, seed_folder_table } from "./files_nodes.setup.test.ts";

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

test("rename_node refuses a new parent folder name over the limit and keeps the old name", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.nested_files(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId, name: "Rename User" });
	const accepted = await test_rename_node(t, asUser, {
		membershipId: db.membershipId,
		nodeId: db.files.file_root_1._id,
		path: `${"n".repeat(files_NAME_MAX_LENGTH + 1)}/renamed`,
	});
	if (!accepted._yay) throw new Error("Rename was not accepted", { cause: accepted._nay });
	expect(await t.run((ctx) => ctx.db.get("activities", accepted._yay!.activityId))).toMatchObject({
		status: "failed",
	});
	const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
	expect(
		nodes.filter((node) => node.name.length > files_NAME_MAX_LENGTH),
		"no folder with a name over the limit",
	).toEqual([]);
	expect(nodes.find((node) => node._id === db.files.file_root_1._id)?.path).toBe(db.files.file_root_1.path);
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

// The move nodes tests are in files_nodes.move_nodes.test.ts.

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

// A root node with a name saved before the length limit existed.
function insert_old_root_node(
	ctx: MutationCtx,
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
	name: string,
	kind: "file" | "folder",
) {
	return ctx.db.insert("files_nodes", {
		...test_mocks.files.base(),
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		createdBy: db.userId,
		updatedBy: db.userId,
		parentId: files_ROOT_ID,
		name,
		sortName: files_sort_text_key(name),
		kind,
		path: `/${name}`,
		treePath: kind === "folder" ? `/${name}/` : `/${name}`,
		pathDepth: 1,
	});
}

describe("files_nodes.create_upload_node", () => {
	test("old names over the limit stay usable: replace a long-named file and upload into a long-named folder", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folderName = "f".repeat(files_NAME_MAX_LENGTH + 1);
		const fileName = `${"n".repeat(files_NAME_MAX_LENGTH)}.pdf`;
		const oldFileId = await t.run(async (ctx) => {
			await insert_old_root_node(ctx, db, folderName, "folder");
			return await insert_old_root_node(ctx, db, fileName, "file");
		});
		const upload = (filename: string) =>
			asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename,
				contentType: "application/pdf",
				size: 10,
			});

		expect((await upload(fileName))._nay, "replace of an old long-named file").toBeUndefined();
		expect((await upload(`${folderName}/new.pdf`))._nay, "upload into an old long-named folder").toBeUndefined();
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(
			nodes
				.filter((node) => node.archiveOperationId === null)
				.map((node) => node.path)
				.sort(),
		).toEqual([`/${fileName}`, `/${folderName}`, `/${folderName}/new.pdf`].sort());
		expect(nodes.find((node) => node._id === oldFileId)?.archiveOperationId, "the old file is replaced").not.toBeNull();
	});

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

/**
 * Real read limits. A member who may write only in the restricted folder `/l`, a chain of folders
 * named `a` below it, `depth` levels deep with `/l`, and optionally a Move that holds the workspace
 * slot and the folder `/moving`, so every write guard runs.
 */
async function seed_upload_folder_limits(args: { depth: number; move: boolean }) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const member = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "upload-folder-limits-member" });
		const now = Date.now();
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: now,
		});
		await access_control_db_ensure_role_assignment(ctx, { ...db, userId, role: "member", now });
		await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
		return { userId, membershipId };
	});
	const folder = async (path: string) => {
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const lockedId = await folder("/l");
	expect(
		(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: lockedId }))._nay,
	).toBeUndefined();
	expect(
		(
			await asOwner.mutation(api.files_sharing.set_node_share_grant, {
				membershipId: db.membershipId,
				nodeId: lockedId,
				principal: { kind: "user", userId: member.userId },
				level: "write",
			})
		)._nay,
	).toBeUndefined();
	// Raw inserts in pages, so seeding a deep chain stays under the limits too.
	let deepId = lockedId;
	let deepPath = "/l";
	for (let start = 2; start <= args.depth; start += 200) {
		({ deepId, deepPath } = await t.run(async (ctx) => {
			let parentId = deepId;
			let path = deepPath;
			for (let pathDepth = start; pathDepth < start + 200 && pathDepth <= args.depth; pathDepth++) {
				path = `${path}/a`;
				parentId = await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					updatedBy: db.userId,
					parentId,
					name: "a",
					sortName: files_sort_text_key("a"),
					kind: "folder",
					path,
					treePath: `${path}/`,
					pathDepth,
					restrictedScopeNodeId: lockedId,
				});
			}
			return { deepId: parentId, deepPath: path };
		}));
	}
	if (args.move) {
		const movingId = await folder("/moving");
		await t.run(async (ctx) => {
			await ctx.db.insert("files_move_source_reservations", {
				cohortId: await test_db_hold_move_slot(ctx, db),
				source: { kind: "saved", id: movingId },
				mode: "subtree",
				userId: null,
				generation: 1,
			});
		});
	}
	const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
	return { t, asMember, membershipId: member.membershipId, lockedId, deepId };
}

describe("files_nodes.create_upload_nodes", () => {
	// The deepest folder whose path still fits the short names "/0" to "/49".
	const deepestFolder = Math.floor((files_PATH_MAX_LENGTH - "/49".length) / 2);
	const chain = (head: string, folders: number) => [head, ...Array<string>(folders - 1).fill("a")].join("/");

	test.each([false, true])("fits 50 files into a restricted folder 510 levels deep (Move: %s)", async (move) => {
		const f = await seed_upload_folder_limits({ depth: deepestFolder, move });
		const result = await f.asMember.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: f.membershipId,
			parentId: f.deepId,
			onConflict: "skip",
			items: Array.from({ length: files_IMPORT_MAX_ITEMS_PER_CALL }, (_, i) => ({
				relativePath: `${i}`,
				contentType: "application/octet-stream",
				size: 1,
			})),
		});
		expect(result._yay?.created, "every file in the deep folder").toHaveLength(files_IMPORT_MAX_ITEMS_PER_CALL);
	});

	test.each([false, true])("fits 50 files into new chains that use every folder slot (Move: %s)", async (move) => {
		const f = await seed_upload_folder_limits({ depth: 1, move });
		// Two new chains of the most new folders a path may add name every folder a call may name.
		const chains = [chain("p", files_NEW_FOLDER_DEPTH_MAX), chain("q", files_NEW_FOLDER_DEPTH_MAX)];
		expect(chains.length * files_NEW_FOLDER_DEPTH_MAX).toBe(files_REQUEST_FOLDER_PREFIXES_MAX);
		const result = await f.asMember.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: f.membershipId,
			parentId: f.lockedId,
			onConflict: "skip",
			items: Array.from({ length: files_IMPORT_MAX_ITEMS_PER_CALL }, (_, i) => ({
				relativePath: `${chains[i % 2]}/${i}.bin`,
				size: 1,
			})),
		});
		expect(result._yay?.created, "every file in the new chains").toHaveLength(files_IMPORT_MAX_ITEMS_PER_CALL);
	});

	test("fits 50 files into an existing chain that uses every folder slot during a Move", async () => {
		const f = await seed_upload_folder_limits({ depth: files_REQUEST_FOLDER_PREFIXES_MAX + 1, move: true });
		const result = await f.asMember.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: f.membershipId,
			parentId: f.lockedId,
			onConflict: "skip",
			items: Array.from({ length: files_IMPORT_MAX_ITEMS_PER_CALL }, (_, i) => ({
				relativePath: `${chain("a", files_REQUEST_FOLDER_PREFIXES_MAX)}/${i}.bin`,
				size: 1,
			})),
		});
		expect(result._yay?.created, "every file at the end of the existing chain").toHaveLength(
			files_IMPORT_MAX_ITEMS_PER_CALL,
		);
	});

	test("refuses a call with too many folders before any write, during a Move", async () => {
		const f = await seed_upload_folder_limits({ depth: 1, move: true });
		const count = () =>
			f.t.run(async (ctx) => ({
				nodes: (await ctx.db.query("files_nodes").collect()).length,
				assets: (await ctx.db.query("files_r2_assets").collect()).length,
			}));
		const before = await count();
		const upload = (relativePaths: string[]) =>
			f.asMember.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: f.membershipId,
				parentId: f.lockedId,
				onConflict: "skip",
				items: relativePaths.map((relativePath) => ({ relativePath, size: 1 })),
			});
		// Each file in its own new chain of the most new folders a path may add.
		const ownChains = await upload(
			Array.from(
				{ length: files_IMPORT_MAX_ITEMS_PER_CALL },
				(_, i) => `${chain(`c${i}`, files_NEW_FOLDER_DEPTH_MAX)}/f.bin`,
			),
		);
		expect(ownChains._nay, "50 new chains").toMatchObject({ name: "too_many_folders" });
		const tooDeepPath = `${chain("d", files_NEW_FOLDER_DEPTH_MAX + 1)}/f.bin`;
		const tooDeep = await upload([tooDeepPath]);
		expect(tooDeep._nay, "one path with one new folder too many").toMatchObject({
			name: "too_many_folders",
			data: { path: tooDeepPath },
		});
		expect(await count()).toEqual(before);
	});

	test("old names over the limit stay usable: replace a long-named file and upload into a long-named folder", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const folderName = "f".repeat(files_NAME_MAX_LENGTH + 1);
		const fileName = `${"n".repeat(files_NAME_MAX_LENGTH)}.bin`;
		const oldFileId = await t.run(async (ctx) => {
			await insert_old_root_node(ctx, db, folderName, "folder");
			return await insert_old_root_node(ctx, db, fileName, "file");
		});

		const result = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [
				{ relativePath: fileName, size: 5 },
				{ relativePath: `${folderName}/new.bin`, size: 6 },
			],
		});
		expect(result._nay, "upload batch under old long names").toBeUndefined();
		const nodes = await t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(
			nodes
				.filter((node) => node.archiveOperationId === null)
				.map((node) => node.path)
				.sort(),
		).toEqual([`/${fileName}`, `/${folderName}`, `/${folderName}/new.bin`].sort());
		expect(nodes.find((node) => node._id === oldFileId)?.archiveOperationId, "the old file is replaced").not.toBeNull();
	});

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
		expect(result._yay).toEqual({
			created: [],
			skipped: [
				{ relativePath: "keep.bin", reason: "storage_full" },
				{ relativePath: "new.bin", reason: "storage_full" },
			],
			freeBytes: 0,
		});
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

	test("keeps a conflict skip when no other file fits the storage left", async () => {
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
				{ relativePath: "keep.bin", size: 1 },
				{ relativePath: "new.bin", size: 6 },
			],
		});
		// The client counts the conflict as a file the user chose to skip, so it must reach the client.
		expect(result._yay, "the conflict skip is kept").toEqual({
			created: [],
			skipped: [
				{ relativePath: "keep.bin", reason: "conflict" },
				{ relativePath: "new.bin", reason: "storage_full" },
			],
			freeBytes: 5,
		});
	});

	test("creates the files that fit the storage left and skips the others", async () => {
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
			const quota = await ctx.db.get("quotas", quotaId);
			await ctx.db.patch("quotas", quotaId, { usedCount: quota!.maxCount - 100 });
		});
		const result = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [
				{ relativePath: "keep.bin", size: 200 },
				{ relativePath: "a.bin", size: 50 },
				{ relativePath: "b.bin", size: 40 },
			],
		});
		expect(result._yay?.created.map((item) => item.relativePath)).toEqual(["a.bin", "b.bin"]);
		expect(result._yay?.skipped).toEqual([{ relativePath: "keep.bin", reason: "storage_full" }]);
		expect(result._yay?.freeBytes, "free bytes left after a.bin and b.bin").toBe(10);
		const kept = await t.run((ctx) => ctx.db.get("files_nodes", original._yay.nodeId));
		expect(kept?.archiveOperationId, "the skipped replace keeps the old file").toBeNull();

		// Admission reserves nothing, so 100 bytes are still free. When no file fits, the call still answers.
		const noneFit = await asUser.mutation(api.files_nodes.create_upload_nodes, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			onConflict: "replace",
			items: [{ relativePath: "c.bin", size: 200 }],
		});
		expect(noneFit._yay).toEqual({
			created: [],
			skipped: [{ relativePath: "c.bin", reason: "storage_full" }],
			freeBytes: 100,
		});
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
