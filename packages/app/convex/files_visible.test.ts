import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with, test_run_with_flush } from "./setup.test.ts";
import { files_visible_db_create_reader, type files_visible_internal_list_Result } from "./files_visible.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import type { files_PendingParent } from "../shared/files.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, asUser };
}

async function create_private(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	path: string;
	kind?: "file" | "folder";
	threadId?: Id<"ai_chat_threads">;
	userId?: Id<"users">;
}) {
	const { f, kind = "folder", threadId, path, userId = f.db.userId } = args;

	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId,
		path,
		kind,
		...(threadId ? { threadId } : {}),
	});
	if (created._nay) throw new Error(created._nay.message);
	return created._yay;
}

async function create_saved(f: Awaited<ReturnType<typeof fixture>>, path: string) {
	const created = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	return { kind: "saved" as const, id: created._yay.nodeId };
}

/**
 * A member of the fixture's workspace, with the workspace role `admin` and the organization role
 * `member`, like the admin of the tree access fixture in `files_nodes.test.ts`.
 */
async function add_member(f: Awaited<ReturnType<typeof fixture>>) {
	const member = await f.t.run(async (ctx) => {
		const now = Date.now();
		const organization = await ctx.db.get("organizations", f.db.organizationId);
		if (!organization?.defaultWorkspaceId) throw new Error("Expected the organization default workspace");
		const userId = await ctx.db.insert("users", { clerkUserId: null });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			active: true,
			updatedAt: now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			role: "admin",
			now,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: organization.defaultWorkspaceId,
			userId,
			role: "member",
			now,
		});
		await ctx.db.insert("organizations_membership_lifetimes", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			membershipId,
			lifetime: 2,
			active: true,
		});
		return { userId, membershipId };
	});
	return { ...member, as: f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }) };
}

async function create_thread(f: Awaited<ReturnType<typeof fixture>>, clientGeneratedId: string) {
	const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
		membershipId: f.db.membershipId,
		clientGeneratedId,
		title: clientGeneratedId,
		lastMessageAt: undefined,
	});
	if (thread._nay) throw new Error(thread._nay.message);
	return thread._yay.threadId;
}

async function move_draft(args: {
	f: Awaited<ReturnType<typeof fixture>>;
	userId: Id<"users">;
	target: { kind: "saved"; id: Id<"files_nodes"> };
	destParent: files_PendingParent;
	destName: string;
}) {
	const moved = await args.f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		organizationId: args.f.db.organizationId,
		workspaceId: args.f.db.workspaceId,
		userId: args.userId,
		target: args.target,
		destParent: args.destParent,
		destName: args.destName,
	});
	if (moved._nay) throw new Error(moved._nay.message);
}

