import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { r2_create_asset_key } from "./r2_client.ts";
import { test_create_saved_placement_fixture as fixture } from "../server/files-saved-placement.test-fixtures.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_saved_placement_db_get_slot } from "../server/files-saved-placement.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("cohort-wake-test-work" as never);
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
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Move cohort worker wake", () => {
	test("accepted uploads resume in pages after release, with no duplicate wake after a lost reply", async () => {
		const f = await fixture();
		const events = [];
		const reservations: Id<"files_move_source_reservations">[] = [];
		for (let index = 0; index < 10; index++) {
			const result = await f.asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: f.db.membershipId,
				parentId: "root",
				filename: `upload-${index}.png`,
				contentType: "image/png",
				size: 12,
			});
			if (result._nay) throw new Error(result._nay.message);
			const { nodeId, assetId } = result._yay;
			await f.stageNode(nodeId);
			reservations.push(
				await f.t.run((ctx) =>
					ctx.db.insert("files_move_source_reservations", {
						cohortId: f.cohortId,
						source: { kind: "saved", id: nodeId },
						mode: "placement",
						userId: null,
						generation: 1,
					}),
				),
			);
			const event = {
				assetId,
				r2Key: r2_create_asset_key({ ...f.db, assetId }),
				size: 12,
				eventId: `upload-event-${index}`,
			};
			events.push(event);
			expect(await f.t.mutation(internal.r2.process_uploaded_asset_event, event)).toEqual({ _yay: null });
		}
		const waiters = () =>
			f.t.run((ctx) =>
				ctx.db
					.query("files_move_waiters")
					.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
					.collect(),
			);
		const scheduledEvents = () =>
			f.t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect())
					.filter((job) => job.name === "r2:process_uploaded_asset_event")
					.flatMap((job) => job.args),
			);
		const wake = () => f.t.mutation(internal.files_move_cohorts.wake_waiters, { cohortId: f.cohortId });
		expect(await waiters()).toHaveLength(10);
		await wake();
		expect(await scheduledEvents(), "staging never wakes accepted uploads").toEqual([]);
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "complete" }));
		await wake();
		expect(await waiters(), "physical claims must be released before workers resume").toHaveLength(10);
		await f.t.run(async (ctx) => {
			for (const id of reservations) await ctx.db.delete("files_move_source_reservations", id);
			for (const claim of await ctx.db
				.query("files_move_slot_claims")
				.withIndex("by_cohort", (q) => q.eq("cohortId", f.cohortId))
				.collect())
				await ctx.db.delete("files_move_slot_claims", claim._id);
		});
		await wake();
		expect(await waiters(), "one native wake page leaves the remaining accepted uploads durable").toHaveLength(2);
		// Replay the lost reply. Removed rows cannot enqueue again.
		await wake();
		await wake();
		expect(await waiters()).toEqual([]);
		expect(await scheduledEvents(), "each accepted upload resumes exactly once").toEqual(events);
	});
});

async function native_rotation(count: number) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodes: Id<"files_nodes">[] = [];
	for (let index = 0; index < count; index++) {
		if (index % 10 === 0) vi.setSystemTime(Date.now() + 60_000);
		const created = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: `/source-${index}`,
		});
		if (created._nay) throw new Error(created._nay.message);
		nodes.push(created._yay.nodeId);
	}
	const move = async (index: number, destName: string) => {
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...scope,
			target: { kind: "saved", id: nodes[index]! },
			destParent: { kind: "root" },
			destName,
		});
		if (moved._nay) throw new Error(moved._nay.message);
	};
	await move(0, "temporary-draft-name");
	for (let index = count - 1; index > 0; index--) await move(index, `source-${(index + 1) % count}`);
	await move(0, "source-1");
	const proposals = await t.run((ctx) =>
		Promise.all(
			nodes.map((id) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", id))
					.unique(),
			),
		),
	);
	const started = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: count,
		items: proposals
			.slice(0, 100)
			.map((proposal) => ({
				pendingUpdateId: proposal!._id,
				reviewedRevision: proposal!.revision,
				selectedContentStateId: null,
			})),
	});
	if (started._nay) throw new Error(started._nay.message);
	const runId = started._yay.runId;
	for (let offset = 100; offset < count; offset += 100)
		expect(
			await asUser.mutation(api.files_pending_update_runs.append_items, {
				membershipId: db.membershipId,
				runId,
				offset,
				items: proposals
					.slice(offset, offset + 100)
					.map((proposal) => ({
						pendingUpdateId: proposal!._id,
						reviewedRevision: proposal!.revision,
						selectedContentStateId: null,
					})),
			}),
		).toEqual({ _yay: null });
	expect(await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	for (let pass = 0; pass < 1000; pass++) {
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) =>
					q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId),
				)
				.first(),
		);
		if (job) {
			await t.mutation(internal.files_pending_overlay.run_job, {
				kind: job.kind,
				key: job.key,
				nextAttemptAt: job.nextAttemptAt,
			});
			continue;
		}
		await t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		const run = await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (run?.step !== "planning") break;
		if (pass === 999) throw new Error("Rotation planning did not finish");
	}
	await t.mutation(internal.files_pending_update_runs.advance, { runId });
	const unit = await t.run((ctx) =>
		ctx.db
			.query("files_pending_update_run_units")
			.withIndex("by_run_order", (q) => q.eq("runId", runId))
			.first(),
	);
	if (!unit?.cohortId) throw new Error("Rotation did not start a cohort");
	const readNames = () =>
		t.run((ctx) =>
			Promise.all(
				nodes.map((_node, index) =>
					files_saved_placement_db_get_slot(ctx.db, { ...scope, parentId: "root", name: `source-${index}` }),
				),
			),
		);
	return { t, db, scope, asUser, nodes, runId, cohortId: unit.cohortId, readNames };
}

