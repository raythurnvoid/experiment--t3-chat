import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import {
	files_pending_overlay_db_stage_owner,
	files_pending_overlay_db_stage_owner_fields,
	files_pending_overlay_db_stage_owner_lists,
	files_pending_overlay_db_target_cohort,
	files_pending_overlay_db_wake_job,
	files_pending_overlay_list,
} from "./files-pending-overlay.ts";
import { test_create_saved_placement_fixture as fixture } from "./files-saved-placement.test-fixtures.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("owner-view-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function owner_work(f: Awaited<ReturnType<typeof fixture>>) {
	return await f.t.run((ctx) =>
		ctx.db.insert("files_move_owner_work", {
			cohortId: f.cohortId,
			userId: f.db.userId,
			target: f.proposal.target,
			order: 0,
			pendingUpdateId: f.proposal._id,
			reviewedRevision: f.proposal.revision,
			privateVersion: null,
			nodeRecordId: f.recordId,
			beforeHideId: null,
			afterHideId: null,
			beforePlaceId: null,
			afterPlaceId: null,
			status: "planned",
			dependencyCursor: null,
			fieldCursor: null,
			generation: 1,
			validatedEpoch: null,
		}),
	);
}

describe("Move owner views", () => {
	test("asks the normal overlay audit to wait for the Move", async () => {
		const f = await fixture();
		const result = await f.t.query(internal.files_pending_overlay.check_user, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			cursor: null,
		});
		expect(result, "an active Move is not a completed clean audit").toEqual({
			differences: [],
			cursor: null,
			moveInProgress: true,
		});
	});

	test("parks child work only for an ancestor subtree reservation", async () => {
		const f = await fixture({ normalPaths: ["/target/child.txt"] });
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.normalNodes.get("/target/child.txt")!)))?.parentId).toBe(f.parentId);
		const reservationId = await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.parentId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		const read = () =>
			f.t.run((ctx) =>
				files_pending_overlay_db_target_cohort(ctx.db, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					target: { kind: "saved", id: f.normalNodes.get("/target/child.txt")! },
				}),
			);
		expect(await read(), "an anchor does not park unrelated child work").toBeNull();
		await f.t.run((ctx) => ctx.db.patch("files_move_source_reservations", reservationId, { mode: "subtree" }));
		expect(await read()).toBe(f.cohortId);
	});

	test("keeps a native field job's remaining work while parked and waking", async () => {
		const f = await fixture();
		const place = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q
						.eq("target.kind", "saved")
						.eq("target.id", f.nodeId)
						.eq("userId", f.db.userId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.unique(),
		);
		if (!place) throw new Error("Expected the pending move place");
		const jobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "place_fields"))
				.collect(),
		);
		const job = jobs.find((job) => job.kind === "place_fields" && job.placeIds.includes(place._id));
		if (!job || job.kind !== "place_fields") throw new Error("Expected the native field job");
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		await f.t.mutation(internal.files_pending_overlay.run_job, {
			kind: job.kind,
			key: job.key,
			nextAttemptAt: job.nextAttemptAt,
		});
		const parked = await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id));
		expect(parked).toMatchObject({ blockedByCohortId: f.cohortId, placeIds: [place._id], cursor: job.cursor });
		await f.t.run((ctx) => files_pending_overlay_db_wake_job(ctx, { cohortId: f.cohortId, jobId: job._id }));
		const awake = await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id));
		expect(awake?.blockedByCohortId).toBeUndefined();
		expect(awake, "waking keeps the exact remaining field work").toMatchObject({
			placeIds: [place._id],
			cursor: job.cursor,
		});
		expect(awake?.scheduledFunctionId).not.toBe(job.scheduledFunctionId);
	});

	test("wakes a native owner job once after physical cleanup releases its cohort", async () => {
		const f = await fixture();
		const place = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q
						.eq("target.kind", "saved")
						.eq("target.id", f.nodeId)
						.eq("userId", f.db.userId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.unique(),
		);
		if (!place) throw new Error("Expected the pending move place");
		const jobs = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "place_fields"))
				.collect(),
		);
		const job = jobs.find((job) => job.kind === "place_fields" && job.placeIds.includes(place._id));
		if (!job || job.kind !== "place_fields") throw new Error("Expected the native field job");
		const reservationId = await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
		await f.t.mutation(internal.files_pending_overlay.run_job, {
			kind: job.kind,
			key: job.key,
			nextAttemptAt: job.nextAttemptAt,
		});
		const parked = await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id));
		expect(parked).toMatchObject({ blockedByCohortId: f.cohortId, cursor: job.cursor, placeIds: job.placeIds });
		const wake = () => f.t.mutation(internal.files_move_cohorts.wake_owner_jobs, { cohortId: f.cohortId });
		await wake();
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id)))?.scheduledFunctionId).toBe(
			parked?.scheduledFunctionId,
		);
		// The inactive foundation fixture supplies the future finalizer's completed cleanup.
		await f.publish();
		await f.materializeNode(f.nodeId);
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "complete" }));
		await wake();
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id)))?.blockedByCohortId).toBe(f.cohortId);
		await f.t.run(async (ctx) => {
			await ctx.db.delete("files_move_source_reservations", reservationId);
			const claims = await ctx.db
				.query("files_move_slot_claims")
				.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
				.collect();
			for (const claim of claims) await ctx.db.delete("files_move_slot_claims", claim._id);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
			.unique();
			if (!slot) throw new Error("Expected the fixture workspace slot");
			await ctx.db.patch("files_move_workspace_slots", slot._id, { cohortId: null });
		});
		const scheduled = () => f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		const before = await scheduled();
		await wake();
		const awake = await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id));
		expect(awake, "released owner work keeps its exact cursor and remaining IDs").toMatchObject({
			cursor: parked!.cursor,
			placeIds: job.placeIds,
		});
		expect(awake?.blockedByCohortId, "released owner work is no longer parked").toBeUndefined();
		const after = await scheduled();
		const added = after.filter((fn) => !before.some((old) => old._id === fn._id));
		expect(added, "released owner work schedules one run_job").toHaveLength(1);
		expect(added[0]).toMatchObject({ name: "files_pending_overlay:run_job", args: [{ kind: job.kind, key: job.key }] });
		await wake();
		expect(await scheduled(), "a lost wake reply does not schedule the owner job twice").toEqual(after);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id)))?.scheduledFunctionId).toBe(
			awake?.scheduledFunctionId,
		);
	});

	test("keeps original before docs and joins every after field to one stable place", async () => {
		const f = await fixture();
		const ownerWorkId = await owner_work(f);
		const original = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_places")
				.withIndex("by_target_user", (q) =>
					q
						.eq("target.kind", "saved")
						.eq("target.id", f.nodeId)
						.eq("userId", f.db.userId)
						.eq("moveView.cohortId", undefined)
						.eq("moveView.view", undefined),
				)
				.unique(),
		);
		if (!original) throw new Error("Expected the native pending move place");
		expect(
			(
				await f.t.run((ctx) =>
					files_pending_overlay_db_stage_owner(ctx, {
						cohortId: f.cohortId,
						fence: 1,
						attemptFence: 0,
						ownerWorkId,
					}),
				)
			)._nay?.name,
			"a stale attempt cannot tag the owner's original place",
		).toBe("stopped");
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_places", original._id)))?.moveView).toBeUndefined();
		const staged = await f.t.run((ctx) =>
			files_pending_overlay_db_stage_owner(ctx, { cohortId: f.cohortId, fence: 1, attemptFence: 1, ownerWorkId }),
		);
		expect(staged._nay).toBeUndefined();
		const work = staged._yay!;
		expect(work.beforePlaceId).toBe(original._id);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_places", original._id))).toMatchObject({
			_creationTime: original._creationTime,
			moveView: { cohortId: f.cohortId, view: "before" },
		});
		if (!work.afterPlaceId) throw new Error("Expected the after place");
		// The inactive cohort fixture supplies the future materializer's metadata input.
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 151; index++)
				await ctx.db.insert("files_metadata_docs", {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					sourceKind: "committed",
					fileNodeId: f.nodeId,
					path: f.saved.path,
					treePath: f.saved.treePath,
					docKind: "field",
					fieldPath: `metadata.key${index}`,
				});
		});
		let cursor: string | null = null;
		let done = false;
		let pages = 0;
		while (!done && pages < 10) {
			const result = await f.t.run((ctx) =>
				files_pending_overlay_db_stage_owner_fields(ctx, {
					cohortId: f.cohortId,
					fence: 1,
					attemptFence: 1,
					ownerWorkId,
					cursor,
				}),
			);
			expect(result._nay).toBeUndefined();
			cursor = result._yay!.cursor;
			done = result._yay!.done;
			pages++;
		}
		expect(done).toBe(true);
		expect(pages).toBeGreaterThan(2);
		const fields = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_place_fields")
				.withIndex("by_place", (q) =>
					q.eq("placeId", work.afterPlaceId!).eq("moveView.cohortId", f.cohortId).eq("moveView.view", "after"),
				)
				.collect(),
		);
		expect(fields, "every after field keeps the staged place ID").toHaveLength(151);
		expect(new Set(fields.map((field) => field.placeId))).toEqual(new Set([work.afterPlaceId]));
		expect(
			(
				await f.t.run((ctx) =>
					files_pending_overlay_db_stage_owner_fields(ctx, {
						cohortId: f.cohortId,
						fence: 1,
						attemptFence: 1,
						ownerWorkId,
						cursor: null,
					}),
				)
			)._nay?.name,
		).toBe("stopped");
	});

	test("stages Pending list docs in pages and serves only the selected side", async () => {
		const f = await fixture();
		const ownerWorkId = await owner_work(f);
		expect(
			(
				await f.t.run((ctx) =>
					files_pending_overlay_db_stage_owner(ctx, { cohortId: f.cohortId, fence: 1, attemptFence: 1, ownerWorkId }),
				)
			)._nay,
		).toBeUndefined();
		let cursor: string | null = null;
		for (let page = 0; page < 5; page++) {
			const result = await f.t.run((ctx) =>
				files_pending_overlay_db_stage_owner_lists(ctx, {
					cohortId: f.cohortId,
					fence: 1,
					attemptFence: 1,
					ownerWorkId,
					cursor,
				}),
			);
			expect(result._nay).toBeUndefined();
			cursor = result._yay!.cursor;
			if (result._yay!.done) break;
		}
		const read = (view: "before" | "after") =>
			f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
				membershipId: f.db.membershipId,
				listKey: "all",
				savedStream: { kind: "cohort", cohortId: f.cohortId, view, generation: 1 },
				paginationOpts: { cursor: null, numItems: 20 },
			});
		expect((await read("before")).page.map((row) => row.pendingUpdateId)).toEqual([f.proposal._id]);
		await f.publish();
		expect((await read("after")).page.map((row) => row.pendingUpdateId)).toEqual([f.proposal._id]);
		const facts = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_review_facts")
				.withIndex("by_proposal_view", (q) =>
					q.eq("pendingUpdateId", f.proposal._id).eq("cohortId", f.cohortId).eq("view", "after"),
				)
				.unique(),
		);
		expect(facts).toMatchObject({
			sourcePath: "/target/new.txt",
			destinationPath: "/target/new.txt",
			structuralKind: "move",
		});
	});

	test("indexes a saved content-only proposal without a place", async () => {
		const f = await fixture({ normalPaths: ["/content.txt"] });
		const target = { kind: "saved" as const, id: f.normalNodes.get("/content.txt")! };
		const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const batch = await f.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{ ...scope, target },
		);
		if (batch._nay) throw new Error(batch._nay.message);
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId: batch._yay.operationBatchId,
					role: "unstaged",
					text: "new content",
				})
			)._nay,
		).toBeUndefined();
		const updated = await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			...scope,
			target,
			operationBatchId: batch._yay.operationBatchId,
		});
		if (updated._nay) throw new Error(updated._nay.message);
		const proposal = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", scope.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.unique(),
		);
		if (!proposal) throw new Error("Expected a content proposal");
		const facts = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_review_facts")
				.withIndex("by_proposal_view", (q) =>
					q.eq("pendingUpdateId", proposal._id).eq("cohortId", null).eq("view", "normal"),
				)
				.unique(),
		);
		expect(facts, "content-only proposals remain in the indexed review scope").toMatchObject({
			sourcePath: "/content.txt",
			sourceTreePath: "/content.txt",
			destinationPath: null,
			structuralKind: "none",
			proposalRevision: proposal.revision,
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) =>
						q
							.eq("target.kind", "saved")
							.eq("target.id", target.id)
							.eq("userId", scope.userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.unique(),
			),
		).toBeNull();
	});

	test("reopens an empty chosen source when a later saved doc stages between pages", async () => {
		const f = await fixture({ normalPaths: ["/target/a.txt", "/target/b.txt", "/target/c.txt"] });
		const ctx = { runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">;
		const list = (cursor: string | null) =>
			files_pending_overlay_list(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				visibilityUserId: f.db.userId,
				folderPath: "/target",
				mode: "children",
				order: "asc",
				kind: "file",
				numItems: 1,
				cursor,
			});
		const first = await list(null);
		expect(first._yay?.items.map((item) => item.path)).toEqual(["/target/a.txt"]);
		await f.stageNode(f.normalNodes.get("/target/b.txt")!);
		let cursor = first._yay!.continueCursor;
		const paths = [...first._yay!.items.map((item) => item.path)];
		for (let page = 0; cursor !== null && page < 12; page++) {
			const result = await list(cursor);
			expect(result._nay).toBeUndefined();
			paths.push(...result._yay!.items.map((item) => item.path));
			cursor = result._yay!.continueCursor;
		}
		expect(paths, "a doc staged into the chosen source stays on the next page").toEqual([
			"/target/a.txt",
			"/target/b.txt",
			"/target/c.txt",
		]);
		expect(cursor).toBeNull();
	});

	test("reopens the normal source when a later saved doc finishes between pages", async () => {
		const f = await fixture({ normalPaths: ["/target/a.txt", "/target/b.txt", "/target/c.txt"] });
		for (const nodeId of f.normalNodes.values()) await f.stageNode(nodeId);
		await f.publish();
		const ctx = { runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">;
		const list = (cursor: string | null) =>
			files_pending_overlay_list(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				visibilityUserId: f.db.userId,
				folderPath: "/target",
				mode: "children",
				order: "asc",
				kind: "file",
				numItems: 1,
				cursor,
			});
		const first = await list(null);
		expect(first._yay?.items.map((item) => item.path)).toEqual(["/target/a.txt"]);
		await f.materializeNode(f.normalNodes.get("/target/b.txt")!);
		let cursor = first._yay!.continueCursor;
		const paths = [...first._yay!.items.map((item) => item.path)];
		for (let page = 0; cursor !== null && page < 12; page++) {
			const result = await list(cursor);
			expect(result._nay).toBeUndefined();
			paths.push(...result._yay!.items.map((item) => item.path));
			cursor = result._yay!.continueCursor;
		}
		expect(paths, "a doc moved to normal cleanup stays on the next page").toEqual([
			"/target/a.txt",
			"/target/b.txt",
			"/target/c.txt",
			"/target/new.txt",
		]);
		expect(cursor).toBeNull();
	});
});