describe("internal_list", () => {
	test("complete traversal refuses a hidden child on a later page while ordinary lists stay filtered", async () => {
		const owner = await fixture();
		const { t, db } = owner;
		const other = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		expect(
			await owner.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userIdToAdd: other.userId,
			}),
		).toEqual({ _yay: null });
		await create_saved(owner, "source/first");
		const hidden = await create_saved(owner, "source/secret-name");
		expect(
			await owner.asUser.mutation(api.files_sharing.restrict_node, {
				membershipId: db.membershipId,
				nodeId: hidden.id,
			}),
		).toEqual({ _yay: null });
		const args = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			visibilityUserId: other.userId,
			overlayUserId: other.userId,
			folderPath: "/source",
			mode: "children" as const,
			numItems: 1,
			cursor: null,
			requireComplete: true,
		};
		const first = await t.query(internal.files_visible.internal_list, args);
		if (first._nay) throw new Error(first._nay.message);
		expect(first._yay.items.map((item) => item.path)).toEqual(["/source/first"]);
		expect(first._yay.isDone).toBe(false);
		const second = await t.query(internal.files_visible.internal_list, { ...args, cursor: first._yay.continueCursor });
		expect(second).toEqual({ _nay: { message: "Permission denied" } });
		expect(JSON.stringify(second)).not.toContain("secret-name");
		const filtered = await t.query(internal.files_visible.internal_list, {
			...args,
			requireComplete: false,
			numItems: 10,
		});
		expect(filtered._yay?.items.map((item) => item.path)).toEqual(["/source/first"]);
		expect(filtered._yay?.isDone).toBe(true);
		const readable = await t.query(internal.files_visible.internal_list, {
			...args,
			visibilityUserId: db.userId,
			overlayUserId: db.userId,
			numItems: 10,
		});
		expect(readable._yay?.items.map((item) => item.path)).toEqual(["/source/first", "/source/secret-name"]);
		expect(readable._yay?.isDone).toBe(true);
	});

	test("complete traversal keeps the owner's overlay and ignores another user's private drafts", async () => {
		const f = await fixture();
		const source = await create_saved(f, "source");
		const movedOut = await create_saved(f, "source/out");
		const removed = await create_saved(f, "source/removed");
		const movedIn = await create_saved(f, "outside");
		await create_private({ f, path: "/source/mine" });
		for (const [target, destParent, destName] of [
			[movedOut, { kind: "root" as const }, "out"],
			[movedIn, source, "in"],
		] as const) {
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						userId: f.db.userId,
						target,
						destParent,
						destName,
					})
				)._nay,
			).toBeUndefined();
		}
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					target: removed,
				})
			)._nay,
		).toBeUndefined();
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: other.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			(
				await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: other.userId,
					path: "/source/foreign-private",
					kind: "folder",
				})
			)._nay,
		).toBeUndefined();
		const result = await f.t.query(internal.files_visible.internal_list, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			overlayUserId: f.db.userId,
			folderPath: "/source",
			mode: "children",
			numItems: 10,
			cursor: null,
			requireComplete: true,
		});
		expect(result._yay?.items.map((item) => item.path)).toEqual(["/source/in", "/source/mine"]);
		expect(result._yay?.isDone).toBe(true);
		expect(JSON.stringify(result)).not.toContain("foreign-private");
	});

	test("lists the user's draft move to the root under its new name, but not one from another workspace", async () => {
		const f = await fixture();
		await create_saved(f, "source");
		const moved = await create_saved(f, "source/old-name");
		await move_draft({ f, userId: f.db.userId, target: moved, destParent: { kind: "root" }, destName: "new-name" });

		// The same user also owns the organization's default workspace. A root move there must stay there.
		const otherDb = await f.t.run(async (ctx) => {
			const organization = await ctx.db.get("organizations", f.db.organizationId);
			if (!organization?.defaultWorkspaceId) throw new Error("Expected the organization default workspace");
			const workspaceId = organization.defaultWorkspaceId;
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", workspaceId).eq("userId", f.db.userId))
				.first();
			if (!membership) throw new Error("Expected a membership in the default workspace");
			return { ...f.db, workspaceId, membershipId: membership._id };
		});
		const other = { ...f, db: otherDb };
		await create_saved(other, "elsewhere");
		const otherMoved = await create_saved(other, "elsewhere/other-old");
		await move_draft({
			f: other,
			userId: f.db.userId,
			target: otherMoved,
			destParent: { kind: "root" },
			destName: "other-new",
		});

		const result = await f.t.query(internal.files_visible.internal_list, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			overlayUserId: f.db.userId,
			folderPath: "/",
			mode: "children",
			numItems: 10,
			cursor: null,
		});
		expect(result._yay?.items.map((item) => item.path)).toEqual(["/new-name", "/source"]);
		expect(result._yay?.isDone).toBe(true);
	});

	test("continues after empty filtered pages without losing later matches", async () => {
		const f = await fixture();
		for (let index = 0; index < 110; index++) {
			vi.setSystemTime(Date.now() + 2_000);
			await create_saved(f, `folder-${String(index).padStart(3, "0")}`);
		}
		const last = await create_private({ f, path: "/zzz-match" });
		let cursor: string | null = null;
		const paths: string[] = [];
		let done = false;
		let emptyPages = 0;
		for (let page = 0; page < 20 && !done; page++) {
			const result: files_visible_internal_list_Result = await f.t.query(internal.files_visible.internal_list, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				visibilityUserId: f.db.userId,
				overlayUserId: f.db.userId,
				folderPath: "/",
				mode: "children",
				numItems: 50,
				cursor,
				pathQuery: "zzz",
			});
			if (result._nay) throw new Error(result._nay.message);
			if (result._yay.items.length === 0 && !result._yay.isDone) emptyPages++;
			paths.push(...result._yay.items.map((item) => item.path));
			cursor = result._yay.continueCursor;
			done = result._yay.isDone;
		}
		expect(done).toBe(true);
		expect(emptyPages).toBeGreaterThan(0);
		expect(paths).toEqual(["/zzz-match"]);
		expect(
			await f.asUser.query(api.files_visible.get_path, { membershipId: f.db.membershipId, target: last.target }),
		).toBe("/zzz-match");
	});

	test("rejects a cursor from a different folder", async () => {
		const f = await fixture();
		await create_private({ f, path: "/a/first" });
		await create_private({ f, path: "/b/second" });
		const scope = {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			visibilityUserId: f.db.userId,
			overlayUserId: f.db.userId,
		};
		const first = await f.t.query(internal.files_visible.internal_list, {
			...scope,
			folderPath: "/",
			mode: "children",
			numItems: 1,
			cursor: null,
		});
		if (first._nay) throw new Error(first._nay.message);
		const other = await f.t.query(internal.files_visible.internal_list, {
			...scope,
			folderPath: "/a",
			mode: "children",
			numItems: 1,
			cursor: first._yay.continueCursor,
		});
		expect(other._nay?.message).toBe(
			"cursor does not match this listing; rerun the original command to get a fresh Next page cursor.",
		);
	});
});

