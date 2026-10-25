// The later flush tests and the job, share row and ancestor tests, split from files_pending_overlay.test.ts so
// the two files can run at the same time. See the comment at the top of that file.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";
import { access_control_db_set_service_account_grant } from "./access_control.ts";
import { files_nodes_db_hard_delete_node } from "./files_nodes.ts";
import { files_visible_db_create_reader } from "./files_visible_db.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	test_rename_node,
	test_move_nodes,
	test_run_with_flush,
	test_spy_handler,
	test_meta_search,
	test_db_hold_move_slot,
} from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import {
	files_pending_overlay_db_flush,
	files_pending_overlay_db_mark_target,
	files_pending_overlay_db_set_acting_user,
	files_pending_overlay_list,
	files_pending_overlay_search_name,
} from "../server/files-pending-overlay.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import { files_ancestor_ids, type files_PendingTarget } from "../shared/files.ts";
import {
	type Fixture,
	type Scope,
	insert_saved_node,
	fixture,
	add_member,
	proposal_doc,
	target,
	parent,
	share_rows,
	share_keys,
} from "./files_pending_overlay.setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("files_pending_overlay flush", () => {
	test("a place stores the saved node whose access decides if its owner sees it", async () => {
		const f = await fixture();
		const r = await f.saved(null, "r", "folder");
		const open = await f.saved(null, "open", "folder");
		const plan = await f.saved(r, "plan.md");
		const restricted = await f.asU.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: r._id,
		});
		expect(restricted._nay).toBeUndefined();
		const share = {
			membershipId: f.db.membershipId,
			nodeId: r._id,
			principal: { kind: "user", userId: f.v.userId },
		} as const;
		expect((await f.asU.mutation(api.files_sharing.set_node_share_grant, { ...share, level: "write" }))._nay).toBe(
			undefined,
		);

		// V drafts `mv /r/plan.md /open/` while a grant lets V read and write restricted /r.
		await f.draft_move(target(plan), parent(open), "plan.md", f.v);
		expect((await f.overlay(target(plan), f.v)).place).toMatchObject({
			ownerTreePath: "/open/plan.md",
			isVisible: true,
			accessNodeId: plan._id,
		});
		// A private node stores its nearest saved ancestor.
		const notes = await f.create_private("/r/notes.md");
		expect((await f.overlay(notes)).place).toMatchObject({ accessNodeId: r._id });
		await f.expect_overlay_true();

		// Every place read checks `accessNodeId` the way the reader checks a saved node (Phases D, E).
		const v_can_read_place = async () =>
			await f.t.run(async (ctx) => {
				const place = (await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) =>
						q.eq("target.kind", "saved").eq("target.id", plan._id).eq("userId", f.v.userId),
					)
					.unique())!;
				const reader = await files_visible_db_create_reader(ctx, f.v);
				return await reader.canRead(await ctx.db.get("files_nodes", place.accessNodeId!));
			});
		expect(await v_can_read_place()).toBe(true);

		// V loses the grant. The place stays, since derived docs do not check access, and the read check
		// now drops it.
		expect((await f.asU.mutation(api.files_sharing.remove_node_share_grant, share))._nay).toBeUndefined();
		expect((await f.overlay(target(plan), f.v)).place).toMatchObject({ isVisible: true, accessNodeId: plan._id });
		expect(await v_can_read_place()).toBe(false);
		await f.expect_overlay_true();
	});

	test("a draft move into a folder the member can no longer read hides the moved nodes from path reads", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const hr = await f.saved(null, "hr", "folder");
		const notes = await f.saved(null, "notes.md");
		const proj = await f.saved(null, "proj", "folder");
		const plan = await f.saved(proj, "plan.md");
		// V may write in open /team: V drafts `mv /notes.md /team/` and `mv /proj /team/`, then a new file
		// inside the moved folder, whose path goes through that move too.
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		await f.draft_move(target(proj), parent(team), "proj", f.v);
		const draft = await f.create_private("/team/proj/new.md", "file", f.v);

		const membershipId = f.vMember.membershipId;
		const get_path = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_visible.get_path, { membershipId, target: pendingTarget });
		const target_at = async (path: string) =>
			(await f.asV.query(api.files_nodes.get_visible_target_by_path, { membershipId, path }))?.target ?? null;
		const pending_view = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_pending_target.get_file_pending_target, { membershipId, target: pendingTarget });
		const v_path_read = (path: string) =>
			f.t.run(async (ctx) => (await (await files_visible_db_create_reader(ctx, f.v)).resolvePath(path))?.path ?? null);
		expect((await f.v_find()).paths).toEqual([
			"/hr",
			"/team",
			"/team/notes.md",
			"/team/proj",
			"/team/proj/new.md",
			"/team/proj/plan.md",
		]);
		expect((await f.v_find({ kind: "file" })).paths).toEqual([
			"/team/notes.md",
			"/team/proj/new.md",
			"/team/proj/plan.md",
		]);
		expect(await pending_view(target(notes))).toMatchObject({ canAccept: true, moveDestinationUnreadable: false });

		// The owner restricts /hr without sharing it with V, then moves /team into it and renames it.
		await f.restrict(hr);
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, {
				membershipId: f.db.membershipId,
				itemIds: [team._id],
				targetParentId: hr._id,
			}),
		);
		await f.as_u(() =>
			test_rename_node(f.t, f.asU, {
				membershipId: f.db.membershipId,
				nodeId: team._id,
				path: "secret",
			}),
		);
		// The derived docs still describe the draft and do not check access.
		expect((await f.overlay(target(notes), f.v)).place).toMatchObject({
			ownerTreePath: "/hr/secret/notes.md",
			destinationAccessNodeIds: [team._id],
		});
		expect((await f.overlay(draft, f.v)).place).toMatchObject({
			ownerTreePath: "/hr/secret/proj/new.md",
			accessNodeId: proj._id,
			destinationAccessNodeIds: [team._id],
		});
		await f.expect_overlay_true();

		// No read names the hidden folder. Path reads hide the moved nodes, the saved file inside the moved
		// folder, and the draft created there, like listings do. They do not fall back to a saved place.
		expect(await get_path(target(notes))).toBe(null);
		expect(await get_path(target(proj))).toBe(null);
		expect(await get_path(target(plan))).toBe(null);
		expect(await get_path(draft)).toBe(null);
		expect(await target_at("/hr/secret/notes.md")).toBe(null);
		expect(await target_at("/hr/secret/proj/new.md")).toBe(null);
		expect(await target_at("/proj/new.md")).toBe(null);
		// The agent's path read (`cat /notes.md`) finds nothing at the saved place either. The UI path
		// lookup above still opens the saved rows there, since it reads saved rows first.
		expect(await v_path_read("/notes.md")).toBe(null);
		expect(await v_path_read("/proj/plan.md")).toBe(null);
		expect(await target_at("/notes.md")).toEqual(target(notes));
		// The blocked answer does not depend on the read order: a child read first still knows.
		const blocked_in_order = (targets: files_PendingTarget[]) =>
			f.t.run(async (ctx) => {
				const reader = await files_visible_db_create_reader(ctx, f.v);
				const answers: boolean[] = [];
				for (const pendingTarget of targets) {
					await reader.resolve(pendingTarget);
					answers.push(reader.isBlocked(pendingTarget));
				}
				return answers;
			});
		expect(await blocked_in_order([draft, target(plan), target(proj), target(notes), target(hr)])).toEqual([
			true,
			true,
			true,
			true,
			false,
		]);
		expect(await blocked_in_order([target(proj), target(plan), draft])).toEqual([true, true, true]);
		// The Pending row still shows the saved node at its saved place. Accept would fail, so it is off,
		// and the row knows the path is not the destination. The draft inside the moved folder has no
		// view, so its row offers Discard only.
		expect(await pending_view(target(notes))).toMatchObject({
			entry: { path: "/notes.md" },
			canAccept: false,
			canAcceptWithParents: false,
			moveDestinationUnreadable: true,
		});
		expect(await pending_view(draft)).toBe(null);
		// Listings drop the places, and the hides still drop the saved rows, so `find` shows none of them.
		// It shows only /hr, locked, and reads nothing under it.
		expect((await f.v_find()).paths).toEqual(["/hr"]);
		expect((await f.v_find({ kind: "file" })).paths).toEqual([]);
		// `cp -r /proj` finds no folder to copy, since path reads hide /proj too. The refusal for a hidden
		// child of a folder V can still open is in the next test.
		expect(
			await files_pending_overlay_list({ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">, {
				organizationId: f.v.organizationId,
				workspaceId: f.v.workspaceId,
				visibilityUserId: f.v.userId,
				subject: { kind: "user", userId: f.v.userId, plugin: null },
				overlayUserId: f.v.userId,
				requireComplete: true,
				folderPath: "/proj",
				mode: "children",
				order: "asc",
				cursor: null,
				numItems: 50,
			}),
		).toEqual({ _yay: { items: [], continueCursor: null, isDone: true } });
	});

	test("a full listing refuses a saved node whose draft moves it into a folder the member can no longer read", async () => {
		const f = await fixture();
		const docs = await f.saved(null, "docs", "folder");
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(docs, "notes.md");
		await f.saved(docs, "readme.md");
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		// `cp -r /docs` lists every child. The moved file is not one of them.
		const list_docs = () =>
			files_pending_overlay_list({ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">, {
				organizationId: f.v.organizationId,
				workspaceId: f.v.workspaceId,
				visibilityUserId: f.v.userId,
				subject: { kind: "user", userId: f.v.userId, plugin: null },
				overlayUserId: f.v.userId,
				requireComplete: true,
				folderPath: "/docs",
				mode: "children",
				order: "asc",
				cursor: null,
				numItems: 50,
			});
		expect((await list_docs())._yay?.items.map((item) => item.path)).toEqual(["/docs/readme.md"]);

		// The owner restricts /team. Path reads now hide notes.md, and its hide and its dropped place would
		// leave it out of the copy, so the listing refuses.
		await f.restrict(team);
		expect(
			await f.asV.query(api.files_visible.get_path, { membershipId: f.vMember.membershipId, target: target(notes) }),
		).toBe(null);
		expect(await list_docs()).toEqual({
			_nay: {
				message:
					"A draft move here, or of a folder above it, goes into a folder you can no longer open. Discard that move and try again.",
			},
		});
	});

	test("a blocked draft move resolves at its destination again once the member can read it", async () => {
		const f = await fixture();
		const docs = await f.saved(null, "docs", "folder");
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(docs, "notes.md");
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		const membershipId = f.vMember.membershipId;
		const get_path = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_visible.get_path, { membershipId, target: pendingTarget });
		// The agent's path read, like `cat`.
		const v_path_read = (path: string) =>
			f.t.run(async (ctx) => {
				const entry = await (await files_visible_db_create_reader(ctx, f.v)).resolvePath(path);
				return entry ? { kind: entry.kind, id: entry.node._id } : null;
			});
		expect(await get_path(target(notes))).toBe("/team/notes.md");
		expect(await v_path_read("/team/notes.md")).toEqual(target(notes));

		await f.restrict(team);
		expect(await get_path(target(notes))).toBe(null);
		expect(await v_path_read("/docs/notes.md")).toBe(null);
		// Like any moved-away node, the saved path is free in V's view: the agent's write there makes a
		// new draft.
		const draft = await f.create_private("/docs/notes.md", "file", f.v);
		expect(await v_path_read("/docs/notes.md")).toEqual(draft);

		// The owner shares /team with V again.
		await f.share(team, { kind: "user", userId: f.v.userId }, "read");
		expect(await get_path(target(notes))).toBe("/team/notes.md");
		expect(await v_path_read("/team/notes.md")).toEqual(target(notes));
		expect(await v_path_read("/docs/notes.md")).toEqual(draft);
	});

	test("a draft move into a saved draft folder that is itself blocked is hidden too", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(null, "notes.md");
		// V drafts a folder /new and `mv /notes.md /new/`, then saves the folder first. The move still
		// points at the draft folder. V then drafts `mv /new /team/`.
		const folder = await f.create_private("/new", "folder", f.v);
		await f.draft_move(target(notes), { kind: "private", id: folder.id as Id<"files_pending_nodes"> }, "notes.md", f.v);
		await f.review("accept", [await f.proposal_of(folder, f.v)], "v");
		const published = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", folder.id as Id<"files_pending_nodes">))
				.unique(),
		);
		await f.draft_move({ kind: "saved", id: published!.savedNodeId }, parent(team), "new", f.v);
		const membershipId = f.vMember.membershipId;
		const get_path = () => f.asV.query(api.files_visible.get_path, { membershipId, target: target(notes) });
		expect(await get_path()).toBe("/team/new/notes.md");

		// The owner restricts /team. The saved folder's move is blocked, so the draft folder it came from
		// is blocked too, and so is notes.md.
		await f.restrict(team);
		expect(await get_path()).toBe(null);
		expect(
			await f.asV.query(api.files_pending_target.get_file_pending_target, { membershipId, target: target(notes) }),
		).toMatchObject({ entry: { path: "/notes.md" }, canAccept: false, moveDestinationUnreadable: true });
	});

	test("find -mmin, find -name and meta search leave out the saved children of a blocked moved folder", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const proj = await f.saved(null, "proj", "folder");
		await f.saved(proj, "plan.md");
		await f.set_metadata("/proj/plan.md", [{ key: "status", value: "open" }], f.v);
		await f.draft_move(target(proj), parent(team), "proj", f.v);
		await f.expect_overlay_true();
		const find_mmin = async () => {
			const result = await files_pending_overlay_list(
				{ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: f.v.organizationId,
					workspaceId: f.v.workspaceId,
					visibilityUserId: f.v.userId,
					subject: { kind: "user", userId: f.v.userId, plugin: null },
					overlayUserId: f.v.userId,
					folderPath: "/",
					mode: "subtree",
					order: "asc",
					updated: { from: 0, to: null },
					numItems: 50,
					cursor: null,
				},
			);
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.items.map((item) => item.path).filter((path) => path.endsWith("plan.md"));
		};
		const find_name = async () => {
			const result = await files_pending_overlay_search_name(
				{ runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">,
				{
					organizationId: f.v.organizationId,
					workspaceId: f.v.workspaceId,
					visibilityUserId: f.v.userId,
					subject: { kind: "user", userId: f.v.userId, plugin: null },
					overlayUserId: f.v.userId,
					folderPath: "/",
					query: "plan",
					numItems: 10,
					cursor: null,
				},
			);
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.items.map((item) => item.path);
		};
		const meta_search = async () =>
			(await test_meta_search(f.t, { ...f.v, plan: { op: "exists", fieldPath: "metadata.status" } })).items.map(
				(item) => item.path,
			);
		expect(await find_mmin()).toEqual(["/team/proj/plan.md"]);
		expect(await find_name()).toEqual(["/team/proj/plan.md"]);
		expect(await meta_search()).toEqual(["/team/proj/plan.md"]);

		// The owner restricts /team. No listing shows plan.md, at the destination or at its saved place.
		await f.restrict(team);
		expect(await find_mmin()).toEqual([]);
		expect(await find_name()).toEqual([]);
		expect(await meta_search()).toEqual([]);
	});

	test("a draft move into a saved draft folder the member can no longer read cannot be accepted", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const notes = await f.saved(null, "notes.md");
		// V drafts a folder /team/new and `mv /notes.md /team/new/`, then saves the folder first. The move
		// still points at the draft folder, which now leads to the saved one.
		const folder = await f.create_private("/team/new", "folder", f.v);
		await f.draft_move(target(notes), { kind: "private", id: folder.id as Id<"files_pending_nodes"> }, "notes.md", f.v);
		await f.review("accept", [await f.proposal_of(folder, f.v)], "v");
		const pending_view = () =>
			f.asV.query(api.files_pending_target.get_file_pending_target, {
				membershipId: f.vMember.membershipId,
				target: target(notes),
			});
		expect(await pending_view()).toMatchObject({
			entry: { path: "/team/new/notes.md" },
			canAccept: true,
			moveDestinationUnreadable: false,
		});

		await f.restrict(team);
		expect(await pending_view()).toMatchObject({
			entry: { path: "/notes.md" },
			canAccept: false,
			moveDestinationUnreadable: true,
		});
	});

	test("a draft move inside another draft move checks both destinations", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const pub = await f.saved(null, "pub", "folder");
		const notes = await f.saved(null, "notes.md");
		// V drafts `mv /notes.md /team/`, then `mv /team /pub/`: the path of notes goes through both.
		await f.draft_move(target(notes), parent(team), "notes.md", f.v);
		await f.draft_move(target(team), parent(pub), "team", f.v);
		expect((await f.overlay(target(notes), f.v)).place).toMatchObject({
			ownerTreePath: "/pub/team/notes.md",
			destinationAccessNodeIds: [team._id, pub._id],
		});
		expect((await f.v_find()).paths).toEqual(["/pub", "/pub/team", "/pub/team/notes.md"]);

		// The owner restricts /pub without sharing it with V. V can still read /team, but path reads hide
		// both: the move of /team is blocked, and so is notes.md, whose path goes through it.
		await f.restrict(pub);
		await f.expect_overlay_true();
		// `find` shows /pub locked and reads nothing under it.
		expect((await f.v_find()).paths).toEqual(["/pub"]);
		const get_path = (pendingTarget: files_PendingTarget) =>
			f.asV.query(api.files_visible.get_path, { membershipId: f.vMember.membershipId, target: pendingTarget });
		expect(await get_path(target(team))).toBe(null);
		expect(await get_path(target(notes))).toBe(null);
		// The Pending row of notes.md names its saved place, not /team/notes.md as if that were the
		// destination.
		expect(
			await f.asV.query(api.files_pending_target.get_file_pending_target, {
				membershipId: f.vMember.membershipId,
				target: target(notes),
			}),
		).toMatchObject({ entry: { path: "/notes.md" }, canAccept: false, moveDestinationUnreadable: true });
	});

	test("a moved-in folder's next page shows nothing once its destination is unreadable", async () => {
		const f = await fixture();
		const team = await f.saved(null, "team", "folder");
		const proj = await f.saved(null, "proj", "folder");
		await f.saved(proj, "a.md");
		await f.saved(proj, "b.md");
		await f.draft_move(target(proj), parent(team), "proj", f.v);
		const first = await f.v_find({ kind: "file", numItems: 1 });
		expect(first.paths).toEqual(["/team/proj/a.md"]);

		// The cursor keeps the moved-in folder's stream open. The path does not change, so only the
		// access check on the next page stops it.
		await f.restrict(team);
		expect((await f.v_find({ kind: "file", cursor: first.cursor })).paths).toEqual([]);
	});

	test.each([
		{ others: 31, refused: false },
		{ others: 32, refused: true },
	])(
		"U's draft on a saved node where other users hold $others hides and places is refused: $refused",
		async ({ others, refused }) => {
			const f = await fixture();
			const a = await f.saved(null, "a", "folder");
			const x = await f.saved(null, "x.md");
			// Each other user's move gives a hide and a place; an odd count ends with one draft delete.
			await test_run_with_flush(f.t, async (ctx) => {
				for (let index = 0; index * 2 < others; index++) {
					const scope = await add_member(ctx, f.u, `clerk_crowd_${index}`);
					await ctx.db.insert(
						"files_pending_updates",
						proposal_doc(
							scope,
							target(x),
							index * 2 + 1 < others
								? { pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path } }
								: { pendingArchive: { fromPath: x.path } },
						),
					);
				}
			});
			await f.settle();
			const docs = await f.t.run(async (ctx) => [
				...(await ctx.db
					.query("files_pending_hides")
					.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", x._id))
					.collect()),
				...(await ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) => q.eq("target.kind", "saved").eq("target.id", x._id))
					.collect()),
			]);
			expect(docs).toHaveLength(others);

			const drafting = f.draft_move(target(x), parent(a), "x.md");
			if (refused)
				await expect(drafting).rejects.toThrow("Too many people have pending changes on x.md. Try again later.");
			else await drafting;
			expect((await f.overlay(target(x))).hidden).toBe(!refused);
			await f.expect_overlay_true();
		},
		120_000,
	);

	test("a side effect may add U's hide of a saved node where other users hold 32 hides and places", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(null, "x.md");
		// Each other user's move gives a hide and a place. A write of several users goes to jobs, which
		// never refuse.
		const crowd = async (from: number, to: number) => {
			await test_run_with_flush(f.t, async (ctx) => {
				for (let index = from; index < to; index++) {
					const scope = await add_member(ctx, f.u, `clerk_crowd_${index}`);
					await ctx.db.insert(
						"files_pending_updates",
						proposal_doc(scope, target(x), {
							pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path },
						}),
					);
				}
			});
			await f.settle();
		};
		// U drafts `mv /x.md /b/` while other users hold 28 docs of x, then they hold 32.
		await crowd(0, 14);
		await f.draft_move(target(x), parent(b), "x.md");
		await crowd(14, 16);

		// `rm -r /b` drops U's hide of x. Its undo adds the hide back in the owner path step, not in a
		// write of x's own draft, so it is not refused.
		await f.draft_delete(target(b));
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await expect(f.undo(target(b))).resolves.toBeUndefined();
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await f.expect_overlay_true();
	}, 120_000);

	test("U's draft onto the name of a saved node where other users hold 32 hides and places is refused", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(null, "x.md");
		const y = await f.saved(null, "y.md");
		await test_run_with_flush(f.t, async (ctx) => {
			for (let index = 0; index < 16; index++) {
				const scope = await add_member(ctx, f.u, `clerk_crowd_${index}`);
				await ctx.db.insert(
					"files_pending_updates",
					proposal_doc(scope, target(x), {
						pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path },
					}),
				);
			}
		});
		await f.settle();

		// A replacing `mv /y.md /x.md` writes only y's draft. Its claim adds U's hide of x, so the cap
		// still applies.
		await expect(
			f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...f.u,
				target: target(y),
				destParent: { kind: "root" },
				destName: "x.md",
				replace: true,
			}),
		).rejects.toThrow("Too many people have pending changes on x.md. Try again later.");
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();
	}, 120_000);

	test("a proposal patch of fields the overlay does not read recomputes nothing", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_delete(target(x));
		const proposal = await f.proposal_of(target(x));
		const flush_ranges = async (patch: Partial<Doc<"files_pending_updates">>) =>
			await test_run_with_flush(f.t, async (ctx) => {
				await ctx.db.patch("files_pending_updates", proposal._id, patch);
				const before = await ctx.meta.getTransactionMetrics();
				await files_pending_overlay_db_flush(ctx);
				return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
			});

		expect(await flush_ranges({ expiresAt: proposal.expiresAt + 1, size: 1 })).toBe(0);
		// A field the overlay reads still recomputes the draft.
		expect(await flush_ranges({ updatedAt: proposal.updatedAt + 1 })).toBeGreaterThan(0);
		await f.expect_overlay_true();
	});

	test("a write to the drafts of two users recomputes them in one job per user", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");
		await f.draft_move(target(x), parent(b), "x.md", f.v);
		await f.settle();
		// U's targets job doc is full, so U's new work goes to the next key.
		const key_of = (scope: Scope) => `${scope.organizationId}:${scope.workspaceId}:${scope.userId}`;
		const fullJobId = await f.t.run(async (ctx) => {
			const key = key_of(f.u);
			return await ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "targets",
				userId: f.u.userId,
				key,
				items: Array.from({ length: 1000 }, () => ({ target: target(a), pendingUpdateId: null, fieldsChanged: false })),
				cursor: null,
				nextAttemptAt: Date.now() + 60 * 60 * 1000,
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "targets",
					key,
					nextAttemptAt: Date.now() + 60 * 60 * 1000,
				}),
				attempts: 0,
			});
		});

		// A hard delete of x removes both users' proposals in one transaction.
		await test_run_with_flush(f.t, (ctx) => files_nodes_db_hard_delete_node(ctx, { ...f.u, nodeId: x._id }));
		expect((await f.overlay(target(x))).place).not.toBe(null);
		expect((await f.overlay(target(x), f.v)).place).not.toBe(null);
		const jobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "targets"))
				.collect(),
		);
		expect(jobs.map((job) => [job.key, job.kind === "targets" ? job.items.length : 0]).sort()).toEqual(
			[
				[key_of(f.u), 1000],
				[`${key_of(f.u)}:1`, 1],
				[key_of(f.v), 1],
			].sort(),
		);

		await f.t.run((ctx) => ctx.db.delete("files_pending_overlay_jobs", fullJobId));
		await f.settle();
		expect((await f.overlay(target(x))).place).toBe(null);
		expect((await f.overlay(target(x), f.v)).place).toBe(null);
		await f.expect_overlay_true();
	});

	test("an Accept that also writes another user's draft keeps the accepting user's docs exact at once", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(null, "x.md");
		const y = await f.saved(null, "y.md");
		await f.draft_move(target(x), parent(a), "x.md");
		const proposal = await f.proposal_of(target(x));

		// Like `commit_unit`: U's draft goes, and the same transaction writes V's draft.
		await test_run_with_flush(f.t, async (ctx) => {
			files_pending_overlay_db_set_acting_user(ctx, f.u.userId);
			await ctx.db.delete("files_pending_updates", proposal._id);
			await ctx.db.insert(
				"files_pending_updates",
				proposal_doc(f.v, target(y), { pendingArchive: { fromPath: y.path } }),
			);
		});
		// No job ran yet: U's docs of x are gone, and V's change waits in V's targets job.
		expect(await f.overlay(target(x))).toEqual({ hidden: false, place: null });
		expect((await f.overlay(target(y), f.v)).hidden).toBe(false);
		const jobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "targets"))
				.collect(),
		);
		expect(jobs.map((job) => job.kind === "targets" && job.userId)).toEqual([f.v.userId]);

		await f.settle();
		expect((await f.overlay(target(y), f.v)).hidden).toBe(true);
		await f.expect_overlay_true();
	});

	test("a write to two users' drafts that changes a draft's metadata syncs its place fields in the job", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		await f.set_metadata("/p", [{ key: "status", value: "draft" }]);
		const y = await f.saved(null, "y.md");
		await f.expect_overlay_true();
		const place = (await f.overlay(folder)).place!;

		// One transaction changes U's metadata value and writes V's draft, so U's recompute goes to
		// U's targets job.
		await test_run_with_flush(f.t, async (ctx) => {
			const docs = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", place.pendingUpdateId))
				.collect();
			for (const doc of docs)
				if (doc.stringValue === "draft") await ctx.db.patch("files_metadata_docs", doc._id, { stringValue: "done" });
			await ctx.db.insert(
				"files_pending_updates",
				proposal_doc(f.v, target(y), { pendingArchive: { fromPath: y.path } }),
			);
		});
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) =>
					q.eq("kind", "targets").eq("key", `${f.u.organizationId}:${f.u.workspaceId}:${f.u.userId}`),
				)
				.unique(),
		);
		expect(job).toMatchObject({
			items: [{ target: folder, pendingUpdateId: place.pendingUpdateId, fieldsChanged: true }],
		});

		await f.settle();
		expect((await f.overlay(folder)).place!.fieldsVersion).toBeGreaterThan(place.fieldsVersion);
		const fields = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_place_fields")
				.withIndex("by_place", (q) => q.eq("placeId", place._id))
				.collect(),
		);
		expect(fields.map((field) => field.stringValue).filter(Boolean)).toEqual(["done"]);
		await f.expect_overlay_true();
	});

	test("a hard deleted draft target sends its claim to the owner's job", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const p = await f.saved(null, "p", "folder");
		const x = await f.saved(a, "x.md");
		// U drafts `mv /a/x.md /p/n.md`, then a save adds /p/n.md: U's draft claims its name.
		await f.draft_move(target(x), parent(p), "n.md");
		const n = await f.saved(p, "n.md");
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(true);

		await test_run_with_flush(f.t, (ctx) => files_nodes_db_hard_delete_node(ctx, { ...f.u, nodeId: x._id }));
		// U's own docs of x go at once; the claim on /p/n.md ends in U's targets job.
		expect((await f.overlay(target(x))).place).toBe(null);
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("a claim ends when the private claimer goes after its proposal", async () => {
		const f = await fixture();
		const p = await f.saved(null, "p", "folder");
		const claimer = await f.create_private("/p/n", "folder");
		const n = await f.saved(p, "n", "folder");
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(true);

		// The proposal goes first: the active private node still claims the name.
		const proposal = await f.proposal_of(claimer);
		await test_run_with_flush(f.t, (ctx) => ctx.db.delete("files_pending_updates", proposal._id));
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.delete("files_pending_nodes", claimer.id as Id<"files_pending_nodes">),
		);
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("a second flush in one mutation walks a folder's places again", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");

		// One mutation drafts `rm -r /b`, checks its limits (a flush), then undoes the draft.
		await test_run_with_flush(f.t, async (ctx) => {
			const id = await ctx.db.insert(
				"files_pending_updates",
				proposal_doc(f.u, target(b), { pendingArchive: { fromPath: "/b" } }),
			);
			await files_pending_overlay_db_flush(ctx);
			const place = await ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q.eq("target.kind", "saved").eq("target.id", x._id).eq("userId", f.u.userId),
				)
				.unique();
			expect(place).toMatchObject({ isVisible: false });
			await ctx.db.delete("files_pending_updates", id);
		});
		expect((await f.overlay(target(x))).place).toMatchObject({ isVisible: true });
		await f.expect_overlay_true();
	});

	test("with 45 moved files, the inline step does all of them and leaves no job", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const files: Doc<"files_nodes">[] = [];
		for (let index = 0; index < 45; index++) {
			const file = await f.saved(a, `x${String(index).padStart(2, "0")}.md`);
			await f.draft_move(target(file), parent(b), file.name);
			files.push(file);
		}
		await f.settle();

		await f.draft_delete(target(b));
		const visible = await Promise.all(files.map(async (file) => (await f.overlay(target(file))).place!.isVisible));
		expect(visible.filter(Boolean)).toHaveLength(0);
		const ownerPathJobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "owner_path"))
				.collect(),
		);
		expect(ownerPathJobs).toEqual([]);
		await f.expect_overlay_true();
	}, 120_000);

	test("crafted docs in a second workspace of the organization stay in their workspace", async () => {
		const f = await fixture();
		const second: Scope = {
			...f.u,
			workspaceId: await f.t.run((ctx) =>
				ctx.db.insert("organizations_workspaces", {
					organizationId: f.u.organizationId,
					name: "second",
					description: "",
					default: false,
					pluginInstallAccess: "owner",
					updatedAt: Date.now(),
				}),
			),
		};
		// In each workspace U drafts `mv /b/x.md /a/`.
		const moved: Array<{ scope: Scope; a: Doc<"files_nodes">; x: Doc<"files_nodes"> }> = [];
		for (const scope of [f.u, second]) {
			const { a, x } = await test_run_with_flush(f.t, async (ctx) => {
				const a = await insert_saved_node(ctx, scope, { parent: null, name: "a", kind: "folder" });
				const b = await insert_saved_node(ctx, scope, { parent: null, name: "b", kind: "folder" });
				const x = await insert_saved_node(ctx, scope, { parent: b, name: "x.md", kind: "file" });
				await ctx.db.insert(
					"files_pending_updates",
					proposal_doc(scope, target(x), {
						pendingMove: { destParent: parent(a), destName: "x.md", fromPath: x.path },
					}),
				);
				return { a, x };
			});
			moved.push({ scope, a, x });
		}
		// One write drafts `rm -r /a` in both: each workspace's walk of `/a/` runs.
		await test_run_with_flush(f.t, async (ctx) => {
			for (const { scope, a } of moved)
				await ctx.db.insert(
					"files_pending_updates",
					proposal_doc(scope, target(a), { pendingArchive: { fromPath: "/a" } }),
				);
		});
		for (const { x } of moved) expect((await f.overlay(target(x))).place).toMatchObject({ isVisible: false });

		// A proposal doc of the second workspace on a node of the first is not the first one's draft.
		const y = await f.saved(null, "y.md");
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.insert(
				"files_pending_updates",
				proposal_doc(second, target(y), { pendingArchive: { fromPath: "/y.md" } }),
			),
		);
		await test_run_with_flush(f.t, async (ctx) =>
			files_pending_overlay_db_mark_target(ctx, { ...f.u, target: target(y) }),
		);
		expect((await f.overlay(target(y))).hidden).toBe(false);
	});

	test("a place's parent becomes the saved folder only through the owner's own receipt", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		const p = await f.create_private("/p", "folder");
		const c = await f.create_private("/p/c.md");
		// A receipt of another user for U's private folder (impossible data).
		await test_run_with_flush(f.t, async (ctx) => {
			const privateNodeId = p.id as Id<"files_pending_nodes">;
			await ctx.db.patch("files_pending_nodes", privateNodeId, { state: "published" });
			await ctx.db.insert("files_pending_node_publish_receipts", {
				...f.v,
				privateNodeId,
				creationGeneration: 0,
				structuralRevision: 0,
				proposalRevision: 0,
				savedNodeId: s._id,
				createdAt: Date.now(),
			});
			files_pending_overlay_db_mark_target(ctx, { ...f.u, target: c });
		});
		expect((await f.overlay(c)).place?.parent).toEqual({ kind: "private", id: p.id });
	});

	test("two writes of one private node in Promise.all read its old doc once", async () => {
		const f = await fixture();
		const p = await f.create_private("/p.md");
		const ranges = await test_run_with_flush(f.t, async (ctx) => {
			const before = await ctx.meta.getTransactionMetrics();
			const privateNodeId = p.id as Id<"files_pending_nodes">;
			await Promise.all([
				ctx.db.patch("files_pending_nodes", privateNodeId, { name: "q.md" }),
				ctx.db.patch("files_pending_nodes", privateNodeId, { structuralRevision: 5 }),
			]);
			return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
		});
		expect(ranges, "Concurrent writes reuse the old node and the workspace check").toBe(2);
		expect((await f.overlay(p)).place).toMatchObject({ name: "q.md", ownerTreePath: "/q.md" });
	});
});

