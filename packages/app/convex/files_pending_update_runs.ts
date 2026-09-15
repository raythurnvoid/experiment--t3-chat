import { Result } from "common/errors-as-values-utils.ts";
import { Workpool } from "@convex-dev/workpool";
import { z } from "zod";
import { ConvexError, getConvexSize, v, type Value } from "convex/values";
import { doc } from "convex-helpers/validators";
import {
	paginationOptsValidator,
	paginationResultValidator,
	type RegisteredMutation,
	type RegisteredQuery,
} from "convex/server";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import {
	activities_db_require_by_source_id,
	activities_db_finish,
	activities_db_start,
	activities_get_controls,
	activities_get_result_status,
	activities_is_active,
	activities_db_delete,
} from "./activities_db.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import app_convex_schema, {
	files_pending_target_validator,
	files_pending_prepared_content_validator,
} from "./schema.ts";
import {
	files_pending_nodes_db_fence_discard,
	files_pending_nodes_db_get_ancestry,
	files_pending_nodes_db_resolve_saved_parent,
} from "./files_pending_nodes.ts";
import {
	files_pending_updates_action_prepare_content,
	files_pending_updates_db_commit_prepared_content,
	files_pending_updates_db_retire_prepared_content,
	files_pending_updates_db_discard_saved,
	files_pending_update_db_settle_move_row,
	files_pending_updates_db_apply_archive,
} from "./files_pending_updates.ts";
import { files_nodes_db_apply_move, files_nodes_db_preflight_move } from "./files_nodes.ts";
import { files_db_get_pending_update } from "../server/files.ts";
import { path_join, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { billing_db_check_credits, billing_pick_billed_user_id } from "./billing_db.ts";

export const experimental_reuseContext = true;

const MAX_SELECTED_ITEMS = 10_000;
const SELECTION_PAGE_SIZE = 100;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
// Eight deep private chains stay below the query's index-read limit.
const PLAN_PAGE_SIZE = 8;
const ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Use the transfer component so Copy and review preparation share the same two slots.
const files_review_workpool = new Workpool(components.files_transfer_workpool, {
	maxParallelism: 2,
	retryActionsByDefault: false,
});

function refuse_unit(code: string, message: string): never {
	// Throwing rolls back private publication, structural changes, billing, and receipts together.
	throw convex_error({ message, data: { code } });
}

/**
 * Count the full final transaction, including calls inside the shared Save and move tails.
 */
function db_with_unit_budget(ctx: MutationCtx) {
	let readDocuments = 0;
	let writtenDocuments = 0;
	let readBytes = 0;
	let writtenBytes = 0;
	let ranges = 0;

	function check() {
		if (
			readDocuments > 8_000 ||
			writtenDocuments > 8_000 ||
			readBytes > 12 * 1024 * 1024 ||
			writtenBytes > 12 * 1024 * 1024 ||
			ranges > 3_000
		)
			refuse_unit(
				"review_too_large",
				"These linked changes are too large to save together. Review a smaller independent set.",
			);
	}

	function read(value: Value | undefined) {
		if (value != null) {
			readDocuments++;
			readBytes += getConvexSize(value) + 128;
		}
		check();
	}

	function write(value: Value | undefined) {
		writtenDocuments++;
		writtenBytes += getConvexSize(value) + 128;
		check();
	}

	function query<T extends object>(source: T): T {
		return new Proxy(source, {
			get(target, property) {
				const method = Reflect.get(target, property) as (...args: unknown[]) => unknown;

				if (property === Symbol.asyncIterator)
					return async function* () {
						ranges++;
						check();
						for await (const doc of target as AsyncIterable<Value>) {
							read(doc);
							yield doc;
						}
					};

				if (property === "collect" || property === "take" || property === "first" || property === "unique")
					return async (count?: number) => {
						const docs: Value[] = [];
						const limit = property === "first" ? 1 : property === "unique" ? 2 : (count ?? Infinity);
						if (limit > 0)
							for await (const doc of query(target) as AsyncIterable<Value>) {
								docs.push(doc);
								if (docs.length >= limit) break;
							}
						if (property === "unique" && docs.length > 1)
							throw should_never_happen("Review commit expected one indexed doc");
						return property === "first" || property === "unique" ? (docs[0] ?? null) : docs;
					};

				// No final tail uses filtered scans. Counting their returned docs would miss rejected reads.
				if (property === "filter" || property === "withSearchIndex" || property === "paginate")
					return () => {
						throw should_never_happen("Review commit used an uncounted query", { method: String(property) });
					};

				return (...args: unknown[]) => query(Reflect.apply(method, target, args) as object);
			},
		});
	}

	const db = new Proxy(ctx.db, {
		get(target, property) {
			if (property === "query")
				return new Proxy(target.query.bind(target), {
					apply(method, receiver, args: [string]) {
						return query(Reflect.apply(method, receiver, args) as object);
					},
				});

			if (property === "get")
				return new Proxy(target.get.bind(target), {
					async apply(method, receiver, args: unknown[]) {
						ranges++;
						check();
						const value = (await Reflect.apply(method, receiver, args)) as Value | null;
						read(value);
						return value;
					},
				});

			if (property === "insert" || property === "replace" || property === "patch" || property === "delete") {
				const method = target[property].bind(target);
				return new Proxy(method, {
					async apply(fn, receiver, args: unknown[]) {
						let value = args.at(-1) as Value;
						if (property === "patch" || property === "delete") {
							ranges++;
							check();
							const current = (await Reflect.apply(target.get.bind(target), target, args.slice(0, 2))) as Record<
								string,
								Value
							> | null;
							read(current);
							value = property === "patch" ? { ...current, ...(value as Record<string, Value>) } : null;
						}
						write(value);
						return await Reflect.apply(fn, receiver, args);
					},
				});
			}

			return Reflect.get(target, property) as unknown;
		},
	});

	return {
		...ctx,
		db,
		runQuery: new Proxy(ctx.runQuery, {
			async apply(method, receiver, args: unknown[]) {
				// The final billing gates use Polar's one-doc product lookup.
				ranges++;
				check();
				const value = (await Reflect.apply(method, receiver, args)) as Value | null;
				read(value);
				return value;
			},
		}),
		runMutation: new Proxy(ctx.runMutation, {
			async apply(method, receiver, args: unknown[]) {
				// Workpool enqueue reads fixed global and run docs and writes one event doc plus its
				// queue docs. Its 200-entry running list fits this reserve. Event bytes are counted
				// separately.
				ranges += 16;
				readDocuments += 16;
				writtenDocuments += 16;
				readBytes += 64 * 1024;
				writtenBytes += 64 * 1024 + 2 * getConvexSize(args[1] as Value);
				check();
				return (await Reflect.apply(method, receiver, args)) as unknown;
			},
		}),
		scheduler: new Proxy(ctx.scheduler, {
			get(target, property) {
				const method = Reflect.get(target, property) as (...args: unknown[]) => Promise<unknown>;
				return async (...args: unknown[]) => {
					write(args.at(-1) as Value);
					return await Reflect.apply(method, target, args);
				};
			},
		}),
	};
}

// Shared by the first page and later pages of the same reviewed selection.
const reviewed_item_validator = v.object({
	pendingUpdateId: v.id("files_pending_updates"),
	reviewedRevision: v.number(),
	selectedContentStateId: v.union(v.id("files_pending_update_yjs_states"), v.null()),
});

// These paths are internal planning facts. Public history returns IDs and safe status only.
const plan_context_validator = v.object({
	proposal: doc(app_convex_schema, "files_pending_updates"),
	path: v.union(v.string(), v.null()),
	savedAncestorPath: v.union(v.string(), v.null()),
	nodeKind: v.union(v.literal("file"), v.literal("folder"), v.null()),
	privateAncestorIds: v.array(v.id("files_pending_nodes")),
	destinationPrivateAncestorIds: v.array(v.id("files_pending_nodes")),
	destinationParentPath: v.union(v.string(), v.null()),
	destinationSavedAncestorPath: v.union(v.string(), v.null()),
	destinationPath: v.union(v.string(), v.null()),
	privateVersion: v.union(v.object({ creationGeneration: v.number(), structuralRevision: v.number() }), v.null()),
});

const revalidation_validator = v.object({
	unitId: v.id("files_pending_update_run_units"),
	attemptFence: v.number(),
	reviewVersion: v.number(),
});

async function db_get_review_version(
	ctx: QueryCtx | MutationCtx,
	scope: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
) {
	const version = await ctx.db
		.query("files_pending_review_versions")
		.withIndex("by_organization_workspace_user", (q) =>
			q.eq("organizationId", scope.organizationId).eq("workspaceId", scope.workspaceId).eq("userId", scope.userId),
		)
		.first();
	return version?.revision ?? 0;
}

async function db_get_run_membership(ctx: QueryCtx | MutationCtx, run: Doc<"files_pending_update_runs">) {
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	if (!activity.membershipId || activity.membershipLifetime === undefined) return null;
	const [user, workspace, organization, lifetime] = await Promise.all([
		ctx.db.get("users", run.userId),
		ctx.db.get("organizations_workspaces", run.workspaceId),
		ctx.db.get("organizations", run.organizationId),
		organizations_membership_lifetimes_db_get(ctx, run),
	]);
	if (
		!user ||
		user.deletedAt !== undefined ||
		!organization ||
		!workspace ||
		workspace.organizationId !== run.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!lifetime?.active ||
		lifetime.membershipId !== activity.membershipId ||
		lifetime.lifetime !== activity.membershipLifetime
	)
		return null;
	return await organizations_db_get_membership(ctx, { userId: run.userId, membershipId: activity.membershipId });
}

async function db_get_owned_run(
	ctx: QueryCtx | MutationCtx,
	args: { membershipId: Id<"organizations_workspaces_users">; runId: Id<"files_pending_update_runs"> },
) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
	const run = await ctx.db.get("files_pending_update_runs", args.runId);
	if (!run || run.userId !== userAuth.id) return Result({ _nay: { message: "Not found" } });
	const membership = await db_get_run_membership(ctx, run);
	if (!membership || membership._id !== args.membershipId) return Result({ _nay: { message: "Not found" } });
	return Result({ _yay: { run, membership } });
}

