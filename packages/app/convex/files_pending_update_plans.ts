import { Result } from "common/errors-as-values-utils.ts";
import { doc } from "convex-helpers/validators";
import type { PaginationOptions } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { activities_db_require_by_source_id, activities_is_active } from "./activities_db.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const ITEM_PAGE_SIZE = 100;
const RELATION_PAGE_SIZE = 8;
const COMPONENT_POP_SIZE = 16;
const COMPONENT_STEP_SIZE = 8;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

async function db_get_run(ctx: QueryCtx | MutationCtx, runId: Id<"files_pending_update_runs">, fence: number) {
	const run = await ctx.db.get("files_pending_update_runs", runId);
	if (!run || run.kind !== "accept" || run.step !== "planning" || run.fence !== fence)
		return Result({ _nay: { name: "stopped", message: "This review is no longer planning." } });
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	if (!activities_is_active(activity.status) || activity.deadlineAt <= Date.now())
		return Result({ _nay: { name: "timed_out", message: "This review has expired." } });
	const [user, workspace, organization, lifetime] = await Promise.all([
		ctx.db.get("users", run.userId),
		ctx.db.get("organizations_workspaces", run.workspaceId),
		ctx.db.get("organizations", run.organizationId),
		organizations_membership_lifetimes_db_get(ctx, run),
	]);
	if (
		!user ||
		user.deletedAt !== undefined ||
		!workspace ||
		!organization ||
		workspace.organizationId !== run.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!activity.membershipId ||
		!lifetime?.active ||
		lifetime.membershipId !== activity.membershipId ||
		lifetime.lifetime !== activity.membershipLifetime ||
		!(await organizations_db_get_membership(ctx, { userId: run.userId, membershipId: activity.membershipId }))
	)
		return Result({ _nay: { name: "permission_denied", message: "This review is no longer available." } });
	return Result({ _yay: { run, activity } });
}

async function db_get_plan(ctx: QueryCtx | MutationCtx, planId: Id<"files_pending_update_plans">) {
	const plan = await ctx.db.get("files_pending_update_plans", planId);
	if (!plan) return Result({ _nay: { name: "not_found", message: "The review plan is no longer available." } });
	const checked = await db_get_run(ctx, plan.runId, plan.fence);
	if (checked._nay) return checked;
	if (checked._yay.run.planEpoch !== plan.epoch || checked._yay.run.graphPlanId !== plan._id)
		return Result({ _nay: { name: "stopped", message: "This review plan belongs to an earlier attempt." } });
	return Result({ _yay: { ...checked._yay, plan } });
}

async function db_save_plan(
	ctx: MutationCtx,
	plan: Doc<"files_pending_update_plans">,
	patch: Partial<Doc<"files_pending_update_plans">>,
) {
	const updatedAt = Date.now();
	const { _id: _planId, _creationTime: _createdAt, ...fields } = patch;
	await ctx.db.patch("files_pending_update_plans", plan._id, { ...fields, step: plan.step + 1, updatedAt });
	const activity = await activities_db_require_by_source_id(ctx, plan.runId);
	await ctx.db.patch("activities", activity._id, { deadlineAt: updatedAt + RUN_TIMEOUT_MS, updatedAt });
	return { ...plan, ...patch, step: plan.step + 1, updatedAt };
}

async function db_push_vertex(
	ctx: MutationCtx,
	plan: Doc<"files_pending_update_plans">,
	item: Doc<"files_pending_update_plan_items">,
	parentItemId: Id<"files_pending_update_plan_items"> | null,
) {
	const dfsIndex = plan.nextDfsIndex;
	await ctx.db.patch("files_pending_update_plan_items", item._id, {
		visited: true,
		dfsIndex,
		lowlink: dfsIndex,
		onStack: true,
	});
	await ctx.db.insert("files_pending_update_plan_frames", {
		planId: plan._id,
		stack: "dfs",
		position: plan.dfsTop + 1,
		itemId: item._id,
		parentItemId,
		neighborOrder: -1,
	});
	await ctx.db.insert("files_pending_update_plan_frames", {
		planId: plan._id,
		stack: "component",
		position: plan.componentTop + 1,
		itemId: item._id,
		parentItemId: null,
		neighborOrder: -1,
	});
	return { ...plan, nextDfsIndex: dfsIndex + 1, dfsTop: plan.dfsTop + 1, componentTop: plan.componentTop + 1 };
}