describe("list_private_folder_children", () => {
	const REFUSED = { page: [], isDone: true, continueCursor: "" };

	function private_id(target: { kind: "private" | "saved"; id: string }) {
		if (target.kind !== "private") throw new Error("Expected a private target");
		return target.id as Id<"files_pending_nodes">;
	}

	async function list_pages(args: {
		as: Awaited<ReturnType<typeof fixture>>["asUser"];
		membershipId: Id<"organizations_workspaces_users">;
		folderId: Id<"files_pending_nodes">;
	}) {
		const pages: FunctionReturnType<typeof api.files_visible.list_private_folder_children>[] = [];
		let cursor: string | null = null;
		do {
			const page: FunctionReturnType<typeof api.files_visible.list_private_folder_children> = await args.as.query(
				api.files_visible.list_private_folder_children,
				{ membershipId: args.membershipId, folderId: args.folderId, paginationOpts: { numItems: 50, cursor } },
			);
			pages.push(page);
			cursor = page.isDone ? null : page.continueCursor;
		} while (cursor !== null && pages.length < 20);
		return pages;
	}

	test("pages drafts and moved-in saved nodes in name order, with folders mixed in", async () => {
		const f = await fixture();
		const box = private_id((await create_private({ f, path: "/box" })).target);
		const names: string[] = [];
		for (let index = 0; index < 120; index++) {
			const name = `item-${String(index).padStart(3, "0")}`;
			// Every third child is a folder, so folders and files mix in name order.
			await create_private({ f, path: `/box/${name}`, kind: index % 3 === 0 ? "folder" : "file" });
			names.push(name);
		}
		for (const [index, destName] of ["item-010b", "item-055b", "zz-moved"].entries()) {
			const saved = await create_saved(f, `source-${index}`);
			await move_draft({ f, userId: f.db.userId, target: saved, destParent: { kind: "private", id: box }, destName });
			names.push(destName);
		}

		const pages = await list_pages({ as: f.asUser, membershipId: f.db.membershipId, folderId: box });
		expect(pages.map((page) => page.page.length)).toEqual([50, 50, 23]);
		const rows = pages.flatMap((page) => page.page);
		expect(rows.map((row) => row.name)).toEqual(names.toSorted());
		expect(rows.find((row) => row.name === "item-003")).toMatchObject({ kind: "folder", preparing: false });
		// A text file created with no content yet is still preparing.
		expect(rows.find((row) => row.name === "item-004")).toMatchObject({ kind: "file", preparing: true });
		expect(rows.find((row) => row.name === "zz-moved")).toMatchObject({
			target: { kind: "saved" },
			kind: "folder",
			preparing: false,
		});
	});

	test("another user's folder and a discarded folder give an empty, done page", async () => {
		const f = await fixture();
		const kept = private_id((await create_private({ f, path: "/kept" })).target);
		await create_private({ f, path: "/kept/child.md", kind: "file" });
		const gone = await create_private({ f, path: "/gone" });
		if (!gone.pendingUpdateId) throw new Error("Expected the folder proposal");
		expect(
			(
				await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: f.db.membershipId,
					target: gone.target,
					pendingUpdateId: gone.pendingUpdateId,
					reviewedRevision: 1,
				})
			)._nay,
		).toBeUndefined();
		const member = await add_member(f);
		await create_private({ f, path: "/kept", userId: member.userId });

		const read = (as: typeof f.asUser, membershipId: typeof f.db.membershipId, folderId: Id<"files_pending_nodes">) =>
			as.query(api.files_visible.list_private_folder_children, {
				membershipId,
				folderId,
				paginationOpts: { numItems: 50, cursor: null },
			});
		expect(await read(member.as, member.membershipId, kept)).toEqual(REFUSED);
		expect(await read(f.asUser, f.db.membershipId, private_id(gone.target))).toEqual(REFUSED);
		// The owner still reads the kept folder, so the answers above are refusals, not an empty folder.
		expect((await read(f.asUser, f.db.membershipId, kept)).page.map((row) => row.name)).toEqual(["child.md"]);
	});

	test("leaves out a moved-in saved node once the user cannot read it", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const folder = private_id((await create_private({ f, path: "/mine", userId: member.userId })).target);
		await create_private({ f, path: "/mine/draft", userId: member.userId });
		const saved = await create_saved(f, "plans");
		await move_draft({
			f,
			userId: member.userId,
			target: saved,
			destParent: { kind: "private", id: folder },
			destName: "moved",
		});

		const names = async () =>
			(await list_pages({ as: member.as, membershipId: member.membershipId, folderId: folder }))
				.flatMap((page) => page.page)
				.map((row) => row.name);
		expect(await names()).toEqual(["draft", "moved"]);

		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: saved.id }),
		).toEqual({ _yay: null });
		expect(await names()).toEqual(["draft"]);
	});

	test("leaves out a draft child once the user cannot read its saved ancestor", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const plans = await create_saved(f, "plans");
		const box = private_id((await create_private({ f, path: "/plans/box", userId: member.userId })).target);
		await create_private({ f, path: "/plans/box/note.md", kind: "file", userId: member.userId });

		const names = async () =>
			(await list_pages({ as: member.as, membershipId: member.membershipId, folderId: box }))
				.flatMap((page) => page.page)
				.map((row) => row.name);
		expect(await names()).toEqual(["note.md"]);

		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: plans.id }),
		).toEqual({ _yay: null });
		expect(await names()).toEqual([]);
	});

	test("leaves out a moved-in saved node that is archived before the overlay jobs run", async () => {
		const f = await fixture();
		const box = private_id((await create_private({ f, path: "/box" })).target);
		const saved = await create_saved(f, "plans");
		await move_draft({ f, userId: f.db.userId, target: saved, destParent: { kind: "private", id: box }, destName: "moved" });
		const names = async () =>
			(await list_pages({ as: f.asUser, membershipId: f.db.membershipId, folderId: box }))
				.flatMap((page) => page.page)
				.map((row) => row.name);
		expect(await names()).toEqual(["moved"]);

		// A raw write skips the flush, so the place still says visible, like the window before the jobs run.
		await f.t.run((ctx) => ctx.db.patch("files_nodes", saved.id, { archiveOperationId: "archive-1" }));
		expect(await names()).toEqual([]);
	});

	// Guard = floor(3,000 index ranges / index ranges read by the worst row). The worst row is a saved
	// node moved into the folder that is its own restricted scope, so each row runs a fresh access
	// check. The member reads it through their second role and also has an old plugin grant on it: the
	// check reads that grant, then the live membership lifetime, then the roles.
	test("the page guard fits the measured reads of the worst row", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const folder = private_id((await create_private({ f, path: "/mine", userId: member.userId })).target);
		for (let index = 0; index < 6; index++) {
			const saved = await create_saved(f, `restricted-${index}`);
			expect(
				await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: saved.id }),
			).toEqual({ _yay: null });
			await f.t.run(async (ctx) => {
				const now = Date.now();
				// The member's draft move needs write access too.
				for (const [principal, permission] of [
					[{ principalKind: "role" as const, role: "member" as const }, "content.read"],
					[{ principalKind: "role" as const, role: "member" as const }, "content.write"],
					[
						{ principalKind: "user" as const, userId: member.userId, externalPluginMembershipLifetime: 1 },
						"content.read",
					],
				] as const) {
					await ctx.db.insert("access_control_permission_grants", {
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						resourceKind: "file",
						resourceId: String(saved.id),
						...principal,
						permission,
						createdAt: now,
						updatedAt: now,
					});
				}
			});
			await move_draft({
				f,
				userId: member.userId,
				target: saved,
				destParent: { kind: "private", id: folder },
				destName: `a-${index}`,
			});
		}

		const read_cost = (numItems: number) =>
			member.as.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				const result = await ctx.runQuery(api.files_visible.list_private_folder_children, {
					membershipId: member.membershipId,
					folderId: folder,
					paginationOpts: { numItems, cursor: null },
				});
				const after = await ctx.meta.getTransactionMetrics();
				return { rows: result.page.length, ranges: after.databaseQueries.used - before.databaseQueries.used };
			});

		// The page cost minus the cost of a one-row page is what the other rows read.
		const one = await read_cost(1);
		const six = await read_cost(6);
		expect([one.rows, six.rows]).toEqual([1, 6]);
		const perRow = (six.ranges - one.ranges) / 5;
		expect(perRow).toBeGreaterThan(0);
		expect(250).toBeLessThanOrEqual(Math.floor(3000 / perRow));
	});

	// convex-test gives a split cursor to a page that reads more than `numItems` + 1 rows. A page pinned
	// by an end cursor reads every row up to that cursor, like a reactive rerun after many creates.
	test("a page whose end cursor holds more than 250 rows asks for a split", async () => {
		const f = await fixture();
		const box = private_id((await create_private({ f, path: "/box" })).target);
		for (let index = 0; index < 260; index++) {
			await create_private({ f, path: `/box/n-${String(index).padStart(3, "0")}.md`, kind: "file" });
		}
		const read = (paginationOpts: { numItems: number; cursor: string | null; endCursor?: string }) =>
			f.asUser.query(api.files_visible.list_private_folder_children, {
				membershipId: f.db.membershipId,
				folderId: box,
				paginationOpts,
			});

		const first = await read({ numItems: 200, cursor: null });
		const endCursor = (await read({ numItems: 55, cursor: first.continueCursor })).continueCursor;
		expect(await read({ numItems: 200, cursor: null, endCursor })).toEqual({
			page: [],
			isDone: false,
			continueCursor: endCursor,
			splitCursor: expect.any(String),
			pageStatus: "SplitRequired",
		});
		// A pinned page under the guard gives its rows.
		expect((await read({ numItems: 250, cursor: null, endCursor: first.continueCursor })).page).toHaveLength(200);
	});
});