describe("files_pending_overlay jobs", () => {
	test("a job that throws once is retried by the recover cron", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");
		await f.settle();

		// V's archive of /b schedules the parent job, and its first run throws.
		let failures = 0;
		test_spy_handler((await import("./files_pending_overlay.ts")).run_job, async (handler, ctx, args) => {
			if ((args as { kind: string }).kind === "parent" && failures++ === 0) throw new Error("test failure");
			return await handler(ctx, args);
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await f.v_archive({ id: b._id });
		expect(failures).toBe(1);
		expect((await f.overlay(target(x))).place).toMatchObject({ isVisible: true });
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "parent"))
				.unique(),
		);
		expect(job).toMatchObject({ attempts: 0 });

		// The cron finds the late task and runs the job again.
		vi.setSystemTime(Date.now() + 16 * 60 * 1000);
		await f.t.mutation(internal.files_pending_overlay.recover_jobs, {});
		await f.settle();
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual([]);
		await f.expect_overlay_true();
	});

	test("a run scheduled for an older nextAttemptAt does nothing, so one job never runs two chains", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		await f.settle();
		const nextAttemptAt = Date.now();
		const jobId = await f.t.run(async (ctx) =>
			ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "saved_node",
				savedNodeId: x._id,
				key: x._id,
				cursor: null,
				nextAttemptAt,
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "saved_node",
					key: x._id,
					nextAttemptAt,
				}),
				attempts: 0,
			}),
		);
		const read_state = () =>
			f.t.run(async (ctx) => ({
				job: await ctx.db.get("files_pending_overlay_jobs", jobId),
				scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
			}));
		const before = await read_state();

		// A run retried after a newer write rescheduled the job: it must not work or schedule a next run.
		await f.t.mutation(internal.files_pending_overlay.run_job, {
			kind: "saved_node",
			key: x._id,
			nextAttemptAt: nextAttemptAt - 1,
		});
		expect(await read_state()).toEqual(before);

		await f.t.mutation(internal.files_pending_overlay.run_job, { kind: "saved_node", key: x._id, nextAttemptAt });
		// The run it was scheduled for does work.
		expect(await read_state()).not.toEqual(before);
	});

	test("a job asked again in the middle of its pass ends the pass, then walks once more", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");
		await f.settle();
		// x's saved node job is in its places stream.
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "saved_node",
				savedNodeId: x._id,
				key: x._id,
				cursor: JSON.stringify({ phase: 2, page: null, isDone: false, pending: [] }),
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(0, internal.files_pending_overlay.run_job, {
					kind: "saved_node",
					key: x._id,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});

		// Change the ordinary source without driving its queued overlay job.
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", x._id, {
				name: "y.md",
				sortName: files_sort_text_key("y.md"),
				path: "/a/y.md",
				treePath: "/a/y.md",
				updatedAt: x.updatedAt + 1,
			}),
		);
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "saved_node").eq("key", x._id))
				.unique(),
		);
		expect(JSON.parse(job!.cursor!)).toMatchObject({ phase: 2, rerun: true });

		await f.settle();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual([]);
		await f.expect_overlay_true();
	});

	test("a saved node job that moved starts the places at its new spot from the first", async () => {
		const f = await fixture();
		// pNew sorts before pOld, so a cursor of the old spot is past every doc at the new one.
		const pNew = await f.saved(null, "pnew", "folder");
		const pOld = await f.saved(null, "pold", "folder");
		const x = await f.saved(pOld, "x");
		const claimer = await f.create_private("/pnew/x");
		await f.create_private("/pold/y", "file", f.v);
		await f.settle();
		// The cursor of one page at x's old spot, after V's private /pold/y.
		const page = await f.t.run(async (ctx) => {
			const y = await ctx.db
				.query("files_pending_places")
				.withIndex("by_org_ws_user_ownerTreePath", (q) =>
					q.eq("organizationId", f.v.organizationId).eq("workspaceId", f.v.workspaceId).eq("userId", f.v.userId),
				)
				.first();
			await ctx.db.patch("files_pending_places", y!._id, { name: "x" });
			return await ctx.db
				.query("files_pending_places")
				.withIndex("by_org_ws_parent_name", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined)
						.eq("parent.kind", "saved")
						.eq("parent.id", pOld._id)
						.eq("name", "x"),
				)
				.paginate({ cursor: null, numItems: 1 });
		});
		expect(page.page).toHaveLength(1);
		// Put the place back, so only the job's own spot check is under test.
		await f.t.run((ctx) => ctx.db.patch("files_pending_places", page.page[0]!._id, { name: "y" }));
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				kind: "saved_node",
				savedNodeId: x._id,
				key: x._id,
				cursor: JSON.stringify({
					phase: 3,
					page: page.continueCursor,
					isDone: false,
					pending: [],
					range: `${pOld._id}:x`,
				}),
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "saved_node",
					key: x._id,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});

		// V moves x next to U's private /pnew/x, which then claims its name.
		const moved = await test_move_nodes(f.t, f.asV, {
			membershipId: f.vMember.membershipId,
			itemIds: [x._id],
			targetParentId: pNew._id,
		});
		if (moved._nay) throw new Error(moved._nay.message);
		await f.run_job("saved_node", x._id);
		expect((await f.overlay(target(x))).hidden).toBe(true);
		expect((await f.overlay(claimer)).place).toMatchObject({ ownerTreePath: "/pnew/x" });
		await f.expect_overlay_true();
	});

	test("a saved node job stores no metadata key in its cursor when it repairs pending metadata scope", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		// A Convex cursor holds the index key of its last doc. A real key can be 500k chars long, and
		// a cursor with it is too large to store in the job doc.
		const longKey = "k".repeat(2_000);
		const docCount = 6;
		await test_run_with_flush(f.t, async (ctx) => {
			for (const scope of [f.u, f.v]) {
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", proposal_doc(scope, target(x), {}));
				for (let index = 0; index < docCount; index++)
					await ctx.db.insert("files_metadata_docs", {
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						sourceKind: "pending",
						target: target(x),
						userId: scope.userId,
						pendingUpdateId,
						proposalRevision: 1,
						path: x.path,
						treePath: x.treePath,
						fieldPath: `frontmatter.${longKey}${index}`,
						docKind: "field",
					});
			}
		});
		await f.settle();

		// A saved write of a new path sends the scope repair to x's saved node job.
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", x._id, {
				name: "y.md",
				sortName: files_sort_text_key("y.md"),
				path: "/y.md",
				treePath: "/y.md",
			}),
		);
		const cursors: string[] = [];
		for (let run = 0; run < 50; run++) {
			const job = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_kind_key", (q) => q.eq("kind", "saved_node").eq("key", x._id))
					.unique(),
			);
			if (!job) break;
			if (job.cursor) cursors.push(job.cursor);
			await f.run_job("saved_node", x._id);
		}
		expect(cursors.some((cursor) => JSON.parse(cursor).phase === 5)).toBe(true);
		expect(
			cursors.filter((cursor) => cursor.includes(longKey)),
			"no stored cursor holds the metadata key",
		).toEqual([]);
		const metadata = await f.t.run((ctx) =>
			ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_target_fieldPath", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("target.kind", "saved")
						.eq("target.id", x._id),
				)
				.collect(),
		);
		expect(metadata).toHaveLength(2 * docCount);
		expect(metadata.every((doc) => doc.path === "/y.md" && doc.treePath === "/y.md")).toBe(true);
	});

	test("an owner path job walks a folder that moved behind the place it reached", async () => {
		const f = await fixture();
		const j = await f.saved(null, "j", "folder");
		const b = await f.saved(j, "b", "folder");
		const e = await f.saved(j, "e", "folder");
		await f.saved(j, "m", "folder");
		const s = await f.saved(j, "s", "folder");
		const g = await f.saved(s, "g", "folder");
		// U drafts `mv /j/s/g /j/b/`, a private file in g, 100 private files in /j/m and a folder /j/w.
		await f.draft_move(target(g), parent(b), "g");
		const child = await f.create_private("/j/b/g/c.md");
		for (let index = 0; index < 100; index++) await f.create_private(`/j/m/f${String(index).padStart(3, "0")}.md`);
		const w = await f.create_private("/j/w", "folder");
		await f.settle();
		const key = `${f.u.organizationId}:${f.u.workspaceId}:${f.u.userId}:/j/`;
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				...f.u,
				kind: "owner_path",
				prefix: "/j/",
				key,
				cursor: null,
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "owner_path",
					key,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});
		// The first run walks one page: g, c.md and 98 files of /j/m.
		await f.run_job("owner_path", key);

		// Changes only the job's walk finds: g's draft now goes to /j/e, and /j/w is now /j/s/g. The
		// second run reaches /j/w, whose claim recomputes g behind the place the job reached.
		await f.t.run(async (ctx) => {
			const proposal = (await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.u.userId).eq("target.kind", "saved").eq("target.id", g._id),
				)
				.unique())!;
			await ctx.db.patch("files_pending_updates", proposal._id, {
				pendingMove: { ...proposal.pendingMove!, destParent: parent(e) },
			});
			await ctx.db.patch("files_pending_nodes", w.id as Id<"files_pending_nodes">, {
				parent: parent(s),
				name: "g",
			});
		});
		await f.run_job("owner_path", key);
		await f.settle();
		expect((await f.overlay(target(g))).place).toMatchObject({ ownerTreePath: "/j/e/g/" });
		expect((await f.overlay(child)).place).toMatchObject({ ownerTreePath: "/j/e/g/c.md" });
		await f.expect_overlay_true();
	}, 120_000);

	test("an owner path job keeps the furthest place it marked when a place of its page moved back", async () => {
		const f = await fixture();
		await f.saved(null, "j", "folder");
		const b = await f.create_private("/j/b", "folder");
		const c = await f.create_private("/j/b/c.md");
		const z = await f.create_private("/j/z.md");
		await f.settle();
		const placeIds = await f.t.run(async (ctx) =>
			Promise.all(
				[b, z].map(
					async (privateTarget) =>
						(await ctx.db
							.query("files_pending_places")
							.withIndex("by_target_user", (q) =>
								q.eq("target.kind", "private").eq("target.id", privateTarget.id).eq("userId", f.u.userId),
							)
							.unique())!._id,
				),
			),
		);
		// U's private /j/b is now /j/y, a change only the job's walk finds.
		await f.t.run((ctx) => ctx.db.patch("files_pending_nodes", b.id as Id<"files_pending_nodes">, { name: "y" }));
		// The job read its last page and marked places up to /j/m.md. b's place, left on that page, moved
		// back since. z keeps the job in its first stream after b: the near-limit check before z flushes
		// b's walk request.
		const key = `${f.u.organizationId}:${f.u.workspaceId}:${f.u.userId}:/j/`;
		await f.t.run(async (ctx) => {
			await ctx.db.insert("files_pending_overlay_jobs", {
				...f.u,
				kind: "owner_path",
				prefix: "/j/",
				key,
				cursor: JSON.stringify({ phase: 0, page: null, isDone: true, pending: placeIds, lastPath: "/j/m.md" }),
				nextAttemptAt: Date.now(),
				scheduledFunctionId: await ctx.scheduler.runAfter(60 * 60 * 1000, internal.files_pending_overlay.run_job, {
					kind: "owner_path",
					key,
					nextAttemptAt: Date.now(),
				}),
				attempts: 0,
			});
		});

		// b's walk of /j/b/ is behind /j/m.md, so it gets its own job and moves c.
		await f.run_job("owner_path", key);
		await f.settle();
		expect((await f.overlay(c)).place).toMatchObject({ ownerTreePath: "/j/y/c.md" });
		await f.expect_overlay_true();
	});

	test("a parent job reuses its reader across the places it walks", async () => {
		// A job stops when fewer than 2,048 ranges are left, so this limit leaves the parent job 800 ranges.
		// One reader reads the 20 folders once: about 330 ranges for 25 places. A new reader per place reads
		// them again, about 100 ranges per place.
		const f = await fixture({ databaseQueries: 2_048 + 800 });
		const top = await f.saved(null, "c00", "folder");
		let folder = top;
		let path = "/c00";
		for (let depth = 1; depth < 20; depth++) {
			const name = `c${String(depth).padStart(2, "0")}`;
			folder = await f.saved(folder, name, "folder");
			path += `/${name}`;
		}
		for (let index = 0; index < 25; index++) await f.create_private(`${path}/f${String(index).padStart(3, "0")}.md`);
		await f.settle();

		let parentRuns = 0;
		test_spy_handler((await import("./files_pending_overlay.ts")).run_job, async (handler, ctx, args) => {
			if ((args as { kind: string }).kind === "parent") parentRuns++;
			return await handler(ctx, args);
		});
		// Use an ordinary source write. Move stages its own owner views.
		const renamedPath = `${path.slice(0, path.lastIndexOf("/"))}/bottom`;
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", folder._id, {
				name: "bottom",
				sortName: files_sort_text_key("bottom"),
				path: renamedPath,
				treePath: `${renamedPath}/`,
				updatedAt: folder.updatedAt + 1,
			}),
		);
		await f.settle();
		// Places, incoming moves, private children and typed dependencies each have a native page.
		expect(parentRuns).toBe(4);
		await f.expect_overlay_true();
	}, 120_000);

	test("a repair syncs a place's fields once", async () => {
		const f = await fixture();
		await f.create_private("/m", "folder");
		await f.set_metadata(
			"/m",
			Array.from({ length: 128 }, (_, index) => ({ key: `k${index}`, value: `v${index}` })),
		);
		await f.settle();

		let documentsRead = 0;
		test_spy_handler((await import("./files_pending_overlay.ts")).run_job, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			if ((args as { kind: string }).kind === "repair_user")
				documentsRead += (await ctx.meta.getTransactionMetrics()).documentsRead.used;
			return result;
		});
		await f.t.mutation(internal.files_pending_overlay.repair_user, { ...f.u, cursor: null });
		await f.settle();
		// About 1,000 docs. A sync per field doc would read the 128 fields again for each one.
		expect(documentsRead).toBeLessThan(3_000);
		await f.expect_overlay_true();
	}, 120_000);
});

