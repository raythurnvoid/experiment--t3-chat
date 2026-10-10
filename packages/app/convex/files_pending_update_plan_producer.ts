import { Result } from "common/errors-as-values-utils.ts";
import { doc } from "convex-helpers/validators";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { activities_db_require_by_source_id } from "./activities_db.ts";
import schema from "./schema.ts";
import {
	files_pending_update_plans_db_add_items,
	files_pending_update_plans_db_add_relations,
	files_pending_update_plans_db_begin,
	files_pending_update_plans_db_get,
	files_pending_update_plans_db_seal_graph,
	files_pending_update_plans_db_seal_items,
} from "./files_pending_update_plans.ts";
import { files_pending_nodes_db_resolve_read_target } from "./files_pending_nodes.ts";
import { files_subtree_ops_db_find_repair } from "./files_subtree_ops.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_publish_receipt,
	files_saved_placement_db_get_slot,
} from "../server/files-saved-placement.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_media_parse_src } from "../shared/files-media.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

const PAGE_SIZE = 8;
type Plan = Doc<"files_pending_update_plans">;
type Item = Doc<"files_pending_update_plan_items">;
type Run = Doc<"files_pending_update_runs">;
type Parent = NonNullable<Item["sourceParent"]>;
type Target = Item["target"];

function is_copy(header: NonNullable<Doc<"files_pending_update_run_items">["reviewHeader"]>) {
	return Boolean(
		header.copiedFrom &&
		!header.pendingMove &&
		!header.pendingArchive &&
		!header.preparation &&
		(header.target.kind === "private" ? header.createIntent : header.pendingReplacement),
	);
}

async function db_save(ctx: MutationCtx, plan: Plan, patch: Partial<Plan>) {
	const updatedAt = Date.now();
	await ctx.db.patch("files_pending_update_plans", plan._id, { ...patch, step: plan.step + 1, updatedAt });
	const activity = await activities_db_require_by_source_id(ctx, plan.runId);
	await ctx.db.patch("activities", activity._id, { updatedAt, deadlineAt: updatedAt + 30 * 60 * 1000 });
	return { ...plan, ...patch, step: plan.step + 1 };
}

async function db_selected(ctx: MutationCtx, plan: Plan, target: Target) {
	return await ctx.db
		.query("files_pending_update_plan_items")
		.withIndex("by_plan_target", (q) =>
			q.eq("planId", plan._id).eq("target.kind", target.kind).eq("target.id", target.id),
		)
		.unique();
}

async function db_input(ctx: MutationCtx, item: Item) {
	const input = await ctx.db.get("files_pending_update_run_items", item.runItemId);
	if (!input?.reviewHeader) throw should_never_happen("Missing frozen review header");
	return input;
}

async function db_error(
	ctx: MutationCtx,
	item: Item,
	message: string,
	unreviewed?: { runId: Id<"files_pending_update_runs">; pendingUpdateId: Id<"files_pending_updates"> },
) {
	if (unreviewed) {
		const run = (await ctx.db.get("files_pending_update_runs", unreviewed.runId))!;
		// Keep the existing display sample. It does not limit the selected items or graph.
		await ctx.db.patch("files_pending_update_runs", run._id, {
			needsReviewIds: [...new Set([...run.needsReviewIds, unreviewed.pendingUpdateId])].slice(0, 20),
		});
	}
	if (item.errorCode !== null) return;
	await ctx.db.patch("files_pending_update_plan_items", item._id, { errorCode: "needs_review", errorMessage: message });
}

async function db_link(
	ctx: MutationCtx,
	plan: Plan,
	from: Item,
	to: Item,
	kind: Doc<"files_pending_update_plan_edges">["kind"],
) {
	const added = await files_pending_update_plans_db_add_relations(ctx, {
		planId: plan._id,
		offset: plan.relationCount,
		relations: [{ fromRunItemId: from.runItemId, toRunItemId: to.runItemId, kind }],
	});
	if (added._nay) throw should_never_happen("Cannot add reviewed relation", added._nay);
	return {
		...plan,
		relationCount: added._yay.relationCount,
		edgeCount: added._yay.edgeCount,
		step: added._yay.step,
		updatedAt: added._yay.updatedAt,
	};
}

