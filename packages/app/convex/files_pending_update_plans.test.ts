import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Result } from "common/errors-as-values-utils.ts";
import { api, internal } from "./_generated/api.js";
import { advance as produce_advance } from "./files_pending_update_plan_producer.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	advance,
	files_pending_update_plans_db_add_items,
	files_pending_update_plans_db_add_relations,
	files_pending_update_plans_db_begin,
	files_pending_update_plans_db_delete_run_batch,
	files_pending_update_plans_db_get,
	files_pending_update_plans_db_seal_graph,
	files_pending_update_plans_db_seal_items,
} from "./files_pending_update_plans.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_record,
} from "./organizations_membership_lifetimes.ts";
import {
	test_convex,
	test_finish_pending_update_run,
	test_mocks,
	test_mocks_fill_db_with,
	test_spy_handler,
} from "./setup.test.ts";
import { files_pending_overlay_db_flush } from "../server/files-pending-overlay.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

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

async function saved_folders(f: Awaited<ReturnType<typeof fixture>>, count: number) {
	const ids: Id<"files_nodes">[] = [];
	for (let offset = 0; offset < count; offset += 100) {
		ids.push(
			...(await f.t.run(async (ctx) => {
				const page = [];
				for (let order = offset; order < Math.min(offset + 100, count); order++) {
					const name = `source-${order}`;
					page.push(
						await ctx.db.insert("files_nodes", {
							...test_mocks.files.base(),
							organizationId: f.scope.organizationId,
							workspaceId: f.scope.workspaceId,
							createdBy: f.scope.userId,
							updatedBy: f.scope.userId,
							parentId: "root",
							name,
							sortName: files_sort_text_key(name),
							path: `/${name}`,
							treePath: `/${name}/`,
							pathDepth: 1,
						}),
					);
				}
				return page;
			})),
		);
	}
	return ids;
}

async function propose_move(f: Awaited<ReturnType<typeof fixture>>, nodeId: Id<"files_nodes">, destName: string) {
	const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
		...f.scope,
		target: { kind: "saved", id: nodeId },
		destParent: { kind: "root" },
		destName,
	});
	if (moved._nay) throw new Error(moved._nay.message);
	const proposal = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) =>
				q.eq("userId", f.db.userId).eq("target.kind", "saved").eq("target.id", nodeId),
			)
			.unique(),
	);
	if (!proposal) throw new Error("Expected the Move proposal");
	return proposal;
}