async function db_validate_items(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		kind: "accept" | "discard";
		items: Array<
			Pick<Doc<"files_pending_update_run_items">, "pendingUpdateId" | "reviewedRevision" | "selectedContentStateId">
		>;
	},
) {
	if (
		args.items.length === 0 ||
		args.items.length > SELECTION_PAGE_SIZE ||
		new Set(args.items.map((item) => item.pendingUpdateId)).size !== args.items.length
	)
		return Result({
			_nay: { name: "invalid_selection", message: "Send between 1 and 100 different reviewed changes." },
		});
	const proposals: Doc<"files_pending_updates">[] = [];
	for (const item of args.items) {
		const proposal = await ctx.db.get("files_pending_updates", item.pendingUpdateId);
		if (
			!proposal ||
			proposal.userId !== args.userId ||
			proposal.organizationId !== args.organizationId ||
			proposal.workspaceId !== args.workspaceId
		)
			return Result({ _nay: { name: "not_found", message: "A reviewed change is no longer available." } });
		if (
			proposal.revision !== item.reviewedRevision ||
			(args.kind === "accept" &&
				proposal.content !== undefined &&
				!proposal.pendingArchive &&
				!proposal.pendingReplacement &&
				item.selectedContentStateId === null) ||
			(item.selectedContentStateId !== null &&
				item.selectedContentStateId !== proposal.content?.stagedStateId &&
				item.selectedContentStateId !== proposal.content?.unstagedStateId)
		)
			return Result({
				_nay: { name: "needs_review", message: "Pending changes were revised. Review the latest version." },
			});
		proposals.push(proposal);
	}
	return Result({ _yay: proposals });
}

async function db_get_plan_context(ctx: QueryCtx | MutationCtx, proposal: Doc<"files_pending_updates">) {
	let path: string | null = null;
	let savedAncestorPath: string | null = null;
	let nodeKind: "file" | "folder" | null = null;
	let privateVersion: { creationGeneration: number; structuralRevision: number } | null = null;
	let privateAncestorIds: Id<"files_pending_nodes">[] = [];
	let destinationPrivateAncestorIds: Id<"files_pending_nodes">[] = [];
	let destinationParentPath: string | null = null;
	let destinationSavedAncestorPath: string | null = null;
	let destinationPath: string | null = null;

	if (proposal.target.kind === "saved") {
		const node = await ctx.db.get("files_nodes", proposal.target.id);
		if (
			node &&
			node.organizationId === proposal.organizationId &&
			node.workspaceId === proposal.workspaceId &&
			node.archiveOperationId === null
		) {
			path = node.path;
			savedAncestorPath = node.path;
			nodeKind = node.kind;
		}
	} else {
		const ancestry = await files_pending_nodes_db_get_ancestry(ctx, { ...proposal, privateNodeId: proposal.target.id });
		if (ancestry._yay) {
			const { node, ancestors, savedParent } = ancestry._yay;
			path = path_join(
				savedParent?.path ?? "/",
				[...ancestors.toReversed().map((ancestor) => ancestor.name), node.name].join("/"),
			);
			savedAncestorPath = savedParent?.path ?? "/";
			destinationSavedAncestorPath = savedAncestorPath;
			nodeKind = node.kind;
			privateVersion = { creationGeneration: node.creationGeneration, structuralRevision: node.structuralRevision };
			privateAncestorIds = ancestors.map((ancestor) => ancestor._id);
			destinationPrivateAncestorIds = privateAncestorIds;
			destinationParentPath = path.slice(0, path.lastIndexOf("/")) || "/";
			destinationPath = path;
		}
	}

	if (proposal.pendingMove) {
		let parent = proposal.pendingMove.destParent;
		if (parent.kind === "private") {
			const ancestry = await files_pending_nodes_db_get_ancestry(ctx, { ...proposal, privateNodeId: parent.id });
			if (ancestry._yay) {
				const { node, ancestors, savedParent } = ancestry._yay;
				destinationParentPath = path_join(
					savedParent?.path ?? "/",
					[...ancestors.toReversed().map((ancestor) => ancestor.name), node.name].join("/"),
				);
				destinationSavedAncestorPath = savedParent?.path ?? "/";
				destinationPrivateAncestorIds = [node._id, ...ancestors.map((ancestor) => ancestor._id)];
			} else {
				const published = await files_pending_nodes_db_resolve_saved_parent(ctx, { ...proposal, parent });
				if (published._yay)
					parent =
						published._yay.parentId === "root" ? { kind: "root" } : { kind: "saved", id: published._yay.parentId };
			}
		}

		if (parent.kind === "root") {
			destinationParentPath = "/";
			destinationSavedAncestorPath = "/";
		}

		if (parent.kind === "saved") {
			const node = await ctx.db.get("files_nodes", parent.id);
			if (
				node?.kind === "folder" &&
				node.organizationId === proposal.organizationId &&
				node.workspaceId === proposal.workspaceId &&
				node.archiveOperationId === null
			) {
				destinationParentPath = node.path;
				destinationSavedAncestorPath = node.path;
			}
		}

		if (destinationParentPath !== null)
			destinationPath = path_join(destinationParentPath, proposal.pendingMove.destName);
	}

	return {
		proposal,
		path,
		savedAncestorPath,
		nodeKind,
		privateAncestorIds,
		destinationPrivateAncestorIds,
		destinationParentPath,
		destinationSavedAncestorPath,
		destinationPath,
		privateVersion,
	};
}

async function db_get_planning_run(
	ctx: QueryCtx | MutationCtx,
	args: { runId: Id<"files_pending_update_runs">; fence: number },
) {
	const run = await ctx.db.get("files_pending_update_runs", args.runId);
	if (!run || run.fence !== args.fence || run.step !== "planning")
		return Result({ _nay: { name: "stopped", message: "This review is no longer planning." } });
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	if (!activities_is_active(activity.status) || activity.deadlineAt <= Date.now())
		return Result({ _nay: { name: "timed_out", message: "This review has expired." } });
	if (!(await db_get_run_membership(ctx, run)))
		return Result({ _nay: { name: "permission_denied", message: "This review is no longer available." } });
	if ((await db_get_review_version(ctx, run)) !== run.reviewVersion)
		return Result({
			_nay: { name: "needs_review", message: "Pending changes changed during review. Review them again." },
		});
	return Result({ _yay: run });
}

export const start = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		requestId: v.string(),
		kind: v.union(v.literal("accept"), v.literal("discard")),
		expectedItemCount: v.number(),
		items: v.array(reviewed_item_validator),
	},
	returns: v_result({
		_yay: v.object({ runId: v.id("files_pending_update_runs"), activityId: v.id("activities") }),
		_nay: { data: v.object({ runId: v.id("files_pending_update_runs"), activityId: v.id("activities") }) },
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });

		if (
			!args.requestId ||
			args.requestId.length > 200 ||
			!Number.isInteger(args.expectedItemCount) ||
			args.expectedItemCount < args.items.length ||
			args.expectedItemCount > MAX_SELECTED_ITEMS
		)
			return Result({ _nay: { name: "invalid_selection", message: "Select between 1 and 10,000 changes." } });

		const scope = {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
		};

		const requestHash = await crypto_sha256_hex(
			JSON.stringify([args.membershipId, args.kind, args.expectedItemCount, args.items]),
		);

		const existing = await ctx.db
			.query("files_pending_update_runs")
			.withIndex("by_user_requestId", (q) => q.eq("userId", userAuth.id).eq("requestId", args.requestId))
			.first();

		if (existing) {
			if (existing.requestHash !== requestHash || !(await db_get_run_membership(ctx, existing)))
				return Result({
					_nay: { name: "request_changed", message: "This request ID was already used for a different review." },
				});
			const activity = await activities_db_require_by_source_id(ctx, existing._id);
			return Result({ _yay: { runId: existing._id, activityId: activity._id } });
		}

		const [workspace, user] = await Promise.all([
			ctx.db.get("organizations_workspaces", membership.workspaceId),
			ctx.db.get("users", userAuth.id),
		]);

		if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined || !user || user.deletedAt !== undefined)
			return Result({ _nay: { message: "This workspace is no longer available." } });

		for (const status of ["queued", "running", "awaiting_input", "stopping"] as const) {
			const active = await ctx.db
				.query("activities")
				.withIndex("by_user_workspace_source_kind_status", (q) =>
					q
						.eq("userId", userAuth.id)
						.eq("workspaceId", membership.workspaceId)
						.eq("source.kind", "files_pending_update_run")
						.eq("status", status),
				)
				.first();
			if (active && active.source.kind === "files_pending_update_run")
				return Result({
					_nay: {
						name: "busy",
						message: "A review is already running in this workspace.",
						data: { runId: active.source.id, activityId: active._id },
					},
				});
		}

		const checked = await db_validate_items(ctx, { ...scope, kind: args.kind, items: args.items });
		if (checked._nay) return checked;

		const now = Date.now();
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);

		const runId = await ctx.db.insert("files_pending_update_runs", {
			...scope,
			requestId: args.requestId,
			requestHash,
			kind: args.kind,
			step: "uploading",
			expectedItemCount: args.expectedItemCount,
			itemCount: args.items.length,
			unitCount: 0,
			finishedUnitCount: 0,
			plannedItemCount: 0,
			reviewVersion: await db_get_review_version(ctx, scope),
			revalidateRemaining: false,
			fence: 0,
			planningAttempts: 0,
			needsReviewIds: [],
			updatedAt: now,
		});

		for (const [order, item] of args.items.entries()) {
			await ctx.db.insert("files_pending_update_run_items", {
				runId,
				order,
				...item,
				target: checked._yay[order]!.target,
				unitId: null,
				prepared: null,
				billedUserId: null,
				expectedPath: null,
				expectedDestinationParentPath: null,
			});
		}

		const activityId = await activities_db_start(ctx, {
			...scope,
			membershipId: membership._id,
			membershipLifetime,
			source: { kind: "files_pending_update_run", id: runId, operationKind: args.kind },
			title: args.kind === "accept" ? "Save reviewed changes" : "Discard reviewed changes",
			targets: [],
			visibility: "requester",
			feedVisible: true,
			status: "queued",
			resultKind: args.kind === "accept" ? "saved" : "discarded",
			progress: {
				unit: "items",
				discovered: args.items.length,
				total: args.expectedItemCount,
				completed: 0,
				skipped: 0,
				failed: 0,
				blocked: 0,
				canceled: 0,
			},
			deadlineAt: now + RUN_TIMEOUT_MS,
			now,
		});

		return Result({ _yay: { runId, activityId } });
	},
});