async function db_pop_component(ctx: MutationCtx, originalPlan: Doc<"files_pending_update_plans">) {
	let plan = originalPlan;
	if (!plan.poppingRootId || !plan.poppingUnitId) throw should_never_happen("Missing review component root");
	const component = await ctx.db
		.query("files_pending_update_plan_components")
		.withIndex("by_plan_unit", (q) => q.eq("planId", plan._id).eq("unitId", plan.poppingUnitId!))
		.unique();
	if (!component) throw should_never_happen("Missing review component");
	let itemCount = component.itemCount;
	let order = component.order;
	let kind = component.kind;
	for (let index = 0; index < COMPONENT_POP_SIZE; index++) {
		const frame = await ctx.db
			.query("files_pending_update_plan_frames")
			.withIndex("by_plan_stack_position", (q) =>
				q.eq("planId", plan._id).eq("stack", "component").eq("position", plan.componentTop),
			)
			.unique();
		if (!frame) throw should_never_happen("Missing review component stack entry");
		const item = await ctx.db.get("files_pending_update_plan_items", frame.itemId);
		if (!item) throw should_never_happen("Missing review graph item");
		itemCount++;
		order = Math.min(order, item.order);
		if (itemCount > 1 || item.hardLinked) kind = "cohort";
		await ctx.db.patch("files_pending_update_plan_items", item._id, { onStack: false, unitId: component.unitId });
		await ctx.db.patch("files_pending_update_run_items", item.runItemId, { unitId: component.unitId });
		await ctx.db.delete("files_pending_update_plan_frames", frame._id);
		const unit = await ctx.db.get("files_pending_update_run_units", component.unitId);
		if (!unit) throw should_never_happen("Missing review unit");
		await ctx.db.patch("files_pending_update_run_units", unit._id, {
			order,
			itemCount,
			kind: "cohort",
			deleteLast: unit.deleteLast || item.deleteLast,
			...(unit.errorCode === null && item.errorCode !== null
				? { errorCode: item.errorCode, errorMessage: item.errorMessage }
				: {}),
		});
		plan = { ...plan, componentTop: plan.componentTop - 1, assignedItemCount: plan.assignedItemCount + 1 };
		if (item._id === plan.poppingRootId) {
			plan = { ...plan, poppingRootId: null, poppingUnitId: null };
			break;
		}
	}
	await ctx.db.patch("files_pending_update_plan_components", component._id, { itemCount, order, kind });
	return plan;
}

/**
 * Save the next edge before descent. Each call does a fixed number of graph steps.
 */
