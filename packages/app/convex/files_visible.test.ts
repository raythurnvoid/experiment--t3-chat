import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_visible_db_create_reader, type files_visible_internal_list_Result } from "./files_visible.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, asUser };
}

async function create_private(
	f: Awaited<ReturnType<typeof fixture>>,
	path: string,
	kind: "file" | "folder" = "folder",
	threadId?: Id<"ai_chat_threads">,
) {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
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

describe("list", () => {
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
		await create_private(f, "/source/mine");
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

	test("continues after empty filtered pages without losing later matches", async () => {
		const f = await fixture();
		for (let index = 0; index < 110; index++) {
			vi.setSystemTime(Date.now() + 2_000);
			await create_saved(f, `folder-${String(index).padStart(3, "0")}`);
		}
		const last = await create_private(f, "/zzz-match");
		let cursor: string | null = null;
		const paths: string[] = [];
		let done = false;
		let emptyPages = 0;
		for (let page = 0; page < 20 && !done; page++) {
			const result: files_visible_internal_list_Result = await f.asUser.query(api.files_visible.list, {
				membershipId: f.db.membershipId,
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

	test("merges saved, renamed, and private children in name order across pages", async () => {
		const f = await fixture();
		await create_saved(f, "a");
		await create_saved(f, "c");
		const renamed = await create_saved(f, "z");
		await create_private(f, "/b");
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: renamed,
			destParent: { kind: "root" },
			destName: "aa",
		});
		expect(moved._nay).toBeUndefined();
		const paths: string[] = [];
		let cursor: string | null = null;
		let done = false;
		for (let page = 0; page < 10 && !done; page++) {
			const result: files_visible_internal_list_Result = await f.asUser.query(api.files_visible.list, {
				membershipId: f.db.membershipId,
				folderPath: "/",
				mode: "children",
				numItems: 1,
				cursor,
			});
			if (result._nay) throw new Error(result._nay.message);
			expect(result._yay.items.length).toBeLessThanOrEqual(1);
			paths.push(...result._yay.items.map((item) => item.path));
			cursor = result._yay.continueCursor;
			done = result._yay.isDone;
		}
		expect(done).toBe(true);
		expect(paths).toEqual(["/a", "/aa", "/b", "/c"]);
	});

	test("children and subtree mode list in raw name order across pages, with drafts and moves", async () => {
		const f = await fixture();
		const box = await create_saved(f, "box");
		for (const name of ["Zeta", "b", "n"]) await create_saved(f, `box/${name}`);
		const elsewhere = await create_saved(f, "elsewhere");

		// Insert saved files directly. The listing reads only the node fields.
		const insert_file = (parentId: typeof box.id | "root", path: string) =>
			f.t.run(async (ctx) => {
				const name = path.slice(path.lastIndexOf("/") + 1);
				return {
					kind: "saved" as const,
					id: await ctx.db.insert("files_nodes", {
						...test_mocks.files.base(),
						organizationId: f.db.organizationId,
						workspaceId: f.db.workspaceId,
						createdBy: f.db.userId,
						updatedBy: f.db.userId,
						parentId,
						name,
						kind: "file",
						path,
						treePath: path,
						pathDepth: path.split("/").length - 1,
						lowercaseExtension: "txt",
						contentType: "text/plain",
					}),
				};
			});
		for (const name of ["a.txt", "file-10.txt", "file-9.txt", "z.txt"]) await insert_file(box.id, `/box/${name}`);
		const renamed = await insert_file(box.id, "/box/q.txt");
		const outside = await insert_file("root", "/outside.txt");

		await create_private(f, "/box/c-draft");
		await create_private(f, "/box/b-draft.txt", "file");
		for (const [target, destName] of [
			[renamed, "m.txt"],
			[outside, "0-moved.txt"],
			[elsewhere, "x-moved"],
		] as const) {
			const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				target,
				destParent: box,
				destName,
			});
			expect(moved._nay).toBeUndefined();
		}

		const list_all = async (args: { mode: "children" | "subtree"; numItems: number }) => {
			const names: string[] = [];
			let cursor: string | null = null;
			let done = false;
			for (let page = 0; page < 30 && !done; page++) {
				const result: files_visible_internal_list_Result = await f.asUser.query(api.files_visible.list, {
					membershipId: f.db.membershipId,
					folderPath: "/box",
					cursor,
					...args,
				});
				if (result._nay) throw new Error(result._nay.message);
				expect(result._yay.items.length).toBeLessThanOrEqual(args.numItems);
				names.push(...result._yay.items.map((item) => item.name));
				cursor = result._yay.continueCursor;
				done = result._yay.isDone;
			}
			expect(done).toBe(true);
			return names;
		};

		// Raw order puts digits and capitals before lowercase, and "file-10" before "file-9".
		const names = [
			"0-moved.txt",
			"Zeta",
			"a.txt",
			"b",
			"b-draft.txt",
			"c-draft",
			"file-10.txt",
			"file-9.txt",
			"m.txt",
			"n",
			"x-moved",
			"z.txt",
		];
		// Each page size moves the page boundary, so a skipped or repeated entry changes the list.
		for (const numItems of [1, 2, 3, 50]) {
			expect(await list_all({ mode: "children", numItems })).toEqual(names);
		}
		expect(await list_all({ mode: "subtree", numItems: 50 })).toEqual(names);
	});

	test("walks private folders and moved-in saved folders once", async () => {
		const f = await fixture();
		const parent = await create_private(f, "/draft/nested");
		await create_private(f, "/draft/nested/preparing.txt", "file");
		const source = await create_saved(f, "source/child");
		const sourceParent = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.db.membershipId,
			path: "/source",
		});
		if (!sourceParent) throw new Error("Expected the saved source folder");
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: sourceParent.target,
			destParent: parent.target,
			destName: "moved",
		});
		expect(moved._nay).toBeUndefined();
		const result = await f.asUser.query(api.files_visible.list, {
			membershipId: f.db.membershipId,
			folderPath: "/draft",
			mode: "subtree",
			numItems: 20,
			cursor: null,
		});
		if (result._nay) throw new Error(result._nay.message);
		expect(result._yay.isDone).toBe(true);
		expect(result._yay.items.map((item) => item.path)).toEqual([
			"/draft/nested",
			"/draft/nested/moved",
			"/draft/nested/moved/child",
			"/draft/nested/preparing.txt",
		]);
		expect(result._yay.items.find((item) => item.target.id === source.id)?.path).toBe("/draft/nested/moved/child");
		expect(result._yay.items.at(-1)).toMatchObject({ target: { kind: "private" }, preparing: true });
	});

	test("keeps private children reachable after their parent is saved", async () => {
		const f = await fixture();
		const parent = await create_private(f, "/draft");
		const child = await create_private(f, "/draft/child");
		if (!parent.pendingUpdateId) throw new Error("Expected the parent proposal");
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.db.membershipId,
			target: parent.target,
			pendingUpdateId: parent.pendingUpdateId,
			reviewedRevision: 1,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		const result = await f.asUser.query(api.files_visible.list, {
			membershipId: f.db.membershipId,
			folderPath: "/draft",
			mode: "children",
			numItems: 20,
			cursor: null,
		});
		if (result._nay) throw new Error(result._nay.message);
		expect(result._yay.items).toMatchObject([{ target: child.target, path: "/draft/child", preparing: false }]);
		expect(
			await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
				membershipId: f.db.membershipId,
				path: "/draft/child",
			}),
		).toEqual({ target: child.target, kind: "folder" });
	});

	test("rejects a cursor from a different folder", async () => {
		const f = await fixture();
		await create_private(f, "/a/first");
		await create_private(f, "/b/second");
		const first = await f.asUser.query(api.files_visible.list, {
			membershipId: f.db.membershipId,
			folderPath: "/",
			mode: "children",
			numItems: 1,
			cursor: null,
		});
		if (first._nay) throw new Error(first._nay.message);
		const other = await f.asUser.query(api.files_visible.list, {
			membershipId: f.db.membershipId,
			folderPath: "/a",
			mode: "children",
			numItems: 1,
			cursor: first._yay.continueCursor,
		});
		expect(other._nay?.message).toBe("Listing changed. Start again.");
	});
});

