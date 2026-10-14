// Public Transfer reads. Work and controls stay in files_transfer.ts.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { activities_db_require_by_source_id, activities_get_controls } from "./activities_db.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import { organizations_membership_lifetimes_db_get } from "./organizations_membership_lifetimes.ts";
import app_convex_schema, {
	files_pending_target_validator,
	files_transfer_source_version_validator,
} from "./schema.ts";
import { files_visible_db_create_reader } from "./files_visible_db.ts";
import { files_saved_placement_db_get_node } from "../server/files-saved-placement.ts";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { convex_error } from "../server/convex-utils.ts";
import type { files_PendingTarget, files_VisibleEntry } from "../shared/files.ts";

// Reuse the loaded module between calls. Keep request state inside each query.
export const experimental_reuseContext = true;

export const files_transfer_queries_MAX_SELECTED_NODES = 200;

export async function files_transfer_queries_db_require_activity(
	ctx: QueryCtx | MutationCtx,
	runId: Id<"files_transfer_runs">,
) {
	const activity = await activities_db_require_by_source_id(ctx, runId);
	if (!activity.progress || !activity.membershipId || activity.membershipLifetime === undefined) {
		const errorMessage = "Transfer activity is missing progress or membership";
		const errorData = { runId, activityId: activity._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return {
		...activity,
		progress: activity.progress,
		membershipId: activity.membershipId,
		membershipLifetime: activity.membershipLifetime,
	};
}

export async function files_transfer_queries_db_get_current_activity(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; workspaceId: Id<"organizations_workspaces"> },
	readyRenamesOnly = false,
) {
	// A Rename waiting for a conflict answer gives way until its pins are checked again.
	// It also does not block new Copy or Move starts. Its Activity card still opens it.
	const statuses = readyRenamesOnly
		? (["running", "stopping", "queued"] as const)
		: (["queued", "running", "awaiting_input", "stopping"] as const);
	for (const isRename of readyRenamesOnly ? [true] : [false, true]) {
		for (const status of statuses) {
			if (isRename && status === "awaiting_input") continue;
			const query = ctx.db
				.query("activities")
				.withIndex("by_user_workspace_source_kind_isRename_status", (q) =>
					q
						.eq("userId", args.userId)
						.eq("workspaceId", args.workspaceId)
						.eq("source.kind", "files_transfer_run")
						.eq("source.isRename", isRename)
						.eq("status", status),
				);
			const activity = isRename ? await query.first() : await query.unique();
			if (activity) return activity;
		}
	}
	return null;
}

export async function files_transfer_queries_db_get_owned_run(
	ctx: QueryCtx | MutationCtx,
	args: { membershipId: Id<"organizations_workspaces_users">; runId: Id<"files_transfer_runs"> },
) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });

	const membership = await organizations_db_get_membership(ctx, {
		userId: userAuth.id,
		membershipId: args.membershipId,
	});
	if (!membership) return Result({ _nay: { message: "Unauthorized" } });

	const run = await ctx.db.get("files_transfer_runs", args.runId);
	if (
		!run ||
		run.userId !== userAuth.id ||
		run.organizationId !== membership.organizationId ||
		run.workspaceId !== membership.workspaceId
	) {
		return Result({ _nay: { message: "Not found" } });
	}
	return Result({ _yay: { run, membership } });
}

export async function files_transfer_queries_db_get_entry(args: {
	ctx: QueryCtx | MutationCtx;
	run: Pick<Doc<"files_transfer_runs">, "organizationId" | "workspaceId" | "userId" | "sourceView" | "rename">;
	target: files_PendingTarget;
	reader: Awaited<ReturnType<typeof files_visible_db_create_reader>>;
}): Promise<files_VisibleEntry | null> {
	const { ctx, run, target, reader } = args;

	if (run.sourceView === "draft") return await reader.resolveTarget(target);
	if (target.kind !== "saved") return null;
	const node = await files_saved_placement_db_get_node(ctx.db, target.id);
	if (
		!node ||
		node.organizationId !== run.organizationId ||
		node.workspaceId !== run.workspaceId ||
		(node.archiveOperationId !== null &&
			(!run.rename ||
				node.parentId !== run.rename.source.parentId ||
				node.name !== run.rename.source.name ||
				node.path !== run.rename.source.path ||
				node.archiveOperationId !== run.rename.source.archiveOperationId)) ||
		!(await reader.canRead(node))
	)
		return null;
	return { kind: "saved", node, pendingUpdate: null, path: node.path };
}