describe("files_share_rows", () => {
	test("share dialog writes keep one row per shared user or role", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		// The owner holds no grant, so the new restricted folder has no row.
		expect(await share_keys(f, s._id)).toEqual([]);

		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);
		// "manage" adds more grants, but only the read grant has a row.
		await f.share(s, { kind: "user", userId: f.v.userId }, "manage");
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);
		// A role share is one row, not one row per member.
		await f.share(s, { kind: "role", role: "member" }, "read");
		expect(await share_keys(f, s._id)).toEqual(["role:member", `user:${f.v.userId}`]);

		await f.as_u(() =>
			f.asU.mutation(api.files_sharing.remove_node_share_grant, {
				membershipId: f.db.membershipId,
				nodeId: s._id,
				principal: { kind: "user", userId: f.v.userId },
			}),
		);
		expect(await share_keys(f, s._id)).toEqual(["role:member"]);
		await f.expect_share_rows_true();
	});

	test("rows follow a rename, move, archive and restore of the shared folder and of its parent", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const s = await f.saved(a, "s", "folder");
		const b = await f.saved(null, "b", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		const membershipId = f.db.membershipId;

		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId, nodeId: s._id, path: "t" }));
		expect(await share_rows(f, s._id)).toMatchObject([{ name: "t", parentId: a._id, treePath: "/a/t/" }]);
		// The parent's rename writes the shared folder's new `treePath`.
		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId, nodeId: a._id, path: "a2" }));
		expect(await share_rows(f, s._id)).toMatchObject([{ name: "t", parentId: a._id, treePath: "/a2/t/" }]);
		await f.as_u(() => test_move_nodes(f.t, f.asU, { membershipId, itemIds: [s._id], targetParentId: b._id }));
		expect(await share_rows(f, s._id)).toMatchObject([{ name: "t", parentId: b._id, treePath: "/b/t/" }]);
		await f.expect_share_rows_true();

		// Archiving the parent archives the shared folder too. Archived rows stay.
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [b._id] }));
		expect((await share_rows(f, s._id))[0]?.archiveOperationId).not.toBe(null);
		await f.as_u(() => f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [b._id] }));
		expect(await share_rows(f, s._id)).toMatchObject([{ archiveOperationId: null, treePath: "/b/t/" }]);
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [s._id] }));
		expect((await share_rows(f, s._id))[0]?.archiveOperationId).not.toBe(null);
		await f.as_u(() => f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [s._id] }));
		expect(await share_rows(f, s._id)).toMatchObject([{ archiveOperationId: null }]);
		await f.expect_share_rows_true();
	});

	test("rows follow a restore that lands the folder above a shared folder at a new path", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(a, "b", "folder");
		const s = await f.saved(b, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		const membershipId = f.db.membershipId;

		// `s` has its own archive, so the restore of `b` only moves it. `a` stays archived, so `b` lands
		// at the root, and the restore's job writes the new `treePath` of `s` through the flush.
		for (const node of [s, b, a])
			await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [node._id] }));
		await f.as_u(() => f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [b._id] }));
		expect(await share_rows(f, s._id)).toMatchObject([{ treePath: "/b/s/", archiveOperationId: expect.any(String) }]);
		await f.expect_share_rows_true();
	});

	test("rows live only while their node is a restricted or extended root", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		await f.share(s, { kind: "role", role: "member" }, "read");

		// A node write alone ends and brings back the rows, while the grants stay.
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", s._id, { restrictedScopeNodeId: null, isRestrictedScopeRoot: false }),
		);
		expect(await share_keys(f, s._id)).toEqual([]);
		await f.expect_share_rows_true();
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", s._id, { restrictedScopeNodeId: s._id, isRestrictedScopeRoot: true }),
		);
		expect(await share_keys(f, s._id)).toEqual(["role:member", `user:${f.v.userId}`]);

		await f.as_u(() =>
			f.asU.mutation(api.files_sharing.unrestrict_node, { membershipId: f.db.membershipId, nodeId: s._id }),
		);
		// Unrestrict keeps the list as added people, so the rows stay.
		expect(await share_keys(f, s._id)).toEqual(["role:member", `user:${f.v.userId}`]);
		await f.expect_share_rows_true();
	});

	test("a hard deleted shared file leaves no row", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		await f.restrict(x);
		await f.share(x, { kind: "user", userId: f.v.userId }, "read");
		expect(await share_rows(f, x._id)).toMatchObject([{ kind: "file", lowercaseExtension: "md" }]);

		await test_run_with_flush(f.t, (ctx) => files_nodes_db_hard_delete_node(ctx, { ...f.u, nodeId: x._id }));
		expect(await share_keys(f, x._id)).toEqual([]);
		await f.expect_share_rows_true();
	});

	test("removing a member from the organization removes the member's rows", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		await f.share(s, { kind: "role", role: "member" }, "read");

		// The fixture inserts V's membership directly. Removal also needs V's credential quota.
		await f.t.run((ctx) => quotas_db_ensure(ctx, { quotaName: "active_api_credentials", ...f.v, now: Date.now() }));
		await f.as_u(() =>
			f.asU.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.u.organizationId,
				userIdToRemove: f.v.userId,
			}),
		);
		expect(await share_keys(f, s._id)).toEqual(["role:member"]);
		await f.expect_share_rows_true();
	});

	test("a grant of another workspace on the node gets no row, also after the node changes", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		const secondWorkspaceId = await f.t.run((ctx) =>
			ctx.db.insert("organizations_workspaces", {
				organizationId: f.u.organizationId,
				name: "second",
				description: "",
				default: false,
				pluginInstallAccess: "owner",
				updatedAt: Date.now(),
			}),
		);
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: f.u.organizationId,
				workspaceId: secondWorkspaceId,
				resourceKind: "file",
				resourceId: String(s._id),
				principalKind: "user",
				userId: f.v.userId,
				permission: "content.read",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		expect(await share_keys(f, s._id)).toEqual([]);

		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId: f.db.membershipId, nodeId: s._id, path: "t" }));
		expect(await share_keys(f, s._id)).toEqual([]);
		await f.expect_share_rows_true();
		await f.expect_share_rows_true(secondWorkspaceId);
	});

	test("a service account grant gets a row on a shared folder and on an extended node, a public grant none", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		const o = await f.saved(null, "o", "folder");
		const x = await f.saved(o, "x.md");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		const serviceAccountId = await test_run_with_flush(f.t, async (ctx) => {
			const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				name: "bot",
				createdBy: f.u.userId,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				revokedAt: null,
			});
			for (const principal of [
				{ principalKind: "service_account" as const, serviceAccountId },
				{ principalKind: "public" as const },
			])
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: f.u.organizationId,
					workspaceId: f.u.workspaceId,
					resourceKind: "file",
					resourceId: String(s._id),
					...principal,
					permission: "content.read",
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			// An account grant makes the open node an extended root, which has share rows.
			const granted = await access_control_db_set_service_account_grant(ctx, {
				...f.u,
				serviceAccountId,
				resource: { kind: "file", nodeId: x._id },
				level: "read",
			});
			if (granted._nay) throw new Error(granted._nay.message);
			return serviceAccountId;
		});
		const accountKey = `service_account:${serviceAccountId}`;
		expect(await share_keys(f, s._id)).toEqual([accountKey, `user:${f.v.userId}`]);
		expect(await share_rows(f, x._id)).toMatchObject([{ principalKey: accountKey, treePath: "/o/x.md" }]);

		// The open node's row follows a rename of the node and above it and an archive. It stays when the
		// node moves into a restricted folder: an item keeps its added people there.
		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId: f.db.membershipId, nodeId: x._id, path: "y.md" }));
		expect(await share_rows(f, x._id)).toMatchObject([{ principalKey: accountKey, treePath: "/o/y.md" }]);
		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId: f.db.membershipId, nodeId: o._id, path: "o2" }));
		expect(await share_rows(f, x._id)).toMatchObject([{ principalKey: accountKey, treePath: "/o2/y.md" }]);
		await f.as_u(() =>
			f.asU.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [x._id] }),
		);
		expect((await share_rows(f, x._id))[0]?.archiveOperationId).not.toBe(null);
		await f.as_u(() =>
			f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId: f.db.membershipId, nodeIds: [x._id] }),
		);
		expect(await share_rows(f, x._id)).toMatchObject([{ archiveOperationId: null }]);
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, { membershipId: f.db.membershipId, itemIds: [x._id], targetParentId: s._id }),
		);
		expect(await share_keys(f, x._id)).toEqual([accountKey]);
		await f.expect_share_rows_true();
	});

	test("a grant write that is not a file grant marks nothing", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		const grant = (resourceKind: "workspace" | "plugin_scope" | "file", resourceId: string) => ({
			organizationId: f.u.organizationId,
			workspaceId: f.u.workspaceId,
			resourceKind,
			resourceId,
			principalKind: "user" as const,
			userId: f.v.userId,
			permission: "content.read" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const flush_ranges = async (write: (ctx: MutationCtx) => Promise<unknown>) =>
			await test_run_with_flush(f.t, async (ctx) => {
				await write(ctx);
				const before = await ctx.meta.getTransactionMetrics();
				await files_pending_overlay_db_flush(ctx);
				return (await ctx.meta.getTransactionMetrics()).databaseQueries.used - before.databaseQueries.used;
			});

		expect(
			await flush_ranges(async (ctx) => {
				const workspaceGrantId = await ctx.db.insert(
					"access_control_permission_grants",
					grant("workspace", f.u.workspaceId),
				);
				const scopeGrantId = await ctx.db.insert(
					"access_control_permission_grants",
					grant("plugin_scope", "plugin:scope"),
				);
				await ctx.db.patch("access_control_permission_grants", workspaceGrantId, { updatedAt: Date.now() + 1 });
				await ctx.db.delete("access_control_permission_grants", scopeGrantId);
			}),
		).toBe(0);
		// A file grant write still syncs its row.
		expect(
			await flush_ranges((ctx) => ctx.db.insert("access_control_permission_grants", grant("file", String(s._id)))),
		).toBeGreaterThan(0);
		expect(await f.t.run((ctx) => ctx.db.query("files_share_rows").collect())).toEqual([]);
		await f.expect_share_rows_true();
	});

	test("a size patch and a content save of a shared file update its rows", async () => {
		const f = await fixture();
		const x = await f.saved(null, "x.md");
		await f.restrict(x);
		await f.share(x, { kind: "user", userId: f.v.userId }, "read");

		// A materialization patches the size alone. A content save also patches `updatedAt`.
		await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", x._id, { contentByteSize: 42 }));
		expect(await share_rows(f, x._id)).toMatchObject([{ contentByteSize: 42 }]);
		const savedAt = Date.now() + 1000;
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", x._id, { contentByteSize: 99, updatedBy: f.u.userId, updatedAt: savedAt }),
		);
		expect(await share_rows(f, x._id)).toMatchObject([{ contentByteSize: 99, updatedAt: savedAt }]);
		await f.expect_share_rows_true();
	});

	test("a shared folder keeps its rows when its parent is restricted and when it moves into another restricted folder", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const s = await f.saved(a, "s", "folder");
		const r = await f.saved(null, "r", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		await f.restrict(r);
		await f.share(r, { kind: "role", role: "member" }, "read");

		await f.restrict(a);
		expect(await share_keys(f, s._id)).toEqual([`user:${f.v.userId}`]);
		await f.as_u(() =>
			test_move_nodes(f.t, f.asU, {
				membershipId: f.db.membershipId,
				itemIds: [s._id],
				targetParentId: r._id,
			}),
		);
		expect(await share_rows(f, s._id)).toMatchObject([{ principalKey: `user:${f.v.userId}`, parentId: r._id }]);
		expect(await share_keys(f, r._id)).toEqual(["role:member"]);
		await f.expect_share_rows_true();
	});

	test("a node write that changes only its workspace drops its rows", async () => {
		const f = await fixture();
		const s = await f.saved(null, "s", "folder");
		await f.restrict(s);
		await f.share(s, { kind: "user", userId: f.v.userId }, "read");
		const secondWorkspaceId = await f.t.run((ctx) =>
			ctx.db.insert("organizations_workspaces", {
				organizationId: f.u.organizationId,
				name: "second",
				description: "",
				default: false,
				pluginInstallAccess: "owner",
				updatedAt: Date.now(),
			}),
		);

		// No app code moves a node to another workspace. The rows must still never copy such a node.
		await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", s._id, { workspaceId: secondWorkspaceId }));
		expect(await share_keys(f, s._id)).toEqual([]);
		await f.expect_share_rows_true();
		await f.expect_share_rows_true(secondWorkspaceId);
	});
});