describe("files_visible_db_create_reader", () => {
	test("resolves preparing files by owner path without exposing a saved placeholder", async () => {
		const f = await fixture();
		const created = await create_private(f, "/draft/new.txt", "file");
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
		const created = await create_private(f, "/draft");
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
	test("continues a short or empty page and excludes a discarded draft from its count", async () => {
		const f = await fixture();
		for (let index = 0; index < 7; index++) await create_private(f, `/review-${index}`);
		const queryArgs = { membershipId: f.db.membershipId, paginationOpts: { numItems: 20, cursor: null } };
		const first = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, queryArgs);
		expect(first.page).toHaveLength(5);
		expect(first.isDone).toBe(false);
		const second = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			...queryArgs,
			paginationOpts: { numItems: 20, cursor: first.continueCursor },
		});
		expect(second.page).toHaveLength(2);
		expect(second.isDone).toBe(true);
		const chosen = second.page[0];
		if (chosen?.kind !== "entry" || chosen.entry.kind !== "private") throw new Error("Expected a private review entry");
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.db.membershipId,
			clientGeneratedId: "pending-list-thread",
			title: "Review",
			lastMessageAt: undefined,
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			target: chosen.entry.pendingUpdate.target,
			destParent: { kind: "root" },
			destName: "chat-review",
			threadId: thread._yay.threadId,
		});
		expect(moved._nay).toBeUndefined();
		const empty = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			...queryArgs,
			threadId: thread._yay.threadId,
		});
		expect(empty.page).toEqual([]);
		expect(empty.isDone).toBe(false);
		const next = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			...queryArgs,
			threadId: thread._yay.threadId,
			paginationOpts: { numItems: 20, cursor: empty.continueCursor },
		});
		expect(next.page).toMatchObject([{ kind: "entry", entry: { path: "/chat-review" } }]);
		expect(next.isDone).toBe(true);
		expect(
			await f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
				membershipId: f.db.membershipId,
				threadId: thread._yay.threadId,
			}),
		).toEqual({ count: 1, truncated: false });
		expect(
			await f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
				membershipId: f.db.membershipId,
				threadId: "optimistic-thread",
			}),
		).toEqual({ count: 0, truncated: false });
		const ready = next.page[0];
		if (ready?.kind !== "entry" || ready.entry.kind !== "private") throw new Error("Expected a private review entry");
		expect(
			(
				await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: f.db.membershipId,
					target: ready.entry.pendingUpdate.target,
					pendingUpdateId: ready.entry.pendingUpdate._id,
					reviewedRevision: ready.entry.pendingUpdate.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
				membershipId: f.db.membershipId,
			}),
		).toEqual({ count: 6, truncated: false });
	});

	test("hides a folder draft that holds a draft on every page and in the count", async () => {
		const f = await fixture();
		await create_private(f, "/qa/page.md", "file");
		await create_private(f, "/a/b");

		// One row per page, so a folder and its child always land on different pages.
		const flags = new Map<string, boolean>();
		let cursor: string | null = null;
		do {
			const page: FunctionReturnType<typeof api.files_pending_updates.list_files_pending_updates> =
				await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
					membershipId: f.db.membershipId,
					paginationOpts: { numItems: 1, cursor },
				});
			for (const view of page.page) {
				if (view.kind === "entry") flags.set(view.entry.path, view.hasActiveChildDraft);
			}
			cursor = page.isDone ? null : page.continueCursor;
		} while (cursor !== null);
		expect(Object.fromEntries(flags)).toEqual({ "/qa": true, "/qa/page.md": false, "/a": true, "/a/b": false });
		expect(
			await f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
				membershipId: f.db.membershipId,
			}),
		).toEqual({ count: 2, truncated: false });

		// Discarding the only file inside brings the empty folder back as its own change.
		const all = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId: f.db.membershipId,
			paginationOpts: { numItems: 20, cursor: null },
		});
		const file = all.page.find((view) => view.kind === "entry" && view.entry.path === "/qa/page.md");
		if (file?.kind !== "entry" || !file.entry.pendingUpdate) throw new Error("Expected the file draft");
		expect(
			(
				await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: f.db.membershipId,
					target: file.entry.pendingUpdate.target,
					pendingUpdateId: file.entry.pendingUpdate._id,
					reviewedRevision: file.entry.pendingUpdate.revision,
				})
			)._nay,
		).toBeUndefined();
		const after = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId: f.db.membershipId,
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(
			Object.fromEntries(
				after.page.flatMap((view) => (view.kind === "entry" ? [[view.entry.path, view.hasActiveChildDraft]] : [])),
			),
		).toEqual({ "/qa": false, "/a": true, "/a/b": false });
		expect(
			await f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
				membershipId: f.db.membershipId,
			}),
		).toEqual({ count: 2, truncated: false });
	});

	test("hides a folder from one chat that holds a draft from another chat in every count", async () => {
		const f = await fixture();
		const [chatA, chatB] = await Promise.all(
			["pending-chat-a", "pending-chat-b"].map(async (clientGeneratedId) => {
				const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
					membershipId: f.db.membershipId,
					clientGeneratedId,
					title: clientGeneratedId,
					lastMessageAt: undefined,
				});
				if (thread._nay) throw new Error(thread._nay.message);
				return thread._yay.threadId;
			}),
		);
		await create_private(f, "/reports", "folder", chatA);
		await create_private(f, "/reports/june.md", "file", chatB);

		const count = (threadId?: Id<"ai_chat_threads">) =>
			f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
				membershipId: f.db.membershipId,
				...(threadId ? { threadId } : {}),
			});
		expect(await count(chatA)).toEqual({ count: 0, truncated: false });
		expect(await count(chatB)).toEqual({ count: 1, truncated: false });
		expect(await count()).toEqual({ count: 1, truncated: false });
	});
});