describe("has_drafts_in_folder", () => {
	test("says whether the caller's drafts add, move or remove items in a saved folder", async () => {
		const f = await fixture();
		const has_drafts = (folderId: Id<"files_nodes"> | "root", as = f.asUser, membershipId = f.db.membershipId) =>
			as.query(api.files_nodes.has_drafts_in_folder, { membershipId, folderId });
		const archive_draft = async (target: { kind: "saved"; id: Id<"files_nodes"> }) => {
			const archived = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				target,
			});
			if (archived._nay) throw new Error(archived._nay.message);
		};

		const created = await create_saved(f, "created");
		await create_private({ f, path: "/created/draft.md", kind: "file" });
		const movedIn = await create_saved(f, "moved-in");
		await move_draft({
			f,
			userId: f.db.userId,
			target: await create_saved(f, "source/outside"),
			destParent: movedIn,
			destName: "in",
		});
		const movedOut = await create_saved(f, "moved-out");
		await move_draft({
			f,
			userId: f.db.userId,
			target: await create_saved(f, "moved-out/child"),
			destParent: created,
			destName: "child",
		});
		const deleted = await create_saved(f, "deleted");
		await archive_draft(await create_saved(f, "deleted/child"));

		// A draft with no move and no delete, like a draft that only changes content, makes no place and
		// no hide. The real content flow needs R2, so the draft is written directly and the flush runs on it.
		const edited = await create_saved(f, "edited");
		const editedChild = await create_saved(f, "edited/child");
		await test_run_with_flush(f.t, async (ctx) => {
			const now = Date.now();
			await ctx.db.insert("files_pending_updates", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				target: editedChild,
				revision: 1,
				size: 0,
				updatedAt: now,
				expiresAt: now + 4 * 60 * 60 * 1000,
			});
		});

		const empty = await create_saved(f, "empty");
		for (const [folder, expected] of [
			[created.id, true],
			[movedIn.id, true],
			[movedOut.id, true],
			[deleted.id, true],
			[edited.id, false],
			[empty.id, false],
			["root", false],
		] as const) {
			expect([folder, await has_drafts(folder)]).toEqual([folder, expected]);
		}

		// The root works like any folder.
		await create_private({ f, path: "/root-draft.md", kind: "file" });
		expect(await has_drafts("root")).toBe(true);

		// A member who cannot read the folder gets false, even with a draft there.
		const member = await add_member(f);
		await create_private({ f, path: "/created/member-draft.md", kind: "file", userId: member.userId });
		expect(await has_drafts(created.id, member.as, member.membershipId)).toBe(true);
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: created.id }),
		).toEqual({ _yay: null });
		expect(await has_drafts(created.id, member.as, member.membershipId)).toBe(false);
	});
});