async function db_advance_components(ctx: MutationCtx, originalPlan: Doc<"files_pending_update_plans">) {
	let plan = originalPlan;
	if (plan.poppingRootId) return await db_pop_component(ctx, plan);
	if (plan.returningChildId) {
		const child = await ctx.db.get("files_pending_update_plan_items", plan.returningChildId);
		const parentFrame = await ctx.db
			.query("files_pending_update_plan_frames")
			.withIndex("by_plan_stack_position", (q) =>
				q.eq("planId", plan._id).eq("stack", "dfs").eq("position", plan.dfsTop),
			)
			.unique();
		const parent = parentFrame ? await ctx.db.get("files_pending_update_plan_items", parentFrame.itemId) : null;
		if (!child || !parent || child.lowlink === null || parent.lowlink === null)
			throw should_never_happen("Missing review DFS return");
		await ctx.db.patch("files_pending_update_plan_items", parent._id, {
			lowlink: Math.min(parent.lowlink, child.lowlink),
		});
		plan = { ...plan, returningChildId: null };
	}
	if (plan.dfsTop === 0) {
		const next = await ctx.db
			.query("files_pending_update_plan_items")
			.withIndex("by_plan_visited_order", (q) => q.eq("planId", plan._id).eq("visited", false))
			.first();
		if (!next) {
			if (plan.assignedItemCount !== plan.itemCount || plan.componentTop !== 0)
				throw should_never_happen("Review graph assignment is incomplete");
			return { ...plan, phase: "unit_edges" as const, edgeCursor: null };
		}
		plan = await db_push_vertex(ctx, plan, next, null);
	}
	const frame = await ctx.db
		.query("files_pending_update_plan_frames")
		.withIndex("by_plan_stack_position", (q) => q.eq("planId", plan._id).eq("stack", "dfs").eq("position", plan.dfsTop))
		.unique();
	const item = frame ? await ctx.db.get("files_pending_update_plan_items", frame.itemId) : null;
	if (!frame || !item || item.dfsIndex === null || item.lowlink === null)
		throw should_never_happen("Missing review DFS entry");
	const edge = await ctx.db
		.query("files_pending_update_plan_edges")
		.withIndex("by_plan_from_order", (q) =>
			q.eq("planId", plan._id).eq("fromItemId", item._id).gt("order", frame.neighborOrder),
		)
		.first();
	if (edge) {
		await ctx.db.patch("files_pending_update_plan_frames", frame._id, { neighborOrder: edge.order });
		const neighbor = await ctx.db.get("files_pending_update_plan_items", edge.toItemId);
		if (!neighbor) throw should_never_happen("Missing review graph neighbor");
		if (!neighbor.visited) return await db_push_vertex(ctx, plan, neighbor, item._id);
		if (neighbor.onStack) {
			if (neighbor.dfsIndex === null) throw should_never_happen("Missing review neighbor index");
			await ctx.db.patch("files_pending_update_plan_items", item._id, {
				lowlink: Math.min(item.lowlink, neighbor.dfsIndex),
			});
		}
		return plan;
	}
	await ctx.db.delete("files_pending_update_plan_frames", frame._id);
	plan = { ...plan, dfsTop: plan.dfsTop - 1, returningChildId: frame.parentItemId ? item._id : null };
	if (item.lowlink !== item.dfsIndex) return plan;
	const unitId = await ctx.db.insert("files_pending_update_run_units", {
		runId: plan.runId,
		order: item.order,
		kind: "cohort",
		planEpoch: plan.epoch,
		cohortId: null,
		publicationRecorded: false,
		remainingPrerequisiteCount: 0,
		dependentsSettled: false,
		deleteLast: false,
		itemCount: 0,
		status: "waiting",
		attemptCount: 0,
		workId: null,
		attemptFence: 0,
		attemptDeadlineAt: null,
		validatedReviewVersion: null,
		errorCode: null,
		errorMessage: null,
		finishedAt: null,
		privateDiscardRoots: [],
	});
	await ctx.db.insert("files_pending_update_plan_components", {
		planId: plan._id,
		unitId,
		rootItemId: item._id,
		kind: "singleton",
		order: item.order,
		itemCount: 0,
	});
	plan = { ...plan, unitCount: plan.unitCount + 1, poppingRootId: item._id, poppingUnitId: unitId };
	return await db_pop_component(ctx, plan);
}