export const append_items = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_pending_update_runs"),
		offset: v.number(),
		items: v.array(reviewed_item_validator),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;
		const { run } = owned._yay;

		if (
			!Number.isInteger(args.offset) ||
			args.offset < 0 ||
			args.offset > run.itemCount ||
			args.items.length === 0 ||
			args.items.length > SELECTION_PAGE_SIZE ||
			args.offset + args.items.length > run.expectedItemCount
		)
			return Result({
				_nay: { name: "invalid_selection", message: "This review page has an invalid position or size." },
			});

		if (args.offset < run.itemCount) {
			const existing = await ctx.db
				.query("files_pending_update_run_items")
				.withIndex("by_run_order", (q) =>
					q
						.eq("runId", run._id)
						.gte("order", args.offset)
						.lt("order", args.offset + args.items.length),
				)
				.take(SELECTION_PAGE_SIZE);

			if (
				existing.length !== args.items.length ||
				existing.some((item, index) => {
					const reviewed = args.items[index]!;
					return (
						item.pendingUpdateId !== reviewed.pendingUpdateId ||
						item.reviewedRevision !== reviewed.reviewedRevision ||
						item.selectedContentStateId !== reviewed.selectedContentStateId
					);
				})
			)
				return Result({
					_nay: { name: "request_changed", message: "This review page was already sent with different changes." },
				});

			return Result({ _yay: null });
		}

		if (run.step !== "uploading")
			return Result({ _nay: { name: "selection_sealed", message: "This review selection is already closed." } });

		const checked = await db_validate_items(ctx, { ...run, items: args.items });
		if (checked._nay) return checked;

		for (const item of args.items) {
			const existing = await ctx.db
				.query("files_pending_update_run_items")
				.withIndex("by_run_pendingUpdate", (q) => q.eq("runId", run._id).eq("pendingUpdateId", item.pendingUpdateId))
				.first();
			if (existing)
				return Result({
					_nay: { name: "invalid_selection", message: "A change appears more than once in this review." },
				});
		}

		for (const [index, item] of args.items.entries()) {
			await ctx.db.insert("files_pending_update_run_items", {
				runId: run._id,
				order: args.offset + index,
				...item,
				target: checked._yay[index]!.target,
				unitId: null,
				prepared: null,
				billedUserId: null,
				expectedPath: null,
				expectedDestinationParentPath: null,
			});
		}

		const now = Date.now();
		await ctx.db.patch("files_pending_update_runs", run._id, {
			itemCount: run.itemCount + args.items.length,
			updatedAt: now,
		});

		const activity = await activities_db_require_by_source_id(ctx, run._id);
		await ctx.db.patch("activities", activity._id, {
			progress: { ...activity.progress!, discovered: run.itemCount + args.items.length },
			updatedAt: now,
		});

		return Result({ _yay: null });
	},
});

export const seal = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), runId: v.id("files_pending_update_runs") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;
		const { run } = owned._yay;
		if (run.step !== "uploading") return Result({ _yay: null });
		if (run.itemCount !== run.expectedItemCount)
			return Result({ _nay: { name: "incomplete_selection", message: "Send all reviewed changes before starting." } });
		const now = Date.now();
		const activity = await activities_db_require_by_source_id(ctx, run._id);
		if (!activities_is_active(activity.status) || activity.deadlineAt <= now)
			return Result({ _nay: { name: "timed_out", message: "This review request has expired." } });
		await ctx.db.patch("files_pending_update_runs", run._id, {
			step: "planning",
			planningAttempts: 1,
			reviewVersion: await db_get_review_version(ctx, run),
			updatedAt: now,
		});
		await ctx.db.patch("activities", activity._id, { status: "running", startedAt: now, updatedAt: now });
		await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.plan, { runId: run._id, fence: run.fence });
		return Result({ _yay: null });
	},
});

export const get_plan_selection_page = internalQuery({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		cursor: v.union(v.string(), v.null()),
		revalidation: v.optional(revalidation_validator),
	},
	returns: v_result({
		_yay: v.object({
			run: doc(app_convex_schema, "files_pending_update_runs"),
			page: v.array(
				v.object({ item: doc(app_convex_schema, "files_pending_update_run_items"), context: plan_context_validator }),
			),
			isDone: v.boolean(),
			continueCursor: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const planning = args.revalidation
			? await db_get_revalidation_run(ctx, { ...args, ...args.revalidation })
			: await db_get_planning_run(ctx, args);
		if (planning._nay) return planning;
		const run = planning._yay;
		const itemQuery = ctx.db.query("files_pending_update_run_items");
		const selection = args.revalidation
			? itemQuery.withIndex("by_unit_order", (q) => q.eq("unitId", args.revalidation!.unitId))
			: itemQuery.withIndex("by_run_order", (q) => q.eq("runId", run._id));
		const items = await selection.paginate({ cursor: args.cursor, numItems: PLAN_PAGE_SIZE });
		const page = [];
		for (const item of items.page) {
			const checked = await db_validate_items(ctx, { ...run, items: [item] });
			if (checked._nay) return checked;
			const context = await db_get_plan_context(ctx, checked._yay[0]!);
			if (
				args.revalidation &&
				(context.path !== item.expectedPath || context.destinationParentPath !== item.expectedDestinationParentPath)
			)
				return Result({
					_nay: { name: "needs_review", message: "A reviewed source or destination moved. Review it again." },
				});
			if (context.path === null && run.kind === "accept")
				return Result({ _nay: { name: "needs_review", message: "A reviewed destination is no longer available." } });
			page.push({ item, context });
		}
		return Result({ _yay: { run, page, isDone: items.isDone, continueCursor: items.continueCursor } });
	},
});

type get_plan_selection_page_Result =
	typeof get_plan_selection_page extends RegisteredQuery<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const get_plan_proposals_page = internalQuery({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		cursor: v.union(v.string(), v.null()),
		revalidation: v.optional(revalidation_validator),
	},
	returns: v_result({
		_yay: v.object({ page: v.array(plan_context_validator), isDone: v.boolean(), continueCursor: v.string() }),
	}),
	handler: async (ctx, args) => {
		const planning = args.revalidation
			? await db_get_revalidation_run(ctx, { ...args, ...args.revalidation })
			: await db_get_planning_run(ctx, args);
		if (planning._nay) return planning;
		const run = planning._yay;
		const proposals = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_organization_workspace_user_target", (q) =>
				q.eq("organizationId", run.organizationId).eq("workspaceId", run.workspaceId).eq("userId", run.userId),
			)
			.paginate({ cursor: args.cursor, numItems: PLAN_PAGE_SIZE });
		const page = [];
		for (const proposal of proposals.page) page.push(await db_get_plan_context(ctx, proposal));
		return Result({ _yay: { page, isDone: proposals.isDone, continueCursor: proposals.continueCursor } });
	},
});

type get_plan_proposals_page_Result =
	typeof get_plan_proposals_page extends RegisteredQuery<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const refresh_plan = internalMutation({
	args: { runId: v.id("files_pending_update_runs"), fence: v.number() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const planning = await db_get_planning_run(ctx, args);
		if (planning._nay) return planning;
		await ctx.db.patch("files_pending_update_runs", planning._yay._id, { updatedAt: Date.now() });
		return Result({ _yay: null });
	},
});

type refresh_plan_Result =
	typeof refresh_plan extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const fail_plan = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		code: v.string(),
		message: v.string(),
		unreviewedIds: v.array(v.id("files_pending_updates")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_pending_update_runs", args.runId);
		if (!run || run.fence !== args.fence || run.step !== "planning") return null;
		const activity = await activities_db_require_by_source_id(ctx, run._id);
		const now = Date.now();
		if (activity.deadlineAt <= now) {
			await files_pending_update_runs_db_request_stop(ctx, { runId: run._id, reason: "timeout", now });
			return null;
		}
		await ctx.db.patch("files_pending_update_runs", run._id, {
			step: "finished",
			fence: run.fence + 1,
			needsReviewIds: args.unreviewedIds.slice(0, 20),
			updatedAt: now,
		});
		await ctx.db.patch("activities", activity._id, {
			progress: { ...activity.progress!, blocked: run.itemCount },
			updatedAt: now,
		});
		await activities_db_finish(ctx, {
			sourceId: run._id,
			status: "failed",
			errorCode: args.code,
			errorMessage: args.message,
			now,
		});
		return null;
	},
});

export const stage_plan_units = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		offset: v.number(),
		units: v.array(
			v.object({
				itemCount: v.number(),
				deleteLast: v.boolean(),
				privateDiscardRoots:
					app_convex_schema.tables.files_pending_update_run_units.validator.fields.privateDiscardRoots,
			}),
		),
	},
	returns: v_result({ _yay: v.array(v.id("files_pending_update_run_units")) }),
	handler: async (ctx, args) => {
		const planning = await db_get_planning_run(ctx, args);
		if (planning._nay) return planning;
		const run = planning._yay;

		if (args.units.length > SELECTION_PAGE_SIZE || args.offset > run.unitCount)
			return Result({ _nay: { name: "invalid_plan", message: "The review plan is out of order." } });

		if (args.offset < run.unitCount) {
			const units = await ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", run._id).gte("order", args.offset))
				.take(args.units.length);

			if (
				units.length !== args.units.length ||
				units.some(
					(unit, index) =>
						unit.itemCount !== args.units[index]!.itemCount ||
						unit.deleteLast !== args.units[index]!.deleteLast ||
						JSON.stringify(unit.privateDiscardRoots) !== JSON.stringify(args.units[index]!.privateDiscardRoots),
				)
			)
				return Result({ _nay: { name: "invalid_plan", message: "The review plan changed." } });

			return Result({ _yay: units.map((unit) => unit._id) });
		}

		const ids = [];
		for (const [index, unit] of args.units.entries()) {
			ids.push(
				await ctx.db.insert("files_pending_update_run_units", {
					runId: run._id,
					order: args.offset + index,
					...unit,
					status: "queued",
					attemptCount: 0,
					workId: null,
					attemptFence: 0,
					attemptDeadlineAt: null,
					validatedReviewVersion: null,
					errorCode: null,
					errorMessage: null,
					finishedAt: null,
				}),
			);
		}

		await ctx.db.patch("files_pending_update_runs", run._id, {
			unitCount: run.unitCount + ids.length,
			updatedAt: Date.now(),
		});

		return Result({ _yay: ids });
	},
});

type stage_plan_units_Result =
	typeof stage_plan_units extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const stage_plan_items = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		offset: v.number(),
		items: v.array(
			v.object({
				itemId: v.id("files_pending_update_run_items"),
				unitId: v.id("files_pending_update_run_units"),
				expectedPath: v.union(v.string(), v.null()),
				expectedDestinationParentPath: v.union(v.string(), v.null()),
			}),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const planning = await db_get_planning_run(ctx, args);
		if (planning._nay) return planning;
		const run = planning._yay;
		if (args.items.length > SELECTION_PAGE_SIZE || args.offset > run.plannedItemCount)
			return Result({ _nay: { name: "invalid_plan", message: "The review plan is out of order." } });
		const items = [];
		for (const [index, assignment] of args.items.entries()) {
			const item = await ctx.db.get("files_pending_update_run_items", assignment.itemId);
			const unit = await ctx.db.get("files_pending_update_run_units", assignment.unitId);
			if (
				!item ||
				item.runId !== run._id ||
				item.order !== args.offset + index ||
				!unit ||
				unit.runId !== run._id ||
				(item.unitId !== null &&
					(item.unitId !== unit._id ||
						item.expectedPath !== assignment.expectedPath ||
						item.expectedDestinationParentPath !== assignment.expectedDestinationParentPath))
			)
				return Result({ _nay: { name: "invalid_plan", message: "The review plan changed." } });
			items.push(item);
		}
		if (args.offset < run.plannedItemCount) return Result({ _yay: null });
		for (const [index, item] of items.entries()) {
			const { itemId: _itemId, ...assignment } = args.items[index]!;
			await ctx.db.patch("files_pending_update_run_items", item._id, assignment);
		}
		await ctx.db.patch("files_pending_update_runs", run._id, {
			plannedItemCount: run.plannedItemCount + items.length,
			updatedAt: Date.now(),
		});
		return Result({ _yay: null });
	},
});