const run_view_validator = v.object({
	_id: v.id("files_transfer_runs"),
	kind: doc(app_convex_schema, "files_transfer_runs").fields.kind,
	publication: doc(app_convex_schema, "files_transfer_runs").fields.publication,
	step: doc(app_convex_schema, "files_transfer_runs").fields.step,
	revision: v.number(),
	activity: doc(app_convex_schema, "activities"),
	controls: v.object({ canStop: v.boolean(), canRetry: v.boolean(), canDismiss: v.boolean() }),
	conflicts: v.array(
		v.object({
			itemId: v.id("files_transfer_items"),
			sourceName: v.union(v.string(), v.null()),
			sourcePath: v.union(v.string(), v.null()),
			targetName: v.union(v.string(), v.null()),
			kind: v.union(v.literal("name_conflict"), v.literal("source_changed"), v.literal("destination_changed")),
		}),
	),
	movedNodeIds: v.array(v.id("files_nodes")),
});

async function db_get_run_view(args: {
	ctx: QueryCtx;
	run: Doc<"files_transfer_runs">;
	membership: Doc<"organizations_workspaces_users">;
}) {
	const { ctx, run, membership } = args;

	const activity = await files_transfer_queries_db_require_activity(ctx, run._id);
	const conflicts = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "conflict"))
		.take(files_transfer_queries_MAX_SELECTED_NODES);

	const sourceScope = { ...run, ...run.sourceScope };
	const reader = await files_visible_db_create_reader(ctx, sourceScope);
	const visibleConflicts = [];
	for (const item of conflicts) {
		// Hide names once the source is no longer readable; run history can outlive source access.
		const readable =
			(await files_transfer_queries_db_get_entry({ ctx, run: sourceScope, target: item.source, reader }))?.path ===
			item.sourcePath;
		visibleConflicts.push({
			itemId: item._id,
			sourceName: readable ? item.sourceName : null,
			sourcePath: readable ? item.sourcePath : null,
			targetName: readable ? item.sourceName : null,
			kind: item.conflictKind ?? ("source_changed" as const),
		});
	}

	const movedItems =
		run.kind === "move"
			? await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "completed"))
					.take(files_transfer_queries_MAX_SELECTED_NODES)
			: [];

	return {
		_id: run._id,
		kind: run.kind,
		publication: run.publication,
		step: run.step,
		revision: run.revision,
		activity,
		controls: activities_get_controls(activity, membership.userId),
		conflicts: visibleConflicts,
		movedNodeIds: movedItems.flatMap((item) => (item.outputTarget?.kind === "saved" ? [item.outputTarget.id] : [])),
	};
}