async function start_review(
	f: Awaited<ReturnType<typeof fixture>>,
	proposals: Doc<"files_pending_updates">[],
	native: boolean | "action" = false,
	afterUpload?: () => Promise<void>,
) {
	const items = proposals.map((proposal) => ({
		pendingUpdateId: proposal._id,
		reviewedRevision: proposal.revision,
		selectedContentStateId: null,
	}));
	const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: items.length,
		items: items.slice(0, 100),
	});
	if (started._nay) throw new Error(started._nay.message);
	for (let offset = 100; offset < items.length; offset += 100)
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.append_items, {
				membershipId: f.db.membershipId,
				runId: started._yay.runId,
				offset,
				items: items.slice(offset, offset + 100),
			}),
		).toEqual({ _yay: null });
	expect(
		await f.asUser.mutation(api.files_pending_update_runs.seal, {
			membershipId: f.db.membershipId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	await afterUpload?.();
	const begun = await f.t.run((ctx) =>
		files_pending_update_plans_db_begin(ctx, { runId: started._yay.runId, fence: 0 }),
	);
	if (begun._nay) throw new Error(begun._nay.message);
	let nativePlan = begun._yay;
	if (native === "action") {
		for (;;) {
			const job = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_overlay_jobs")
					.withIndex("by_org_ws", (q) =>
						q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
					)
					.first(),
			);
			if (job) {
				await f.t.mutation(internal.files_pending_overlay.run_job, {
					kind: job.kind,
					key: job.key,
					nextAttemptAt: job.nextAttemptAt,
				});
				continue;
			}
			await f.t.action(internal.files_pending_update_runs.plan, { runId: started._yay.runId, fence: 0 });
			const run = await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", started._yay.runId));
			if (!run?.graphPlanId) throw new Error("Expected the active graph plan");
			nativePlan = (await f.t.run((ctx) => ctx.db.get("files_pending_update_plans", run.graphPlanId!)))!;
			if (run.step !== "planning") break;
		}
	} else if (native) {
		while (nativePlan.producerPhase !== "sealed") {
			const result = await f.t.mutation(internal.files_pending_update_plan_producer.advance, {
				runId: started._yay.runId,
				fence: 0,
				planEpoch: nativePlan.epoch,
			});
			if (result._nay) throw new Error(result._nay.message);
			nativePlan = result._yay.plan;
			if (result._yay.media) throw new Error("This fixture has no media");
			if (result._yay.waiting) {
				const job = await f.t.run((ctx) =>
					ctx.db
						.query("files_pending_overlay_jobs")
						.withIndex("by_org_ws", (q) =>
							q.eq("organizationId", f.scope.organizationId).eq("workspaceId", f.scope.workspaceId),
						)
						.first(),
				);
				if (!job) throw new Error("Expected a pending facts job");
				await f.t.mutation(internal.files_pending_overlay.run_job, {
					kind: job.kind,
					key: job.key,
					nextAttemptAt: job.nextAttemptAt,
				});
			}
		}
	}
	let cursor: string | null = null;
	const runItems: Doc<"files_pending_update_run_items">[] = [];
	for (;;) {
		const page = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.paginate({ cursor, numItems: 100 }),
		);
		runItems.push(...page.page);
		const added = native
			? Result({ _yay: nativePlan })
			: await f.t.run((ctx) =>
					files_pending_update_plans_db_add_items(ctx, {
						planId: begun._yay._id,
						offset: page.page[0]!.order,
						items: page.page.map((item) => ({ runItemId: item._id, mode: "ordinary", deleteLast: false, error: null })),
					}),
				);
		if (added._nay) throw new Error(added._nay.message);
		if (page.isDone) break;
		cursor = page.continueCursor;
	}
	const sealed = native
		? Result({ _yay: nativePlan })
		: await f.t.run((ctx) => files_pending_update_plans_db_seal_items(ctx, { planId: begun._yay._id }));
	if (sealed._nay) throw new Error(sealed._nay.message);
	return { ...started._yay, plan: sealed._yay, runItems };
}

async function independent_review(count: number, native: boolean | "action" = false) {
	const f = await fixture();
	const nodes = await saved_folders(f, count);
	const proposals = [];
	for (const [order, nodeId] of nodes.entries()) proposals.push(await propose_move(f, nodeId, `moved-${order}`));
	return { ...f, nodes, proposals, ...(await start_review(f, proposals, native)) };
}

async function add_relations(
	f: Awaited<ReturnType<typeof independent_review>>,
	relations: { from: number; to: number; kind: Doc<"files_pending_update_plan_relations">["kind"] }[],
) {
	for (let offset = 0; offset < relations.length; offset += 8) {
		const result = await f.t.run((ctx) =>
			files_pending_update_plans_db_add_relations(ctx, {
				planId: f.plan._id,
				offset,
				relations: relations.slice(offset, offset + 8).map((relation) => ({
					fromRunItemId: f.runItems[relation.from]!._id,
					toRunItemId: f.runItems[relation.to]!._id,
					kind: relation.kind,
				})),
			}),
		);
		if (result._nay) throw new Error(result._nay.message);
	}
	const sealed = await f.t.run((ctx) =>
		files_pending_update_plans_db_seal_graph(ctx, { planId: f.plan._id, relationCount: relations.length }),
	);
	if (sealed._nay) throw new Error(sealed._nay.message);
	return sealed._yay;
}

async function finish_plan(
	f: Awaited<ReturnType<typeof fixture>>,
	initial: Doc<"files_pending_update_plans">,
) {
	let plan = initial;
	while (plan.phase !== "ready") {
		const next = await f.t.mutation(internal.files_pending_update_plans.advance, { planId: plan._id, step: plan.step });
		if (next._nay) throw new Error(next._nay.message);
		plan = next._yay;
	}
	return plan;
}

async function read_components(f: Awaited<ReturnType<typeof independent_review>>) {
	const rows: Doc<"files_pending_update_plan_components">[] = [];
	let cursor: string | null = null;
	for (;;) {
		const page = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_plan_components")
				.withIndex("by_plan_order", (q) => q.eq("planId", f.plan._id))
				.paginate({ cursor, numItems: 100 }),
		);
		rows.push(...page.page);
		if (page.isDone) return rows;
		cursor = page.continueCursor;
	}
}