type stage_plan_items_Result =
	typeof stage_plan_items extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const seal_plan = internalMutation({
	args: { runId: v.id("files_pending_update_runs"), fence: v.number() },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const planning = await db_get_planning_run(ctx, args);
		if (planning._nay) return planning;
		const run = planning._yay;
		if (run.plannedItemCount !== run.itemCount || run.unitCount === 0)
			return Result({ _nay: { name: "invalid_plan", message: "The review plan is incomplete." } });
		await ctx.db.patch("files_pending_update_runs", run._id, { step: "running", updatedAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.advance, { runId: run._id });
		return Result({ _yay: null });
	},
});

type seal_plan_Result = typeof seal_plan extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

function build_review_dependencies(
	kind: "accept" | "discard",
	selected: NonNullable<get_plan_selection_page_Result["_yay"]>["page"],
) {
	const indexById = new Map(selected.map(({ item }, index) => [item.pendingUpdateId, index]));
	const parents = selected.map((_, index) => index);

	function root(index: number): number {
		while (parents[index] !== index) {
			parents[index] = parents[parents[index]!]!;
			index = parents[index]!;
		}
		return index;
	}

	function join(left: number, right: number) {
		parents[root(right)] = root(left);
	}

	const selectedMoves = new Map(
		selected.flatMap(({ context }, index) =>
			context.proposal.target.kind === "saved" &&
			context.proposal.pendingMove &&
			!context.proposal.pendingArchive &&
			context.path
				? [[context.path, { context, index }] as const]
				: [],
		),
	);

	function projectedPath(
		path: string | null,
		savedAncestorPath: string | null,
		visited = new Set<string>(),
	): string | null {
		if (path === null || savedAncestorPath === null) return path;
		let prefix = savedAncestorPath;
		while (prefix && prefix !== "/") {
			const move = selectedMoves.get(prefix);
			if (move) {
				if (visited.has(prefix)) return null;
				visited.add(prefix);
				const parent = projectedPath(
					move.context.destinationParentPath,
					move.context.destinationSavedAncestorPath,
					visited,
				);
				return parent === null
					? null
					: path_join(parent, move.context.proposal.pendingMove!.destName) + path.slice(prefix.length);
			}
			prefix = prefix.slice(0, prefix.lastIndexOf("/"));
		}
		return path;
	}

	const requiredTargets = new Map<string, Set<number>>();
	const selectedDestinations = new Map<string, Set<number>>();
	const selectedMoveSources = new Map<string, Set<number>>();
	const selectedAncestorPaths = new Map<string, Set<number>>();
	const archives = new Map<string, Set<number>>();
	const privateDiscards = new Map<Id<"files_pending_nodes">, number>();

	function add(map: Map<string, Set<number>>, key: string, index: number) {
		const values = map.get(key) ?? new Set<number>();
		values.add(index);
		map.set(key, values);
	}

	for (const [index, { context }] of selected.entries()) {
		const { proposal } = context;
		if (kind === "accept") {
			const projected = projectedPath(context.path, context.savedAncestorPath);
			const destination = projectedPath(context.destinationPath, context.destinationSavedAncestorPath);
			if (projected === null || (context.destinationPath !== null && destination === null)) {
				return Result({
					_nay: { name: "needs_review", message: "These moves form a folder cycle. Review their destinations." },
				});
			}

			// A selected child's Save must share the transaction that moves its saved parent.
			let ancestor = context.savedAncestorPath;
			while (ancestor && ancestor !== "/") {
				const movedParent = selectedMoves.get(ancestor);
				if (movedParent) join(index, movedParent.index);
				ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
			}

			// Moving or creating below another move uses that parent's reviewed placement.
			if (proposal.pendingMove || proposal.target.kind === "private") {
				for (const path of [context.path, context.destinationPath]) {
					let parentPath = path?.slice(0, path.lastIndexOf("/")) ?? "";
					while (parentPath) {
						add(selectedAncestorPaths, parentPath, index);
						parentPath = parentPath.slice(0, parentPath.lastIndexOf("/"));
					}
				}
			}

			for (const id of [...context.privateAncestorIds, ...context.destinationPrivateAncestorIds])
				add(requiredTargets, `private:${id}`, index);
			const replaced = proposal.pendingMove?.replacesTarget;
			if (replaced) add(requiredTargets, `${replaced.kind}:${replaced.id}`, index);
			if (context.destinationPath) add(selectedDestinations, context.destinationPath, index);
			if (proposal.pendingArchive) add(archives, projected, index);
		} else {
			if (proposal.target.kind === "private") privateDiscards.set(proposal.target.id, index);
			if (proposal.pendingMove && context.path) add(selectedMoveSources, context.path, index);
		}
	}

	function requiredBy(context: Awaited<ReturnType<typeof db_get_plan_context>>) {
		const { proposal } = context;
		const indices = new Set(requiredTargets.get(`${proposal.target.kind}:${proposal.target.id}`));
		if (kind === "accept") {
			if ((proposal.pendingMove || proposal.pendingArchive) && context.path)
				for (const index of selectedAncestorPaths.get(context.path) ?? []) indices.add(index);
			if (proposal.pendingMove && context.path)
				for (const index of selectedDestinations.get(context.path) ?? []) indices.add(index);

			for (const path of [
				projectedPath(context.path, context.savedAncestorPath),
				projectedPath(context.destinationPath, context.destinationSavedAncestorPath),
			]) {
				if (!path) continue;
				let prefix = path;
				while (prefix) {
					for (const index of archives.get(prefix) ?? []) indices.add(index);
					prefix = prefix.slice(0, prefix.lastIndexOf("/"));
				}
			}
		} else {
			if (context.destinationPath)
				for (const index of selectedMoveSources.get(context.destinationPath) ?? []) indices.add(index);
			for (const parentId of [...context.privateAncestorIds, ...context.destinationPrivateAncestorIds]) {
				const index = privateDiscards.get(parentId);
				if (index === undefined) continue;
				const parentProposal = selected[index]!.context.proposal;
				const ready = proposal.createIntent && (proposal.createIntent.kind !== "text" || proposal.content);
				const crossChat = proposal.threadIds?.some((id) => !parentProposal.threadIds?.includes(id));
				if (indexById.has(proposal._id) || proposal.target.kind === "saved" || ready || crossChat) indices.add(index);
			}
		}
		return indices;
	}

	for (const [index, { context }] of selected.entries())
		for (const required of requiredBy(context)) join(index, required);

	const groups = new Map<number, typeof selected>();
	for (const [index, entry] of selected.entries()) {
		const key = root(index);
		const group = groups.get(key) ?? [];
		group.push(entry);
		groups.set(key, group);
	}

	return Result({
		_yay: {
			units: [...groups.values()].sort((a, b) => a[0]!.item.order - b[0]!.item.order),
			scanRequired: Boolean(
				requiredTargets.size ||
					selectedDestinations.size ||
					selectedMoveSources.size ||
					selectedAncestorPaths.size ||
					archives.size ||
					privateDiscards.size,
			),
			unreviewed: (contexts: Awaited<ReturnType<typeof db_get_plan_context>>[]) =>
				contexts.filter((context) => !indexById.has(context.proposal._id) && requiredBy(context).size > 0),
		},
	});
}

export const plan = internalAction({
	args: { runId: v.id("files_pending_update_runs"), fence: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		async function fail(error: { name?: string; message: string }, unreviewedIds: Id<"files_pending_updates">[] = []) {
			await ctx.runMutation(internal.files_pending_update_runs.fail_plan, {
				...args,
				code: error.name ?? "failed",
				message: error.message,
				unreviewedIds: unreviewedIds.slice(0, 20),
			});
		}

		let lastRefreshAt = Date.now();

		async function refresh() {
			if (Date.now() - lastRefreshAt < 30_000) return true;
			const refreshed = (await ctx.runMutation(
				internal.files_pending_update_runs.refresh_plan,
				args,
			)) as refresh_plan_Result;
			if (refreshed._nay) {
				await fail(refreshed._nay);
				return false;
			}
			lastRefreshAt = Date.now();
			return true;
		}

		try {
			const selected: NonNullable<get_plan_selection_page_Result["_yay"]>["page"] = [];
			let run: Doc<"files_pending_update_runs"> | null = null;
			let cursor: string | null = null;

			while (true) {
				if (!(await refresh())) return null;
				const page = (await ctx.runQuery(internal.files_pending_update_runs.get_plan_selection_page, {
					...args,
					cursor,
				})) as get_plan_selection_page_Result;
				if (page._nay) {
					await fail(page._nay);
					return null;
				}
				run = page._yay.run;
				selected.push(...page._yay.page);
				if (page._yay.isDone) break;
				cursor = page._yay.continueCursor;
			}

			if (!run || selected.length !== run.itemCount) {
				await fail({ name: "invalid_plan", message: "The review selection is incomplete." });
				return null;
			}

			const dependencies = build_review_dependencies(run.kind, selected);
			if (dependencies._nay) {
				await fail(dependencies._nay);
				return null;
			}

			// Plain content changes need no workspace scan. Structural changes can invalidate hidden work.
			if (dependencies._yay.scanRequired) {
				cursor = null;
				while (true) {
					if (!(await refresh())) return null;
					const page = (await ctx.runQuery(internal.files_pending_update_runs.get_plan_proposals_page, {
						...args,
						cursor,
					})) as get_plan_proposals_page_Result;
					if (page._nay) {
						await fail(page._nay);
						return null;
					}
					const missing = dependencies._yay.unreviewed(page._yay.page);
					if (missing.length) {
						await fail(
							{ name: "needs_review", message: "This action also affects unselected changes. Review them together." },
							missing.map((context) => context.proposal._id),
						);
						return null;
					}
					if (page._yay.isDone) break;
					cursor = page._yay.continueCursor;
				}
			}

			const units = dependencies._yay.units;
			const unitIds: Id<"files_pending_update_run_units">[] = [];

			for (let offset = 0; offset < units.length; offset += SELECTION_PAGE_SIZE) {
				const page = units.slice(offset, offset + SELECTION_PAGE_SIZE).map((unit) => {
					const privateTargets = new Set(
						unit
							.filter(({ context }) => context.proposal.target.kind === "private")
							.map(({ context }) => context.proposal.target.id),
					);
					const privateDiscardRoots =
						run!.kind === "discard"
							? unit.flatMap(({ item, context }) => {
									if (
										context.proposal.target.kind !== "private" ||
										!context.privateVersion ||
										context.privateAncestorIds.some((id) => privateTargets.has(id))
									)
										return [];
									return [
										{
											privateNodeId: context.proposal.target.id,
											...context.privateVersion,
											pendingUpdateId: item.pendingUpdateId,
											reviewedRevision: item.reviewedRevision,
										},
									];
								})
							: [];
					return {
						itemCount: unit.length,
						deleteLast: unit.some(({ context }) => context.proposal.pendingArchive !== undefined),
						privateDiscardRoots,
					};
				});

				const staged = (await ctx.runMutation(internal.files_pending_update_runs.stage_plan_units, {
					...args,
					offset,
					units: page,
				})) as stage_plan_units_Result;
				if (staged._nay) {
					await fail(staged._nay);
					return null;
				}
				unitIds.push(...staged._yay);
			}

			const unitIdByItem = new Map(
				units.flatMap((unit, index) => unit.map(({ item }) => [item._id, unitIds[index]!] as const)),
			);

			for (let offset = 0; offset < selected.length; offset += SELECTION_PAGE_SIZE) {
				const items = selected.slice(offset, offset + SELECTION_PAGE_SIZE).map(({ item, context }) => ({
					itemId: item._id,
					unitId: unitIdByItem.get(item._id)!,
					expectedPath: context.path,
					expectedDestinationParentPath: context.destinationParentPath,
				}));

				const staged = (await ctx.runMutation(internal.files_pending_update_runs.stage_plan_items, {
					...args,
					offset,
					items,
				})) as stage_plan_items_Result;
				if (staged._nay) {
					await fail(staged._nay);
					return null;
				}
			}

			const sealed = (await ctx.runMutation(internal.files_pending_update_runs.seal_plan, args)) as seal_plan_Result;
			if (sealed._nay) await fail(sealed._nay);
		} catch (error) {
			console.error("Review planning failed", { runId: args.runId, error });
			// The recovery lease retries this exact selection, including after a lost response.
		}
		return null;
	},
});