export async function files_pending_update_plans_db_begin(
	ctx: MutationCtx,
	args: { runId: Id<"files_pending_update_runs">; fence: number },
) {
	const checked = await db_get_run(ctx, args.runId, args.fence);
	if (checked._nay) return checked;
	const existing = await ctx.db
		.query("files_pending_update_plans")
		.withIndex("by_run_epoch", (q) => q.eq("runId", args.runId).eq("epoch", checked._yay.run.planEpoch))
		.unique();
	if (existing) {
		if (existing._id !== checked._yay.run.graphPlanId)
			return Result({ _nay: { name: "stopped", message: "This review plan belongs to an earlier attempt." } });
		// Recovery keeps this graph's saved progress under the current run fence.
		if (existing.fence !== args.fence) {
			await ctx.db.patch("files_pending_update_plans", existing._id, { fence: args.fence });
			return Result({ _yay: { ...existing, fence: args.fence } });
		}
		return Result({ _yay: existing });
	}
	const id = await ctx.db.insert("files_pending_update_plans", {
		...args,
		epoch: checked._yay.run.planEpoch,
		producerPhase: "facts",
		producerCursor: null,
		producerOrder: -1,
		producerItemId: null,
		producerWalkParent: null,
		producerWalkStep: 0,
		producerMediaOffset: 0,
		factsStructureRevision: null,
		factsReviewVersion: null,
		phase: "items",
		step: 0,
		itemCount: 0,
		relationCount: 0,
		edgeCount: 0,
		assignedItemCount: 0,
		unitCount: 0,
		nextDfsIndex: 0,
		dfsTop: 0,
		componentTop: 0,
		returningChildId: null,
		poppingRootId: null,
		poppingUnitId: null,
		edgeCursor: null,
		updatedAt: Date.now(),
	});
	await ctx.db.patch("files_pending_update_runs", args.runId, { graphPlanId: id });
	return Result({ _yay: (await ctx.db.get("files_pending_update_plans", id))! });
}

export async function files_pending_update_plans_db_add_items(
	ctx: MutationCtx,
	args: {
		planId: Id<"files_pending_update_plans">;
		offset: number;
		items: {
			runItemId: Id<"files_pending_update_run_items">;
			mode: Doc<"files_pending_update_plan_items">["mode"];
			deleteLast: boolean;
			context?: Pick<
				Doc<"files_pending_update_plan_items">,
				| "sourceParent"
				| "sourceName"
				| "nodeKind"
				| "sourcePath"
				| "destinationParent"
				| "destinationName"
				| "destinationPath"
				| "structuralKind"
			>;
			error: { code: string; message: string } | null;
		}[];
	},
) {
	const checked = await db_get_plan(ctx, args.planId);
	if (checked._nay) return checked;
	const { plan, run } = checked._yay;
	if (
		!Number.isSafeInteger(args.offset) ||
		args.offset < 0 ||
		args.items.length < 1 ||
		args.items.length > ITEM_PAGE_SIZE
	)
		return Result({ _nay: { name: "invalid_plan", message: "Invalid review item page." } });
	const replay = args.offset < plan.itemCount;
	if (
		(!replay && plan.phase !== "items") ||
		args.offset > plan.itemCount ||
		args.offset + args.items.length > run.itemCount
	)
		return Result({ _nay: { name: "invalid_plan", message: "The review item page is out of order." } });
	for (const [index, input] of args.items.entries()) {
		const item = await ctx.db.get("files_pending_update_run_items", input.runItemId);
		if (!item || item.runId !== run._id || item.order !== args.offset + index)
			throw convex_error({ message: "The reviewed item changed.", data: { code: "invalid_plan" } });
		const existing = await ctx.db
			.query("files_pending_update_plan_items")
			.withIndex("by_plan_runItem", (q) => q.eq("planId", plan._id).eq("runItemId", item._id))
			.unique();
		if (replay) {
			if (
				!existing ||
				existing.order !== item.order ||
				existing.mode !== input.mode ||
				existing.deleteLast !== input.deleteLast ||
				existing.errorCode !== (input.error?.code ?? null) ||
				existing.errorMessage !== (input.error?.message ?? null)
			)
				throw convex_error({ message: "The review item replay changed.", data: { code: "invalid_plan" } });
			continue;
		}
		if (existing) throw should_never_happen("Duplicate review graph item");
		await ctx.db.insert("files_pending_update_plan_items", {
			planId: plan._id,
			runItemId: item._id,
			order: item.order,
			target: item.target,
			sourceParent: input.context?.sourceParent ?? null,
			sourceName: input.context?.sourceName ?? null,
			nodeKind: input.context?.nodeKind ?? null,
			sourcePath: input.context?.sourcePath ?? null,
			destinationParent: input.context?.destinationParent ?? null,
			destinationName: input.context?.destinationName ?? null,
			destinationPath: input.context?.destinationPath ?? null,
			structuralKind: input.context?.structuralKind ?? "none",
			settlementOnly: false,
			mode: input.mode,
			deleteLast: input.deleteLast,
			visited: false,
			dfsIndex: null,
			lowlink: null,
			onStack: false,
			unitId: null,
			hardLinked: false,
			errorCode: input.error?.code ?? null,
			errorMessage: input.error?.message ?? null,
		});
	}
	return Result({
		_yay: replay ? plan : await db_save_plan(ctx, plan, { itemCount: plan.itemCount + args.items.length }),
	});
}