async function db_canonical_parent(ctx: MutationCtx, run: Run, parent: Target): Promise<Target> {
	if (parent.kind !== "private") return parent;
	const receipt = await files_saved_placement_db_get_publish_receipt(ctx.db, { ...run, privateNodeId: parent.id });
	return receipt ? { kind: "saved", id: receipt.savedNodeId } : parent;
}

async function db_parent(
	ctx: MutationCtx,
	run: Run,
	plan: Plan,
	target: Target,
	final: boolean,
): Promise<Parent | null> {
	const selected = await db_selected(ctx, plan, target);
	if (selected) {
		if (final && selected.destinationParent && selected.structuralKind === "move") return selected.destinationParent;
		return selected.sourceParent;
	}
	if (target.kind === "saved") {
		const node = await files_saved_placement_db_get_node(ctx.db, target.id);
		if (
			!node ||
			node.organizationId !== run.organizationId ||
			node.workspaceId !== run.workspaceId ||
			node.archiveOperationId !== null
		)
			return null;
		return node.parentId === "root" ? { kind: "root" } : { kind: "saved", id: node.parentId };
	}
	const canonical = await db_canonical_parent(ctx, run, target);
	if (canonical.kind !== "private") return canonical;
	const node = await ctx.db.get("files_pending_nodes", target.id);
	return node?.state === "active" &&
		node.organizationId === run.organizationId &&
		node.workspaceId === run.workspaceId &&
		node.userId === run.userId
		? node.parent
		: null;
}

async function db_facts(ctx: MutationCtx, run: Run, plan: Plan) {
	const page = await ctx.db
		.query("files_pending_update_run_items")
		.withIndex("by_run_order", (q) => q.eq("runId", run._id))
		.paginate({ cursor: plan.producerCursor, numItems: PAGE_SIZE });
	const items = [];
	for (const input of page.page) {
		const header = input.reviewHeader;
		if (!header) throw should_never_happen("Missing frozen Accept header");
		const proposal = await ctx.db.get("files_pending_updates", input.pendingUpdateId);
		const fact = await ctx.db
			.query("files_pending_review_facts")
			.withIndex("by_proposal_view", (q) =>
				q.eq("pendingUpdateId", input.pendingUpdateId).eq("cohortId", null).eq("view", "normal"),
			)
			.unique();
		let error =
			!proposal || proposal.revision !== input.reviewedRevision
				? "A reviewed change was revised. Review it again."
				: !input.reviewSource || !fact || fact.sourcePath === null
					? "A reviewed source changed. Review it again."
					: null;
		if (input.reviewSource?.path !== null && input.reviewSource?.path !== fact?.sourcePath)
			error ??= "A reviewed source moved. Review it again.";
		const destinationParentPath = fact?.destinationPath
			? fact.destinationPath.slice(0, fact.destinationPath.lastIndexOf("/")) || "/"
			: null;
		if (input.expectedDestinationParentPath !== null && input.expectedDestinationParentPath !== destinationParentPath)
			error ??= "A reviewed destination moved. Review it again.";
		const privateVersion = input.reviewSource?.privateVersion ?? null;
		if (header.target.kind === "private") {
			const node = await ctx.db.get("files_pending_nodes", header.target.id);
			if (
				!node ||
				node.creationGeneration !== privateVersion?.creationGeneration ||
				node.structuralRevision !== privateVersion?.structuralRevision
			)
				error ??= "A reviewed draft moved. Review it again.";
		}
		if (header.mediaDependencySetId) {
			const set = await ctx.db.get("files_media_dependency_sets", header.mediaDependencySetId);
			if (
				!set?.sealed ||
				input.mediaDependencySet?.setId !== set._id ||
				input.mediaDependencySet?.generation !== set.generation ||
				set.organizationId !== run.organizationId ||
				set.workspaceId !== run.workspaceId ||
				set.userId !== run.userId ||
				set.owner.kind !== "proposal" ||
				set.owner.pendingUpdateId !== input.pendingUpdateId
			)
				error ??= "The reviewed media changed. Review it again.";
		}
		const destinationParent =
			header.pendingMove?.destParent ??
			(header.target.kind === "private" ? (input.reviewSource?.parent ?? null) : null);
		await ctx.db.patch("files_pending_update_run_items", input._id, {
			privateVersion,
			expectedPath: input.reviewSource?.path ?? fact?.sourcePath ?? null,
		});
		items.push({
			runItemId: input._id,
			mode: is_copy(header) ? ("copy" as const) : ("ordinary" as const),
			deleteLast: Boolean(header.pendingArchive),
			error: error ? { code: "needs_review", message: error } : null,
			context: {
				sourceParent: input.reviewSource?.parent ?? null,
				sourceName: input.reviewSource?.name ?? null,
				nodeKind: input.reviewSource?.kind ?? null,
				sourcePath: input.reviewSource?.path ?? fact?.sourcePath ?? null,
				destinationParent:
					destinationParent?.kind === "root"
						? destinationParent
						: destinationParent
							? await db_canonical_parent(ctx, run, destinationParent)
							: null,
				destinationName:
					header.pendingMove?.destName ??
					(header.target.kind === "private" ? (input.reviewSource?.name ?? null) : null),
				destinationPath: fact?.proposalRevision === input.reviewedRevision ? fact.destinationPath : null,
				structuralKind: header.pendingArchive
					? ("archive" as const)
					: header.pendingMove
						? ("move" as const)
						: ("none" as const),
			},
		});
	}
	const added = await files_pending_update_plans_db_add_items(ctx, { planId: plan._id, offset: plan.itemCount, items });
	if (added._nay) return added;
	let next = added._yay;
	if (page.isDone) {
		const sealed = await files_pending_update_plans_db_seal_items(ctx, { planId: plan._id });
		if (sealed._nay) return sealed;
		next = sealed._yay;
	}
	return Result({
		_yay: await db_save(ctx, next, {
			producerCursor: page.isDone ? null : page.continueCursor,
			producerPhase: page.isDone ? "source_ancestors" : "facts",
		}),
	});
}