async function db_get_running_unit(
	ctx: QueryCtx | MutationCtx,
	args: {
		runId: Id<"files_pending_update_runs">;
		fence: number;
		unitId: Id<"files_pending_update_run_units">;
		attemptFence: number;
	},
) {
	const [run, unit] = await Promise.all([
		ctx.db.get("files_pending_update_runs", args.runId),
		ctx.db.get("files_pending_update_run_units", args.unitId),
	]);
	if (
		!run ||
		run.step !== "running" ||
		run.fence !== args.fence ||
		!unit ||
		unit.runId !== run._id ||
		unit.status !== "preparing" ||
		unit.attemptFence !== args.attemptFence
	)
		return Result({ _nay: { name: "stopped", message: "This review attempt is no longer running." } });
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	if (
		!activities_is_active(activity.status) ||
		activity.deadlineAt <= Date.now() ||
		unit.attemptDeadlineAt === null ||
		unit.attemptDeadlineAt <= Date.now()
	)
		return Result({ _nay: { name: "timed_out", message: "This review attempt has expired." } });
	const membership = await db_get_run_membership(ctx, run);
	if (!membership)
		return Result({ _nay: { name: "permission_denied", message: "This review is no longer available." } });
	return Result({ _yay: { run, unit, activity, membership } });
}

async function db_get_revalidation_run(
	ctx: QueryCtx | MutationCtx,
	args: {
		runId: Id<"files_pending_update_runs">;
		fence: number;
		unitId: Id<"files_pending_update_run_units">;
		attemptFence: number;
		reviewVersion: number;
	},
) {
	const checked = await db_get_running_unit(ctx, args);
	if (checked._nay) return checked;
	if ((await db_get_review_version(ctx, checked._yay.run)) !== args.reviewVersion)
		return Result({
			_nay: {
				name: "review_changed",
				message: "Pending changes changed during this check. Trying the same selection again.",
			},
		});
	return Result({ _yay: checked._yay.run });
}

export const begin_unit_review = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
	},
	returns: v_result({ _yay: v.object({ required: v.boolean(), reviewVersion: v.number() }) }),
	handler: async (ctx, args) => {
		const checked = await db_get_running_unit(ctx, args);
		if (checked._nay) return checked;
		const { run, unit } = checked._yay;
		const reviewVersion = await db_get_review_version(ctx, run);
		const required = run.revalidateRemaining || reviewVersion !== run.reviewVersion;
		// Own commits advance the run clock. Later units must still check changes seen before that commit.
		if (required && !run.revalidateRemaining)
			await ctx.db.patch("files_pending_update_runs", run._id, { revalidateRemaining: true });
		await ctx.db.patch("files_pending_update_run_units", unit._id, {
			validatedReviewVersion: required ? null : reviewVersion,
		});
		return Result({ _yay: { required, reviewVersion } });
	},
});

type begin_unit_review_Result =
	typeof begin_unit_review extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const seal_unit_review = internalMutation({
	args: { runId: v.id("files_pending_update_runs"), fence: v.number(), ...revalidation_validator.fields },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const checked = await db_get_revalidation_run(ctx, args);
		if (checked._nay) return checked;
		await ctx.db.patch("files_pending_update_run_units", args.unitId, { validatedReviewVersion: args.reviewVersion });
		return Result({ _yay: null });
	},
});

type seal_unit_review_Result =
	typeof seal_unit_review extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

async function db_finish_unit(
	ctx: MutationCtx,
	args: {
		run: Doc<"files_pending_update_runs">;
		unit: Doc<"files_pending_update_run_units">;
		status: "completed" | "blocked" | "failed";
		code?: string;
		message?: string;
	},
) {
	const { run, unit } = args;
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	const now = Date.now();
	if (unit.workId && args.status !== "completed") await files_review_workpool.cancel(ctx, unit.workId);
	await ctx.db.patch("files_pending_update_run_units", unit._id, {
		status: args.status,
		workId: null,
		errorCode: args.code ?? null,
		errorMessage: args.message ?? null,
		finishedAt: now,
		attemptDeadlineAt: null,
		attemptFence: unit.attemptFence + 1,
	});
	await ctx.db.patch("files_pending_update_runs", run._id, {
		finishedUnitCount: run.finishedUnitCount + 1,
		...(args.status === "completed" ? { reviewVersion: await db_get_review_version(ctx, run) } : {}),
		updatedAt: now,
	});
	await ctx.db.patch("activities", activity._id, {
		progress: { ...activity.progress!, [args.status]: activity.progress![args.status] + unit.itemCount },
		updatedAt: now,
	});
	await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.advance, { runId: run._id });
	await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.retire_unit_preparation, { unitId: unit._id });
}

export async function files_pending_update_runs_db_request_stop(
	ctx: MutationCtx,
	args: { runId: Id<"files_pending_update_runs">; reason: "user" | "timeout" | "permission"; now: number },
) {
	const run = await ctx.db.get("files_pending_update_runs", args.runId);
	if (!run || run.step === "finished") return;
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	const progress = activity.progress!;
	const remaining =
		run.expectedItemCount -
		progress.completed -
		progress.skipped -
		progress.failed -
		progress.blocked -
		progress.canceled;
	await ctx.db.patch("files_pending_update_runs", run._id, {
		step: "finished",
		fence: run.fence + 1,
		updatedAt: args.now,
	});
	await ctx.db.patch("activities", activity._id, {
		progress: { ...progress, canceled: progress.canceled + remaining },
		updatedAt: args.now,
	});
	await activities_db_finish(ctx, {
		sourceId: run._id,
		status: args.reason === "timeout" ? "timed_out" : "canceled",
		now: args.now,
		errorCode: args.reason === "permission" ? "permission_denied" : undefined,
		errorMessage:
			args.reason === "permission"
				? "This review is no longer available."
				: args.reason === "timeout"
					? "The review reached its execution deadline."
					: null,
	});
	const preparing = await ctx.db
		.query("files_pending_update_run_units")
		.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", run._id).eq("status", "preparing"))
		.first();
	if (preparing?.workId) {
		await files_review_workpool.cancel(ctx, preparing.workId);
		await ctx.db.patch("files_pending_update_run_units", preparing._id, { workId: null });
	}
	await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.retire_run_preparation, {
		runId: run._id,
		cursor: null,
	});
}

export const advance = internalMutation({
	args: { runId: v.id("files_pending_update_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_pending_update_runs", args.runId);
		if (!run || run.step !== "running") return null;

		const activity = await activities_db_require_by_source_id(ctx, run._id);
		if (!activities_is_active(activity.status)) return null;

		const now = Date.now();
		if (activity.deadlineAt <= now || !(await db_get_run_membership(ctx, run))) {
			await files_pending_update_runs_db_request_stop(ctx, {
				runId: run._id,
				reason: activity.deadlineAt <= now ? "timeout" : "permission",
				now,
			});
			return null;
		}

		if (run.finishedUnitCount === run.unitCount) {
			await ctx.db.patch("files_pending_update_runs", run._id, {
				step: "finished",
				fence: run.fence + 1,
				updatedAt: now,
			});

			const status = activities_get_result_status(activity.progress!);
			await activities_db_finish(ctx, {
				sourceId: run._id,
				status,
				errorMessage: status === "failed" || status === "partial" ? "Some changes still need review." : null,
				now,
			});
			return null;
		}

		const preparing = await ctx.db
			.query("files_pending_update_run_units")
			.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", run._id).eq("status", "preparing"))
			.first();

		if (preparing) {
			if (preparing.attemptDeadlineAt !== null && preparing.attemptDeadlineAt <= now) {
				if (preparing.attemptCount < MAX_ATTEMPTS) {
					if (preparing.workId) await files_review_workpool.cancel(ctx, preparing.workId);
					await ctx.db.patch("files_pending_update_run_units", preparing._id, {
						status: "queued",
						workId: null,
						attemptFence: preparing.attemptFence + 1,
						attemptDeadlineAt: null,
					});
					await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.advance, args);
				} else
					await db_finish_unit(ctx, {
						run,
						unit: preparing,
						status: "failed",
						code: "attempt_expired",
						message: "This review attempt did not finish. Start a new review.",
					});
			}
			return null;
		}

		// One worker bounds external preparation and keeps this owner's units in a stable order.
		const unit = await ctx.db
			.query("files_pending_update_run_units")
			.withIndex("by_run_status_deleteLast_order", (q) => q.eq("runId", run._id).eq("status", "queued"))
			.first();

		if (!unit) throw should_never_happen("Review has unfinished units but no queued work", { runId: run._id });

		await ctx.db.patch("files_pending_update_run_units", unit._id, {
			status: "preparing",
			attemptCount: unit.attemptCount + 1,
			attemptFence: unit.attemptFence + 1,
			attemptDeadlineAt: Math.min(activity.deadlineAt, now + ATTEMPT_TIMEOUT_MS),
			validatedReviewVersion: null,
		});

		await ctx.db.patch("activities", activity._id, {
			status: "running",
			startedAt: activity.startedAt ?? now,
			updatedAt: now,
		});
		await ctx.db.patch("files_pending_update_runs", run._id, { updatedAt: now });

		const workId = await files_review_workpool.enqueueAction(ctx, internal.files_pending_update_runs.prepare_unit, {
			runId: run._id,
			fence: run.fence,
			unitId: unit._id,
			attemptFence: unit.attemptFence + 1,
		});
		await ctx.db.patch("files_pending_update_run_units", unit._id, { workId });

		await ctx.scheduler.runAfter(ATTEMPT_TIMEOUT_MS, internal.files_pending_update_runs.advance, args);
		return null;
	},
});