describe("files_nodes ancestors", () => {
	/**
	 * The active node at a path, with its stored ancestor ids.
	 */
	const node_at = async (f: Fixture, path: string) => {
		const node = await f.t.run((ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", f.u.organizationId)
						.eq("workspaceId", f.u.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("path", path),
				)
				.first(),
		);
		if (!node) throw new Error(`Expected a node at ${path}`);
		return { ...node, ancestors: files_ancestor_ids(node) };
	};

	/**
	 * Run the jobs, then check that every node copies its parent's ancestors plus the parent.
	 */
	const expect_ancestors_true = async (f: Fixture) => {
		await f.settle();
		const differences: string[] = [];
		let cursor: string | null = null;
		do {
			const page: { differences: string[]; cursor: string | null } = await f.t.query(
				internal.files_pending_overlay.check_ancestors,
				{ cursor },
			);
			differences.push(...page.differences);
			cursor = page.cursor;
		} while (cursor);
		expect(differences).toEqual([]);
	};

	test("inserts, a rename, a move and a nested move keep every node's ancestors", async () => {
		const f = await fixture();
		const membershipId = f.db.membershipId;
		// Each mutation inserts a folder and the folders inside it in one round.
		const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.u, path: "/a/b/c" });
		if (created._nay) throw new Error(created._nay.message);
		await f.as_u(() =>
			f.asU.mutation(api.files_nodes.create_folder_node, { membershipId, parentId: files_ROOT_ID, path: "d/e" }),
		);
		const a = await node_at(f, "/a");
		const b = await node_at(f, "/a/b");
		const d = await node_at(f, "/d");
		expect(a.ancestors).toEqual([]);
		expect((await node_at(f, "/a/b/c")).ancestors).toEqual([a._id, b._id]);
		expect((await node_at(f, "/d/e")).ancestors).toEqual([d._id]);
		await expect_ancestors_true(f);

		// A rename changes paths, not ancestors.
		await f.as_u(() => test_rename_node(f.t, f.asU, { membershipId, nodeId: a._id, path: "a2" }));
		expect((await node_at(f, "/a2/b/c")).ancestors).toEqual([a._id, b._id]);

		// `b` moves into `/d/e`, and its child follows it in the move's subtree step.
		const e = await node_at(f, "/d/e");
		await f.as_u(() => test_move_nodes(f.t, f.asU, { membershipId, itemIds: [b._id], targetParentId: e._id }));
		expect((await node_at(f, "/d/e/b")).ancestors).toEqual([d._id, e._id]);
		expect((await node_at(f, "/d/e/b/c")).ancestors).toEqual([d._id, e._id, b._id]);

		// A nested move: `d` with everything inside moves into `/a2`.
		await f.as_u(() => test_move_nodes(f.t, f.asU, { membershipId, itemIds: [d._id], targetParentId: a._id }));
		expect((await node_at(f, "/a2/d")).ancestors).toEqual([a._id]);
		expect((await node_at(f, "/a2/d/e/b/c")).ancestors).toEqual([a._id, d._id, e._id, b._id]);
		await expect_ancestors_true(f);
	});

	test("a restore under a new parent and an accepted draft move keep every node's ancestors", async () => {
		const f = await fixture();
		const membershipId = f.db.membershipId;
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(a, "b", "folder");
		const x = await f.saved(b, "x.md");
		const z = await f.saved(null, "z", "folder");
		expect((await node_at(f, "/a/b/x.md")).ancestors).toEqual([a._id, b._id]);

		// `b` comes back while its folder stays archived by another operation, so it lands at the root.
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [b._id] }));
		await f.as_u(() => f.asU.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [a._id] }));
		await f.as_u(() => f.asU.mutation(api.files_nodes.unarchive_nodes, { membershipId, nodeIds: [b._id] }));
		expect((await node_at(f, "/b")).ancestors).toEqual([]);
		expect((await node_at(f, "/b/x.md")).ancestors).toEqual([b._id]);
		await expect_ancestors_true(f);

		// The Accept writes the move inside its counted unit.
		await f.draft_move(target(b), parent(z), "b");
		await f.review("accept", [await f.proposal_of(target(b))]);
		expect((await node_at(f, "/z/b")).ancestors).toEqual([z._id]);
		expect((await node_at(f, "/z/b/x.md")).ancestors).toEqual([z._id, b._id]);
		expect(x._id).toBe((await node_at(f, "/z/b/x.md"))._id);
		await expect_ancestors_true(f);
	});

	test("a node more than 12 folders deep keeps the top 12", async () => {
		const f = await fixture();
		const folders: Doc<"files_nodes">[] = [];
		for (let depth = 1; depth <= 14; depth++)
			folders.push(await f.saved(folders.at(-1) ?? null, `f${depth}`, "folder"));
		const deep = await f.saved(folders.at(-1)!, "deep.md");
		const top12 = folders.slice(0, 12).map((folder) => folder._id);
		expect((await node_at(f, deep.path)).ancestors).toEqual(top12);
		expect((await node_at(f, folders[12]!.path)).ancestors).toEqual(top12);
		expect((await node_at(f, folders[11]!.path)).ancestors).toEqual(top12.slice(0, 11));
		await expect_ancestors_true(f);
	});

	test("a files_nodes patch that mixes ancestor fields with other fields throws", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");
		await expect(
			test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", x._id, { ancestor1: a._id, name: "y.md" })),
		).rejects.toThrow("A files_nodes patch mixes ancestor fields with other fields");
	});
});