async function db_destination(ctx: MutationCtx, run: Run, plan: Plan, item: Item) {
	if (!item.destinationParent || !item.destinationName) return plan;
	const input = await db_input(ctx, item);
	const replaced = input.reviewHeader!.pendingMove?.replacesTarget;
	if (replaced) {
		const selected = await db_selected(ctx, plan, replaced);
		if (selected) {
			plan = await db_link(ctx, plan, item, selected, "replacement");
			await ctx.db.patch("files_pending_update_plan_items", selected._id, { settlementOnly: true });
			if (selected.structuralKind === "move")
				await db_error(ctx, item, "A replaced change also moves. Review these changes again.");
		} else {
			const proposal = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", run.organizationId)
						.eq("workspaceId", run.workspaceId)
						.eq("userId", run.userId)
						.eq("target.kind", replaced.kind)
						.eq("target.id", replaced.id),
				)
				.unique();
			if (proposal)
				await db_error(ctx, item, "This replacement also affects an unselected change. Review them together.", {
					runId: run._id,
					pendingUpdateId: proposal._id,
				});
		}
	}
	const duplicate = await ctx.db
		.query("files_pending_update_plan_items")
		.withIndex("by_plan_destination_slot", (q) =>
			q
				.eq("planId", plan._id)
				.eq("destinationParent.kind", item.destinationParent!.kind)
				.eq("destinationParent.id", item.destinationParent!.kind === "root" ? undefined : item.destinationParent!.id)
				.eq("destinationName", item.destinationName)
				.gt("order", item.order),
		)
		.first();
	if (duplicate) {
		plan = await db_link(ctx, plan, item, duplicate, "structure");
		await db_error(ctx, item, "These changes use the same destination name. Review them again.");
	}
	if (item.destinationParent.kind !== "private") {
		const occupant = await files_saved_placement_db_get_slot(ctx.db, {
			...run,
			parentId: item.destinationParent.kind === "root" ? "root" : item.destinationParent.id,
			name: item.destinationName,
		});
		if (occupant && (item.target.kind !== "saved" || occupant._id !== item.target.id)) {
			const selected = await db_selected(ctx, plan, { kind: "saved", id: occupant._id });
			// A selected move or delete frees the name, so both changes publish in one group.
			if (selected?.structuralKind === "move" || selected?.structuralKind === "archive")
				plan = await db_link(ctx, plan, item, selected, "structure");
			else if ((!replaced || replaced.kind !== "saved" || replaced.id !== occupant._id) && item.errorCode === null) {
				const current = (await ctx.db.get("files_pending_update_plan_items", item._id))!;
				// Keep an earlier error found while checking this destination.
				if (current.errorCode === null)
					await ctx.db.patch("files_pending_update_plan_items", item._id, {
						errorCode: "destination_changed",
						errorMessage: "The destination name is already used. Review it again.",
					});
			}
		}
	}
	return plan;
}