export const get_unit_page = internalQuery({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v_result({
		_yay: v.object({
			run: doc(app_convex_schema, "files_pending_update_runs"),
			membershipId: v.id("organizations_workspaces_users"),
			page: v.array(
				v.object({
					item: doc(app_convex_schema, "files_pending_update_run_items"),
					proposal: doc(app_convex_schema, "files_pending_updates"),
				}),
			),
			isDone: v.boolean(),
			continueCursor: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const checked = await db_get_running_unit(ctx, args);
		if (checked._nay) return checked;
		const { run, membership } = checked._yay;
		const page = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_unit_order", (q) => q.eq("unitId", args.unitId))
			.paginate({ cursor: args.cursor, numItems: PLAN_PAGE_SIZE });
		const items = [];
		for (const item of page.page) {
			const valid = await db_validate_items(ctx, { ...run, items: [item] });
			if (valid._nay) return valid;
			items.push({ item, proposal: valid._yay[0]! });
		}
		return Result({
			_yay: {
				run,
				membershipId: membership._id,
				page: items,
				isDone: page.isDone,
				continueCursor: page.continueCursor,
			},
		});
	},
});

type get_unit_page_Result =
	typeof get_unit_page extends RegisteredQuery<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const attach_prepared_item = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
		itemId: v.id("files_pending_update_run_items"),
		prepared: files_pending_prepared_content_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const checked = await db_get_running_unit(ctx, args);
		if (checked._nay) return checked;
		const item = await ctx.db.get("files_pending_update_run_items", args.itemId);
		if (
			!item ||
			item.runId !== args.runId ||
			item.unitId !== args.unitId ||
			args.prepared.pendingUpdateId !== item.pendingUpdateId ||
			args.prepared.reviewedRevision !== item.reviewedRevision ||
			args.prepared.membershipId !== checked._yay.membership._id ||
			args.prepared.billedUserId !== item.billedUserId
		)
			return Result({ _nay: { name: "needs_review", message: "The reviewed change is no longer current." } });
		if (item.prepared) await files_pending_updates_db_retire_prepared_content(ctx, item.prepared);
		await ctx.db.patch("files_pending_update_run_items", item._id, { prepared: args.prepared });
		return Result({ _yay: null });
	},
});

type attach_prepared_item_Result =
	typeof attach_prepared_item extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const pin_item_payer = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
		itemId: v.id("files_pending_update_run_items"),
	},
	returns: v_result({ _yay: v.id("users") }),
	handler: async (ctx, args) => {
		const checked = await db_get_running_unit(ctx, args);
		if (checked._nay) return checked;
		const item = await ctx.db.get("files_pending_update_run_items", args.itemId);
		if (!item || item.runId !== args.runId || item.unitId !== args.unitId)
			return Result({ _nay: { name: "stopped", message: "This review item is no longer available." } });
		if (item.billedUserId) return Result({ _yay: item.billedUserId });
		const organization = await ctx.db.get("organizations", checked._yay.run.organizationId);
		if (!organization)
			return Result({ _nay: { name: "permission_denied", message: "This review is no longer available." } });
		const billedUserId = billing_pick_billed_user_id({ userId: checked._yay.run.userId, organization });
		await ctx.db.patch("files_pending_update_run_items", item._id, { billedUserId });
		return Result({ _yay: billedUserId });
	},
});

type pin_item_payer_Result =
	typeof pin_item_payer extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const refresh_prepared_batches = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
		cursor: v.union(v.string(), v.null()),
	},
	returns: v_result({ _yay: v.object({ isDone: v.boolean(), continueCursor: v.string() }) }),
	handler: async (ctx, args) => {
		const checked = await db_get_running_unit(ctx, args);
		if (checked._nay) return checked;
		const page = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_unit_order", (q) => q.eq("unitId", args.unitId))
			.paginate({ cursor: args.cursor, numItems: 32 });
		for (const item of page.page)
			for (const batchId of item.prepared?.operationBatchIds ?? []) {
				const batch = await ctx.db.get("files_pending_update_operation_batches", batchId);
				if (!batch || batch.expiresAt <= Date.now())
					return Result({
						_nay: { name: "preparation_expired", message: "A prepared change expired. Review it again." },
					});
				await ctx.db.patch("files_pending_update_operation_batches", batchId, { lastActivityAt: Date.now() });
			}
		return Result({ _yay: { isDone: page.isDone, continueCursor: page.continueCursor } });
	},
});

type refresh_prepared_batches_Result =
	typeof refresh_prepared_batches extends RegisteredMutation<infer _V, infer _A, infer R> ? Awaited<R> : never;

export const prepare_unit = internalAction({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		async function fail(error: { name?: string; message: string }, unreviewedIds: Id<"files_pending_updates">[] = []) {
			await ctx.runMutation(internal.files_pending_update_runs.fail_unit, {
				...args,
				code: error.name ?? "needs_review",
				message: error.message,
				unreviewedIds: unreviewedIds.slice(0, 20),
			});
		}

		try {
			const review = (await ctx.runMutation(
				internal.files_pending_update_runs.begin_unit_review,
				args,
			)) as begin_unit_review_Result;

			if (review._nay) {
				await fail(review._nay);
				return null;
			}

			if (review._yay.required) {
				const revalidation = {
					unitId: args.unitId,
					attemptFence: args.attemptFence,
					reviewVersion: review._yay.reviewVersion,
				};

				const reviewed: NonNullable<get_plan_selection_page_Result["_yay"]>["page"] = [];
				let kind: "accept" | "discard" = "accept";
				let cursor: string | null = null;

				while (true) {
					const page = (await ctx.runQuery(internal.files_pending_update_runs.get_plan_selection_page, {
						runId: args.runId,
						fence: args.fence,
						revalidation,
						cursor,
					})) as get_plan_selection_page_Result;
					if (page._nay) {
						await fail(page._nay);
						return null;
					}
					kind = page._yay.run.kind;
					reviewed.push(...page._yay.page);
					if (page._yay.isDone) break;
					cursor = page._yay.continueCursor;
				}

				// This graph contains only this unit. A new link to another unit needs a new review.
				const dependencies = build_review_dependencies(kind, reviewed);
				if (dependencies._nay) {
					await fail(dependencies._nay);
					return null;
				}

				if (dependencies._yay.scanRequired) {
					cursor = null;
					while (true) {
						const page = (await ctx.runQuery(internal.files_pending_update_runs.get_plan_proposals_page, {
							runId: args.runId,
							fence: args.fence,
							revalidation,
							cursor,
						})) as get_plan_proposals_page_Result;
						if (page._nay) {
							await fail(page._nay);
							return null;
						}
						const missing = dependencies._yay.unreviewed(page._yay.page);
						if (missing.length) {
							await fail(
								{ name: "needs_review", message: "This action also affects unselected changes. Review them together." },
								missing.map((context) => context.proposal._id),
							);
							return null;
						}
						if (page._yay.isDone) break;
						cursor = page._yay.continueCursor;
					}
				}

				const sealed = (await ctx.runMutation(internal.files_pending_update_runs.seal_unit_review, {
					runId: args.runId,
					fence: args.fence,
					...revalidation,
				})) as seal_unit_review_Result;
				if (sealed._nay) {
					await fail(sealed._nay);
					return null;
				}
			}

			const selected: NonNullable<get_unit_page_Result["_yay"]>["page"] = [];
			let cursor: string | null = null;
			let scope: Pick<NonNullable<get_unit_page_Result["_yay"]>, "run" | "membershipId"> | null = null;

			while (true) {
				const page = (await ctx.runQuery(internal.files_pending_update_runs.get_unit_page, {
					...args,
					cursor,
				})) as get_unit_page_Result;
				if (page._nay) {
					await fail(page._nay);
					return null;
				}
				scope = page._yay;
				selected.push(...page._yay.page);
				if (page._yay.isDone) break;
				cursor = page._yay.continueCursor;
			}

			if (!scope) return null;

			if (scope.run.kind === "accept") {
				const reviewedPrivateParentIds = selected.flatMap(({ proposal }) =>
					proposal.target.kind === "private" ? [proposal.target.id] : [],
				);
				const reviewedArchiveIds = selected.flatMap(({ proposal }) => (proposal.pendingArchive ? [proposal._id] : []));
				const replacedTargets = new Set(
					selected.flatMap(({ proposal }) =>
						proposal.pendingMove?.replacesTarget
							? [`${proposal.pendingMove.replacesTarget.kind}:${proposal.pendingMove.replacesTarget.id}`]
							: [],
					),
				);

				let lastRefreshAt = Date.now();
				for (const { item, proposal } of selected) {
					if (
						proposal.pendingArchive ||
						replacedTargets.has(`${proposal.target.kind}:${proposal.target.id}`) ||
						(proposal.target.kind === "saved" && !proposal.content && !proposal.pendingReplacement)
					)
						continue;
					// An expired attempt may have prepared bytes before losing its final response.
					if (item.prepared)
						await ctx.runMutation(internal.files_pending_updates.retire_prepared_content, { prepared: item.prepared });

					const payer = (await ctx.runMutation(internal.files_pending_update_runs.pin_item_payer, {
						...args,
						itemId: item._id,
					})) as pin_item_payer_Result;
					if (payer._nay) {
						await fail(payer._nay);
						return null;
					}

					const prepared = await files_pending_updates_action_prepare_content(ctx, {
						userId: scope.run.userId,
						membershipId: scope.membershipId,
						target: proposal.target,
						pendingUpdateId: item.pendingUpdateId,
						reviewedRevision: item.reviewedRevision,
						selectedContentStateId: item.selectedContentStateId,
						reviewedPrivateParentIds,
						reviewedArchiveIds,
						billedUserId: payer._yay,
					});
					if (prepared._nay) {
						await fail(prepared._nay);
						return null;
					}

					let attached = false;
					try {
						const result = (await ctx.runMutation(internal.files_pending_update_runs.attach_prepared_item, {
							...args,
							itemId: item._id,
							prepared: prepared._yay,
						})) as attach_prepared_item_Result;
						if (result._nay) {
							await fail(result._nay);
							return null;
						}
						attached = true;
					} finally {
						if (!attached)
							await ctx.runMutation(internal.files_pending_updates.retire_prepared_content, {
								prepared: prepared._yay,
							});
					}

					if (Date.now() - lastRefreshAt >= 30_000) {
						cursor = null;
						while (true) {
							const refreshed = (await ctx.runMutation(internal.files_pending_update_runs.refresh_prepared_batches, {
								...args,
								cursor,
							})) as refresh_prepared_batches_Result;
							if (refreshed._nay) {
								await fail(refreshed._nay);
								return null;
							}
							if (refreshed._yay.isDone) break;
							cursor = refreshed._yay.continueCursor;
						}
						lastRefreshAt = Date.now();
					}
				}
			}

			await ctx.runMutation(internal.files_pending_update_runs.commit_unit, args);
		} catch (error) {
			const detail = z
				.object({ message: z.string(), data: z.object({ code: z.string() }) })
				.safeParse(error instanceof ConvexError ? error.data : null);
			if (detail.success) await fail({ name: detail.data.data.code, message: detail.data.message });
			else {
				console.error("Review unit failed", { unitId: args.unitId, error });
				await fail({
					name: "unexpected_error",
					message: "This review could not finish. The remaining changes are still pending.",
				});
			}
		}
		return null;
	},
});

