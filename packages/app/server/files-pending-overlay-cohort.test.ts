import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api.js";
import type { Doc } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
} from "../convex/setup.test.ts";
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

	test("parks child work only when the Move holds the child itself", async () => {
		const f = await fixture({ normalPaths: ["/target/child.txt"] });
		const childId = f.normalNodes.get("/target/child.txt")!;
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", childId)))?.parentId).toBe(f.parentId);
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
					target: { kind: "saved", id: childId },
				}),
			);
		expect(await read(), "an anchor does not park unrelated child work").toBeNull();
		// Only private folder holds cover their subtree. The Move holds each saved item below a saved folder
		// on its own, so the child's work waits only for that hold.
		await f.t.run((ctx) => ctx.db.patch("files_move_source_reservations", reservationId, { mode: "subtree" }));
		expect(await read(), "a saved folder hold does not park its child's work").toBeNull();
		await f.t.run((ctx) =>
			ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: childId },
				mode: "placement",
				userId: null,
				generation: 1,
			}),
		);
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
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", job._id)))?.blockedByCohortId).toBe(
			f.cohortId,
		);
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
			await ctx.db.replace("files_move_workspace_slots", slot._id, {
				organizationId: slot.organizationId,
				workspaceId: slot.workspaceId,
				cohortId: null,
				generation: slot.generation,
			});
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

	test.each(["finish", "abort"] as const)(
		"refreshes the kept saved place after native Move %s",
		async (mode) => {
			const t = test_convex({ transactionLimits: true });
			const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			async function saved_folder(path: string) {
				const result = await asUser.mutation(api.files_nodes.create_folder_node, {
					membershipId: db.membershipId,
					parentId: "root",
					path,
				});
				if (result._nay) throw new Error(result._nay.message);
				return result._yay.nodeId;
			}
			const movingId = await saved_folder("/moving");
			const destinationId = await saved_folder("/destination");
			const nodeId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: "/outside.txt",
				textContent: "Saved outside the moving folder.",
			});
			expect(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "note: current",
				}),
			).toEqual({ _yay: null });
			expect(
				(
					await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userId: db.userId,
						target: { kind: "saved", id: nodeId },
						destParent: { kind: "saved", id: movingId },
						destName: "draft.txt",
					})
				)._nay,
			).toBeUndefined();
			const original = await t.run((ctx) =>
				ctx.db
					.query("files_pending_places")
					.withIndex("by_target_user", (q) =>
						q.eq("target.kind", "saved").eq("target.id", nodeId).eq("userId", db.userId),
					)
					.unique(),
			);
			if (!original) throw new Error("Expected the native draft place");
			const fieldJobs = await t.run((ctx) =>
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_kind_key", (q) => q.eq("kind", "place_fields"))
					.collect(),
			);
			const fieldJob = fieldJobs.find((job) => job.kind === "place_fields" && job.placeIds.includes(original._id));
			if (!fieldJob) throw new Error("Expected the queued native field job");
			expect(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: ["note: current", ...Array.from({ length: 80 }, (_, index) => `field${index}: current`)].join(
						"\n",
					),
				}),
			).toEqual({ _yay: null });
			// Start a real partial field copy before Move tags the owner view.
			for (let step = 0; step < 3; step++) {
				const refresh = await t.run((ctx) =>
					ctx.db
						.query("files_pending_overlay_jobs")
						.withIndex("by_kind_key", (q) => q.eq("kind", "saved_places").eq("key", nodeId))
						.unique(),
				);
				if (!refresh) throw new Error("Expected the saved-place refresh");
				await t.mutation(internal.files_pending_overlay.run_job, {
					kind: refresh.kind,
					key: refresh.key,
					nextAttemptAt: refresh.nextAttemptAt,
				});
			}
			const unfinished = await t.run((ctx) =>
				ctx.db
					.query("files_pending_place_fields")
					.withIndex("by_place", (q) => q.eq("placeId", original._id))
					.collect(),
			);
			expect(unfinished, "Move starts during a partial field build").toHaveLength(64);
			expect(unfinished.every((field) => field.fieldsRefreshId !== original.fieldsRefreshId)).toBe(true);
			const overlay = await import("./files-pending-overlay.ts");
			const canJoin = overlay.files_pending_overlay_db_can_join_step;
			// Pause admission once. Every later step uses the native Move driver.
			const join = vi
				.spyOn(overlay, "files_pending_overlay_db_can_join_step")
				.mockImplementation(async (ctx, limitFactor) => {
					const allowed = await canJoin(ctx, limitFactor);
					const slot = await ctx.db
						.query("files_move_workspace_slots")
						.withIndex("by_workspace", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId),
						)
						.unique();
					return allowed && !slot?.cohortId;
				});
			const started = await asUser.mutation(api.files_transfer.accept_input, {
				membershipId: db.membershipId,
				requestId: crypto.randomUUID(),
				kind: "move",
				sourceIds: [movingId],
				expectedSourceCount: 1,
				targetParentId: destinationId,
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
				_yay: null,
			});
			let cohort: Doc<"files_move_cohorts"> | null = null;
			for (let step = 0; step < 200; step++) {
				cohort = await t.run((ctx) =>
					ctx.db
						.query("files_move_cohorts")
						.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
						.order("desc")
						.first(),
				);
				if (cohort) join.mockRestore();
				if (cohort?.workPhase === "publish") break;
				if (cohort) {
					expect(cohort.errorCode).toBeNull();
					await t.action(internal.files_move_run.run, {
						cohortId: cohort._id,
						step: cohort.step,
						runGeneration: cohort.runJob?.generation ?? null,
						mode: "step",
					});
				} else await t.mutation(internal.files_transfer.advance, { runId });
			}
			expect(cohort?.workPhase, "the native Move reaches publication").toBe("publish");
			if (!cohort) throw new Error("Expected the native cohort");
			const cohortId = cohort._id;
			const work = await t.run((ctx) =>
				ctx.db
					.query("files_move_owner_work")
					.withIndex("by_cohort_owner_target", (q) =>
						q.eq("cohortId", cohortId).eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId),
					)
					.unique(),
			);
			if (!work?.beforePlaceId || !work.afterPlaceId) throw new Error("Expected both native owner places");
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("files_move_cohort_nodes")
						.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohortId).eq("nodeId", nodeId))
						.unique(),
				),
				"the saved target is outside the physical Move",
			).toBeNull();
			expect(
				await t.run((ctx) =>
					files_pending_overlay_db_target_cohort(ctx.db, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						target: { kind: "saved", id: nodeId },
					}),
				),
				"owner collection holds the outside saved target before tagging its place",
			).toBe(cohortId);
			await t.mutation(internal.files_pending_overlay.run_job, {
				kind: fieldJob.kind,
				key: fieldJob.key,
				nextAttemptAt: fieldJob.nextAttemptAt,
			});
			expect(
				await t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", fieldJob._id)),
				"the existing field job parks on the native target reservation",
			).toMatchObject({ blockedByCohortId: cohortId });
			const keptId = mode === "finish" ? work.afterPlaceId : work.beforePlaceId;
			const lostId = mode === "finish" ? work.beforePlaceId : work.afterPlaceId;
			const saved = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
			// Seed an old copied header and value. This is not a write through a held saved-file door.
			await t.run(async (ctx) => {
				await ctx.db.patch("files_pending_places", keptId, { updatedAt: saved.updatedAt - 100 });
				const fields = await ctx.db
					.query("files_pending_place_fields")
					.withIndex("by_place", (q) => q.eq("placeId", keptId))
					.collect();
				for (const field of fields)
					if (field.docKind === "value" && field.fieldPath === "metadata.note")
						await ctx.db.patch("files_pending_place_fields", field._id, { stringValue: "stale" });
			});
			if (mode === "abort")
				expect(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId })).toEqual({
					_yay: null,
				});
			let promoted = false;
			let refreshRequested = false;
			let refreshParked = false;
			await test_finish_transfer_run(asUser, runId, async () => {
				const kept = await t.run((ctx) => ctx.db.get("files_pending_places", keptId));
				if (!kept || kept.moveView) return;
				promoted = true;
				const job = await t.run((ctx) =>
					ctx.db
						.query("files_pending_overlay_jobs")
						.withIndex("by_kind_key", (q) => q.eq("kind", "saved_places").eq("key", nodeId))
						.unique(),
				);
				if (job?.kind === "saved_places") {
					refreshRequested ||= job.fieldsChanged;
					refreshParked ||= job.blockedByCohortId === cohortId;
				}
			});
			expect(promoted, "native cleanup promotes the kept place").toBe(true);
			const kept = await t.run((ctx) => ctx.db.get("files_pending_places", keptId));
			expect(kept, "promotion refreshes the kept date").toMatchObject({ updatedAt: saved.updatedAt });
			expect(kept?.moveView).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_pending_places", lostId))).toBeNull();
			const fields = await t.run((ctx) =>
				ctx.db
					.query("files_pending_place_fields")
					.withIndex("by_place", (q) =>
						q.eq("placeId", keptId).eq("moveView.cohortId", undefined).eq("moveView.view", undefined),
					)
					.collect(),
			);
			expect(
				fields
					.filter((field) => field.docKind === "value" && field.fieldPath === "metadata.note")
					.map((field) => field.stringValue),
				"promotion refreshes the kept metadata value",
			).toEqual(["current"]);
			expect(refreshRequested, "promotion requests a complete saved-field refresh").toBe(true);
			expect(refreshParked, "the saved-place refresh waits for the native target reservation to release").toBe(true);
			expect(
				fields.every(
					(field) =>
						field.fieldsVersion === kept?.fieldsVersion &&
						field.fieldsRefreshId === kept?.fieldsRefreshId &&
						field.ownerTreePath === kept?.ownerTreePath,
				),
				"refreshed fields keep the promoted path and version",
			).toBe(true);
			expect(fields, "partial copies do not leave duplicates after Move").toHaveLength(162);
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("files_pending_place_fields")
						.withIndex("by_place", (q) => q.eq("placeId", lostId))
						.collect(),
				),
			).toEqual([]);
		},
		120_000,
	);

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
						fence: f.fence,
						attemptFence: f.attemptFence - 1,
						ownerWorkId,
					}),
				)
			)._nay?.name,
			"a stale attempt cannot tag the owner's original place",
		).toBe("stopped");
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_places", original._id)))?.moveView).toBeUndefined();
		const staged = await f.t.run((ctx) =>
			files_pending_overlay_db_stage_owner(ctx, {
				cohortId: f.cohortId,
				fence: f.fence,
				attemptFence: f.attemptFence,
				ownerWorkId,
			}),
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
					restrictedScopeNodeId: f.saved.restrictedScopeNodeId,
					docKind: "field",
					fieldPath: `metadata.key${index}`,
				});
		});
		let cursor: string | null = null;
		let done = false;
		let pages = 0;
		while (!done && pages < 40) {
			const result = await f.t.run((ctx) =>
				files_pending_overlay_db_stage_owner_fields(ctx, {
					cohortId: f.cohortId,
					fence: f.fence,
					attemptFence: f.attemptFence,
					ownerWorkId,
					cursor,
				}),
			);
			expect(result._nay).toBeUndefined();
			if (!result._yay!.done)
				expect(result._yay!.cursor, "each unfinished field page advances its native cursor").not.toBe(cursor);
			cursor = result._yay!.cursor;
			done = result._yay!.done;
			pages++;
		}
		expect(done).toBe(true);
		// Each page reads at most 8 metadata docs, so 151 fields need at least 19 pages.
		expect(pages).toBeGreaterThanOrEqual(Math.ceil(151 / 8));
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
						fence: f.fence,
						attemptFence: f.attemptFence,
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
					files_pending_overlay_db_stage_owner(ctx, {
						cohortId: f.cohortId,
						fence: f.fence,
						attemptFence: f.attemptFence,
						ownerWorkId,
					}),
				)
			)._nay,
		).toBeUndefined();
		let cursor: string | null = null;
		for (let page = 0; page < 5; page++) {
			const result = await f.t.run((ctx) =>
				files_pending_overlay_db_stage_owner_lists(ctx, {
					cohortId: f.cohortId,
					fence: f.fence,
					attemptFence: f.attemptFence,
					ownerWorkId,
					cursor,
				}),
			);
			expect(result._nay).toBeUndefined();
			cursor = result._yay!.cursor;
			if (result._yay!.done) break;
		}
		const generation = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!.slotGeneration;
		const read = (view: "before" | "after") =>
			f.asUser.query(api.files_pending_list.list_files_pending_updates, {
				membershipId: f.db.membershipId,
				listKey: "all",
				savedStream: { kind: "cohort", cohortId: f.cohortId, view, generation },
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
			{
				...scope,
				target,
				expectedPendingContentVersion: (await f.t.run((ctx) => ctx.db.get("files_nodes", target.id)))!
					.pendingContentVersion,
			},
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
				subject: { kind: "user", userId: f.db.userId, plugin: null },
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
				subject: { kind: "user", userId: f.db.userId, plugin: null },
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

	test("find -mmin reads the time index of the selected Move view", async () => {
		const f = await fixture();
		const ctx = { runQuery: f.t.query } as unknown as Pick<ActionCtx, "runQuery">;
		// Each view's place has its own update time, so a window that holds one time finds one place.
		const list = async (updatedAt: number) => {
			const result = await files_pending_overlay_list(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				visibilityUserId: f.db.userId,
				subject: { kind: "user", userId: f.db.userId, plugin: null },
				folderPath: "/",
				mode: "subtree",
				order: "asc",
				kind: "file",
				updated: { from: updatedAt, to: updatedAt },
				numItems: 20,
				cursor: null,
			});
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.items.map((item) => item.path);
		};

		expect(await list(f.before.updatedAt), "the before view").toEqual(["/old.txt"]);
		await f.publish();
		expect(await list(f.after.updatedAt), "the after view").toEqual(["/target/new.txt"]);
	});

	test("keeps a saved doc that stages between two stream calls of one page", async () => {
		for (const stageMidPage of [false, true]) {
			const f = await fixture({ normalPaths: ["/target/a.txt", "/target/b1.txt", "/target/b2.txt", "/target/c.txt"] });
			// The owner's drafts move b1 and b2 away, so the normal stream drops them and must read again.
			for (const name of ["b1.txt", "b2.txt"]) {
				const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.db.userId,
					target: { kind: "saved", id: f.normalNodes.get(`/target/${name}`)! },
					destParent: { kind: "root" },
					destName: `out-${name}`,
				});
				if (moved._nay) throw new Error(moved._nay.message);
			}
			const c = f.normalNodes.get("/target/c.txt")!;
			if (!stageMidPage) await f.stageNode(c);
			// Stage c right after the cohort stream read its empty range, before the normal stream reads again.
			let staged = !stageMidPage;
			const ctx = {
				runQuery: async (query: FunctionReference<"query", "internal">, args: { savedStream?: { kind: string } }) => {
					const result = await f.t.query(query, args as never);
					if (
						!staged &&
						getFunctionName(query) === "files_visible:internal_list_children_saved" &&
						args.savedStream?.kind === "cohort"
					) {
						staged = true;
						await f.stageNode(c);
					}
					return result;
				},
			} as unknown as Pick<ActionCtx, "runQuery">;
			const paths: string[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < 12; page++) {
				const result = await files_pending_overlay_list(ctx, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					visibilityUserId: f.db.userId,
					subject: { kind: "user", userId: f.db.userId, plugin: null },
					overlayUserId: f.db.userId,
					folderPath: "/target",
					mode: "children",
					order: "asc",
					kind: "file",
					numItems: 3,
					cursor,
				});
				if (result._nay) throw new Error(result._nay.message);
				paths.push(...result._yay.items.map((item) => item.path));
				cursor = result._yay.continueCursor;
				if (cursor === null) break;
			}
			expect(staged).toBe(true);
			expect(paths, `c.txt is listed (staged mid-page: ${stageMidPage})`).toEqual([
				"/target/a.txt",
				"/target/c.txt",
				"/target/new.txt",
			]);
		}
	});

	test("keeps the owner's after hide at the after place when a published Move's node changes its write policy", async () => {
		const f = await fixture();
		await f.publish();
		// The owner's draft hides the moved node in the after view. The physical node still has the
		// before place until cleanup.
		const hideId = await f.t.run((ctx) =>
			ctx.db.insert("files_pending_hides", {
				moveView: { cohortId: f.cohortId, view: "after" },
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				savedNodeId: f.nodeId,
				parentId: f.after.parentId,
				kind: f.after.kind,
				name: f.after.name,
				lowercaseExtension: f.after.lowercaseExtension,
				treePath: f.after.treePath,
			}),
		);
		expect(
			await f.asUser.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_hides", hideId))).toMatchObject({
			parentId: f.parentId,
			name: "new.txt",
			treePath: "/target/new.txt",
		});
	});
});