const phases = [
	"source_ancestors",
	"destination_ancestors",
	"final_source_ancestors",
	"final_destination_ancestors",
	"media",
] as const;

async function db_walk(ctx: MutationCtx, run: Run, original: Plan) {
	let plan = original;
	let item = plan.producerItemId ? await ctx.db.get("files_pending_update_plan_items", plan.producerItemId) : null;
	if (!item) {
		item = await ctx.db
			.query("files_pending_update_plan_items")
			.withIndex("by_plan_order", (q) => q.eq("planId", plan._id).gt("order", plan.producerOrder))
			.first();
		if (!item) {
			const index = phases.findIndex((phase) => phase === plan.producerPhase);
			return await db_save(ctx, plan, {
				producerPhase: phases[index + 1]!,
				producerOrder: -1,
				producerItemId: null,
				producerWalkParent: null,
				producerWalkStep: 0,
			});
		}
		if (plan.producerPhase === "destination_ancestors") plan = await db_destination(ctx, run, plan, item);
		const destination =
			plan.producerPhase === "destination_ancestors" || plan.producerPhase === "final_destination_ancestors";
		plan = {
			...plan,
			producerItemId: item._id,
			producerWalkParent: destination ? item.destinationParent : item.target,
			producerWalkStep: 0,
		};
	}
	const final = plan.producerPhase === "final_source_ancestors" || plan.producerPhase === "final_destination_ancestors";
	const destination =
		plan.producerPhase === "destination_ancestors" || plan.producerPhase === "final_destination_ancestors";
	const kind = final
		? destination
			? ("final_destination" as const)
			: ("final_source" as const)
		: destination
			? ("destination" as const)
			: ("source" as const);
	const input = await db_input(ctx, item);
	if (plan.producerWalkParent && plan.producerWalkParent.kind !== "root") {
		const target = await db_canonical_parent(ctx, run, plan.producerWalkParent);
		const visited = await ctx.db
			.query("files_pending_update_plan_walks")
			.withIndex("by_plan_item_kind_target", (q) =>
				q
					.eq("planId", plan._id)
					.eq("itemId", item!._id)
					.eq("kind", kind)
					.eq("target.kind", target.kind)
					.eq("target.id", target.id),
			)
			.unique();
		if (visited) {
			await db_error(ctx, item, "These moves form a folder cycle. Review their destinations.");
			plan = { ...plan, producerWalkParent: null };
			return await db_save(ctx, plan, {
				producerItemId: null,
				producerOrder: item.order,
				producerWalkParent: null,
				producerWalkStep: 0,
			});
		}
		await ctx.db.insert("files_pending_update_plan_walks", {
			planId: plan._id,
			itemId: item._id,
			kind,
			target,
			step: plan.producerWalkStep,
		});
		const selected = await db_selected(ctx, plan, target);
		if (selected && selected._id !== item._id) {
			if (final && selected.structuralKind === "archive") plan = await db_link(ctx, plan, item, selected, "archive");
			else if (!final && selected.structuralKind === "move" && selected.nodeKind === "folder")
				plan = await db_link(ctx, plan, item, selected, "structure");
			if (!final && target.kind === "private")
				plan = await db_link(ctx, plan, item, selected, item.mode === "copy" ? "copy_parent" : "ordinary_parent");
		}
		if (
			!final &&
			(destination || input.reviewHeader!.pendingMove || input.target.kind === "private") &&
			(!selected || selected._id !== item._id)
		) {
			const proposal = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", run.organizationId)
						.eq("workspaceId", run.workspaceId)
						.eq("userId", run.userId)
						.eq("target.kind", target.kind)
						.eq("target.id", target.id),
				)
				.unique();
			if (!selected && (target.kind === "private" || proposal?.pendingMove || proposal?.pendingArchive))
				await db_error(
					ctx,
					item,
					"This action also affects an unselected change. Review them together.",
					proposal ? { runId: run._id, pendingUpdateId: proposal._id } : undefined,
				);
		}
		const parent = await db_parent(ctx, run, plan, target, final);
		if (parent === null) await db_error(ctx, item, "A reviewed parent changed. Review it again.");
		plan = { ...plan, producerWalkParent: parent, producerWalkStep: plan.producerWalkStep + 1 };
	}
	const done = !plan.producerWalkParent || plan.producerWalkParent.kind === "root";
	return await db_save(ctx, plan, {
		producerItemId: done ? null : item._id,
		producerOrder: done ? item.order : plan.producerOrder,
		producerWalkParent: done ? null : plan.producerWalkParent,
		producerWalkStep: done ? 0 : plan.producerWalkStep,
	});
}