describe("files_visible_db_create_reader", () => {
	test("resolves preparing files by owner path without exposing a saved placeholder", async () => {
		const f = await fixture();
		const created = await create_private({ f, path: "/draft/new.txt", kind: "file" });
		const read = await f.t.run(async (ctx) => {
			const reader = await files_visible_db_create_reader(ctx, f.db);
			return {
				byTarget: await reader.resolveTarget(created.target),
				byPath: await reader.resolvePath("/draft/new.txt"),
				exhausted: reader.exhausted,
			};
		});
		expect(read.byTarget).toEqual(read.byPath);
		expect(read.byTarget).toMatchObject({ kind: "private", path: "/draft/new.txt" });
		expect(read.exhausted).toBe(false);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test("hides a private target from another owner and from an inactive member", async () => {
		const f = await fixture();
		const created = await create_private({ f, path: "/draft" });
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
		expect(
			await f.t.run(async (ctx) =>
				(await files_visible_db_create_reader(ctx, { ...f.db, userId: other.userId })).resolveTarget(created.target),
			),
		).toBeNull();
		await f.t.run((ctx) => ctx.db.patch("organizations_workspaces_users", f.db.membershipId, { active: false }));
		expect(
			await f.t.run(async (ctx) => (await files_visible_db_create_reader(ctx, f.db)).resolveTarget(created.target)),
		).toBeNull();
	});
});

describe("list_files_pending_updates", () => {
	function list(
		f: Awaited<ReturnType<typeof fixture>>,
		listKey: string,
		paginationOpts: { numItems: number; cursor: string | null; endCursor?: string },
	) {
		return f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId: f.db.membershipId,
			listKey,
			paginationOpts,
		});
	}

	// Each row's path comes from its own view query, like the Pending tab loads it.
	async function list_paths(f: Awaited<ReturnType<typeof fixture>>, listKey: string) {
		const paths: string[] = [];
		let cursor: string | null = null;
		do {
			const page: FunctionReturnType<typeof api.files_pending_updates.list_files_pending_updates> = await list(
				f,
				listKey,
				{ numItems: 20, cursor },
			);
			for (const row of page.page) {
				const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
					membershipId: f.db.membershipId,
					target: row.target,
				});
				paths.push(view?.entry.path ?? "restricted");
			}
			cursor = page.isDone ? null : page.continueCursor;
		} while (cursor !== null);
		return paths;
	}

	function summary(f: Awaited<ReturnType<typeof fixture>>, listKey?: string) {
		return f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
			membershipId: f.db.membershipId,
			...(listKey ? { listKey } : {}),
		});
	}

	// Copies of one proposal's "all" list row. The list and the summary read only these rows first.
	async function add_list_rows(f: Awaited<ReturnType<typeof fixture>>, count: number) {
		await f.t.run(async (ctx) => {
			const row = await ctx.db
				.query("files_pending_list_rows")
				.withIndex("by_user", (q) => q.eq("userId", f.db.userId))
				.filter((q) => q.eq(q.field("listKey"), "all"))
				.first();
			if (!row) throw new Error("Expected a list row");
			const { _id, _creationTime, ...fields } = row;
			for (let index = 0; index < count; index++) {
				await ctx.db.insert("files_pending_list_rows", { ...fields, updatedAt: index });
			}
		});
	}

	test("lists the newest change first, at most 5 rows per page", async () => {
		const f = await fixture();
		for (let index = 0; index < 7; index++) {
			await create_private({ f, path: `/review-${index}.md`, kind: "file" });
			vi.advanceTimersByTime(1000);
		}

		const first = await list(f, "all", { numItems: 20, cursor: null });
		expect(first.page).toHaveLength(5);
		expect(first.isDone).toBe(false);
		expect(await list_paths(f, "all")).toEqual([6, 5, 4, 3, 2, 1, 0].map((index) => `/review-${index}.md`));
	});

	test("lists one source by list key, and a bad key gives an empty done page", async () => {
		const f = await fixture();
		const chat = await create_thread(f, "pending-chat");
		await create_private({ f, path: "/own.md", kind: "file" });
		vi.advanceTimersByTime(1000);
		await create_private({ f, path: "/chat.md", kind: "file", threadId: chat });

		expect(await list_paths(f, "all")).toEqual(["/chat.md", "/own.md"]);
		expect(await list_paths(f, "own")).toEqual(["/own.md"]);
		expect(await list_paths(f, chat)).toEqual(["/chat.md"]);
		expect(await list(f, "not-a-key", { numItems: 5, cursor: null })).toEqual({
			page: [],
			isDone: true,
			continueCursor: "",
		});
		expect(await summary(f)).toEqual({ count: 2, truncated: false });
		expect(await summary(f, "own")).toEqual({ count: 1, truncated: false });
		expect(await summary(f, chat)).toEqual({ count: 1, truncated: false });
		expect(await summary(f, "optimistic-thread")).toEqual({ count: 0, truncated: false });
	});

	test("skips a folder draft that holds a draft before paging and in the count", async () => {
		const f = await fixture();
		await create_private({ f, path: "/qa/page.md", kind: "file" });
		await create_private({ f, path: "/a/b" });

		// One row per page. Every page that is not the last one must hold a row, so a hidden
		// folder never uses a slot.
		let cursor: string | null = null;
		do {
			const page: FunctionReturnType<typeof api.files_pending_updates.list_files_pending_updates> = await list(
				f,
				"all",
				{ numItems: 1, cursor },
			);
			if (!page.isDone) expect(page.page).toHaveLength(1);
			cursor = page.isDone ? null : page.continueCursor;
		} while (cursor !== null);
		expect((await list_paths(f, "all")).toSorted()).toEqual(["/a/b", "/qa/page.md"]);
		expect(await summary(f)).toEqual({ count: 2, truncated: false });

		// Discarding the only file inside brings the empty folder back as its own change.
		const rows = (await list(f, "all", { numItems: 5, cursor: null })).page;
		const paths = await list_paths(f, "all");
		const file = rows[paths.indexOf("/qa/page.md")];
		if (!file) throw new Error("Expected the file draft");
		expect(
			(
				await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: f.db.membershipId,
					target: file.target,
					pendingUpdateId: file.pendingUpdateId,
					reviewedRevision: file.revision,
				})
			)._nay,
		).toBeUndefined();
		expect((await list_paths(f, "all")).toSorted()).toEqual(["/a/b", "/qa"]);
		expect(await summary(f)).toEqual({ count: 2, truncated: false });
	});

	test("hides a folder from one chat that holds a draft from another chat in every count", async () => {
		const f = await fixture();
		const chatA = await create_thread(f, "pending-chat-a");
		const chatB = await create_thread(f, "pending-chat-b");
		await create_private({ f, path: "/reports", kind: "folder", threadId: chatA });
		await create_private({ f, path: "/reports/june.md", kind: "file", threadId: chatB });

		expect(await summary(f, chatA)).toEqual({ count: 0, truncated: false });
		expect(await summary(f, chatB)).toEqual({ count: 1, truncated: false });
		expect(await summary(f)).toEqual({ count: 1, truncated: false });

		// The list skips the folder, so the draft's view names it as a parent to save with it.
		const [row] = (await list(f, chatB, { numItems: 5, cursor: null })).page;
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.db.membershipId,
				target: row!.target,
			}),
		).toMatchObject({ entry: { path: "/reports/june.md" }, requiredParents: [{ path: "/reports" }] });
	});

	test("counts up to 500 changes and says 500+ past that", async () => {
		const f = await fixture();
		await create_private({ f, path: "/one.md", kind: "file" });
		await add_list_rows(f, 499);
		expect(await summary(f)).toEqual({ count: 500, truncated: false });
		await add_list_rows(f, 1);
		expect(await summary(f)).toEqual({ count: 500, truncated: true });
	});

	// One page reads its list rows and each row's stored proposal only. A row's path and access load
	// in its own `get_file_pending_target` query, so a deep draft costs a page no more than a shallow
	// one. This is the "1 range per row" in the guard of `list_files_pending_updates`.
	test("a page costs 1 range more per row, at any draft depth", async () => {
		const f = await fixture();
		const cost = () =>
			f.asUser.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				await ctx.runQuery(api.files_pending_updates.list_files_pending_updates, {
					membershipId: f.db.membershipId,
					listKey: "all",
					paginationOpts: { numItems: 5, cursor: null },
				});
				const after = await ctx.meta.getTransactionMetrics();
				return after.databaseQueries.used - before.databaseQueries.used;
			});

		await create_private({ f, path: "/shallow.md", kind: "file" });
		const one = await cost();
		await create_private({ f, path: `/${Array.from({ length: 30 }, () => "d").join("/")}/deep.md`, kind: "file" });
		const two = await cost();
		await create_private({ f, path: "/other.md", kind: "file" });
		const three = await cost();
		expect([two - one, three - two]).toEqual([1, 1]);
	});

	// convex-test gives a split cursor to a page that reads more than `numItems` + 1 rows. A page pinned
	// by an end cursor reads every row up to that cursor, like a reactive rerun after many changes.
	test("a page whose end cursor holds more than 3,000 rows asks for a split", async () => {
		const f = await fixture();
		await create_private({ f, path: "/one.md", kind: "file" });
		await add_list_rows(f, 3001);
		// The same index and order as the list query, so its cursors fit the list query.
		const end_cursor = (numItems: number) =>
			f.t.run(
				async (ctx) =>
					(
						await ctx.db
							.query("files_pending_list_rows")
							.withIndex("by_org_ws_user_listKey_updatedAt", (q) =>
								q
									.eq("organizationId", f.db.organizationId)
									.eq("workspaceId", f.db.workspaceId)
									.eq("userId", f.db.userId)
									.eq("listKey", "all"),
							)
							.order("desc")
							.paginate({ numItems, cursor: null })
					).continueCursor,
			);

		const endCursor = await end_cursor(3001);
		expect(await list(f, "all", { numItems: 5, cursor: null, endCursor })).toEqual({
			page: [],
			isDone: false,
			continueCursor: endCursor,
			splitCursor: expect.any(String),
			pageStatus: "SplitRequired",
		});
		// A pinned page under the guard gives its rows.
		expect((await list(f, "all", { numItems: 5, cursor: null, endCursor: await end_cursor(5) })).page).toHaveLength(5);
	});

	test("keeps a page's end at the given endCursor", async () => {
		// The convex/react hook sends `endCursor` when it splits a page, to keep the page's end fixed.
		const f = await fixture();
		await create_private({ f, path: "/one.md", kind: "file" });
		await create_private({ f, path: "/two.md", kind: "file" });
		await create_private({ f, path: "/three.md", kind: "file" });

		const first = await list(f, "all", { numItems: 1, cursor: null });
		const second = await list(f, "all", { numItems: 1, cursor: first.continueCursor });

		// An end cursor wins over `numItems`, so the page holds both rows.
		const pinned = await list(f, "all", { numItems: 1, cursor: null, endCursor: second.continueCursor });
		expect(pinned.page).toHaveLength(2);
		expect(pinned.continueCursor).toBe(second.continueCursor);
		expect(pinned.isDone).toBe(false);
	});
});