export const commit_unit = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
	},
	returns: v.null(),
	handler: async (originalCtx, args) => {
		const ctx = db_with_unit_budget(originalCtx);
		const checked = await db_get_running_unit(ctx, args);
		if (checked._nay) refuse_unit(checked._nay.name, checked._nay.message);
		const { run, unit, membership } = checked._yay;
		if (unit.validatedReviewVersion === null || (await db_get_review_version(ctx, run)) !== unit.validatedReviewVersion)
			refuse_unit("review_changed", "Pending changes changed during this check. Trying the same selection again.");

		const itemQuery = ctx.db.query("files_pending_update_run_items");
		// Large private Discard was checked in pages. The unchanged owner clock protects that set.
		const items =
			run.kind === "discard" && unit.privateDiscardRoots.length
				? await itemQuery
						.withIndex("by_unit_targetKind_order", (q) => q.eq("unitId", unit._id).eq("target.kind", "saved"))
						.collect()
				: await itemQuery.withIndex("by_unit_order", (q) => q.eq("unitId", unit._id)).collect();

		const selected = [];
		for (const item of items) {
			const valid = await db_validate_items(ctx, { ...run, items: [item] });
			if (valid._nay) refuse_unit(valid._nay.name, valid._nay.message);
			const proposal = valid._yay[0]!;
			const context = run.kind === "accept" ? await db_get_plan_context(ctx, proposal) : null;
			if (
				context &&
				(context.path !== item.expectedPath || context.destinationParentPath !== item.expectedDestinationParentPath)
			)
				refuse_unit("needs_review", "A reviewed source or destination moved. Review it again.");
			selected.push({ item, proposal, context });
		}

		if (run.kind === "discard") {
			for (const root of unit.privateDiscardRoots) {
				const node = await ctx.db.get("files_pending_nodes", root.privateNodeId);
				const proposal = await ctx.db.get("files_pending_updates", root.pendingUpdateId);
				if (
					!node ||
					node.userId !== run.userId ||
					node.organizationId !== run.organizationId ||
					node.workspaceId !== run.workspaceId ||
					node.state !== "active" ||
					node.creationGeneration !== root.creationGeneration ||
					node.structuralRevision !== root.structuralRevision ||
					!proposal ||
					proposal.revision !== root.reviewedRevision ||
					proposal.target.kind !== "private" ||
					proposal.target.id !== node._id
				)
					refuse_unit("needs_review", "A reviewed draft changed. Review it again.");
				await files_pending_nodes_db_fence_discard(ctx, node);
				const cleanupTaskId = await ctx.db.insert("files_pending_node_cleanup_tasks", {
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					userId: run.userId,
					privateNodeId: node._id,
					nextAttemptAt: Date.now(),
				});
				await ctx.scheduler.runAfter(0, internal.files_pending_nodes.cleanup_discarded_node, { cleanupTaskId });
			}

			for (const { proposal } of selected) {
				if (proposal.target.kind !== "saved") refuse_unit("needs_review", "This draft needs a new review.");
				await files_pending_updates_db_discard_saved(ctx, proposal);
			}
		} else {
			const moves = selected.filter(
				({ proposal }) => proposal.target.kind === "saved" && proposal.pendingMove && !proposal.pendingArchive,
			);
			const moveIds = new Set(moves.map(({ proposal }) => proposal.target.id));
			const reviewedPendingUpdateIds = new Set(selected.map(({ proposal }) => proposal._id));
			const replacedIds = new Set(
				selected.flatMap(({ proposal }) =>
					!proposal.pendingArchive && proposal.pendingMove?.replacesTarget?.kind === "saved"
						? [proposal.pendingMove.replacesTarget.id]
						: [],
				),
			);

			if ([...replacedIds].some((id) => moveIds.has(id)))
				refuse_unit("needs_review", "The item being replaced changed. Review it again.");

			const contentItems = selected.filter(
				({ proposal }) =>
					!proposal.pendingArchive &&
					proposal.createIntent?.kind !== "folder" &&
					!(proposal.target.kind === "saved" && replacedIds.has(proposal.target.id)) &&
					(proposal.content || proposal.pendingReplacement || proposal.target.kind === "private"),
			);

			// Signed-in events do not debit the local meter. Check this unit's full cost before any write.
			const costByPayer = new Map<Id<"users">, number>();
			for (const { item } of contentItems) {
				const prepared = item.prepared;
				if (!prepared) refuse_unit("preparing", "A reviewed file is still preparing.");
				if (
					(prepared.kind === "saved_yjs" && !prepared.trustedStageId) ||
					(prepared.kind === "saved_asset" && !prepared.publish)
				)
					continue;
				costByPayer.set(prepared.billedUserId, (costByPayer.get(prepared.billedUserId) ?? 0) + 1);
			}

			for (const [userId, minimumRequiredCents] of costByPayer) {
				const credits = await billing_db_check_credits(ctx, { userId, minimumRequiredCents });
				if (!credits.hasCredits) refuse_unit("insufficient_funds", "Insufficient funds");
			}

			const sources = new Map<Id<"files_nodes">, Doc<"files_nodes">>();
			// Bind every original saved destination before parking names or publishing private folders.
			for (const { proposal } of moves) {
				if (proposal.target.kind !== "saved") continue;
				const node = await ctx.db.get("files_nodes", proposal.target.id);
				if (!node || node.archiveOperationId !== null)
					refuse_unit("needs_review", "A moved item is no longer available.");
				sources.set(node._id, node);
				const move = proposal.pendingMove!;
				const destParent = move.destParent;
				const parent = await files_pending_nodes_db_resolve_saved_parent(ctx, { ...run, parent: move.destParent });
				if (parent._nay) {
					if (
						destParent.kind !== "private" ||
						!selected.some(
							({ proposal: candidate }) =>
								candidate.target.kind === "private" &&
								candidate.target.id === destParent.id &&
								candidate.createIntent?.kind === "folder",
						)
					)
						refuse_unit("needs_review", "Review the destination folder with this move.");
					if (move.replacesTarget) refuse_unit("needs_review", "The move destination changed. Review it again.");
					continue;
				}
				const occupant = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId)
							.eq("parentId", parent._yay.parentId)
							.eq("name", move.destName)
							.eq("archiveOperationId", null),
					)
					.first();
				if (move.replacesTarget) {
					if (
						move.replacesTarget.kind !== "saved" ||
						occupant?._id !== move.replacesTarget.id ||
						moveIds.has(occupant._id)
					)
						refuse_unit("needs_review", "The item being replaced changed. Review it again.");
				} else if (occupant && !moveIds.has(occupant._id))
					refuse_unit("needs_review", "The move destination is now occupied. Review it again.");
			}

			// Parking is invisible outside this transaction. It lets new folders reuse vacated names.
			for (const node of sources.values()) {
				const name = `.review-${unit._id}-${node._id}`;
				const occupied = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId)
							.eq("parentId", node.parentId)
							.eq("name", name)
							.eq("archiveOperationId", null),
					)
					.first();
				if (occupied) refuse_unit("needs_review", "A move needs a new review before it can finish.");
				await ctx.db.patch("files_nodes", node._id, { name });
			}

			const privateFolders = selected
				.filter(({ proposal }) => proposal.target.kind === "private" && proposal.createIntent?.kind === "folder")
				.sort((a, b) => a.context!.privateAncestorIds.length - b.context!.privateAncestorIds.length);
			for (const { item } of privateFolders) {
				if (!item.prepared) refuse_unit("preparing", "A reviewed folder is still preparing.");
				const saved = await files_pending_updates_db_commit_prepared_content(ctx, {
					userId: run.userId,
					prepared: item.prepared,
					reviewedPendingUpdateIds,
				});
				if (saved._nay) refuse_unit(saved._nay.name ?? "needs_review", saved._nay.message);
			}

			if (moves.length) {
				const intents: Parameters<typeof files_nodes_db_preflight_move>[1]["intents"] = [];
				for (const { proposal } of moves) {
					if (proposal.target.kind !== "saved") continue;
					const move = proposal.pendingMove!;
					const node = await ctx.db.get("files_nodes", proposal.target.id);
					const destination = await files_pending_nodes_db_resolve_saved_parent(ctx, {
						...run,
						parent: move.destParent,
					});
					if (!node || destination._nay) refuse_unit("needs_review", "A move destination is no longer available.");
					const parentId = destination._yay.parentId;
					const parent = parentId === "root" ? null : await ctx.db.get("files_nodes", parentId);
					intents.push({
						nodeId: node._id,
						expected: node,
						destination: {
							parentId,
							name: move.destName,
							expectedParentPath: parent?.path ?? "/",
							expectedParentArchiveOperationId: null,
						},
						occupant:
							move.replacesTarget?.kind === "saved"
								? {
										kind: "replace",
										nodeId: move.replacesTarget.id,
										contentVersion: move.replacesContentVersion ?? null,
									}
								: { kind: "empty" },
					});
				}

				const planned = await files_nodes_db_preflight_move(ctx, {
					userAuth: { id: run.userId },
					membership,
					writer: { kind: "user", userId: run.userId },
					policyReach: "ancestors",
					intents,
				});
				if (planned._nay) refuse_unit(planned._nay.name ?? "needs_review", planned._nay.message);

				for (const archivedNodeId of planned._yay.archivedNodeIds) {
					const privateChild = await ctx.db
						.query("files_pending_nodes")
						.withIndex("by_organization_workspace_user_parent_state_name", (q) =>
							q
								.eq("organizationId", run.organizationId)
								.eq("workspaceId", run.workspaceId)
								.eq("userId", run.userId)
								.eq("parent.kind", "saved")
								.eq("parent.id", archivedNodeId)
								.eq("state", "active"),
						)
						.first();
					if (privateChild)
						refuse_unit("needs_review", "The destination folder has private child changes. Review them first.");
				}

				await files_nodes_db_apply_move(ctx, planned._yay);
			}

			for (const { item } of contentItems) {
				const saved = await files_pending_updates_db_commit_prepared_content(ctx, {
					userId: run.userId,
					prepared: item.prepared!,
					reviewedPendingUpdateIds,
				});
				if (saved._nay) refuse_unit(saved._nay.name ?? "needs_review", saved._nay.message);
			}

			for (const { proposal } of moves) {
				const current = await ctx.db.get("files_pending_updates", proposal._id);
				if (current?.pendingMove) await files_pending_update_db_settle_move_row(ctx, { pendingUpdate: current });
			}

			for (const nodeId of replacedIds) {
				const proposal = await files_db_get_pending_update(ctx, { ...run, target: { kind: "saved", id: nodeId } });
				if (proposal) {
					await files_pending_updates_db_discard_saved(ctx, proposal);
				}
			}

			// Archive last, after all reviewed child content and moves have committed in this transaction.
			for (const { proposal } of selected.filter(({ proposal }) => proposal.pendingArchive)) {
				const current = await ctx.db.get("files_pending_updates", proposal._id);
				if (!current?.pendingArchive) continue;
				const archived = await files_pending_updates_db_apply_archive(ctx, {
					userAuth: { id: run.userId },
					membership,
					pendingUpdate: current,
					reviewedPendingUpdateIds,
				});
				if (archived._nay) refuse_unit(archived._nay.name ?? "needs_review", archived._nay.message);
			}
		}

		await db_finish_unit(ctx, { run, unit, status: "completed" });
		return null;
	},
});