export const advance = internalMutation({
	args: { runId: v.id("files_pending_update_runs"), fence: v.number(), planEpoch: v.number() },
	returns: v_result({
		_yay: v.object({
			plan: doc(schema, "files_pending_update_plans"),
			media: v.union(
				v.object({
					item: doc(schema, "files_pending_update_run_items"),
					proposal: doc(schema, "files_pending_updates"),
					offset: v.number(),
				}),
				v.null(),
			),
			waiting: v.boolean(),
		}),
	}),
	handler: async (ctx, args) => {
		const begun = await files_pending_update_plans_db_begin(ctx, { runId: args.runId, fence: args.fence });
		if (begun._nay) return begun;
		let plan = begun._yay;
		const checked = await files_pending_update_plans_db_get(ctx, { planId: plan._id });
		if (checked._nay) return checked;
		const run = (await ctx.db.get("files_pending_update_runs", args.runId))!;
		if (run.planEpoch !== args.planEpoch)
			return Result({ _nay: { name: "stopped", message: "The review plan changed." } });
		if (plan.producerPhase === "sealed") return Result({ _yay: { plan, media: null, waiting: false } });
		const state = await files_pending_review_facts_db_get_state(ctx.db, run);
		const subtree = await files_subtree_ops_db_find_repair(ctx, run);
		const slot = await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", run.organizationId).eq("workspaceId", run.workspaceId))
			.unique();
		if (subtree || (state?.pendingJobCount ?? 0) > 0 || slot?.cohortId)
			return Result({ _yay: { plan, media: null, waiting: true } });
		const review = await ctx.db
			.query("files_pending_review_versions")
			.withIndex("by_organization_workspace_user", (q) =>
				q.eq("organizationId", run.organizationId).eq("workspaceId", run.workspaceId).eq("userId", run.userId),
			)
			.unique();
		const structureRevision = state?.structureRevision ?? 0;
		const reviewVersion = review?.revision ?? 0;
		if (
			plan.factsStructureRevision !== null &&
			(plan.factsStructureRevision !== structureRevision || plan.factsReviewVersion !== reviewVersion)
		) {
			await ctx.db.patch("files_pending_update_runs", run._id, { planEpoch: run.planEpoch + 1, graphPlanId: null });
			const restarted = await files_pending_update_plans_db_begin(ctx, { runId: args.runId, fence: args.fence });
			if (restarted._nay) return restarted;
			return Result({ _yay: { plan: restarted._yay, media: null, waiting: false } });
		}
		if (plan.factsStructureRevision === null)
			plan = await db_save(ctx, plan, { factsStructureRevision: structureRevision, factsReviewVersion: reviewVersion });
		if (plan.producerPhase === "facts") {
			const facts = await db_facts(ctx, run, plan);
			if (facts._nay) return facts;
			return Result({ _yay: { plan: facts._yay, media: null, waiting: false } });
		}
		if (plan.producerPhase !== "media") {
			for (let index = 0; index < PAGE_SIZE && plan.producerPhase !== "media"; index++)
				plan = await db_walk(ctx, run, plan);
			return Result({ _yay: { plan, media: null, waiting: false } });
		}
		for (let index = 0; index < PAGE_SIZE; index++) {
			const next = plan.producerItemId
				? await ctx.db.get("files_pending_update_plan_items", plan.producerItemId)
				: await ctx.db
						.query("files_pending_update_plan_items")
						.withIndex("by_plan_order", (q) => q.eq("planId", plan._id).gt("order", plan.producerOrder))
						.first();
			if (!next) {
				const sealed = await files_pending_update_plans_db_seal_graph(ctx, {
					planId: plan._id,
					relationCount: plan.relationCount,
				});
				if (sealed._nay) return sealed;
				return Result({
					_yay: { plan: await db_save(ctx, sealed._yay, { producerPhase: "sealed" }), media: null, waiting: false },
				});
			}
			const item = await db_input(ctx, next);
			const header = item.reviewHeader!;
			const textKind = header.pendingReplacement
				? header.pendingReplacement.yjsRootKind
				: header.createIntent?.kind === "text"
					? header.createIntent.textKind
					: header.content && header.target.kind === "saved"
						? (await files_saved_placement_db_get_node(ctx.db, header.target.id))?.textKind
						: null;
			if (textKind !== "rich_text" || next.settlementOnly || next.structuralKind === "archive") {
				plan = await db_save(ctx, plan, { producerOrder: next.order, producerItemId: null, producerMediaOffset: 0 });
				continue;
			}
			plan = await db_save(ctx, plan, { producerItemId: next._id });
			return Result({
				_yay: {
					plan,
					media: {
						item,
						proposal: {
							...item.reviewHeader!,
							_id: item.pendingUpdateId,
							_creationTime: 0,
							updatedAt: 0,
							expiresAt: 0,
						},
						offset: plan.producerMediaOffset,
					},
					waiting: false,
				},
			});
		}
		return Result({ _yay: { plan, media: null, waiting: false } });
	},
});