describe("files_nodes restricted scopes", () => {
	/**
	 * Page `check_restricted_scopes` to the end without running the jobs first.
	 */
	const scope_differences = async (f: Fixture) => {
		const differences: string[] = [];
		const busyWorkspaceIds: Id<"organizations_workspaces">[] = [];
		let cursor: string | null = null;
		do {
			const page: { differences: string[]; busyWorkspaceIds: Id<"organizations_workspaces">[]; cursor: string | null } =
				await f.t.query(internal.files_pending_overlay.check_restricted_scopes, { cursor });
			differences.push(...page.differences);
			busyWorkspaceIds.push(...page.busyWorkspaceIds);
			cursor = page.cursor;
		} while (cursor);
		return { differences: differences.sort(), busyWorkspaceIds };
	};

	test("the check reports a wrong scope, root flag or boundary, a missing parent and an active node in an archived folder", async () => {
		const f = await fixture();
		const r = await f.saved(null, "r", "folder");
		const inner = await f.saved(r, "inner", "folder");
		const x = await f.saved(inner, "x.md");
		const m = await f.saved(null, "m", "folder");
		const z = await f.saved(m, "z.md");
		// More nodes than one page, so the archived folder below is checked on the second page.
		const fill = await f.saved(null, "fill", "folder");
		await test_run_with_flush(f.t, async (ctx) => {
			for (let index = 0; index < 1000; index++)
				await insert_saved_node(ctx, f.u, { parent: fill, name: `${index}.md`, kind: "file" });
		});
		const a = await f.saved(null, "a", "folder");
		const y = await f.saved(a, "y.md");
		await f.restrict(r);
		// An idle Move slot does not make the workspace busy.
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_workspace_slots", {
				organizationId: f.u.organizationId,
				workspaceId: f.u.workspaceId,
				cohortId: null,
				generation: 0,
			}),
		);
		expect(await scope_differences(f)).toEqual({ differences: [], busyWorkspaceIds: [] });

		await test_run_with_flush(f.t, async (ctx) => {
			await ctx.db.patch("files_nodes", x._id, { restrictedScopeNodeId: null });
			await ctx.db.patch("files_nodes", inner._id, { isRestrictedScopeRoot: true });
			await ctx.db.patch("files_nodes", r._id, { isRestrictedScopeRoot: false, parentScopeNodeId: undefined });
			await ctx.db.delete("files_nodes", m._id);
			await ctx.db.patch("files_nodes", a._id, { archiveOperationId: "op" });
		});
		expect(await scope_differences(f)).toEqual({
			differences: [
				`active ${y._id} is in archived folder ${a._id} (archive op op)`,
				`boundary of ${r._id}: stored undefined, expected null`,
				`parent of ${z._id} is missing`,
				`root flag of ${inner._id}: stored true, expected false`,
				`root flag of ${r._id}: stored false, expected true`,
				`scope of ${x._id}: stored null, expected ${r._id}`,
			].sort(),
			busyWorkspaceIds: [],
		});
	});

	test("a workspace with an unfinished subtree op is skipped and listed, and other workspaces are still checked", async () => {
		const f = await fixture();
		const r = await f.saved(null, "r", "folder");
		await f.saved(r, "x.md");
		const q = await f.saved(null, "q.md");
		const secondWorkspaceId = await f.t.run((ctx) =>
			ctx.db.insert("organizations_workspaces", {
				organizationId: f.u.organizationId,
				name: "second",
				description: "",
				default: false,
				pluginInstallAccess: "owner",
				updatedAt: Date.now(),
			}),
		);
		// A difference the skip must hide, and one in another workspace that it must not.
		await test_run_with_flush(f.t, async (ctx) => {
			await ctx.db.patch("files_nodes", r._id, { archiveOperationId: "op" });
			await ctx.db.patch("files_nodes", q._id, { workspaceId: secondWorkspaceId, restrictedScopeNodeId: r._id });
		});
		// More children than one job step, and no job run, so the restrict's scope op stays.
		const s = await f.saved(null, "s", "folder");
		await test_run_with_flush(f.t, async (ctx) => {
			for (let index = 0; index < 100; index++)
				await insert_saved_node(ctx, f.u, { parent: s, name: `${index}.md`, kind: "file" });
		});
		const restricted = await f.asU.mutation(api.files_sharing.restrict_node, {
			membershipId: f.db.membershipId,
			nodeId: s._id,
		});
		expect(restricted._nay).toBeUndefined();
		const op = await f.t.run((ctx) => ctx.db.query("files_subtree_ops").first());
		expect(op?.workspaceId).toBe(f.u.workspaceId);

		expect(await scope_differences(f)).toEqual({
			differences: [`scope of ${q._id}: stored ${r._id}, expected null`],
			busyWorkspaceIds: [f.u.workspaceId],
		});
	});

	test("a workspace with a running Move or a purge is skipped and listed", async () => {
		const f = await fixture();
		const r = await f.saved(null, "r", "folder");
		const x = await f.saved(r, "x.md");
		await test_run_with_flush(f.t, (ctx) => ctx.db.patch("files_nodes", r._id, { archiveOperationId: "op" }));
		expect(await scope_differences(f)).toEqual({
			differences: [`active ${x._id} is in archived folder ${r._id} (archive op op)`],
			busyWorkspaceIds: [],
		});

		await f.t.run((ctx) => test_db_hold_move_slot(ctx, f.db));
		expect(await scope_differences(f)).toEqual({ differences: [], busyWorkspaceIds: [f.u.workspaceId] });

		await f.t.run(async (ctx) => {
			const slot = await ctx.db.query("files_move_workspace_slots").unique();
			if (!slot) throw new Error("Expected a Move slot");
			await ctx.db.replace("files_move_workspace_slots", slot._id, {
				organizationId: slot.organizationId,
				workspaceId: slot.workspaceId,
				cohortId: null,
				generation: slot.generation,
			});
			await ctx.db.patch("organizations_workspaces", f.u.workspaceId, { pluginDataPurgeStartedAt: Date.now() });
		});
		expect(await scope_differences(f)).toEqual({ differences: [], busyWorkspaceIds: [f.u.workspaceId] });
	});
});