export const fail_unit = internalMutation({
	args: {
		runId: v.id("files_pending_update_runs"),
		fence: v.number(),
		unitId: v.id("files_pending_update_run_units"),
		attemptFence: v.number(),
		code: v.string(),
		message: v.string(),
		unreviewedIds: v.optional(v.array(v.id("files_pending_updates"))),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_pending_update_runs", args.runId);
		const unit = await ctx.db.get("files_pending_update_run_units", args.unitId);

		if (
			!run ||
			run.step !== "running" ||
			run.fence !== args.fence ||
			!unit ||
			unit.runId !== run._id ||
			unit.status !== "preparing" ||
			unit.attemptFence !== args.attemptFence
		)
			return null;

		// A late action and the watchdog must use the same retry and timeout rules.
		if (unit.attemptDeadlineAt !== null && unit.attemptDeadlineAt <= Date.now()) {
			await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.advance, { runId: run._id });
			return null;
		}

		if (args.unreviewedIds?.length)
			await ctx.db.patch("files_pending_update_runs", run._id, {
				needsReviewIds: [...new Set([...run.needsReviewIds, ...args.unreviewedIds])].slice(0, 20),
			});

		if (
			(args.code === "rate_limited" || args.code === "temporary_failure" || args.code === "review_changed") &&
			unit.attemptCount < MAX_ATTEMPTS
		) {
			if (unit.workId) await files_review_workpool.cancel(ctx, unit.workId);
			await ctx.db.patch("files_pending_update_run_units", unit._id, {
				status: "queued",
				workId: null,
				attemptFence: unit.attemptFence + 1,
				attemptDeadlineAt: null,
			});
			await ctx.scheduler.runAfter(unit.attemptCount * 5_000, internal.files_pending_update_runs.advance, {
				runId: run._id,
			});
			return null;
		}

		await db_finish_unit(ctx, {
			run,
			unit,
			status: args.code === "unexpected_error" ? "failed" : "blocked",
			code: args.code === "review_changed" ? "needs_review" : args.code,
			message:
				args.code === "review_changed"
					? "Pending changes kept changing. Review the remaining changes again."
					: args.message,
		});
		return null;
	},
});

export const retire_unit_preparation = internalMutation({
	args: { unitId: v.id("files_pending_update_run_units"), cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const unit = await ctx.db.get("files_pending_update_run_units", args.unitId);
		if (!unit || unit.status === "preparing" || unit.status === "queued") return null;
		const page = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_unit_order", (q) => q.eq("unitId", unit._id))
			.paginate({ cursor: args.cursor ?? null, numItems: 8 });
		for (const item of page.page)
			if (item.prepared) {
				await files_pending_updates_db_retire_prepared_content(ctx, item.prepared);
				await ctx.db.patch("files_pending_update_run_items", item._id, { prepared: null });
			}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.retire_unit_preparation, {
				unitId: unit._id,
				cursor: page.continueCursor,
			});
		return null;
	},
});

export const retire_run_preparation = internalMutation({
	args: { runId: v.id("files_pending_update_runs"), cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_pending_update_runs", args.runId);
		if (!run || run.step !== "finished") return null;
		const page = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_run_order", (q) => q.eq("runId", run._id))
			.paginate({ cursor: args.cursor, numItems: 8 });
		for (const item of page.page)
			if (item.prepared) {
				await files_pending_updates_db_retire_prepared_content(ctx, item.prepared);
				await ctx.db.patch("files_pending_update_run_items", item._id, { prepared: null });
			}
		if (!page.isDone)
			await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.retire_run_preparation, {
				runId: run._id,
				cursor: page.continueCursor,
			});
		return null;
	},
});

export async function files_pending_update_runs_db_delete_run_batch(
	ctx: MutationCtx,
	args: { runId: Id<"files_pending_update_runs">; batchSize?: number },
) {
	const run = await ctx.db.get("files_pending_update_runs", args.runId);
	if (!run) return { done: true, deletedCount: 0 };
	if (run.step !== "finished")
		await files_pending_update_runs_db_request_stop(ctx, { runId: run._id, reason: "permission", now: Date.now() });
	const batchSize = Math.max(1, Math.min(args.batchSize ?? 8, 8));
	const items = await ctx.db
		.query("files_pending_update_run_items")
		.withIndex("by_run_order", (q) => q.eq("runId", run._id))
		.take(batchSize);
	for (const item of items) {
		if (item.prepared) await files_pending_updates_db_retire_prepared_content(ctx, item.prepared);
		await ctx.db.delete("files_pending_update_run_items", item._id);
	}
	if (items.length) return { done: false, deletedCount: items.length };
	const units = await ctx.db
		.query("files_pending_update_run_units")
		.withIndex("by_run_order", (q) => q.eq("runId", run._id))
		.take(batchSize);
	for (const unit of units) await ctx.db.delete("files_pending_update_run_units", unit._id);
	if (units.length) return { done: false, deletedCount: units.length };
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	const removed = await activities_db_delete(ctx, activity._id);
	if (!removed.done) return removed;
	await ctx.db.delete("files_pending_update_runs", run._id);
	return { done: true, deletedCount: removed.deletedCount + 1 };
}

export const recover = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		for (const step of ["uploading", "planning", "running"] as const) {
			const runs = await ctx.db
				.query("files_pending_update_runs")
				.withIndex("by_step_updatedAt", (q) => q.eq("step", step).lte("updatedAt", now - ATTEMPT_TIMEOUT_MS))
				.take(32);
			for (const run of runs) {
				const activity = await activities_db_require_by_source_id(ctx, run._id);
				if (activity.deadlineAt <= now || !(await db_get_run_membership(ctx, run))) {
					await files_pending_update_runs_db_request_stop(ctx, {
						runId: run._id,
						reason: activity.deadlineAt <= now ? "timeout" : "permission",
						now,
					});
				} else if (step === "planning") {
					if (run.planningAttempts < MAX_ATTEMPTS) {
						await ctx.db.patch("files_pending_update_runs", run._id, {
							fence: run.fence + 1,
							planningAttempts: run.planningAttempts + 1,
							updatedAt: now,
						});
						await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.plan, {
							runId: run._id,
							fence: run.fence + 1,
						});
					} else
						await ctx.runMutation(internal.files_pending_update_runs.fail_plan, {
							runId: run._id,
							fence: run.fence,
							code: "attempt_expired",
							message: "Review planning did not finish. Start a new review.",
							unreviewedIds: [],
						});
				} else if (step === "running")
					await ctx.scheduler.runAfter(0, internal.files_pending_update_runs.advance, { runId: run._id });
			}
		}
		return null;
	},
});

export const get = query({
	args: { membershipId: v.id("organizations_workspaces_users"), runId: v.id("files_pending_update_runs") },
	returns: v.union(
		v.object({
			run: doc(app_convex_schema, "files_pending_update_runs"),
			activity: doc(app_convex_schema, "activities"),
			controls: v.object({ canStop: v.boolean(), canRetry: v.boolean(), canDismiss: v.boolean() }),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return null;
		const activity = await activities_db_require_by_source_id(ctx, owned._yay.run._id);
		return { run: owned._yay.run, activity, controls: activities_get_controls(activity, owned._yay.run.userId) };
	},
});

export const list_items = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_pending_update_runs"),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			pendingUpdateId: v.id("files_pending_updates"),
			target: files_pending_target_validator,
			order: v.number(),
			status: v.union(
				v.literal("queued"),
				v.literal("running"),
				v.literal("completed"),
				v.literal("needs_review"),
				v.literal("failed"),
				v.literal("canceled"),
			),
			message: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return { page: [], isDone: true, continueCursor: "" };
		const activity = await activities_db_require_by_source_id(ctx, args.runId);
		const items = await ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_run_order", (q) => q.eq("runId", args.runId))
			.paginate({ ...args.paginationOpts, numItems: Math.min(SELECTION_PAGE_SIZE, args.paginationOpts.numItems) });
		const page = [];
		for (const item of items.page) {
			const unit = item.unitId ? await ctx.db.get("files_pending_update_run_units", item.unitId) : null;
			let status: "queued" | "running" | "completed" | "needs_review" | "failed" | "canceled" =
				unit?.status === "preparing"
					? "running"
					: unit?.status === "blocked"
						? "needs_review"
						: (unit?.status ?? "queued");
			let message = unit?.errorMessage ?? undefined;
			if ((status === "queued" || status === "running") && owned._yay.run.step === "finished") {
				status = activity.status === "canceled" || activity.status === "timed_out" ? "canceled" : "needs_review";
				message = activity.errorMessage ?? undefined;
			}
			page.push({ pendingUpdateId: item.pendingUpdateId, target: item.target, order: item.order, status, message });
		}
		return { ...items, page };
	},
});