export async function files_pending_update_plans_db_seal_items(
	ctx: MutationCtx,
	args: { planId: Id<"files_pending_update_plans"> },
) {
	const checked = await db_get_plan(ctx, args.planId);
	if (checked._nay) return checked;
	const { plan, run } = checked._yay;
	if (plan.phase !== "items") return Result({ _yay: plan });
	if (plan.itemCount !== run.itemCount || plan.itemCount === 0)
		return Result({ _nay: { name: "invalid_plan", message: "The review selection is incomplete." } });
	return Result({ _yay: await db_save_plan(ctx, plan, { phase: "relations" }) });
}

export async function files_pending_update_plans_db_add_relations(
	ctx: MutationCtx,
	args: {
		planId: Id<"files_pending_update_plans">;
		offset: number;
		relations: {
			fromRunItemId: Id<"files_pending_update_run_items">;
			toRunItemId: Id<"files_pending_update_run_items">;
			kind: Doc<"files_pending_update_plan_relations">["kind"];
		}[];
	},
) {
	const checked = await db_get_plan(ctx, args.planId);
	if (checked._nay) return checked;
	const { plan } = checked._yay;
	if (
		!Number.isSafeInteger(args.offset) ||
		args.offset < 0 ||
		args.relations.length < 1 ||
		args.relations.length > RELATION_PAGE_SIZE
	)
		return Result({ _nay: { name: "invalid_plan", message: "Invalid review relation page." } });
	const replay = args.offset < plan.relationCount;
	if ((!replay && plan.phase !== "relations") || args.offset > plan.relationCount)
		return Result({ _nay: { name: "invalid_plan", message: "The review relation page is out of order." } });
	let edgeCount = plan.edgeCount;
	for (const [index, input] of args.relations.entries()) {
		const [from, to] = await Promise.all(
			[input.fromRunItemId, input.toRunItemId].map((runItemId) =>
				ctx.db
					.query("files_pending_update_plan_items")
					.withIndex("by_plan_runItem", (q) => q.eq("planId", plan._id).eq("runItemId", runItemId))
					.unique(),
			),
		);
		if (!from || !to)
			throw convex_error({ message: "A linked change is outside this review.", data: { code: "invalid_plan" } });
		const order = args.offset + index;
		if (replay) {
			const existing = await ctx.db
				.query("files_pending_update_plan_relations")
				.withIndex("by_plan_order", (q) => q.eq("planId", plan._id).eq("order", order))
				.unique();
			if (!existing || existing.fromItemId !== from._id || existing.toItemId !== to._id || existing.kind !== input.kind)
				throw convex_error({ message: "The review relation replay changed.", data: { code: "invalid_plan" } });
			continue;
		}
		await ctx.db.insert("files_pending_update_plan_relations", {
			planId: plan._id,
			order,
			fromItemId: from._id,
			toItemId: to._id,
			kind: input.kind,
		});
		if (from._id === to._id) continue;
		const hard = input.kind !== "copy_parent" && input.kind !== "copy_media";
		if (hard) {
			await ctx.db.patch("files_pending_update_plan_items", from._id, { hardLinked: true });
			await ctx.db.patch("files_pending_update_plan_items", to._id, { hardLinked: true });
		}
		for (const [fromItemId, toItemId] of hard
			? ([
					[from._id, to._id],
					[to._id, from._id],
				] as const)
			: ([[from._id, to._id]] as const)) {
			const existing = await ctx.db
				.query("files_pending_update_plan_edges")
				.withIndex("by_plan_from_to_kind", (q) =>
					q.eq("planId", plan._id).eq("fromItemId", fromItemId).eq("toItemId", toItemId).eq("kind", input.kind),
				)
				.unique();
			if (existing) continue;
			await ctx.db.insert("files_pending_update_plan_edges", {
				planId: plan._id,
				order: edgeCount,
				fromItemId,
				toItemId,
				kind: input.kind,
			});
			edgeCount++;
		}
	}
	return Result({
		_yay: replay
			? plan
			: await db_save_plan(ctx, plan, { relationCount: plan.relationCount + args.relations.length, edgeCount }),
	});
}