describe("paged review graph", () => {
	test("saves while another user's unrelated Copy waits for a conflict choice", async () => {
		const f = await fixture();
		const folders = new Map<string, Id<"files_nodes">>();
		for (const path of ["/copy-source/item", "/copy-target", "/copy-target/item"]) {
			const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path });
			if (created._nay) throw new Error(created._nay.message);
			folders.set(path, created._yay.nodeId);
		}
		const copier = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "unrelated-copy-member" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { userId, membershipId };
		});
		const asCopier = f.t.withIdentity({ issuer: "https://clerk.test", external_id: copier.userId });
		const copying = await asCopier.mutation(api.files_transfer.start, {
			membershipId: copier.membershipId,
			requestId: "paused-unrelated-copy",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [folders.get("/copy-source/item")!],
			targetParentId: folders.get("/copy-target")!,
		});
		if (copying._nay) throw new Error(copying._nay.message);
		const copyArgs = { membershipId: copier.membershipId, runId: copying._yay.runId };
		expect(await asCopier.mutation(api.files_transfer.seal, copyArgs)).toEqual({ _yay: null });
		for (let step = 0; step < 150; step++) {
			if ((await asCopier.query(api.files_transfer.get, copyArgs))?.activity.status === "awaiting_input") break;
			await f.t.mutation(internal.files_transfer.advance, { runId: copying._yay.runId });
		}
		expect(await asCopier.query(api.files_transfer.get, copyArgs)).toMatchObject({
			activity: { status: "awaiting_input", progress: { completed: 0, blocked: 1 } },
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_subtree_ops")
					.withIndex("by_transferRun", (q) => q.eq("transferRunId", copying._yay.runId))
					.unique(),
			),
		).toMatchObject({ kind: "copy", status: "running" });
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			path: "/review-private",
			kind: "folder",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the private folder proposal");
		const proposal = (await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!)))!;
		const review = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: "save-past-unrelated-copy",
			kind: "accept",
			expectedItemCount: 1,
			items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
		});
		if (review._nay) throw new Error(review._nay.message);
		const reviewArgs = { membershipId: f.db.membershipId, runId: review._yay.runId };
		expect(await f.asUser.mutation(api.files_pending_update_runs.seal, reviewArgs)).toEqual({ _yay: null });
		// Run real steps for one minute. The other user's conflict must not expire.
		for (let step = 0; step < 600; step++) {
			if ((await f.asUser.query(api.files_pending_update_runs.get, reviewArgs))?.activity.status === "succeeded") break;
			vi.advanceTimersByTime(100);
			await f.t.finishInProgressScheduledFunctions();
		}
		expect(
			await f.asUser.query(api.files_pending_update_runs.get, reviewArgs),
			"An unrelated paused Copy must not block private Save",
		).toMatchObject({ activity: { status: "succeeded", progress: { completed: 1 } } });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toBeNull();
		expect(await asCopier.query(api.files_transfer.get, copyArgs)).toMatchObject({
			activity: { status: "awaiting_input", progress: { completed: 0, blocked: 1 } },
		});
	});

	test("plans a private child through its published parent's receipt", async () => {
		const f = await fixture();
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			path: "/parent/child",
			kind: "folder",
		});
		if (created._nay || created._yay.target.kind !== "private") throw new Error("Expected the private child");
		const childId = created._yay.target.id;
		const proposals = await f.t.run(async (ctx) => {
			const child = (await ctx.db.get("files_pending_nodes", childId))!;
			if (child.parent.kind !== "private") throw new Error("Expected the private parent");
			return await Promise.all(
				[child.parent.id, childId].map((id) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", f.db.userId).eq("target.kind", "private").eq("target.id", id),
						)
						.unique(),
				),
			);
		});
		const parentReview = await start_review(f, [proposals[0]!], "action");
		await test_finish_pending_update_run(f.asUser, parentReview.runId);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposals[0]!._id))).toBeNull();
		const child = (await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposals[1]!._id)))!;
		const review = await start_review(f, [child], "action");
		const ready = await finish_plan(f, review.plan);
		expect(ready.unitCount).toBe(1);
		const item = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_plan_items")
				.withIndex("by_plan_order", (q) => q.eq("planId", review.plan._id))
				.unique(),
		);
		expect(item?.errorCode, "a published private parent needs no new reviewed proposal").toBeNull();
	});

	test("seals native saved Move inputs through the relation producer", async () => {
		const f = await independent_review(17, true);
		const ready = await finish_plan(f, f.plan);
		expect(ready).toMatchObject({ producerPhase: "sealed", itemCount: 17, unitCount: 17, assignedItemCount: 17 });
		const components = await read_components(f);
		const units = await f.t.run((ctx) =>
			Promise.all(components.map((component) => ctx.db.get("files_pending_update_run_units", component.unitId))),
		);
		expect(units.every((unit) => unit?.kind === "cohort" && unit.planEpoch === ready.epoch)).toBe(true);
		const vertices = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_plan_items")
				.withIndex("by_plan_order", (q) => q.eq("planId", f.plan._id))
				.collect(),
		);
		expect(
			vertices.map((vertex) => vertex.errorCode),
			"unrelated native Moves have no review errors",
		).toEqual(Array.from({ length: 17 }, () => null));
		expect(f.runItems.every((item) => item.reviewHeader?.pendingMove?.destName.startsWith("moved-"))).toBe(true);
	});
	test("recovers a partial native graph without resetting its saved progress", async () => {
		const f = await independent_review(9, true);
		const advanced = await f.t.mutation(internal.files_pending_update_plans.advance, {
			planId: f.plan._id,
			step: f.plan.step,
		});
		if (advanced._nay) throw new Error(advanced._nay.message);
		const before = advanced._yay;
		expect(before.phase).toBe("components");
		expect(before.assignedItemCount).toBeGreaterThan(0);
		vi.setSystemTime(Date.now() + 5 * 60 * 1000);
		await f.t.mutation(internal.files_pending_update_runs.recover, {});
		const run = (await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", f.runId)))!;
		expect(run).toMatchObject({ fence: 1, graphPlanId: before._id, planEpoch: before.epoch, step: "planning" });
		const rebound = await f.t.run((ctx) =>
			files_pending_update_plans_db_begin(ctx, { runId: f.runId, fence: run.fence }),
		);
		expect(rebound._yay, "recovery keeps the same graph and every saved cursor").toEqual({ ...before, fence: 1 });
		expect(
			(await f.t.run((ctx) => files_pending_update_plans_db_begin(ctx, { runId: f.runId, fence: 0 })))._nay?.name,
		).toBe("stopped");
		expect(
			(
				await f.t.mutation(internal.files_pending_update_plan_producer.stage_media, {
					runId: f.runId,
					fence: 0,
					planEpoch: before.epoch,
					itemId: f.runItems[0]!._id,
					offset: 0,
					refs: [],
					isDone: true,
					error: null,
				})
			)._nay?.name,
			"an old media action cannot write after recovery",
		).toBe("stopped");
		expect(
			await f.t.mutation(internal.files_pending_update_plans.advance, { planId: before._id, step: before.step - 1 }),
		).toEqual(rebound);
		await test_finish_pending_update_run(f.asUser, f.runId);
		expect(
			await f.asUser.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId: f.runId }),
			"the recovered native Move graph finishes",
		).toMatchObject({ activity: { status: "succeeded", progress: { completed: 9 } } });
	});

	test("keeps independent saved Moves separate and replays a lost step reply", async () => {
		const f = await independent_review(3);
		const sealed = await add_relations(f, []);
		const step = { planId: sealed._id, step: sealed.step };
		const advanced = await f.t.mutation(internal.files_pending_update_plans.advance, step);
		expect(advanced._nay).toBeUndefined();
		expect(await f.t.mutation(internal.files_pending_update_plans.advance, step)).toEqual(advanced);
		if (advanced._nay) return;
		const ready = await finish_plan(f, advanced._yay);
		expect(ready).toMatchObject({ itemCount: 3, unitCount: 3, assignedItemCount: 3, dfsTop: 0, componentTop: 0 });
		expect((await read_components(f)).map((component) => [component.kind, component.itemCount])).toEqual([
			["singleton", 1],
			["singleton", 1],
			["singleton", 1],
		]);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodes[0]!))).toMatchObject({ name: "source-0" });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.proposals[0]!._id))).toEqual(f.proposals[0]);
	});

	test("groups a long hard chain across component pop pages", async () => {
		const f = await independent_review(35);
		const sealed = await add_relations(
			f,
			Array.from({ length: 34 }, (_, from) => ({ from, to: from + 1, kind: "structure" })),
		);
		let plan = sealed;
		while (!plan.poppingRootId) {
			const next = await f.t.mutation(internal.files_pending_update_plans.advance, {
				planId: plan._id,
				step: plan.step,
			});
			if (next._nay) throw new Error(next._nay.message);
			plan = next._yay;
		}
		expect(plan.assignedItemCount).toBe(16);
		const step = { planId: plan._id, step: plan.step };
		const popped = await f.t.mutation(internal.files_pending_update_plans.advance, step);
		expect(await f.t.mutation(internal.files_pending_update_plans.advance, step)).toEqual(popped);
		if (popped._nay) throw new Error(popped._nay.message);
		const ready = await finish_plan(f, popped._yay);
		expect(ready).toMatchObject({ unitCount: 1, assignedItemCount: 35 });
		expect(await read_components(f), "one group contains every hard-linked item").toMatchObject([
			{ kind: "cohort", itemCount: 35, order: 0 },
		]);
	});

	test("groups a directed dependency cycle and keeps outside prerequisites", async () => {
		const f = await independent_review(4);
		// The graph API takes reviewed relations. Their producer proves each Copy origin separately.
		const sealed = await add_relations(f, [
			{ from: 0, to: 1, kind: "copy_parent" },
			{ from: 1, to: 2, kind: "copy_media" },
			{ from: 2, to: 0, kind: "copy_parent" },
			{ from: 2, to: 3, kind: "copy_media" },
			{ from: 2, to: 3, kind: "copy_media" },
		]);
		expect(sealed.edgeCount).toBe(4);
		const ready = await finish_plan(f, sealed);
		expect(ready.unitCount, "cyclic dependencies form one group").toBe(2);
		expect(ready.assignedItemCount).toBe(4);
		const components = await read_components(f);
		expect(components).toMatchObject([
			{ kind: "cohort", itemCount: 3 },
			{ kind: "singleton", itemCount: 1 },
		]);
		const units = await f.t.run(async (ctx) =>
			Promise.all(components.map((component) => ctx.db.get("files_pending_update_run_units", component.unitId))),
		);
		expect(units).toMatchObject([
			{ status: "waiting", remainingPrerequisiteCount: 1 },
			{ status: "queued", remainingPrerequisiteCount: 0 },
		]);
		const dependencies = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_dependencies")
				.withIndex("by_unit_required_kind", (q) =>
					q.eq("unitId", components[0]!.unitId).eq("requiredUnitId", components[1]!.unitId).eq("kind", "media"),
				)
				.unique(),
		);
		expect(dependencies).toMatchObject({ settled: false });
	});

	test("groups a native name cycle without changing saved names", async () => {
		const base = await fixture();
		const nodes = await saved_folders(base, 21);
		const proposals = new Map<Id<"files_nodes">, Doc<"files_pending_updates">>();
		await propose_move(base, nodes[0]!, "temporary-draft-name");
		for (let order = nodes.length - 1; order > 0; order--)
			proposals.set(nodes[order]!, await propose_move(base, nodes[order]!, `source-${(order + 1) % nodes.length}`));
		proposals.set(nodes[0]!, await propose_move(base, nodes[0]!, "source-1"));
		const selected = nodes.map((id) => proposals.get(id)!);
		const f = { ...base, nodes, proposals: selected, ...(await start_review(base, selected, true)) };
		const ready = await finish_plan(f, f.plan);
		expect(ready.unitCount, "native name links form one closed group").toBe(1);
		expect(ready).toMatchObject({ unitCount: 1, assignedItemCount: 21 });
		expect(await read_components(f)).toMatchObject([{ kind: "cohort", itemCount: 21 }]);
		const saved = await f.t.run((ctx) => Promise.all(nodes.map((id) => ctx.db.get("files_nodes", id))));
		expect(saved.map((node) => node?.name)).toEqual(nodes.map((_, order) => `source-${order}`));
	});

	test("keeps frozen name links after one selected Move is revised", async () => {
		const base = await fixture();
		const nodes = await saved_folders(base, 3);
		await propose_move(base, nodes[0]!, "temporary-draft-name");
		const third = await propose_move(base, nodes[2]!, "source-0");
		const second = await propose_move(base, nodes[1]!, "source-2");
		const first = await propose_move(base, nodes[0]!, "source-1");
		const proposals = [first, second, third];
		const f = {
			...base,
			nodes,
			proposals,
			...(await start_review(base, proposals, true, async () => {
				await propose_move(base, nodes[0]!, "revised-draft-name");
			})),
		};
		const ready = await finish_plan(f, f.plan);
		expect(ready.unitCount, "the old reviewed name links still form one group").toBe(1);
		const [component] = await read_components(f);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", component!.unitId))).toMatchObject({
			errorCode: "needs_review",
		});
		expect(f.runItems[0]!.reviewHeader?.pendingMove?.destName).toBe("source-1");
	});

	test("refuses changed page replays and an unselected relation", async () => {
		const f = await independent_review(2);
		const itemPage = {
			planId: f.plan._id,
			offset: 0,
			items: [{ runItemId: f.runItems[0]!._id, mode: "ordinary" as const, deleteLast: false, error: null }],
		};
		expect((await f.t.run((ctx) => files_pending_update_plans_db_add_items(ctx, itemPage)))._nay).toBeUndefined();
		await expect(
			f.t.run((ctx) =>
				files_pending_update_plans_db_add_items(ctx, {
					...itemPage,
					items: [{ ...itemPage.items[0]!, deleteLast: true }],
				}),
			),
		).rejects.toThrow("The review item replay changed.");
		const relationPage = {
			planId: f.plan._id,
			offset: 0,
			relations: [{ fromRunItemId: f.runItems[0]!._id, toRunItemId: f.runItems[1]!._id, kind: "structure" as const }],
		};
		const added = await f.t.run((ctx) => files_pending_update_plans_db_add_relations(ctx, relationPage));
		expect(await f.t.run((ctx) => files_pending_update_plans_db_add_relations(ctx, relationPage))).toEqual(added);
		await expect(
			f.t.run((ctx) =>
				files_pending_update_plans_db_add_relations(ctx, {
					...relationPage,
					relations: [{ ...relationPage.relations[0]!, kind: "archive" }],
				}),
			),
		).rejects.toThrow("The review relation replay changed.");
		const db = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other-review" }));
		const otherFixture = {
			...f,
			db,
			scope: { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId },
			asUser: f.t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId }),
		};
		const [otherNode] = await saved_folders(otherFixture, 1);
		const other = await start_review(otherFixture, [await propose_move(otherFixture, otherNode!, "other-moved")]);
		await expect(
			f.t.run((ctx) =>
				files_pending_update_plans_db_add_relations(ctx, {
					...relationPage,
					offset: 1,
					relations: [{ ...relationPage.relations[0]!, toRunItemId: other.runItems[0]!._id }],
				}),
			),
		).rejects.toThrow("A linked change is outside this review.");
		expect((await f.t.run((ctx) => files_pending_update_plans_db_get(ctx, { planId: f.plan._id })))._yay).toMatchObject(
			{
				relationCount: 1,
				edgeCount: 2,
			},
		);
	});

	test("drains graph children before deleting their plan", async () => {
		const f = await independent_review(4);
		const sealed = await add_relations(f, [
			{ from: 0, to: 1, kind: "structure" },
			{ from: 1, to: 2, kind: "structure" },
			{ from: 2, to: 0, kind: "structure" },
		]);
		const next = await f.t.mutation(internal.files_pending_update_plans.advance, {
			planId: sealed._id,
			step: sealed.step,
		});
		if (next._nay) throw new Error(next._nay.message);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_update_plan_frames").collect())).not.toEqual([]);
		await f.asUser.mutation(api.activities.request_stop, {
			membershipId: f.db.membershipId,
			activityId: f.activityId,
		});
		for (let pass = 0; pass < 100; pass++) {
			const result = await f.t.run((ctx) =>
				files_pending_update_plans_db_delete_run_batch(ctx, { runId: f.runId, batchSize: 2 }),
			);
			expect(result.deletedCount).toBeLessThanOrEqual(2);
			const children = await f.t.run(async (ctx) =>
				Promise.all([
					ctx.db.query("files_pending_update_plan_edges").collect(),
					ctx.db.query("files_pending_update_plan_frames").collect(),
					ctx.db.query("files_pending_update_plan_walks").collect(),
					ctx.db.query("files_pending_update_plan_relations").collect(),
					ctx.db.query("files_pending_update_plan_components").collect(),
					ctx.db.query("files_pending_update_plan_items").collect(),
				]),
			);
			const plan = await f.t.run((ctx) => ctx.db.get("files_pending_update_plans", sealed._id));
			if (children.some((rows) => rows.length))
				expect(plan, "the plan stays while any graph child remains").not.toBeNull();
			if (result.done) {
				expect(children, "history cleanup leaves no graph children").toEqual([[], [], [], [], [], []]);
				expect(plan).toBeNull();
				return;
			}
		}
		throw new Error("Graph cleanup did not finish");
	});

	test.each(["stop", "reinvite", "expire"] as const)("writes no graph progress after %s", async (change) => {
		const f = await independent_review(2);
		const sealed = await add_relations(f, []);
		if (change === "stop")
			expect(
				await f.asUser.mutation(api.activities.request_stop, {
					membershipId: f.db.membershipId,
					activityId: f.activityId,
				}),
			).toEqual({ _yay: null });
		if (change === "reinvite")
			await f.t.run(async (ctx) => {
				const membership = await ctx.db.get("organizations_workspaces_users", f.db.membershipId);
				if (!membership) throw new Error("Expected membership");
				await ctx.db.patch("organizations_workspaces_users", membership._id, { active: false });
				await organizations_membership_lifetimes_db_record(ctx, [{ membership, active: false }]);
				await ctx.db.patch("organizations_workspaces_users", membership._id, { active: true });
				expect(await organizations_membership_lifetimes_db_ensure(ctx, { ...membership, active: true })).toBe(2);
			});
		if (change === "expire") vi.setSystemTime(Date.now() + 31 * 60 * 1000);
		const result = await f.t.mutation(internal.files_pending_update_plans.advance, {
			planId: sealed._id,
			step: sealed.step,
		});
		expect(result._nay).toMatchObject({
			name: change === "reinvite" ? "permission_denied" : change === "expire" ? "timed_out" : "stopped",
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_plans", sealed._id))).toEqual(sealed);
	});

	// Run this slow full-size check with test:files:full-size. It has no time limit.
	test("plans 10,001 unrelated saved Move proposals as 10,001 units", async () => {
		const costs: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>[] = [];
		test_spy_handler(advance, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			await files_pending_overlay_db_flush(ctx);
			costs.push(await ctx.meta.getTransactionMetrics());
			return result;
		});
		test_spy_handler(produce_advance, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			await files_pending_overlay_db_flush(ctx);
			costs.push(await ctx.meta.getTransactionMetrics());
			return result;
		});
		const f = await independent_review(10_001, "action");
		const ready = f.plan;
		expect(ready.unitCount, "all 10,001 selected Moves have a unit").toBe(10_001);
		expect(ready.assignedItemCount, "every selected proposal is assigned once").toBe(10_001);
		const components = await read_components(f);
		expect(components).toHaveLength(10_001);
		expect(components.every((component) => component.kind === "singleton" && component.itemCount === 1)).toBe(true);
		const max = {
			databaseQueries: Math.max(...costs.map((cost) => cost.databaseQueries.used)),
			documentsRead: Math.max(...costs.map((cost) => cost.documentsRead.used)),
			bytesRead: Math.max(...costs.map((cost) => cost.bytesRead.used)),
			documentsWritten: Math.max(...costs.map((cost) => cost.documentsWritten.used)),
			bytesWritten: Math.max(...costs.map((cost) => cost.bytesWritten.used)),
		};
		expect(max.databaseQueries).toBeLessThan(4096 * 0.75);
		expect(max.documentsRead).toBeLessThan(32_000 * 0.75);
		expect(max.bytesRead).toBeLessThan(16 * 1024 * 1024 * 0.75);
		expect(max.documentsWritten).toBeLessThan(16_000 * 0.75);
		expect(max.bytesWritten).toBeLessThan(16 * 1024 * 1024 * 0.75);
		console.info("Review graph transaction max", { transactions: costs.length, ...max });
	}, 0);
});