export const get = query({
	args: { membershipId: v.id("organizations_workspaces_users"), runId: v.id("files_transfer_runs") },
	returns: v.union(run_view_validator, v.null()),
	handler: async (ctx, args) => {
		const owned = await files_transfer_queries_db_get_owned_run(ctx, args);
		if (owned._nay) {
			if (owned._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		return await db_get_run_view({ ctx, run: owned._yay.run, membership: owned._yay.membership });
	},
});

export const get_move_acceptance = query({
	args: { membershipId: v.id("organizations_workspaces_users"), requestId: v.string() },
	returns: v.union(
		v.object({
			runId: v.id("files_transfer_runs"),
			step: doc(app_convex_schema, "files_transfer_runs").fields.step,
			isFinished: v.boolean(),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return null;
		const run = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_user_workspace_request", (q) =>
				q.eq("userId", userAuth.id).eq("workspaceId", membership.workspaceId).eq("requestId", args.requestId),
			)
			.unique();
		if (!run || run.kind !== "move" || run.organizationId !== membership.organizationId) return null;
		const activity = await files_transfer_queries_db_require_activity(ctx, run._id);
		const isFinished = activity.finishedAt !== undefined;
		// A finished run can retire old browser input after a reinvite. Live input keeps its lifetime fence.
		if (!isFinished) {
			const lifetime = await organizations_membership_lifetimes_db_get(ctx, {
				workspaceId: run.workspaceId,
				userId: run.userId,
			});
			if (
				!lifetime?.active ||
				membership._id !== activity.membershipId ||
				lifetime.membershipId !== activity.membershipId ||
				lifetime.lifetime !== activity.membershipLifetime
			)
				return null;
		}
		return { runId: run._id, step: run.step, isFinished };
	},
});

export const list_current = query({
	args: { membershipId: v.id("organizations_workspaces_users") },
	returns: v.array(run_view_validator),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) throw convex_error({ message: "Unauthenticated" });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return [];

		const activity = await files_transfer_queries_db_get_current_activity(ctx, {
			userId: userAuth.id,
			workspaceId: membership.workspaceId,
		});
		if (!activity || activity.source.kind !== "files_transfer_run") return [];
		const run = await ctx.db.get("files_transfer_runs", activity.source.id);
		return run ? [await db_get_run_view({ ctx, run, membership })] : [];
	},
});

const item_view_target_validator = v.object({
	target: files_pending_target_validator,
	path: v.string(),
	name: v.string(),
});

const item_view_validator = v.object({
	itemId: v.id("files_transfer_items"),
	state: doc(app_convex_schema, "files_transfer_items").fields.state,
	kind: doc(app_convex_schema, "files_transfer_items").fields.kind,
	outcome: doc(app_convex_schema, "files_transfer_items").fields.outcome,
	movedNodeId: v.union(v.id("files_nodes"), v.null()),
	source: v.union(item_view_target_validator, v.null()),
	output: v.union(item_view_target_validator, v.null()),
	// Why this is separate from `conflict`: two sources in one paste can claim the same new name
	// while nothing occupies it yet. Then the item is a name conflict with no destination doc, so
	// `conflict` below is null. The caller still has to offer Keep both and Skip, so it reads the
	// kind from here and uses `conflict` only for Replace and Merge, which need a doc to act on.
	conflictKind: doc(app_convex_schema, "files_transfer_items").fields.conflictKind,
	conflict: v.union(
		v.object({
			kind: doc(app_convex_schema, "files_transfer_items").fields.conflictKind,
			target: files_pending_target_validator,
			version: v.union(files_transfer_source_version_validator, v.null()),
			path: v.string(),
		}),
		v.null(),
	),
	errorMessage: v.union(v.string(), v.null()),
});

export const list_items = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_transfer_runs"),
		state: v.optional(doc(app_convex_schema, "files_transfer_items").fields.state),
		paginationOpts: paginationOptsValidator,
	},
	returns: v.union(paginationResultValidator(item_view_validator), v.null()),
	handler: async (ctx, args) => {
		const owned = await files_transfer_queries_db_get_owned_run(ctx, args);
		if (owned._nay) {
			if (owned._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const { run } = owned._yay;
		const items = await (
			args.state === undefined
				? ctx.db.query("files_transfer_items").withIndex("by_run_order", (q) => q.eq("runId", run._id))
				: ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", args.state!))
		).paginate({ ...args.paginationOpts, numItems: Math.max(1, Math.min(50, args.paginationOpts.numItems)) });
		const sourceScope = { ...run, ...run.sourceScope };
		const sourceReader = await files_visible_db_create_reader(ctx, sourceScope);
		const reader = await files_visible_db_create_reader(ctx, { ...run, ...run.destinationScope });
		const page = [];
		for (const item of items.page) {
			const source = await files_transfer_queries_db_get_entry({
				ctx,
				run: sourceScope,
				target: item.source,
				reader: sourceReader,
			});
			const output = item.outputTarget ? await reader.resolveTarget(item.outputTarget) : null;
			const conflict = item.conflictTarget ? await reader.resolveTarget(item.conflictTarget) : null;
			page.push({
				itemId: item._id,
				state: item.state,
				kind: item.kind,
				outcome: item.outcome,
				movedNodeId:
					run.kind === "move" && item.state === "completed" && item.outputTarget?.kind === "saved"
						? item.outputTarget.id
						: null,
				source:
					source?.path === item.sourcePath ? { target: item.source, path: source.path, name: item.sourceName } : null,
				output:
					output && item.outputTarget ? { target: item.outputTarget, path: output.path, name: output.node.name } : null,
				conflictKind: item.conflictKind,
				conflict:
					conflict && item.conflictTarget
						? {
								kind: item.conflictKind,
								target: item.conflictTarget,
								version: item.conflictVersion,
								path: conflict.path,
							}
						: null,
				errorMessage: source ? item.errorMessage : item.errorMessage ? "This item is no longer available" : null,
			});
		}
		return { ...items, page };
	},
});