async function finish_cohort(
	f: Awaited<ReturnType<typeof native_rotation>>,
	check?: (cohort: Doc<"files_move_cohorts">) => Promise<void>,
) {
	for (let pass = 0; pass < 10_000; pass++) {
		const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId));
		if (!cohort) throw new Error("Missing rotation cohort");
		if (check) await check(cohort);
		if (cohort.phase === "complete") {
			await f.t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId: cohort._id });
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId: f.runId });
			return cohort;
		}
		await f.t.action(internal.files_move_cohorts.run, { cohortId: cohort._id, step: cohort.step });
	}
	throw new Error("Rotation cohort did not finish");
}

describe("Move cohort publication", () => {
	test("moves 140 linked items without a selection cap", async () => {
		const f = await native_rotation(140);
		expect((await f.readNames()).map((node) => node?._id)).toEqual(f.nodes);
		const finished = await finish_cohort(f);
		expect(finished.errorCode, "the linked group passes the former 139-item cap").toBeNull();
		expect(finished.publishedAt).not.toBeNull();
		expect(
			(await f.readNames()).map((node) => node?._id),
			"every linked destination has its final file ID",
		).toEqual([f.nodes.at(-1), ...f.nodes.slice(0, -1)]);
	}, 300_000);

	test("keeps normal names until one complete group switch", async () => {
		const f = await native_rotation(3);
		let switched = false;
		const finished = await finish_cohort(f, async (cohort) => {
			const ids = (await f.readNames()).map((node) => node?._id);
			if (cohort.publishedAt === null)
				expect(ids, "all old normal names keep the same file IDs until publication").toEqual(f.nodes);
			else {
				expect(ids, "publication exposes every final name at once").toEqual([f.nodes[2], f.nodes[0], f.nodes[1]]);
				switched = true;
			}
		});
		expect(finished.errorCode).toBeNull();
		expect(switched).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_move_source_reservations").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_saved_places").collect())).toEqual([]);
	}, 120_000);

	test("Stop before publication keeps all old names and proposals", async () => {
		const f = await native_rotation(3);
		await f.t.action(internal.files_move_cohorts.run, { cohortId: f.cohortId, step: 0 });
		const activityId = await f.t.run(
			async (ctx) =>
				(await ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", f.runId))
					.unique())!._id,
		);
		expect(
			await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId }),
		).toEqual({ _yay: null });
		const finished = await finish_cohort(f);
		expect(finished.publishedAt).toBeNull();
		expect((await f.readNames()).map((node) => node?._id)).toEqual(f.nodes);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(3);
	}, 120_000);

	test("Stop after publication keeps the group and finishes physical repair", async () => {
		const f = await native_rotation(3);
		let stopped = false;
		const finished = await finish_cohort(f, async (cohort) => {
			if (cohort.publishedAt === null || stopped) return;
			const activityId = await f.t.run(
				async (ctx) =>
					(await ctx.db
						.query("activities")
						.withIndex("by_source_id", (q) => q.eq("source.id", f.runId))
						.unique())!._id,
			);
			expect(
				await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId }),
			).toEqual({ _yay: null });
			stopped = true;
		});
		expect(stopped).toBe(true);
		expect(finished.publishedAt).not.toBeNull();
		expect(
			(await f.readNames()).map((node) => node?._id),
			"Stop keeps every published destination",
		).toEqual([f.nodes[2], f.nodes[0], f.nodes[1]]);
		expect(
			await f.t.run((ctx) =>
				Promise.all(f.nodes.map((id) => ctx.db.get("files_nodes", id))).then((nodes) =>
					nodes.map((node) => node?.moveCohortId ?? null),
				),
			),
			"repair removes every physical marker after Stop",
		).toEqual([null, null, null]);
		expect(await f.t.run((ctx) => ctx.db.query("files_move_source_reservations").collect())).toEqual([]);
	}, 120_000);

	test("a fresh outside write stops publication without changing old names", async () => {
		const f = await native_rotation(3);
		await f.t.action(internal.files_move_cohorts.run, { cohortId: f.cohortId, step: 0 });
		expect(
			await f.asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: f.db.membershipId,
				parentId: "root",
				path: "/outside-change",
			}),
		).toHaveProperty("_yay.nodeId");
		const finished = await finish_cohort(f);
		expect(finished.publishedAt, "a changed workspace clock prevents publication").toBeNull();
		expect(finished.errorCode).toBe("needs_review");
		expect((await f.readNames()).map((node) => node?._id)).toEqual(f.nodes);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(3);
	}, 120_000);

	test("history cleanup keeps the group until its parent is gone, then drains child rows", async () => {
		const f = await native_rotation(3);
		await finish_cohort(f);
		await f.t.mutation(internal.files_move_cohorts.cleanup, { cohortId: f.cohortId });
		expect(
			await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)),
			"parent history still owns the group",
		).not.toBeNull();
		for (let pass = 0; pass < 50; pass++) {
			await f.t.mutation(internal.activities.cleanup_history, {
				_test_now: Date.now() + 8 * 24 * 60 * 60 * 1000,
				_test_disableReschedule: true,
			});
			if (!(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", f.runId)))) break;
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", f.runId))).toBeNull();
		for (let pass = 0; pass < 50; pass++) {
			await f.t.mutation(internal.files_move_cohorts.cleanup, { cohortId: f.cohortId });
			if (!(await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))) break;
		}
		expect(
			await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)),
			"group history drains after its parent",
		).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_move_cohort_nodes").collect())).toEqual([]);
		expect((await f.readNames()).map((node) => node?._id)).toEqual([f.nodes[2], f.nodes[0], f.nodes[1]]);
	}, 120_000);
});