describe("list_files_pending_sources", () => {
	test("pages the sources newest first, 20 at a time, without All changes", async () => {
		const f = await fixture();
		await create_private({ f, path: "/own.md", kind: "file" });
		const threadIds: Id<"ai_chat_threads">[] = [];
		for (let index = 0; index < 21; index++) {
			// Thread writes allow 12 per minute.
			vi.advanceTimersByTime(10_000);
			const threadId = await create_thread(f, `pending-source-${index}`);
			threadIds.push(threadId);
			await create_private({ f, path: `/chat-${index}.md`, kind: "file", threadId });
		}

		const read = (cursor: string | null) =>
			f.asUser.query(api.files_pending_updates.list_files_pending_sources, {
				membershipId: f.db.membershipId,
				paginationOpts: { numItems: 20, cursor },
			});
		const first = await read(null);
		expect(first.isDone).toBe(false);
		const second = await read(first.continueCursor);
		expect(second.isDone).toBe(true);
		expect([...first.page, ...second.page]).toEqual([...threadIds.toReversed(), "own"]);
	});
});

describe("get_pending_move_occupant", () => {
	function occupant(args: {
		f: Awaited<ReturnType<typeof fixture>>;
		as?: Awaited<ReturnType<typeof fixture>>["asUser"];
		membershipId?: Id<"organizations_workspaces_users">;
		path: string;
		nodeId?: string;
	}) {
		const { f, as = f.asUser, membershipId = f.db.membershipId, path, nodeId = "moving-node" } = args;
		return as.query(api.files_pending_updates.get_pending_move_occupant, { membershipId, nodeId, path });
	}

	test("returns a readable occupant, and not a hidden one or the moving node itself", async () => {
		const f = await fixture();
		const member = await add_member(f);
		const taken = await create_saved(f, "taken");
		const asMember = { f, as: member.as, membershipId: member.membershipId, path: "/taken" };

		expect(await occupant(asMember)).toEqual({ nodeId: taken.id, hasActiveChild: false });
		expect(await occupant({ f, path: "/taken", nodeId: taken.id })).toBeNull();
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: taken.id }),
		).toEqual({ _yay: null });
		expect(await occupant(asMember)).toBeNull();
		expect(await occupant({ f, path: "/taken" })).toEqual({ nodeId: taken.id, hasActiveChild: false });
	});

	test("counts a folder whose only child is a restricted root as empty", async () => {
		const f = await fixture();
		const box = await create_saved(f, "box");
		const secret = await create_saved(f, "box/secret");
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId: secret.id }),
		).toEqual({ _yay: null });
		// The restricted child may be hidden from the caller, so it never counts.
		expect(await occupant({ f, path: "/box" })).toEqual({ nodeId: box.id, hasActiveChild: false });

		await create_saved(f, "box/open");
		expect(await occupant({ f, path: "/box" })).toEqual({ nodeId: box.id, hasActiveChild: true });
	});
});