export async function files_pending_update_plans_db_seal_graph(
	ctx: MutationCtx,
	args: { planId: Id<"files_pending_update_plans">; relationCount: number },
) {
	const checked = await db_get_plan(ctx, args.planId);
	if (checked._nay) return checked;
	const { plan } = checked._yay;
	if (args.relationCount !== plan.relationCount)
		return Result({ _nay: { name: "invalid_plan", message: "The review relations are incomplete." } });
	if (plan.phase === "items")
		return Result({ _nay: { name: "invalid_plan", message: "Seal the review selection first." } });
	if (plan.phase !== "relations") return Result({ _yay: plan });
	return Result({ _yay: await db_save_plan(ctx, plan, { phase: "components" }) });
}

export const advance = internalMutation({
	args: { planId: v.id("files_pending_update_plans"), step: v.number() },
	returns: v_result({ _yay: doc(schema, "files_pending_update_plans") }),
	handler: async (ctx, args) => {
		const checked = await db_get_plan(ctx, args.planId);
		if (checked._nay) return checked;
		const { plan } = checked._yay;
		if (!Number.isSafeInteger(args.step) || args.step < 0 || args.step > plan.step)
			return Result({ _nay: { name: "invalid_plan", message: "The review graph step is out of order." } });
		if (args.step < plan.step || plan.phase === "ready") return Result({ _yay: plan });
		if (plan.phase === "components") {
			let next = plan;
			for (let index = 0; index < COMPONENT_STEP_SIZE && next.phase === "components"; index++) {
				next = await db_advance_components(ctx, next);
				if (plan.poppingRootId || next.poppingRootId) break;
			}
			return Result({ _yay: await db_save_plan(ctx, plan, next) });
		}
		if (plan.phase === "unit_edges") {
			const page = await ctx.db
				.query("files_pending_update_plan_edges")
				.withIndex("by_plan", (q) => q.eq("planId", plan._id))
				.paginate({ cursor: plan.edgeCursor, numItems: RELATION_PAGE_SIZE });
			for (const edge of page.page) {
				const [from, to] = await Promise.all([
					ctx.db.get("files_pending_update_plan_items", edge.fromItemId),
					ctx.db.get("files_pending_update_plan_items", edge.toItemId),
				]);
				if (!from?.unitId || !to?.unitId) throw should_never_happen("Unassigned review dependency");
				if (from.unitId === to.unitId) continue;
				if (edge.kind !== "copy_parent" && edge.kind !== "copy_media")
					throw should_never_happen("Split hard review link");
				const kind = edge.kind === "copy_parent" ? "parent" : "media";
				const existing = await ctx.db
					.query("files_pending_update_run_dependencies")
					.withIndex("by_unit_required_kind", (q) =>
						q.eq("unitId", from.unitId!).eq("requiredUnitId", to.unitId!).eq("kind", kind),
					)
					.unique();
				if (existing) continue;
				const unit = await ctx.db.get("files_pending_update_run_units", from.unitId);
				if (!unit) throw should_never_happen("Missing dependent review unit");
				await ctx.db.insert("files_pending_update_run_dependencies", {
					runId: plan.runId,
					unitId: from.unitId,
					requiredUnitId: to.unitId,
					kind,
					settled: false,
				});
				await ctx.db.patch("files_pending_update_run_units", unit._id, {
					remainingPrerequisiteCount: unit.remainingPrerequisiteCount + 1,
				});
			}
			return Result({
				_yay: await db_save_plan(ctx, plan, {
					phase: page.isDone ? "units" : "unit_edges",
					edgeCursor: page.isDone ? null : page.continueCursor,
				}),
			});
		}
		if (plan.phase === "units") {
			const page = await ctx.db
				.query("files_pending_update_plan_components")
				.withIndex("by_plan_order", (q) => q.eq("planId", plan._id))
				.paginate({ cursor: plan.edgeCursor, numItems: RELATION_PAGE_SIZE });
			for (const component of page.page) {
				const unit = await ctx.db.get("files_pending_update_run_units", component.unitId);
				if (!unit) throw should_never_happen("Missing planned review unit");
				await ctx.db.patch("files_pending_update_run_units", unit._id, {
					status: unit.remainingPrerequisiteCount ? "waiting" : "queued",
				});
			}
			return Result({
				_yay: await db_save_plan(ctx, plan, {
					phase: page.isDone ? "ready" : "units",
					edgeCursor: page.isDone ? null : page.continueCursor,
				}),
			});
		}
		return Result({ _nay: { name: "invalid_plan", message: "Seal the review graph before planning its groups." } });
	},
});

