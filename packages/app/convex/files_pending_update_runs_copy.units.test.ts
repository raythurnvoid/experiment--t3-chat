// Copy Save unit planning tests: changed Copies, ordinary changes and Moves. The other Copy Save tests
// are in files_pending_update_runs_copy.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import { api, internal } from "./_generated/api.js";
import {
	fixture,
	start_review,
	agent_copied_folders,
	pending_move,
	review_clock,
	produce_plan_page,
	unit_for,
	plan_review,
	finish_review,
} from "./files_pending_update_runs_copy.setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	let workCount = 0;
	// These tests drive the real worker directly, without running the queue component.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `copy-save-${++workCount}` as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("scalable Copy Save", () => {
	test.each([false, true].flatMap((ordinary) => [false, true].map((edit) => ({ ordinary, edit }))))(
		"isolates a changed Copy during planning (ordinary=$ordinary edit=$edit)",
		async ({ ordinary, edit }) => {
			const f = await agent_copied_folders();
			const selected = [...f.copies];
			if (ordinary) {
				const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: { kind: "saved", id: f.sourceId },
					destParent: { kind: "root" },
					destName: "ordinary-renamed",
				});
				if (moved._nay) throw new Error(moved._nay.message);
				const proposal = await f.t.run(async (ctx) =>
					(await ctx.db.query("files_pending_updates").collect()).find((row) => row.target.id === f.sourceId),
				);
				if (!proposal) throw new Error("Expected the ordinary rename");
				selected.push(proposal);
			}
			const { runId } = await start_review(f, selected);
			const classified = await produce_plan_page(f, runId);
			expect(classified).toMatchObject({ producerPhase: "source_ancestors", itemCount: selected.length });
			if (edit) {
				const changed = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: f.copies[0]!.target,
					destParent: { kind: "saved", id: f.targetId },
					destName: "changed-copy",
				});
				if (changed._nay) throw new Error(changed._nay.message);
			}
			const planned = await plan_review(f, runId);
			expect(planned).toMatchObject({ step: "running", unitCount: selected.length });
			const result = await finish_review({ f, runId, count: selected.length });
			expect(result?.activity).toMatchObject({
				status: edit ? "partial" : "succeeded",
				progress: { completed: selected.length - (edit ? 1 : 0), blocked: edit ? 1 : 0, failed: 0 },
			});
			const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
			const savedCopies = edit ? f.copies.slice(1) : f.copies;
			expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
				savedCopies.map((copy) => copy.target.id).sort(),
			);
			const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(saved.map((node) => node.path).sort()).toEqual(
				[
					ordinary ? "/ordinary-renamed" : "/source",
					"/source-two",
					"/source-three",
					"/target",
					...savedCopies.map((copy) => `/target${copy.copiedFrom!.path}`),
				].sort(),
			);
			for (const receipt of receipts)
				expect(saved.find((node) => node._id === receipt.savedNodeId)).toMatchObject({
					publishedFromPrivateNodeId: receipt.privateNodeId,
					archiveOperationId: null,
				});
			const pending = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			expect(pending).toHaveLength(edit ? 1 : 0);
			if (edit) expect(pending[0]).toMatchObject({ _id: f.copies[0]!._id, revision: f.copies[0]!.revision + 1 });
		},
	);

	test.each(["planning", "running"].flatMap((at) => [false, true].map((edit) => ({ at, edit }))))(
		"keeps the ordinary selected revision check (at=$at edit=$edit)",
		async ({ at, edit }) => {
			const f = await fixture();
			const move = {
				...f.scope,
				target: { kind: "saved" as const, id: f.sourceId },
				destParent: { kind: "root" as const },
			};
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						...move,
						destName: "reviewed",
					})
				)._nay,
			).toBeUndefined();
			const proposal = await f.t.run((ctx) => ctx.db.query("files_pending_updates").unique());
			if (!proposal) throw new Error("Expected the ordinary proposal");
			const { runId } = await start_review(f, [proposal]);
			expect(await produce_plan_page(f, runId)).toMatchObject({ producerPhase: "source_ancestors", itemCount: 1 });
			if (at === "running") await plan_review(f, runId);
			if (edit)
				expect(
					(
						await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
							...move,
							destName: "unreviewed",
						})
					)._nay,
				).toBeUndefined();
			await plan_review(f, runId);
			expect((await finish_review({ f, runId, count: 1 }))?.activity).toMatchObject({
				status: edit ? "failed" : "succeeded",
				progress: { completed: edit ? 0 : 1, blocked: edit ? 1 : 0 },
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).toMatchObject({
				path: edit ? "/source" : "/reviewed",
				archiveOperationId: null,
			});
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
			const pending = await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id));
			if (edit)
				expect(pending).toMatchObject({ revision: proposal.revision + 1, pendingMove: { destName: "unreviewed" } });
			else expect(pending).toBeNull();
		},
	);

	test("keeps Copies independent when an unselected Move enters one after classification", async () => {
		const f = await agent_copied_folders();
		const rename = await pending_move({
			f,
			target: { kind: "saved", id: f.sourceId },
			destParent: { kind: "root" },
			destName: "ordinary-renamed",
		});
		const { runId } = await start_review(f, [...f.copies, rename]);
		expect(await produce_plan_page(f, runId)).toMatchObject({ producerPhase: "source_ancestors", itemCount: 4 });
		const sourceTwo = await f.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/source-two"),
		);
		if (!sourceTwo) throw new Error("Expected the second source");
		const entering = await pending_move({
			f,
			target: { kind: "saved", id: sourceTwo._id },
			destParent: f.copies[0]!.target,
			destName: "entered",
		});
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ step: "running", unitCount: 4 });
		expect(await review_clock(f)).toBeGreaterThan(planned.reviewVersion);

		const result = await finish_review({ f, runId, count: 4 });
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 4, blocked: 0, failed: 0 } });
		// The ordinary rename keeps its own unit and checks the current cohort clock.
		const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
		const ordinary = await unit_for(f, runId, rename);
		expect(ordinary).toMatchObject({ kind: "cohort", itemCount: 1, status: "completed", errorCode: null });
		const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", ordinary.cohortId!));
		expect(cohort?.clockPins.review?.revision).toBeGreaterThan(planned.reviewVersion);
		expect(units).toHaveLength(4);
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/ordinary-renamed",
				"/source-two",
				"/source-three",
				"/target",
				...f.copies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		// The unselected Move was not added to any Save and stays pending as it was.
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toMatchObject([
			{ _id: entering._id, revision: entering.revision, pendingMove: { destName: "entered" } },
		]);
	});

	test("blocks a revised Copy without joining its unreviewed link to an independent Move", async () => {
		const f = await agent_copied_folders();
		const rename = await pending_move({
			f,
			target: { kind: "saved", id: f.sourceId },
			destParent: { kind: "root" },
			destName: "ordinary-renamed",
		});
		const { runId } = await start_review(f, [...f.copies, rename]);
		expect(await produce_plan_page(f, runId)).toMatchObject({ producerPhase: "source_ancestors", itemCount: 4 });
		// The Copy now lives below the folder that the selected rename moves.
		const linked = await pending_move({
			f,
			target: f.copies[0]!.target,
			destParent: { kind: "saved", id: f.sourceId },
			destName: "linked-copy",
		});
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ step: "running", unitCount: 4 });
		expect(await unit_for(f, runId, f.copies[0]!)).toMatchObject({ itemCount: 1, errorCode: "needs_review" });
		expect(await unit_for(f, runId, rename)).toMatchObject({ itemCount: 1, errorCode: null });

		const result = await finish_review({ f, runId, count: 4 });
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 3, blocked: 1, failed: 0 } });
		const items = await f.asUser.query(api.files_pending_update_runs.list_items, {
			membershipId: f.db.membershipId,
			runId,
			paginationOpts: { cursor: null, numItems: 100 },
		});
		expect(items.page.map((item) => item.status)).toEqual(["needs_review", "completed", "completed", "completed"]);
		const savedCopies = f.copies.slice(1);
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			savedCopies.map((copy) => copy.target.id).sort(),
		);
		// Frozen reviewed links keep the independent Move separate from the revised Copy.
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/ordinary-renamed",
				"/source-two",
				"/source-three",
				"/target",
				...savedCopies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", rename._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.copies[0]!._id))).toEqual(linked);
		expect(linked.revision).toBe(f.copies[0]!.revision + 1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(1);
	});

	test("blocks only the revised ordinary change and saves an unrelated ordinary Move", async () => {
		const f = await agent_copied_folders();
		const sourceTwo = await f.t.run(async (ctx) =>
			(await ctx.db.query("files_nodes").collect()).find((node) => node.path === "/source-two"),
		);
		if (!sourceTwo) throw new Error("Expected the second source");
		const rename = await pending_move({
			f,
			target: { kind: "saved", id: f.sourceId },
			destParent: { kind: "root" },
			destName: "ordinary-renamed",
		});
		const other = await pending_move({
			f,
			target: { kind: "saved", id: sourceTwo._id },
			destParent: { kind: "root" },
			destName: "two-renamed",
		});
		const { runId } = await start_review(f, [...f.copies, rename, other]);
		expect(await produce_plan_page(f, runId)).toMatchObject({ producerPhase: "source_ancestors", itemCount: 5 });
		const revised = await pending_move({
			f,
			target: { kind: "saved", id: f.sourceId },
			destParent: { kind: "root" },
			destName: "unreviewed",
		});
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ step: "running", unitCount: 5 });
		expect(await unit_for(f, runId, rename)).toMatchObject({ itemCount: 1, errorCode: "needs_review" });
		expect(await unit_for(f, runId, other)).toMatchObject({ itemCount: 1, errorCode: null });

		const result = await finish_review({ f, runId, count: 5 });
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 4, blocked: 1, failed: 0 } });
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/source",
				"/two-renamed",
				"/source-three",
				"/target",
				...f.copies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		expect(revised).toMatchObject({ revision: rename.revision + 1, pendingMove: { destName: "unreviewed" } });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", rename._id))).toEqual(revised);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", other._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(1);
	});

	test.each([false, true])(
		"keeps an ordinary Move and its child in one unit beside a changed Copy (occupied: %s)",
		async (occupied) => {
			const f = await agent_copied_folders();
			const folder = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				...f.scope,
				path: "/ordinary",
			});
			if (folder._nay) throw new Error(folder._nay.message);
			const move = await pending_move({
				f,
				target: { kind: "saved", id: folder._yay.nodeId },
				destParent: { kind: "root" },
				destName: "moved",
			});
			// The pending view shows the saved folder at "/moved", so the child's parent is that saved folder.
			const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				...f.scope,
				kind: "folder",
				path: "/moved/child",
			});
			if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the ordinary child");
			const child = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
			if (!child) throw new Error("Expected the ordinary child proposal");
			const { runId } = await start_review(f, [...f.copies, move, child]);
			expect(await produce_plan_page(f, runId)).toMatchObject({ producerPhase: "source_ancestors", itemCount: 5 });
			await pending_move({
				f,
				target: f.copies[0]!.target,
				destParent: { kind: "saved", id: f.targetId },
				destName: "changed-copy",
			});
			const planned = await plan_review(f, runId);
			expect(planned).toMatchObject({ step: "running", unitCount: 4 });
			const linkedUnit = await unit_for(f, runId, move);
			expect(linkedUnit).toMatchObject({ kind: "cohort", itemCount: 2, errorCode: null });
			expect((await unit_for(f, runId, child))._id).toBe(linkedUnit._id);
			// A late saved occupant refuses the whole linked group before its switch.
			if (occupied)
				expect(
					(
						await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
							...f.scope,
							path: "/ordinary/child",
						})
					)._nay,
				).toBeUndefined();
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", folder._yay.nodeId));

			const result = await finish_review({ f, runId, count: 5 });
			expect(result?.activity).toMatchObject({
				status: "partial",
				progress: { completed: occupied ? 2 : 4, blocked: occupied ? 3 : 1, failed: 0 },
			});
			const unit = await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", linkedUnit._id));
			expect(unit).toMatchObject({ status: occupied ? "blocked" : "completed" });
			if (!occupied) {
				const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", unit!.cohortId!));
				expect(cohort?.clockPins.review?.revision).toBeGreaterThan(planned.reviewVersion);
			}
			const savedCopies = f.copies.slice(1);
			const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
			expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
				[...savedCopies.map((copy) => copy.target.id), ...(occupied ? [] : [child.target.id])].sort(),
			);
			expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
				[
					...(occupied ? ["/ordinary", "/ordinary/child"] : ["/moved", "/moved/child"]),
					"/source",
					"/source-two",
					"/source-three",
					"/target",
					...savedCopies.map((copy) => `/target${copy.copiedFrom!.path}`),
				].sort(),
			);
			// The refused group never switched, so the saved folder is unchanged.
			if (occupied) expect(await f.t.run((ctx) => ctx.db.get("files_nodes", folder._yay.nodeId))).toEqual(before);
			const pending = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			expect(pending.map((proposal) => proposal._id).sort()).toEqual(
				[f.copies[0]!._id, ...(occupied ? [move._id, child._id] : [])].sort(),
			);
			if (occupied) {
				expect(pending.find((proposal) => proposal._id === move._id)).toEqual(move);
				expect(pending.find((proposal) => proposal._id === child._id)).toEqual(child);
			}
		},
	);

	test("keeps an ordinary Move with its child when the child moves away before classification", async () => {
		const f = await agent_copied_folders();
		const folder = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
			...f.scope,
			path: "/ordinary",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const move = await pending_move({
			f,
			target: { kind: "saved", id: folder._yay.nodeId },
			destParent: { kind: "root" },
			destName: "moved",
		});
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			kind: "folder",
			path: "/moved/child",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the ordinary child");
		const child = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		if (!child) throw new Error("Expected the ordinary child proposal");
		const { runId } = await start_review(f, [...f.copies, move, child]);
		// The child moves out after seal. Its current path no longer shows the reviewed link to the Move,
		// so only the revised selection itself can keep the pair together.
		const revised = await pending_move({
			f,
			target: child.target,
			destParent: { kind: "root" },
			destName: "moved-away-child",
		});
		const planned = await plan_review(f, runId);
		expect(planned).toMatchObject({ step: "running", unitCount: 4 });
		const linkedUnit = await unit_for(f, runId, move);
		expect(linkedUnit).toMatchObject({ kind: "cohort", itemCount: 2, errorCode: "needs_review" });
		expect((await unit_for(f, runId, child))._id).toBe(linkedUnit._id);

		const result = await finish_review({ f, runId, count: 5 });
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 3, blocked: 2, failed: 0 } });
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			f.copies.map((copy) => copy.target.id).sort(),
		);
		// The reviewed Move never saves without its reviewed child.
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/ordinary",
				"/source",
				"/source-two",
				"/source-three",
				"/target",
				...f.copies.map((copy) => `/target${copy.copiedFrom!.path}`),
			].sort(),
		);
		expect(revised.revision).toBe(child.revision + 1);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", move._id))).toEqual(move);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", child._id))).toEqual(revised);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(2);
	});

	test.each([false, true])("keeps Copies with the reviewed Move of their folder (revised: %s)", async (revised) => {
		const f = await agent_copied_folders();
		const move = await pending_move({
			f,
			target: { kind: "saved", id: f.targetId },
			destParent: { kind: "root" },
			destName: "target-renamed",
		});
		const { runId } = await start_review(f, [...f.copies, move]);
		expect(await produce_plan_page(f, runId)).toMatchObject({ producerPhase: "source_ancestors", itemCount: 4 });
		const changed = revised
			? await pending_move({
					f,
					target: { kind: "saved", id: f.targetId },
					destParent: { kind: "root" },
					destName: "target-revised",
				})
			: null;
		const planned = await plan_review(f, runId);
		// The Copies were reviewed below the renamed folder, so they join its unit in both cases.
		expect(planned).toMatchObject({ step: "running", unitCount: 1 });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ kind: "cohort", itemCount: 4, errorCode: revised ? "needs_review" : null },
		]);

		const result = await finish_review({ f, runId, count: 4 });
		expect(result?.activity).toMatchObject({
			status: revised ? "failed" : "succeeded",
			progress: { completed: revised ? 0 : 4, blocked: revised ? 4 : 0, failed: 0 },
		});
		const receipts = await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect());
		expect(receipts.map((receipt) => receipt.privateNodeId).sort()).toEqual(
			revised ? [] : f.copies.map((copy) => copy.target.id).sort(),
		);
		const folder = revised ? "/target" : "/target-renamed";
		expect((await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).map((node) => node.path).sort()).toEqual(
			[
				"/source",
				"/source-two",
				"/source-three",
				folder,
				...(revised ? [] : f.copies.map((copy) => `${folder}${copy.copiedFrom!.path}`)),
			].sort(),
		);
		const pending = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		if (!changed) expect(pending).toEqual([]);
		else {
			expect(changed.revision).toBe(move.revision + 1);
			expect(pending.sort((a, b) => a._creationTime - b._creationTime)).toEqual([...f.copies, changed]);
		}
	});
});