export const stage_media = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		planEpoch: v.number(),
		itemId: v.id("files_pending_update_run_items"),
		offset: v.number(),
		refs: v.array(v.string()),
		isDone: v.boolean(),
		error: v.union(v.string(), v.null()),
	},
	returns: v_result({ _yay: doc(schema, "files_pending_update_plans") }),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_pending_update_runs", args.runId);
		if (!run?.graphPlanId || run.planEpoch !== args.planEpoch || run.fence !== args.fence)
			return Result({ _nay: { name: "stopped", message: "The review plan changed." } });
		const checked = await files_pending_update_plans_db_get(ctx, { planId: run.graphPlanId });
		if (checked._nay) return checked;
		let plan = checked._yay;
		const item = await ctx.db.get("files_pending_update_run_items", args.itemId);
		const vertex = item
			? await ctx.db
					.query("files_pending_update_plan_items")
					.withIndex("by_plan_runItem", (q) => q.eq("planId", plan._id).eq("runItemId", item._id))
					.unique()
			: null;
		if (
			!item ||
			item.runId !== run._id ||
			!vertex ||
			plan.producerItemId !== vertex._id ||
			plan.producerPhase !== "media" ||
			args.refs.length > PAGE_SIZE ||
			args.offset !== plan.producerMediaOffset
		)
			return Result({ _nay: { name: "invalid_plan", message: "The reviewed media page changed." } });
		if (args.error) await db_error(ctx, vertex, args.error);
		const reviewedArchiveIds = new Set<Id<"files_pending_updates">>();
		const reader = await files_visible_db_create_reader(ctx, { ...run, readLimit: 4096, reviewedArchiveIds });
		for (const src of args.refs) {
			const mapping = item.mediaDependencySet
				? await ctx.db
						.query("files_media_dependencies")
						.withIndex("by_set_src", (q) => q.eq("setId", item.mediaDependencySet!.setId).eq("dependency.src", src))
						.first()
				: null;
			const parsed = files_media_parse_src(src);
			const savedId = parsed.kind === "file" ? ctx.db.normalizeId("files_nodes", parsed.fileNodeId) : null;
			const privateId =
				parsed.kind === "private" ? ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId) : null;
			const original =
				mapping?.dependency.target ??
				(savedId
					? { kind: "saved" as const, id: savedId }
					: privateId
						? { kind: "private" as const, id: privateId }
						: null);
			const target = original
				? await files_pending_nodes_db_resolve_read_target(ctx, { ...run, target: original })
				: null;
			let selected = target ? await db_selected(ctx, plan, target) : null;
			if (selected?.structuralKind === "archive")
				reviewedArchiveIds.add((await db_input(ctx, selected)).pendingUpdateId);
			const visible = target ? await reader.resolveTargetForSave(target) : null;
			if (!visible || !original) {
				await db_error(ctx, vertex, "The reviewed media is no longer available.");
				continue;
			}
			selected ??= await db_selected(ctx, plan, original);
			if (selected)
				plan = await db_link(ctx, plan, vertex, selected, vertex.mode === "copy" ? "copy_media" : "ordinary_media");
			else if (target?.kind === "private")
				await db_error(ctx, vertex, "Save the selected media first, or review it with this document.");
		}
		return Result({
			_yay: await db_save(ctx, plan, {
				producerItemId: args.isDone ? null : vertex._id,
				producerOrder: args.isDone ? vertex.order : plan.producerOrder,
				producerMediaOffset: args.isDone ? 0 : args.offset + args.refs.length,
			}),
		});
	},
});