export async function files_pending_update_plans_db_get(
	ctx: QueryCtx | MutationCtx,
	args: { planId: Id<"files_pending_update_plans"> },
) {
	const checked = await db_get_plan(ctx, args.planId);
	if (checked._nay) return checked;
	return Result({ _yay: checked._yay.plan });
}

export async function files_pending_update_plans_db_list_components(
	ctx: QueryCtx | MutationCtx,
	args: { planId: Id<"files_pending_update_plans">; paginationOpts: PaginationOptions },
) {
	const checked = await db_get_plan(ctx, args.planId);
	if (checked._nay) return checked;
	return Result({
		_yay: await ctx.db
			.query("files_pending_update_plan_components")
			.withIndex("by_plan_order", (q) => q.eq("planId", args.planId))
			.paginate(args.paginationOpts),
	});
}

/**
 * Drain one graph page before deleting its parent review history.
 */
export async function files_pending_update_plans_db_delete_run_batch(
	ctx: MutationCtx,
	args: { runId: Id<"files_pending_update_runs">; batchSize?: number },
) {
	const plan = await ctx.db
		.query("files_pending_update_plans")
		.withIndex("by_run_epoch", (q) => q.eq("runId", args.runId))
		.first();
	if (!plan) return { done: true, deletedCount: 0 };
	const numItems = Math.max(1, Math.min(args.batchSize ?? 8, 8));
	for (const table of [
		"files_pending_update_plan_edges",
		"files_pending_update_plan_frames",
		"files_pending_update_plan_walks",
	] as const) {
		if (
			!(await ctx.db
				.query(table)
				.withIndex("by_plan", (q) => q.eq("planId", plan._id))
				.first())
		)
			continue;
		const page = await ctx.db
			.query(table)
			.withIndex("by_plan", (q) => q.eq("planId", plan._id))
			.paginate({ cursor: null, numItems });
		for (const row of page.page) await ctx.db.delete(table, row._id);
		return { done: false, deletedCount: page.page.length };
	}
	for (const table of [
		"files_pending_update_plan_relations",
		"files_pending_update_plan_components",
		"files_pending_update_plan_items",
	] as const) {
		if (
			!(await ctx.db
				.query(table)
				.withIndex("by_plan_order", (q) => q.eq("planId", plan._id))
				.first())
		)
			continue;
		const page = await ctx.db
			.query(table)
			.withIndex("by_plan_order", (q) => q.eq("planId", plan._id))
			.paginate({ cursor: null, numItems });
		for (const row of page.page) await ctx.db.delete(table, row._id);
		return { done: false, deletedCount: page.page.length };
	}
	await ctx.db.delete("files_pending_update_plans", plan._id);
	return { done: false, deletedCount: 1 };
}
