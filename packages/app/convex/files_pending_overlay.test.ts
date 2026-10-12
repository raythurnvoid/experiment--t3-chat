// Each flow writes drafts and saved changes through the real mutations, runs the overlay jobs, then
// compares the stored derived docs with `check_user` and checks the window bound (every hide matches
// one active saved node with the same copied facts). The share row flows compare the share rows with
// `check_share_rows`, and the ancestor flows the saved nodes' ancestors with `check_ancestors`.
//
// The later flush tests and the job, share row and ancestor tests are in files_pending_overlay.jobs.test.ts,
// so the two files can run at the same time.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_rename_node } from "./setup.test.ts";
import { expect_window_bound, fixture, target, parent } from "./files_pending_overlay.setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("files_pending_overlay flush", () => {
	test("private file and folder, then a private move and rename", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		const file = await f.create_private("/p/f.md");
		expect((await f.overlay(folder)).place).toMatchObject({ ownerTreePath: "/p/", isVisible: true, isPathless: false });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/p/f.md", isVisible: true });
		// The folder holds an active draft, so only the file is a Pending row.
		const listed = await f.t.run((ctx) => ctx.db.query("files_pending_list_rows").collect());
		expect(listed.map((row) => row.listKey).sort()).toEqual(["all", "own"]);
		await f.expect_overlay_true();

		// A private folder moves at once: its child follows it.
		await f.draft_move(folder, { kind: "root" }, "q");
		expect((await f.overlay(folder)).place).toMatchObject({ ownerTreePath: "/q/", name: "q", isVisible: true });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/q/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("a saved move and rename in a draft hide the saved node and place it at the destination", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");

		await f.draft_move(target(x), parent(b), "x.md");
		expect(await f.overlay(target(x))).toMatchObject({
			hidden: true,
			place: { ownerTreePath: "/b/x.md", isVisible: true, accessNodeId: x._id },
		});
		await f.expect_overlay_true();

		await f.draft_move(target(x), parent(a), "y.md");
		expect((await f.overlay(target(x))).place).toMatchObject({ ownerTreePath: "/a/y.md", name: "y.md" });
		await f.expect_overlay_true();
	});

	test("a draft delete hides the saved node until undo, a bulk Discard or expiry", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");

		await f.draft_delete(target(x));
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await f.expect_overlay_true();
		await f.undo(target(x));
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();

		await f.draft_delete(target(x));
		await f.review("discard", [await f.proposal_of(target(x))]);
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();

		await f.draft_delete(target(x));
		expect((await f.overlay(target(x))).hidden).toBe(true);
		// U is not active, so the draft expires after 4 hours.
		vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000);
		await f.settle();
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("U's draft delete comes back when V restores the node V archived", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_delete(target(x));

		// V's own transactions keep U's hide true at once, before any job runs.
		const renamed = await test_rename_node(f.t, f.asV, {
			membershipId: f.vMember.membershipId,
			nodeId: x._id,
			path: "y.md",
		});
		expect(renamed._nay).toBeUndefined();
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await expect_window_bound(f.t);
		const archived = await f.asV.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.vMember.membershipId,
			nodeIds: [x._id],
		});
		expect(archived._nay).toBeUndefined();
		expect((await f.overlay(target(x))).hidden).toBe(false);
		await f.expect_overlay_true();

		await f.v_restore({ id: x._id });
		expect((await f.overlay(target(x))).hidden).toBe(true);
		await f.expect_overlay_true();
	});

	test("a draft move of a folder of 40 notes with big metadata, and the fields of a moved note", async () => {
		const f = await fixture();
		const notes = await f.saved(null, "notes", "folder");
		const archive = await f.saved(null, "archive", "folder");
		const files = [];
		for (let index = 0; index < 40; index++) files.push(await f.saved(notes, `n${index}.md`));
		// 128 date-like keys write 384 metadata docs (field, value and maybe_date), the most one file can carry.
		const set = Array.from({ length: 128 }, (_, index) => ({ key: `k${index}`, value: "2026-01-01" }));
		for (const file of files) await f.set_metadata(file.path, set, f.v);

		await f.draft_move(target(notes), parent(archive), "notes");
		expect((await f.overlay(target(notes))).place).toMatchObject({ ownerTreePath: "/archive/notes/", isVisible: true });

		await f.draft_move(target(files[0]!), parent(archive), "n0.md");
		await f.expect_overlay_true();
		const place = (await f.overlay(target(files[0]!))).place!;
		const fields = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_place_fields")
				.withIndex("by_place", (q) => q.eq("placeId", place._id))
				.collect(),
		);
		expect(fields).toHaveLength(384);
		expect(fields.every((field) => field.ownerTreePath === "/archive/n0.md")).toBe(true);
	}, 120_000);

	test("name claims by a private node and by a moved saved node start and end with saved writes", async () => {
		const f = await fixture();
		const p = await f.saved(null, "p", "folder");
		const q = await f.saved(null, "q", "folder");

		// U's private /p/n claims the name; V then saves /p/n.
		await f.create_private("/p/n", "folder");
		const n = await f.saved(p, "n", "folder");
		await f.settle();
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.expect_overlay_true();

		// V renames the claimed node away, then back; then V moves it to /q.
		await f.v_rename({ id: n._id }, "m");
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.v_rename({ id: n._id }, "n");
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.v_move({ id: n._id }, { id: q._id });
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();

		// U drafts `mv /a/k /q/z`, then V renames /q/n to /q/z: the moved saved node claims the name.
		const a = await f.saved(null, "a", "folder");
		const k = await f.saved(a, "k", "folder");
		await f.draft_move(target(k), parent(q), "z");
		await f.v_rename({ id: n._id }, "z");
		expect((await f.overlay(target(n))).hidden).toBe(true);

		// V archives the claimant: the claim ends. V restores it: the claim is back.
		await f.v_archive({ id: k._id });
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.v_restore({ id: k._id });
		expect((await f.overlay(target(n))).hidden).toBe(true);
		await f.expect_overlay_true();

		// The claimer moves on: the claim ends.
		await f.draft_move(target(k), parent(p), "k");
		expect((await f.overlay(target(n))).hidden).toBe(false);
		await f.expect_overlay_true();
	});

	test("a moved node follows its destination folder when V archives, restores and moves it", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(b), "x.md");

		// V archives /b: x is back in /a.
		await f.v_archive({ id: b._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();
		await f.v_restore({ id: b._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: true, place: { isVisible: true } });
		await f.expect_overlay_true();

		// U draft-deletes /b, then undoes it.
		await f.draft_delete(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.undo(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: true, place: { isVisible: true } });
		await f.expect_overlay_true();

		// V archives the moved node itself: `ls /b` must not show it.
		await f.v_archive({ id: x._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();
	});

	test("a move cycle falls back to the saved place, and resolves again when the cycle ends", async () => {
		const f = await fixture();
		const aFolder = await f.saved(null, "a", "folder");
		const bFolder = await f.saved(null, "b", "folder");

		// U drafts `mv /a /b/`, then V saves `mv /b /a/`.
		await f.draft_move(target(aFolder), parent(bFolder), "a");
		await f.v_move({ id: bFolder._id }, { id: aFolder._id });
		expect(await f.overlay(target(aFolder))).toMatchObject({
			hidden: false,
			place: { isPathless: true, isVisible: false, ownerTreePath: "/a/" },
		});
		await f.expect_overlay_true();

		// V moves /a/b back to the root: U's move resolves again.
		await f.v_move({ id: bFolder._id }, null);
		expect(await f.overlay(target(aFolder))).toMatchObject({
			hidden: true,
			place: { isPathless: false, isVisible: true, ownerTreePath: "/b/a/" },
		});
		await f.expect_overlay_true();

		// The cycle again, then U drafts `mv /a/b /`.
		await f.v_move({ id: bFolder._id }, { id: aFolder._id });
		await f.draft_move(target(bFolder), { kind: "root" }, "b");
		await f.settle();
		expect(await f.overlay(target(aFolder))).toMatchObject({
			hidden: true,
			place: { isPathless: false, isVisible: true, ownerTreePath: "/b/a/" },
		});
		await f.expect_overlay_true();
	});

	test("a move into a private folder follows V's archive and move of its saved parent", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const c = await f.saved(null, "c", "folder");
		const x = await f.saved(a, "x.md");
		const p = await f.create_private("/b/p", "folder");
		await f.draft_move(target(x), p, "x.md");
		expect((await f.overlay(target(x))).place).toMatchObject({ ownerTreePath: "/b/p/x.md", isVisible: true });

		// V archives /b: x is back in /a.
		await f.v_archive({ id: b._id });
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();

		// V restores /b and moves it into /c: `find /c` shows x.
		await f.v_restore({ id: b._id });
		await f.v_move({ id: b._id }, { id: c._id });
		expect(await f.overlay(target(x))).toMatchObject({
			hidden: true,
			place: { ownerTreePath: "/c/b/p/x.md", isVisible: true },
		});
		await f.expect_overlay_true();
	});

	test("a private file under a moved folder follows V's rename of the destination", async () => {
		const f = await fixture();
		const g = await f.saved(null, "g", "folder");
		const xFolder = await f.saved(null, "x", "folder");
		await f.draft_move(target(g), parent(xFolder), "g");
		const file = await f.create_private("/x/g/f.md");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/x/g/f.md", isVisible: true });

		await f.v_rename({ id: xFolder._id }, "y");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/y/g/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("a private file in a moved folder follows the folder's destination as it hides and shows", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const g = await f.saved(a, "g", "folder");
		await f.draft_move(target(g), parent(b), "g");
		const file = await f.create_private("/b/g/f.md");

		// V archives /b: `find /a` shows /a/g/f.md. V restores it: `find /b` shows /b/g/f.md.
		await f.v_archive({ id: b._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/a/g/f.md", isVisible: true });
		await f.expect_overlay_true();
		await f.v_restore({ id: b._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/b/g/f.md", isVisible: true });
		await f.expect_overlay_true();

		// The same with U's draft delete of /b and its undo.
		await f.draft_delete(target(b));
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/a/g/f.md", isVisible: true });
		await f.undo(target(b));
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/b/g/f.md", isVisible: true });
		await f.expect_overlay_true();

		// And with a claim on /b that ends: U drafts `mv /c /z`, V renames /b to /z, then U drafts `mv /c /c2`.
		const c = await f.saved(null, "c", "folder");
		await f.draft_move(target(c), { kind: "root" }, "z");
		await f.v_rename({ id: b._id }, "z");
		expect((await f.overlay(target(b))).hidden).toBe(true);
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/a/g/f.md", isVisible: true });
		await f.draft_move(target(c), { kind: "root" }, "c2");
		await f.settle();
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/z/g/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("one agent turn: `mv /a/x.md /b/c/`, `rm -r /b`, then undo, exact at once", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const c = await f.saved(b, "c", "folder");
		const x = await f.saved(a, "x.md");
		await f.draft_move(target(x), parent(c), "x.md");

		// No job runs between these steps: the inline owner path step does the work.
		await f.draft_delete(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.undo(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: true, place: { isVisible: true } });
		await f.expect_overlay_true();

		// The same with a private folder as the destination.
		const p = await f.create_private("/b/p", "folder");
		await f.draft_move(target(x), p, "x.md");
		await f.draft_delete(target(b));
		expect(await f.overlay(target(x))).toMatchObject({ hidden: false, place: { isVisible: false } });
		expect((await f.overlay(p)).place).toMatchObject({ isVisible: false });
		await f.expect_overlay_true();
	});

	test("with 60 moved files, the first 50 are exact at once and the rest after the job", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const files: Doc<"files_nodes">[] = [];
		for (let index = 0; index < 60; index++) {
			const file = await f.saved(a, `x${String(index).padStart(2, "0")}.md`);
			await f.draft_move(target(file), parent(b), file.name);
			files.push(file);
		}
		await f.settle();

		const visible = async () =>
			(await Promise.all(files.map(async (file) => (await f.overlay(target(file))).place!.isVisible))).filter(Boolean)
				.length;
		await f.draft_delete(target(b));
		expect(await visible()).toBe(10);
		await f.settle();
		expect(await visible()).toBe(0);
		await f.expect_overlay_true();
	}, 120_000);

	test("place fields follow a private draft's metadata and V's committed metadata of a moved file", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		await f.set_metadata("/p", [{ key: "status", value: "draft" }]);
		await f.expect_overlay_true();
		const place = (await f.overlay(folder)).place!;
		const fieldsOf = async (placeId: Id<"files_pending_places">) =>
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_place_fields")
					.withIndex("by_place", (q) => q.eq("placeId", placeId))
					.collect(),
			);
		expect((await fieldsOf(place._id)).map((field) => field.stringValue).filter(Boolean)).toEqual(["draft"]);

		// A new value bumps the place's version at once; the job then writes the new value only.
		await f.set_metadata("/p", [{ key: "status", value: "done" }]);
		expect((await f.overlay(folder)).place!.fieldsVersion).toBeGreaterThan(place.fieldsVersion);
		await f.expect_overlay_true();
		expect((await fieldsOf(place._id)).map((field) => field.stringValue).filter(Boolean)).toEqual(["done"]);

		// A moved saved file shows its committed metadata, and follows V's new value.
		const a = await f.saved(null, "a", "folder");
		const x = await f.saved(null, "x.md");
		await f.draft_move(target(x), parent(a), "x.md");
		await f.set_metadata("/x.md", [{ key: "owner", value: "v" }], f.v);
		await f.expect_overlay_true();
		const moved = (await f.overlay(target(x))).place!;
		expect((await fieldsOf(moved._id)).map((field) => field.stringValue).filter(Boolean)).toEqual(["v"]);
	});

	test("publishing one draft of a private folder moves the other drafts to the saved folder", async () => {
		const f = await fixture();
		const folder = await f.create_private("/p", "folder");
		const children = [];
		for (const name of ["a", "b", "c", "d"]) children.push(await f.create_private(`/p/${name}`, "folder"));
		// Accept publishes the private folder with its first draft; the 3 other drafts stay.
		await f.review("accept", [await f.proposal_of(folder), await f.proposal_of(children[0]!)]);

		const published = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", folder.id as Id<"files_pending_nodes">))
				.unique(),
		);
		expect(published).not.toBe(null);
		for (const child of children.slice(1))
			expect((await f.overlay(child)).place).toMatchObject({
				parent: { kind: "saved", id: published!.savedNodeId },
				isVisible: true,
			});
		await f.expect_overlay_true();
	});

	test("V's folder move, rename, archive and restore update U's drafts under it", async () => {
		const f = await fixture();
		const top = await f.saved(null, "top", "folder");
		const other = await f.saved(null, "other", "folder");
		const dir = await f.saved(top, "dir", "folder");
		const file = await f.create_private("/top/dir/f.md");
		const y = await f.saved(top, "y.md");
		await f.draft_move(target(y), parent(dir), "y.md");

		await f.v_move({ id: dir._id }, { id: other._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/other/dir/f.md" });
		expect((await f.overlay(target(y))).place).toMatchObject({ ownerTreePath: "/other/dir/y.md" });
		await f.expect_overlay_true();

		await f.v_rename({ id: dir._id }, "dir2");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/other/dir2/f.md" });
		await f.expect_overlay_true();

		await f.v_archive({ id: dir._id });
		expect((await f.overlay(file)).place).toMatchObject({ isVisible: false });
		expect(await f.overlay(target(y))).toMatchObject({ hidden: false, place: { isVisible: false } });
		await f.expect_overlay_true();

		await f.v_restore({ id: dir._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/other/dir2/f.md", isVisible: true });
		await f.expect_overlay_true();

		// U moved an ancestor in a draft: V's rename of /other still reaches the drafts below.
		await f.draft_move(target(other), parent(top), "other");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/top/other/dir2/f.md" });
		await f.v_rename({ id: dir._id }, "dir3");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/top/other/dir3/f.md" });
		await f.expect_overlay_true();
	});

	test("a draft delete inside a moved folder hides the drafts under it (owner path prefix)", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const xFolder = await f.saved(null, "x", "folder");
		const sub = await f.saved(a, "f", "folder");
		await f.draft_move(target(a), parent(xFolder), "a");
		const file = await f.create_private("/x/a/f/n.md");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/x/a/f/n.md", isVisible: true });

		await f.draft_delete(target(sub));
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/x/a/f/n.md", isVisible: false });
		await f.expect_overlay_true();
	});

	test("the moved folder's fallback path follows V's rename of its saved parent", async () => {
		const f = await fixture();
		const a = await f.saved(null, "a", "folder");
		const b = await f.saved(null, "b", "folder");
		const g = await f.saved(a, "g", "folder");
		await f.draft_move(target(g), parent(b), "g");
		const file = await f.create_private("/b/g/f.md");

		await f.v_archive({ id: b._id });
		await f.v_rename({ id: a._id }, "c");
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/c/g/f.md", isVisible: true });
		await f.v_restore({ id: b._id });
		expect((await f.overlay(file)).place).toMatchObject({ ownerTreePath: "/b/g/f.md", isVisible: true });
		await f.expect_overlay_true();
	});

	test("account deletion of a user with a replace draft leaves no derived doc of that user", async () => {
		const f = await fixture();
		const p = await f.saved(null, "p", "folder");
		const x = await f.saved(p, "x.md");
		// V's "replace": a draft delete of saved /p/x.md plus a private /p/x.md.
		await f.draft_delete(target(x), f.v);
		const file = await f.create_private("/p/x.md", "file", f.v);
		expect((await f.overlay(target(x), f.v)).hidden).toBe(true);
		expect((await f.overlay(file, f.v)).place).toMatchObject({ ownerTreePath: "/p/x.md", isVisible: true });
		await f.expect_overlay_true();

		const requestId = await f.t.mutation(internal.data_deletion.init_user_deletion, { userId: f.v.userId });
		const request = await f.t.run((ctx) => ctx.db.get("data_deletion_requests", requestId!));
		for (let pass = 0; ; pass++) {
			if (pass === 200) throw new Error("User deletion did not finish");
			const result = await f.t.mutation(internal.data_deletion.process_user_deletion_request, {
				requestId: requestId!,
				_test_now: request!.eligibleAt + 1,
			});
			if (result.done) break;
		}
		await f.settle();

		const left = await f.t.run(async (ctx) => [
			...(await ctx.db
				.query("files_pending_hides")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_places")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_place_fields")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_list_rows")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_list_keys")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
			...(await ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_user", (q) => q.eq("userId", f.v.userId))
				.collect()),
		]);
		expect(left).toEqual([]);
		// The saved file stays: it belongs to the workspace.
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", x._id))).toMatchObject({ archiveOperationId: null });
		await f.expect_overlay_true();
	});
});