describe("internal_list_children_saved", () => {
	test("a service account stream stops at the read budget and goes on from its position", async () => {
		const f = await fixture();
		const created = await f.asUser.mutation(api.access_control.create_service_account, {
			membershipId: f.db.membershipId,
			name: "Lister",
		});
		if (created._nay) throw new Error(created._nay.message);
		const { serviceAccountId } = created._yay;
		const grant = await f.asUser.mutation(api.access_control.set_service_account_grant, {
			membershipId: f.db.membershipId,
			serviceAccountId,
			resource: { kind: "workspace" },
			level: "read",
		});
		if (grant._nay) throw new Error(grant._nay.message);
		const big = await create_saved(f, "big");
		const names = Array.from({ length: 1_100 }, (_, index) => `f-${String(index).padStart(4, "0")}.md`);
		await f.t.run(async (ctx) => {
			for (const name of names)
				await ctx.db.insert("files_nodes", {
					...test_mocks.files.base(),
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					createdBy: f.db.userId,
					updatedBy: f.db.userId,
					parentId: big.id,
					name,
					sortName: files_sort_text_key(name),
					kind: "file",
					path: `/big/${name}`,
					treePath: `/big/${name}`,
					pathDepth: 2,
					lowercaseExtension: "md",
				});
		});

		// Outside the owner's overlay every open row costs its own access check, so 1,050 rows do
		// not fit the 3,000 range budget of one call. Measured: 976 rows, then the other 74 of that
		// page (read again and skipped up to `lastKey`), then the last 50.
		let position: { rangeStart: string | null; cursor: string | null; lastKey: unknown[] | null } = {
			rangeStart: null,
			cursor: null,
			lastKey: null,
		};
		const decided: number[] = [];
		const seen: string[] = [];
		for (let call = 0; call < 10; call++) {
			const result = await f.t.query(internal.files_visible.internal_list_children_saved, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				visibilityUserId: f.db.userId,
				serviceAccountId,
				folderPath: "/big",
				orderBy: "name",
				order: "asc",
				numItems: 1_050,
				position,
			});
			if (result._nay) throw new Error(result._nay.message);
			decided.push(result._yay.decided);
			seen.push(...result._yay.rows.map((row) => row.item!.name));
			position = result._yay.position;
			if (result._yay.done) break;
		}
		expect(decided[0]).toBeLessThan(1_050);
		expect(seen).toEqual(names);
	});
});
