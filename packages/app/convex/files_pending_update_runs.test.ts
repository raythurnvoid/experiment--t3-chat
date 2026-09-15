import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Workpool } from "@convex-dev/workpool";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	return { t, db, scope, asUser };
}

async function private_folder(f: Awaited<ReturnType<typeof fixture>>, path: string) {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		kind: "folder",
		path,
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder");
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
	if (!proposal) throw new Error("Expected the new proposal");
	return proposal;
}

async function saved_folder(f: Awaited<ReturnType<typeof fixture>>, name: string) {
	return await f.t.run((ctx) =>
		ctx.db.insert("files_nodes", {
			...test_mocks.files.base(),
			organizationId: f.scope.organizationId,
			workspaceId: f.scope.workspaceId,
			createdBy: f.scope.userId,
			updatedBy: f.scope.userId,
			parentId: "root",
			name,
			path: `/${name}`,
			treePath: `/${name}/`,
		}),
	);
}

async function start_review(
	f: Awaited<ReturnType<typeof fixture>>,
	kind: "accept" | "discard",
	proposals: Doc<"files_pending_updates">[],
	plan = true,
) {
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind,
		expectedItemCount: proposals.length,
		items: proposals.map((proposal) => ({
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: kind === "accept" ? (proposal.content?.unstagedStateId ?? null) : null,
		})),
	});
	if (started._nay) throw new Error(started._nay.message);
	const sealed = await f.asUser.mutation(api.files_pending_update_runs.seal, {
		membershipId: f.db.membershipId,
		runId: started._yay.runId,
	});
	expect(sealed).toEqual({ _yay: null });
	if (plan) await f.t.action(internal.files_pending_update_runs.plan, { runId: started._yay.runId, fence: 0 });
	return started._yay;
}

async function finish_review(f: Awaited<ReturnType<typeof fixture>>, runId: Id<"files_pending_update_runs">) {
	for (let pass = 0; pass < 20; pass++) {
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId));
		if (!run) throw new Error("Expected the review run");
		if (run.step === "finished")
			return await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		const unit = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", runId).eq("status", "preparing"))
				.first(),
		);
		if (!unit) throw new Error("Expected a review worker");
		await f.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence,
		});
	}
	throw new Error("Review did not finish");
}

describe("review jobs", () => {
	test("queues preparation in the shared two-worker pool and cancels it on Stop", async () => {
		const base = await fixture();
		const enqueue = vi.spyOn(Workpool.prototype, "enqueueAction");
		const cancel = vi.spyOn(Workpool.prototype, "cancel");
		const runs = [];
		for (let index = 0; index < 3; index++) {
			const db = await base.t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: `worker-${index}` }),
			);
			const f = {
				t: base.t,
				db,
				scope: { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId },
				asUser: base.t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId }),
			};
			const proposal = await private_folder(f, "/draft");
			const run = await start_review(f, "accept", [proposal]);
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId: run.runId });
			runs.push({ f, ...run });
		}
		const calls = enqueue.mock.calls.flatMap((call, index) =>
			getFunctionName(call[1]) === "files_pending_update_runs:prepare_unit" ? [index] : [],
		);
		expect(calls).toHaveLength(3);
		const pool = new Workpool(components.files_transfer_workpool, {});
		for (const index of calls) {
			const queue = enqueue.mock.contexts[index];
			if (!(queue instanceof Workpool)) throw new Error("Expected the review Workpool");
			expect(queue.options.maxParallelism).toBe(2);
			const workId = await enqueue.mock.results[index]!.value;
			expect(await base.t.query((ctx) => pool.status(ctx, workId))).toMatchObject({ state: "pending" });
		}
		const first = runs[0]!;
		expect(
			await first.f.asUser.mutation(api.activities.request_stop, {
				membershipId: first.f.db.membershipId,
				activityId: first.activityId,
			}),
		).toEqual({ _yay: null });
		const firstWorkId = await enqueue.mock.results[calls[0]!]!.value;
		expect(cancel.mock.calls.map((call) => call[1])).toEqual([firstWorkId]);
		const firstUnit = await base.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", first.runId))
				.unique(),
		);
		await base.t.action(internal.files_pending_update_runs.prepare_unit, {
			runId: first.runId,
			fence: 0,
			unitId: firstUnit!._id,
			attemptFence: firstUnit!.attemptFence,
		});
		expect(await base.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		const scheduled = await base.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(scheduled.filter((job) => job.name === "files_pending_update_runs:prepare_unit")).toEqual([]);
	});

	test("returns the active IDs when the review lane is busy", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const second = await private_folder(f, "/second");
		const running = await start_review(f, "accept", [first]);
		const reply = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [{ pendingUpdateId: second._id, reviewedRevision: second.revision, selectedContentStateId: null }],
		});
		expect(reply._nay).toMatchObject({ name: "busy", data: running });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_runs").collect())).toHaveLength(1);
	});

	test.each(["accept", "discard"] as const)(
		"keeps unchanged units after an unrelated owner edit (%s)",
		async (kind) => {
			const f = await fixture();
			const first = await private_folder(f, "/first");
			const second = await private_folder(f, "/second");
			const { runId } = await start_review(f, kind, [first, second]);
			const unrelated = await private_folder(f, "/unrelated");
			const result = await finish_review(f, runId);
			expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
			expect(result?.run).toMatchObject({ unitCount: 2, finishedUnitCount: 2 });
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", unrelated._id))).toEqual(unrelated);
			const nodes = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			expect(nodes.map((node) => node.path).sort()).toEqual(kind === "accept" ? ["/first", "/second"] : []);
		},
	);

	test("rechecks later private Discard units after an earlier unit adopts the changed owner clock", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const parent = await private_folder(f, "/parent");
		const children = [];
		for (let index = 0; index < 10; index++) children.push(await private_folder(f, `/parent/child-${index}`));
		const { runId } = await start_review(f, "discard", [first, parent, ...children]);
		const unselected = await private_folder(f, "/parent/new-child");
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 1, blocked: 11 } });
		expect(result?.run.needsReviewIds).toEqual([unselected._id]);
		const nodes = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.filter((node) => node.state === "discarded").map((node) => node.name)).toEqual(["first"]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", unselected._id))).toEqual(unselected);
	});

	test("blocks a changed reviewed revision after an unrelated unit commits", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const second = await private_folder(f, "/second");
		const { runId } = await start_review(f, "accept", [first, second]);
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...f.scope,
					target: second.target,
					destParent: { kind: "root" },
					destName: "changed",
				})
			)._nay,
		).toBeUndefined();
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "partial", progress: { completed: 1, blocked: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toMatchObject([{ path: "/first" }]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", second._id))).toMatchObject({
			revision: second.revision + 1,
		});
	});

	test("does not revalidate later units for this run's own commits", async () => {
		const f = await fixture();
		const first = await private_folder(f, "/first");
		const second = await private_folder(f, "/second");
		const { runId } = await start_review(f, "accept", [first, second]);
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run).toMatchObject({ revalidateRemaining: false, unitCount: 2 });
	});

	test.each(["selection page", "proposal page", "seal", "commit"] as const)(
		"does not adopt a clock change at the %s",
		async (at) => {
			const f = await fixture();
			const parent = await private_folder(f, "/parent");
			const children = [];
			for (let index = 0; index < 10; index++) children.push(await private_folder(f, `/parent/child-${index}`));
			const { runId } = await start_review(f, "discard", [parent, ...children]);
			await private_folder(f, "/unrelated");
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").first());
			if (!unit) throw new Error("Expected a review unit");
			const worker = { runId, fence: 0, unitId: unit._id, attemptFence: unit.attemptFence };
			const review = await f.t.mutation(internal.files_pending_update_runs.begin_unit_review, worker);
			if (review._nay) throw new Error(review._nay.message);
			expect(review._yay.required).toBe(true);
			const revalidation = {
				unitId: unit._id,
				attemptFence: unit.attemptFence,
				reviewVersion: review._yay.reviewVersion,
			};
			let selectionCursor: string | null = null;
			while (true) {
				const page: FunctionReturnType<typeof internal.files_pending_update_runs.get_plan_selection_page> =
					await f.t.query(internal.files_pending_update_runs.get_plan_selection_page, {
						runId,
						fence: 0,
						revalidation,
						cursor: selectionCursor,
					});
				if (page._nay) throw new Error(page._nay.message);
				selectionCursor = page._yay.continueCursor;
				if (page._yay.isDone || at === "selection page") break;
			}
			let proposalCursor: string | null = null;
			if (at !== "selection page")
				while (true) {
					const page: FunctionReturnType<typeof internal.files_pending_update_runs.get_plan_proposals_page> =
						await f.t.query(internal.files_pending_update_runs.get_plan_proposals_page, {
							runId,
							fence: 0,
							revalidation,
							cursor: proposalCursor,
						});
					if (page._nay) throw new Error(page._nay.message);
					proposalCursor = page._yay.continueCursor;
					if (page._yay.isDone || at === "proposal page") break;
				}
			if (at === "commit")
				expect(
					await f.t.mutation(internal.files_pending_update_runs.seal_unit_review, {
						runId,
						fence: 0,
						...revalidation,
					}),
				).toEqual({ _yay: null });
			const unselected = await private_folder(f, "/parent/new-child");
			if (at === "selection page" || at === "proposal page") {
				const page =
					at === "selection page"
						? await f.t.query(internal.files_pending_update_runs.get_plan_selection_page, {
								runId,
								fence: 0,
								revalidation,
								cursor: selectionCursor,
							})
						: await f.t.query(internal.files_pending_update_runs.get_plan_proposals_page, {
								runId,
								fence: 0,
								revalidation,
								cursor: proposalCursor,
							});
				expect(page._nay).toMatchObject({ name: "review_changed" });
			}
			if (at === "seal")
				expect(
					await f.t.mutation(internal.files_pending_update_runs.seal_unit_review, {
						runId,
						fence: 0,
						...revalidation,
					}),
				).toMatchObject({ _nay: { name: "review_changed" } });
			await expect(f.t.mutation(internal.files_pending_update_runs.commit_unit, worker)).rejects.toThrow(
				"Pending changes changed",
			);
			await f.t.mutation(internal.files_pending_update_runs.fail_unit, {
				...worker,
				code: "review_changed",
				message: "Retry this selection.",
			});
			const result = await finish_review(f, runId);
			expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 11 } });
			expect(result?.run.needsReviewIds).toEqual([unselected._id]);
			expect(
				(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).every(
					(node) => node.state === "active",
				),
			).toBe(true);
		},
	);

	test("bounds repeated clock changes to three attempts", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review(f, "discard", [parent]);
		for (let index = 0; index < 3; index++) {
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").first());
			if (!unit) throw new Error("Expected a review unit");
			const worker = { runId, fence: 0, unitId: unit._id, attemptFence: unit.attemptFence };
			const review = await f.t.mutation(internal.files_pending_update_runs.begin_unit_review, worker);
			if (review._nay) throw new Error(review._nay.message);
			if (review._yay.required) {
				const revalidation = {
					unitId: unit._id,
					attemptFence: unit.attemptFence,
					reviewVersion: review._yay.reviewVersion,
				};
				for (const query of [
					internal.files_pending_update_runs.get_plan_selection_page,
					internal.files_pending_update_runs.get_plan_proposals_page,
				]) {
					expect(await f.t.query(query, { runId, fence: 0, revalidation, cursor: null })).toMatchObject({
						_yay: { isDone: true },
					});
				}
				expect(
					await f.t.mutation(internal.files_pending_update_runs.seal_unit_review, { runId, fence: 0, ...revalidation }),
				).toEqual({ _yay: null });
			}
			await private_folder(f, `/unrelated-${index}`);
			await expect(f.t.mutation(internal.files_pending_update_runs.commit_unit, worker)).rejects.toThrow(
				"Pending changes changed",
			);
			await f.t.mutation(internal.files_pending_update_runs.fail_unit, {
				...worker,
				code: "review_changed",
				message: "Retry this selection.",
			});
		}
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "blocked", attemptCount: 3, errorCode: "needs_review" },
		]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
	});

	test.each([false, true])(
		"requires the moved child archive in the selected set (included: %s)",
		async (includeChild) => {
			const f = await fixture();
			const nodes = await f.t.run(async (ctx) => {
				const base = {
					...test_mocks.files.base(),
					organizationId: f.scope.organizationId,
					workspaceId: f.scope.workspaceId,
					createdBy: f.scope.userId,
					updatedBy: f.scope.userId,
				};
				const destinationId = await ctx.db.insert("files_nodes", {
					...base,
					parentId: "root",
					name: "a",
					path: "/a",
					treePath: "/a/",
				});
				const sourceId = await ctx.db.insert("files_nodes", {
					...base,
					parentId: "root",
					name: "b",
					path: "/b",
					treePath: "/b/",
				});
				const childId = await ctx.db.insert("files_nodes", {
					...base,
					parentId: sourceId,
					name: "child",
					path: "/b/child",
					treePath: "/b/child/",
					pathDepth: 2,
				});
				return { destinationId, sourceId, childId };
			});
			const childArchive = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
				...f.scope,
				target: { kind: "saved", id: nodes.childId },
			});
			expect(childArchive._nay).toBeUndefined();
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						...f.scope,
						target: { kind: "saved", id: nodes.sourceId },
						destParent: { kind: "saved", id: nodes.destinationId },
						destName: "b",
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
						...f.scope,
						target: { kind: "saved", id: nodes.destinationId },
					})
				)._nay,
			).toBeUndefined();
			const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			const child = proposals.find((proposal) => proposal.target.id === nodes.childId)!;
			const before = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
			const { runId } = await start_review(
				f,
				"accept",
				proposals.filter((proposal) => includeChild || proposal._id !== child._id),
			);
			const result = await finish_review(f, runId);
			if (includeChild) {
				const units = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect());
				expect(units).toMatchObject([{ status: "completed", errorMessage: null }]);
				expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 3 } });
				expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
				const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
				expect(saved).toHaveLength(3);
				expect(saved.every((node) => node.archiveOperationId !== null)).toBe(true);
				return;
			}
			expect(result?.activity).toMatchObject({
				status: "failed",
				errorCode: "needs_review",
				progress: { completed: 0 },
			});
			expect(result?.run.needsReviewIds).toEqual([child._id]);
			expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(before);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
		},
	);

	test("saves a private parent and child in one unit, regardless of selection order", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId } = await start_review(f, "accept", [child, parent]);
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		expect(result?.run).toMatchObject({ unitCount: 1, finishedUnitCount: 1 });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path).sort()).toEqual(["/parent", "/parent/child"]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toHaveLength(2);
	});

	test("rechecks affected proposals when a saved move changes the archive's children", async () => {
		const f = await fixture();
		const parentId = await saved_folder(f, "parent");
		const childId = await saved_folder(f, "child");
		for (const id of [parentId, childId])
			expect(
				(
					await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
						...f.scope,
						target: { kind: "saved", id },
					})
				)._nay,
			).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const parent = proposals.find((proposal) => proposal.target.id === parentId)!;
		const { runId } = await start_review(f, "accept", [parent]);
		const reviewVersion = await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").first());
		expect(
			(
				await f.asUser.mutation(api.files_nodes.move_nodes, {
					membershipId: f.db.membershipId,
					itemIds: [childId],
					targetParentId: parentId,
				})
			)._nay,
		).toBeUndefined();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").first())).toEqual(reviewVersion);
		const beforeReview = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "blocked", errorCode: "needs_review" },
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(beforeReview);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(proposals);
	});

	test("saves a reviewed private folder before archiving its saved parent", async () => {
		const f = await fixture();
		const parentId = await saved_folder(f, "parent");
		await private_folder(f, "/parent/child");
		expect(
			(
				await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
					...f.scope,
					target: { kind: "saved", id: parentId },
				})
			)._nay,
		).toBeUndefined();
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		const { runId } = await start_review(f, "accept", proposals);
		const result = await finish_review(f, runId);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toMatchObject([
			{ status: "completed", errorMessage: null },
		]);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.map((node) => node.path)).toEqual(["/parent", "/parent/child"]);
		expect(saved.every((node) => node.archiveOperationId !== null)).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual([]);
	});

	test("does not discard an unselected ready child", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId } = await start_review(f, "discard", [parent]);
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({
			status: "failed",
			errorCode: "needs_review",
			progress: { completed: 0, blocked: 1 },
		});
		expect(result?.run.needsReviewIds).toEqual([child._id]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toMatchObject([
			{ state: "active" },
			{ state: "active" },
		]);
	});

	test("counts the whole approved Discard at the root fence and keeps cleanup running after Stop", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId, activityId } = await start_review(f, "discard", [parent, child]);
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		const beforeCleanup = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(beforeCleanup.map((node) => node.state)).toEqual(["discarded", "active"]);
		await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId });
		const task = await f.t.run((ctx) => ctx.db.query("files_pending_node_cleanup_tasks").first());
		if (!task) throw new Error("Expected durable cleanup");
		await f.t.mutation(internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId: task._id });
		if (child.target.kind !== "private") throw new Error("Expected a private child");
		const childId = child.target.id;
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", childId))).toMatchObject({ state: "discarded" });
		expect(
			(await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId }))?.activity
				.status,
		).toBe("succeeded");
	});

	test("Stop before preparation leaves every private proposal pending", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId, activityId } = await start_review(f, "accept", [parent]);
		await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId });
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		expect(
			(await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId }))?.activity,
		).toMatchObject({ status: "canceled", progress: { completed: 0, canceled: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
	});

	test("late planning delivery keeps the timeout result", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review(f, "accept", [parent], false);
		vi.setSystemTime(Date.now() + 30 * 60 * 1000);
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.activity).toMatchObject({
			status: "timed_out",
			progress: { completed: 0, blocked: 0, canceled: 1 },
		});
	});

	test.each([false, true])("late preparation keeps its retry (watchdog first: %s)", async (watchdogFirst) => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review(f, "accept", [parent]);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique());
		if (!unit) throw new Error("Expected the first attempt");
		const delivery = { runId, fence: 0, unitId: unit._id, attemptFence: unit.attemptFence };
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		if (watchdogFirst) await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		await f.t.action(internal.files_pending_update_runs.prepare_unit, delivery);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
		await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique())).toMatchObject({
			attemptCount: 2,
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toMatchObject([{ path: "/parent" }]);
	});

	test("stops after three expired preparation attempts", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review(f, "accept", [parent]);
		for (let attempt = 1; attempt <= 3; attempt++) {
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique());
			if (!unit) throw new Error("Expected a preparation attempt");
			expect(unit.attemptCount).toBe(attempt);
			vi.setSystemTime(Date.now() + 5 * 60 * 1000);
			await f.t.action(internal.files_pending_update_runs.prepare_unit, {
				runId,
				fence: 0,
				unitId: unit._id,
				attemptFence: unit.attemptFence,
			});
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
		}
		const result = await finish_review(f, runId);
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, failed: 1 } });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").unique())).toMatchObject({
			attemptCount: 3,
			errorCode: "attempt_expired",
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test("recovers a lost planning action and fences its old delivery", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review(f, "accept", [parent], false);
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({
			step: "planning",
			planningAttempts: 2,
			fence: 1,
		});
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toEqual([]);
		await f.t.action(internal.files_pending_update_runs.plan, { runId, fence: 1 });
		expect((await finish_review(f, runId))?.activity).toMatchObject({
			status: "succeeded",
			progress: { completed: 1 },
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toMatchObject([{ path: "/parent" }]);
	});

	test("keeps finished review history for seven days and removes it in batches", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const child = await private_folder(f, "/parent/child");
		const { runId, activityId } = await start_review(f, "accept", [parent, child]);
		const result = await finish_review(f, runId);
		if (!result) throw new Error("Expected the finished review");
		expect(result.activity.status).toBe("succeeded");
		expect(result.activity.expiresAt).toBe(result.activity.finishedAt! + 7 * 24 * 60 * 60 * 1000);
		const savedBefore = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		const scheduledBefore = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		vi.setSystemTime(result.activity.expiresAt! - 1);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduledBefore);
		expect(await f.t.mutation(internal.activities.cleanup_history, { _test_disableReschedule: true })).toEqual({
			deletedCount: 0,
			done: true,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toEqual(result.run);
		vi.setSystemTime(Date.now() + 1);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		expect(await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduledBefore);
		await f.t.mutation(internal.activities.cleanup_history, { _test_disableReschedule: true });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).not.toBeNull();
		for (let pass = 0; pass < 4; pass++)
			await f.t.mutation(internal.activities.cleanup_history, { _test_disableReschedule: true });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual(savedBefore);
	});

	test("stops after three lost planning attempts without changing drafts", async () => {
		const f = await fixture();
		const parent = await private_folder(f, "/parent");
		const { runId } = await start_review(f, "accept", [parent], false);
		for (let pass = 0; pass < 3; pass++) {
			vi.setSystemTime(Date.now() + 5 * 60 * 1000);
			await f.t.mutation(internal.files_pending_update_runs.recover, {});
		}
		const result = await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId });
		expect(result?.run).toMatchObject({ step: "finished", planningAttempts: 3 });
		expect(result?.activity).toMatchObject({
			status: "failed",
			errorCode: "attempt_expired",
			progress: { completed: 0, blocked: 1 },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
		expect(await f.t.run((ctx) => ctx.db.query("files_nodes").collect())).toEqual([]);
	});

	test.each(["user", "workspace"] as const)(
		"purges active review workers before proposals, one item at a time (%s)",
		async (scope) => {
			const f = await fixture();
			const savedId = await saved_folder(f, "saved");
			const parent = await private_folder(f, "/parent");
			const child = await private_folder(f, "/parent/child");
			const { runId, activityId } = await start_review(f, "accept", [parent, child]);
			await f.t.mutation(internal.files_pending_update_runs.advance, { runId });
			const unit = await f.t.run((ctx) => ctx.db.query("files_pending_update_run_units").first());
			if (!unit) throw new Error("Expected an active unit");
			const control = await f.t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "review-purge-control" }),
			);
			const controlDraft = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: control.organizationId,
				workspaceId: control.workspaceId,
				userId: control.userId,
				path: "/control",
				kind: "folder",
			});
			if (controlDraft._nay) throw new Error(controlDraft._nay.message);
			let requestId: Id<"data_deletion_requests"> | null = null;
			if (scope === "workspace") {
				expect(
					(await f.asUser.mutation(api.organizations.delete_workspace, { workspaceId: f.db.workspaceId }))._nay,
				).toBeUndefined();
				const request = await f.t.run((ctx) => ctx.db.query("data_deletion_requests").collect());
				requestId = request.find((doc) => doc.scope === "workspace" && doc.workspaceId === f.db.workspaceId)!._id;
			}
			async function purge() {
				if (requestId)
					return (
						await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
							requestId,
							_test_batchSize: 1,
						})
					).done;
				return await f.t.mutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: f.db.userId,
					deleteUserRecord: true,
					_test_batchSize: 1,
					_test_disableReschedule: true,
				});
			}
			expect(await purge()).toBe(false);
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_run_items").collect())).toHaveLength(1);
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", runId))).toMatchObject({
				step: "finished",
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", parent._id))).toEqual(parent);
			await f.t.action(internal.files_pending_update_runs.prepare_unit, {
				runId,
				fence: 0,
				unitId: unit._id,
				attemptFence: unit.attemptFence,
			});
			expect(await f.t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts").collect())).toEqual([]);
			let done = false;
			for (let pass = 0; pass < 150 && !done; pass++) done = await purge();
			expect(done).toBe(true);
			for (const table of [
				"files_pending_update_runs",
				"files_pending_update_run_items",
				"files_pending_update_run_units",
			] as const)
				expect(await f.t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
			expect(
				await f.t.run((ctx) => ctx.db.get("files_pending_updates", controlDraft._yay.pendingUpdateId!)),
			).not.toBeNull();
			const saved = await f.t.run((ctx) => ctx.db.get("files_nodes", savedId));
			if (scope === "user") expect(saved).toMatchObject({ path: "/saved", archiveOperationId: null });
			else expect(saved).toBeNull();
		},
	);
});
