// Archive and restore of a big folder do not fit in one mutation. This job changes a batch of nodes
// per step. Each node's side docs (text chunks, metadata docs) change in the same step as the node,
// so search and lists never see a node and its side docs disagree. A small request finishes inside
// the request and writes no run, no op, and no Activity, unless the archive refused a named item.
//
// The job is the archive or restore kind of a `files_subtree_ops` op, and it walks by `parentId`
// through that op's queue. Archive first checks every node inside and writes nothing. A refusal leaves
// out only the named item it is in, with everything inside it. Then the archive stamps every named item
// that passed, then the active children of each stamped folder, the first named item's folder
// first. A child that somebody moved out, or archived on their own, is not reached or keeps its own
// stamp. Restore finds the top items of the operation one page at a time, lands each one, then
// restores the items of the operation inside it. The other items inside get the new path and scope
// and keep their own stamp.
//
// Archive cannot be stopped. Restore can be stopped only while it waits for a clash choice.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { WithoutSystemFields } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { mutation } from "./functions.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import {
	activities_db_delete,
	activities_db_finish,
	activities_db_require_by_source_id,
	activities_db_start,
	activities_get_controls,
	activities_get_result_status,
} from "./activities_db.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import {
	authorize_file_write,
	authorize_leaving_restricted_scope,
	files_nodes_db_archive_node,
	files_nodes_db_rebuild_node,
	files_nodes_db_require_swept_nodes_writable,
	files_nodes_db_require_user_writable,
	files_nodes_db_restore_node,
} from "./files_nodes.ts";
import {
	files_pending_updates_db_remove_archived_node_proposal,
	files_pending_updates_db_require_reviewed_archive_node,
} from "./files_pending_updates.ts";
import {
	files_share_links_create_cleanup_state,
	files_share_links_db_delete_for_roots,
	type files_share_links_CleanupState,
} from "./files_share_links_db.ts";
import {
	files_subtree_ops_db_delete,
	files_subtree_ops_db_enqueue_nodes,
	files_subtree_ops_db_find_blocker,
	files_subtree_ops_db_first_node,
	files_subtree_ops_db_insert,
	files_subtree_ops_db_insert_node,
	files_subtree_ops_db_is_near_limits,
	files_subtree_ops_db_next_children,
	files_subtree_ops_db_pause_for_move,
	files_subtree_ops_db_recover,
	files_subtree_ops_db_reserve_sequences,
	files_subtree_ops_db_run,
	files_subtree_ops_db_save_page,
	files_subtree_ops_db_schedule_step,
} from "./files_subtree_ops.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_db_get_pending_update, files_ROOT_ID } from "../server/files.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * An apply step ends after this many nodes. On dev, one archived node costs about 8.5 ms of
 * database time and one restored node about 16 ms, so a step stays near 1 to 3 seconds.
 */
export const files_archive_runs_STEP_MAX_NODES = 75;

/**
 * A check step reads at most this many nodes. It writes nothing, so it can read more than an apply step.
 */
const CHECK_STEP_MAX_NODES = 500;

const PAGE_SIZE = 50;

/**
 * A running job moves its deadline with every step. The recover cron schedules a job again when
 * the deadline passed, so a step that threw does not stop the job.
 */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * A restore that waits for a name clash choice waits as long as a paste does. It writes nothing meanwhile.
 */
const CHOICE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Restore puts at most this many items at the workspace root. They are items the archive named, so
 * a normal operation has far fewer.
 */
const MAX_ROOT_LANDINGS = 500;

/**
 * A restore marks at most this many paths busy. Every op check reads each of them.
 */
const MAX_DISCOVER_TREE_PATHS = 64;

/**
 * Keep both tries `name-2`, `name-3`, and so on up to this counter.
 */
const MAX_NAME_ATTEMPTS = 100;

type RunFields = WithoutSystemFields<Doc<"files_archive_runs">>;
type RunProgress = NonNullable<Doc<"activities">["progress"]>;

type StepArgs = {
	opId: Id<"files_subtree_ops">;
	/**
	 * A copy of the run that the step changes. The caller saves it.
	 */
	run: RunFields;
	progress: RunProgress;
	userAuth: { id: Id<"users"> };
	/**
	 * Null when the requester left the workspace. The archive stamp walk goes on without them. The
	 * checks and a restore stop.
	 */
	membership: Doc<"organizations_workspaces_users"> | null;
	now: number;
	/**
	 * How many more nodes this mutation may change. A restore of several operations shares one budget
	 * across them, so one request cannot run past the mutation time limit. `hasPaginated` turns true after
	 * this mutation's one paginated read. Convex allows only one, so a later read that needs one ends the step.
	 */
	budget: { nodes: number; hasPaginated: boolean };
	/**
	 * The restricted scopes already checked in this step. The key "" stands for no scope.
	 */
	checkedScopes: Map<string, boolean>;
	/**
	 * Public link cleanup for this mutation. A pending Save passes its own, so its archive shares one
	 * link load with the moves before it. A scheduled step makes a new one.
	 */
	shareLinkCleanup: files_share_links_CleanupState;
	/**
	 * Turns true when this step changes a node. Helpers get a copy of these args, so this stays an object
	 * that every copy shares. A plain boolean set on a copy would never reach `db_step`.
	 */
	writeState: { isWritten: boolean };
};

type StepOutcome =
	| { kind: "continue" }
	| { kind: "blocked" }
	| { kind: "done" }
	| { kind: "paused" }
	| { kind: "failed"; nay: { name?: string; message: string } };

const MEMBERSHIP_LOST = {
	kind: "failed",
	nay: { message: "You can no longer change these files." },
} as const satisfies StepOutcome;

async function db_require_activity(ctx: QueryCtx | MutationCtx, runId: Id<"files_archive_runs">) {
	const activity = await activities_db_require_by_source_id(ctx, runId);
	if (!activity.progress || !activity.membershipId || activity.membershipLifetime === undefined) {
		const errorMessage = "Archive activity is missing progress or membership";
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

async function db_require_op(ctx: QueryCtx | MutationCtx, runId: Id<"files_archive_runs">) {
	const op = await ctx.db
		.query("files_subtree_ops")
		.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
		.unique();
	if (!op) {
		const errorMessage = "Active archive run has no subtree op";
		const errorData = { runId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return op;
}

/**
 * Recheck the membership the job started with. A leave and re-join gives a new lifetime, so it stops
 * the job even though the person is a member again.
 */
async function db_get_run_membership(args: {
	ctx: QueryCtx | MutationCtx;
	run: Doc<"files_archive_runs">;
	activity: Awaited<ReturnType<typeof db_require_activity>>;
}) {
	const { ctx, run, activity } = args;

	const user = await ctx.db.get("users", run.userId);
	if (!user || user.deletedAt !== undefined) return null;

	const workspace = await ctx.db.get("organizations_workspaces", run.workspaceId);
	if (!workspace || workspace.organizationId !== run.organizationId || workspace.pluginDataPurgeStartedAt !== undefined)
		return null;

	const lifetime = await organizations_membership_lifetimes_db_get(ctx, {
		workspaceId: run.workspaceId,
		userId: run.userId,
	});
	if (
		!lifetime?.active ||
		lifetime.membershipId !== activity.membershipId ||
		lifetime.lifetime !== activity.membershipLifetime
	)
		return null;

	return await organizations_db_get_membership(ctx, { userId: run.userId, membershipId: activity.membershipId });
}

async function db_get_owned_run(
	ctx: QueryCtx | MutationCtx,
	args: { membershipId: Id<"organizations_workspaces_users">; runId: Id<"files_archive_runs"> },
) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
	const run = await ctx.db.get("files_archive_runs", args.runId);
	if (!run || run.userId !== userAuth.id) return Result({ _nay: { message: "Not found" } });
	const activity = await db_require_activity(ctx, run._id);
	const membership = await db_get_run_membership({ ctx, run, activity });
	if (!membership || membership._id !== args.membershipId) return Result({ _nay: { message: "Not found" } });
	return Result({ _yay: { userAuth, run, activity, membership } });
}

/**
 * The person must still write each node the job changes: the node's own lock, and write access
 * where it lives. Access is asked once per restricted scope, and once for the unrestricted part of
 * the workspace, so an ordinary tree costs one check per step.
 */
async function db_check_writable_nodes(
	args: StepArgs & {
		ctx: MutationCtx;
		nodes: readonly Doc<"files_nodes">[];
	},
) {
	const { ctx, nodes } = args;

	const membership = args.membership;
	if (!membership) return MEMBERSHIP_LOST;

	for (const node of nodes) {
		const scopeKey = node.restrictedScopeNodeId ?? "";
		let allowed = args.checkedScopes.get(scopeKey);
		if (allowed === undefined) {
			const authorized = await access_control_db_authorize_membership(ctx, {
				userAuth: args.userAuth,
				membership,
				permission: "content.write",
				fileNode: node,
			});
			allowed = !authorized._nay;
			args.checkedScopes.set(scopeKey, allowed);
		}
		if (!allowed) return { kind: "failed", nay: { message: "Permission denied" } } as const;

		const writable = await files_nodes_db_require_user_writable(ctx, { node, userId: args.userAuth.id });
		if (writable._nay) return { kind: "failed", nay: writable._nay } as const;

		if (args.run.pendingUpdateCleanup?.reviewedPendingUpdateIds) {
			const reviewed = await files_pending_updates_db_require_reviewed_archive_node(ctx, {
				organizationId: args.run.organizationId,
				workspaceId: args.run.workspaceId,
				userId: args.userAuth.id,
				nodeId: node._id,
				reviewedPendingUpdateIds: args.run.pendingUpdateCleanup.reviewedPendingUpdateIds,
			});
			if (reviewed._nay) return { kind: "failed", nay: reviewed._nay } as const;
		}
	}
	return null;
}

/**
 * A restore changes the folder an item leaves and the folder it lands in, like a move. So both
 * folders must not be read-only. Name the folder only for somebody who may read it.
 */
async function db_check_restore_folder(
	args: StepArgs & {
		ctx: MutationCtx;
		folder: Doc<"files_nodes">;
	},
) {
	const { ctx, folder } = args;

	const membership = args.membership;
	if (!membership) return MEMBERSHIP_LOST;

	const writable = await files_nodes_db_require_user_writable(ctx, { node: folder, userId: args.userAuth.id });
	if (!writable._nay) return null;

	const readable = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership,
		permission: "content.read",
		fileNode: folder,
	});
	return {
		kind: "failed",
		nay: readable._nay
			? { message: "Permission denied" }
			: {
					name: "read_only",
					message: `The folder "${folder.path}" is read-only. Unlock it before you restore items into it or out of it.`,
				},
	} as const;
}

/**
 * Landing somewhere new is a move. It needs write access where the item lands and permission to
 * leave the item's restricted folder, like Move. An item that is its own restricted folder
 * keeps its scope wherever it lands, so it needs neither.
 */
async function db_check_restore_move(
	args: StepArgs & {
		ctx: MutationCtx;
		node: Doc<"files_nodes">;
	},
) {
	const { ctx, node } = args;

	const membership = args.membership;
	if (!membership) return MEMBERSHIP_LOST;
	if (node.restrictedScopeNodeId === node._id) return null;

	const authorizedTarget = await authorize_file_write(ctx, {
		userAuth: args.userAuth,
		membership,
		nodeId: files_ROOT_ID,
	});
	if (authorizedTarget._nay) return { kind: "failed", nay: authorizedTarget._nay } as const;

	const authorizedLeaving = await authorize_leaving_restricted_scope(ctx, {
		userAuth: args.userAuth,
		membership,
		fileNode: node,
		destParentId: files_ROOT_ID,
	});
	if (authorizedLeaving._nay) return { kind: "failed", nay: authorizedLeaving._nay } as const;

	return null;
}

/**
 * Leave out the named item the check is on, with everything inside it. It counts once, as blocked,
 * so the counts still add up to the total. Nothing inside it counts.
 */
function refuse_named_item(args: StepArgs, refusal: RunFields["refusedItems"][number]["refusal"]) {
	const namedItem = args.run.checkNamedItem;
	if (!namedItem) {
		const errorMessage = "Archive check refused a node before any named item started";
		const errorData = { opId: args.opId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	args.run.checkNamedItem = { ...namedItem, isRefused: true };
	args.run.refusedItems = [...args.run.refusedItems, { nodeId: namedItem.nodeId, refusal }];
	args.progress.discovered = namedItem.discoveredBefore + 1;
	args.progress.blocked += 1;
}

/**
 * The reason saved for a refused named item. When the refused node is inside the named folder, the
 * node's own message would blame the folder. So say that an item inside it is refused.
 */
function get_named_item_refusal(nay: { name?: string; message: string }, isInside: boolean) {
	const name = nay.name ?? null;
	// A review refusal of an agent's delete asks for a new review. That message fits an item inside too.
	if (!isInside || name === "needs_review") return { name, message: nay.message };
	return {
		name,
		message: name === "read_only" ? "An item inside it is read-only." : "You cannot change an item inside it.",
	};
}

/**
 * Check everything the archive will change before it writes anything: each active node, and each
 * archived node inside, which must not be hidden while it is read-only. The walk follows `parentId`
 * from each named item. Nothing is written, so a folder needs no second pass.
 *
 * A refusal leaves out only the named item it is in, with everything inside that item, like `rm` with
 * several files. The other named items are still archived. An agent's delete names one item, so the
 * same rule refuses the whole delete. Only a lost membership ends the job at once.
 */
async function db_check_archive(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	// Check once per step, before anything else. A step can finish the check without a write check,
	// for example when it only drops the rows of a refused item. The apply must not run for somebody
	// who left.
	if (!args.membership) return MEMBERSHIP_LOST;

	const namedCount = run.rootNodeIds.length;
	let readCount = 0;

	while (true) {
		if (readCount >= CHECK_STEP_MAX_NODES || (await files_subtree_ops_db_is_near_limits(ctx))) {
			return { kind: "continue" };
		}

		const row = await files_subtree_ops_db_first_node(ctx, args.opId);
		if (!row) break;

		// Named item k has row number `namedCount - 1 - k`. Every folder the walk finds gets a higher
		// number, and the highest number runs first. So a row at `namedCount` or above is always inside
		// the named item the check is on. Drop the rows of a refused item without checking them.
		if (run.checkNamedItem?.isRefused && (row.sequence >= namedCount || row.nodeId === run.checkNamedItem.nodeId)) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
			readCount += 1;
			continue;
		}

		const node = await ctx.db.get("files_nodes", row.nodeId);
		// Only a named item's row starts with `nodeDone` false.
		if (!row.nodeDone) {
			readCount += 1;
			run.checkNamedItem = { nodeId: row.nodeId, discoveredBefore: progress.discovered, isRefused: false };
			// A named item that is gone by now is refused, like a missing file in `rm`.
			if (!node) {
				await ctx.db.delete("files_subtree_op_nodes", row._id);
				refuse_named_item(args, { name: null, message: "Not found" });
				continue;
			}
			// One that somebody archived meanwhile keeps that archive with everything inside, and is no
			// error, like a missing file in `rm -f`. It counts once, and the apply counts it as skipped.
			if (node.archiveOperationId !== null) {
				await ctx.db.delete("files_subtree_op_nodes", row._id);
				progress.discovered += 1;
				continue;
			}

			const refusal = await db_check_writable_nodes({ ctx, ...args, nodes: [node] });
			if (refusal) {
				if (refusal === MEMBERSHIP_LOST) return refusal;
				refuse_named_item(args, get_named_item_refusal(refusal.nay, false));
				continue;
			}
			progress.discovered += 1;
			if (node.kind === "file") {
				await ctx.db.delete("files_subtree_op_nodes", row._id);
				continue;
			}
			await ctx.db.patch("files_subtree_op_nodes", row._id, { nodeDone: true });
		}
		// A folder inside that is gone by now leaves nothing to check.
		else if (!node) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
			continue;
		}

		const page = await files_subtree_ops_db_next_children(ctx, { row, folder: node, budget: args.budget });
		if (!page) return { kind: "continue" };
		readCount += page.children.length;

		const activeNodes = page.children.filter((child) => child.archiveOperationId === null);
		const refusal = await db_check_writable_nodes({ ctx, ...args, nodes: activeNodes });
		if (refusal) {
			if (refusal === MEMBERSHIP_LOST) return refusal;
			refuse_named_item(args, get_named_item_refusal(refusal.nay, true));
			continue;
		}

		// Archive does not change archived nodes inside. But it must not hide a read-only one under a
		// newly archived folder. Use a general error when the person cannot see it.
		const archivedProtected = await files_nodes_db_require_swept_nodes_writable(ctx, {
			organizationId: args.run.organizationId,
			workspaceId: args.run.workspaceId,
			writeContext: {
				writer: { kind: "user", userId: args.userAuth.id },
				actorUserId: args.userAuth.id,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
			nodes: page.children.filter((child) => child.archiveOperationId !== null),
		});
		if (archivedProtected._nay) {
			refuse_named_item(args, get_named_item_refusal(archivedProtected._nay, true));
			continue;
		}

		progress.discovered += activeNodes.length;
		await files_subtree_ops_db_save_page(ctx, {
			row,
			cursor: page.cursor,
			isDone: page.isDone,
			pending: [],
			folderIds: page.children.filter((child) => child.kind === "folder").map((child) => child._id),
			isRowFirst: false,
		});
	}

	run.checkNamedItem = null;
	if (progress.blocked === 0) return { kind: "done" };

	// A refused named item adds one to both `discovered` and `blocked`. Every other named item adds at
	// least one to `discovered` only. So equal counts mean that the check refused every named item.
	if (progress.discovered === progress.blocked) {
		// The job ends here without an apply, so set the total the apply would set.
		progress.total = progress.discovered;
		const refusal = run.refusedItems.length === 1 ? run.refusedItems[0]!.refusal : null;
		return {
			kind: "failed",
			nay: refusal
				? { ...(refusal.name !== null ? { name: refusal.name } : {}), message: refusal.message }
				: { message: "None of these items can be archived. You cannot change them or items inside them." },
		};
	}

	// The apply stamps only the named items that passed.
	const refusedNodeIds = new Set(run.refusedItems.map((refusedItem) => refusedItem.nodeId));
	run.rootNodeIds = run.rootNodeIds.filter((nodeId) => !refusedNodeIds.has(nodeId));
	return { kind: "done" };
}

async function db_archive_node(
	args: StepArgs & {
		ctx: MutationCtx;
		node: Doc<"files_nodes">;
	},
) {
	const { ctx, node } = args;

	await files_nodes_db_archive_node(ctx, {
		node,
		archiveOperationId: args.run.archiveOperationId,
		updatedBy: args.userAuth.id,
		now: args.now,
	});
	if (args.run.pendingUpdateCleanup) {
		await files_pending_updates_db_remove_archived_node_proposal(ctx, {
			organizationId: args.run.organizationId,
			workspaceId: args.run.workspaceId,
			userId: args.userAuth.id,
			nodeId: node._id,
		});
	}
	args.writeState.isWritten = true;
	args.progress.completed += 1;
	args.budget.nodes -= 1;
}

/**
 * Stamp every named item first, so each one leaves the file tree at once. Then stamp the active
 * children of each folder this job stamped, the first named item's folder first. A stamped child
 * leaves the index range the page reads, so each page starts again from the first active child, and
 * a folder is done when that range is empty.
 *
 * The check already ran on every node, and the job cannot stop. So a lock or grant that changes
 * later does not stop the stamps. A child that somebody moved out is no longer under the folder. A
 * child that somebody archived on their own keeps their stamp and their Restore.
 */
async function db_apply_archive(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run } = args;
	let count = 0;

	// The walk reads no queue row until every named item is stamped.
	while (run.applyRootIndex < run.rootNodeIds.length) {
		if (args.budget.nodes <= 0 || (count > 0 && (await files_subtree_ops_db_is_near_limits(ctx)))) {
			return { kind: "continue" };
		}
		count += 1;

		const index = run.applyRootIndex;
		const node = await ctx.db.get("files_nodes", run.rootNodeIds[index]!);
		// A named item archived or deleted by somebody else in the meantime keeps that state, with
		// everything inside. The check counted it, so count it as skipped.
		if (!node || node.archiveOperationId !== null) {
			args.progress.skipped += 1;
		} else {
			await db_archive_node({ ctx, ...args, node });
			// The check kept the numbers below `rootNodeIds.length` for these rows. The first named item
			// gets the highest one, and every folder found later gets a higher one still. So the walk ends
			// inside the first named item before it goes into the second.
			if (node.kind === "folder") {
				await files_subtree_ops_db_insert_node(ctx, {
					opId: args.opId,
					sequence: run.rootNodeIds.length - 1 - index,
					nodeId: node._id,
					nodeDone: true,
				});
			}
		}
		run.applyRootIndex += 1;
	}

	while (true) {
		if (args.budget.nodes <= 0 || (count > 0 && (await files_subtree_ops_db_is_near_limits(ctx)))) {
			return { kind: "continue" };
		}

		const row = await files_subtree_ops_db_first_node(ctx, args.opId);
		if (!row) return { kind: "done" };
		// Count the row too. A step that only clears empty or deleted folders must still stop near the
		// limits.
		count += 1;

		const node = await ctx.db.get("files_nodes", row.nodeId);
		// A folder archived again by somebody else in the meantime keeps that archive, with everything inside.
		if (!node || node.archiveOperationId !== run.archiveOperationId) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
			continue;
		}

		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
				q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId).eq("moveCohortId", undefined)
					.eq("parentId", node._id)
					.eq("archiveOperationId", null),
			)
			.take(PAGE_SIZE);
		const folderIds = [];
		let isStopped = false;
		for (const child of children) {
			if (args.budget.nodes <= 0 || (await files_subtree_ops_db_is_near_limits(ctx))) {
				isStopped = true;
				break;
			}
			await db_archive_node({ ctx, ...args, node: child });
			count += 1;
			if (child.kind === "folder") {
				folderIds.push(child._id);
			}
		}
		// Queue the folders this page stamped even when the step stops. A stamped child leaves the active
		// range, so no later page finds it again.
		await files_subtree_ops_db_enqueue_nodes(ctx, {
			opId: args.opId,
			nodes: folderIds.map((nodeId) => ({ nodeId, nodeDone: true })),
		});
		if (isStopped) return { kind: "continue" };
		if (children.length < PAGE_SIZE) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
		}
	}
}

/**
 * Replace archives the item in the way, like a pasted move. It needs the same kind, a folder with no
 * active child, and write access to the item in the way and to every archived item inside it.
 */
async function db_can_replace(
	ctx: QueryCtx | MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		node: Doc<"files_nodes">;
		occupant: Doc<"files_nodes">;
	},
) {
	if (args.occupant.kind !== args.node.kind) return false;
	if (args.occupant.kind === "folder") {
		const activeChild = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
				q
					.eq("organizationId", args.occupant.organizationId)
					.eq("workspaceId", args.occupant.workspaceId).eq("moveCohortId", undefined)
					.eq("parentId", args.occupant._id)
					.eq("archiveOperationId", null),
			)
			.first();
		if (activeChild) return false;
	}

	const authorized = await authorize_file_write(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		nodeId: args.occupant._id,
	});
	if (authorized._nay) return false;
	const writable = await files_nodes_db_require_user_writable(ctx, { node: args.occupant, userId: args.userAuth.id });
	if (writable._nay) return false;
	if (args.occupant.kind === "file") return true;

	// Like a pasted move, no read-only item may end up hidden inside the archived folder. The `get` query
	// runs this too, so read at most `CHECK_STEP_MAX_NODES` items inside. A bigger folder cannot be
	// replaced. Keep both and Skip still work.
	const inside: Doc<"files_nodes">[] = [];
	const folderIds = [args.occupant._id];
	while (folderIds.length > 0) {
		const folderId = folderIds.pop()!;
		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
				q
					.eq("organizationId", args.occupant.organizationId)
					.eq("workspaceId", args.occupant.workspaceId).eq("moveCohortId", undefined)
					.eq("parentId", folderId),
			)
			.take(CHECK_STEP_MAX_NODES + 1 - inside.length);
		inside.push(...children);
		if (inside.length > CHECK_STEP_MAX_NODES) return false;
		folderIds.push(...children.filter((child) => child.kind === "folder").map((child) => child._id));
	}
	const swept = await files_nodes_db_require_swept_nodes_writable(ctx, {
		organizationId: args.occupant.organizationId,
		workspaceId: args.occupant.workspaceId,
		writeContext: {
			writer: { kind: "user", userId: args.userAuth.id },
			actorUserId: args.userAuth.id,
			resourceScope: { kind: "workspace" },
			policyReach: "ancestors",
		},
		nodes: inside,
	});
	return !swept._nay;
}

/**
 * Add a top item's path to the paths the restore marks busy. A path inside a folder path of the list
 * is covered already. The list keeps at most `MAX_DISCOVER_TREE_PATHS` paths, so an archive of many top
 * items cannot make it grow. Past that, the two paths with the longest shared folder merge into that folder.
 * The folder can be `/`, which marks the whole workspace busy.
 */
function add_discover_tree_path(run: RunFields, treePath: string) {
	// Only a folder's `treePath` ends with "/", like in `files_subtree_ops_db_find_blocker`.
	const holds = (outer: string, inner: string) => outer === inner || (outer.endsWith("/") && inner.startsWith(outer));
	const add = (path: string) => {
		if (run.discoverTreePaths.some((discoverTreePath) => holds(discoverTreePath, path))) return;
		run.discoverTreePaths = [
			...run.discoverTreePaths.filter((discoverTreePath) => !holds(path, discoverTreePath)),
			path,
		];
	};

	add(treePath);
	while (run.discoverTreePaths.length > MAX_DISCOVER_TREE_PATHS) {
		let folder = "/";
		for (const [index, first] of run.discoverTreePaths.entries()) {
			for (const second of run.discoverTreePaths.slice(index + 1)) {
				let length = 0;
				while (length < first.length && first[length] === second[length]) length += 1;
				const shared = first.slice(0, first.lastIndexOf("/", length - 1) + 1);
				if (shared.length > folder.length) folder = shared;
			}
		}
		add(folder);
	}
}

/**
 * Find every top item before restore checks access or writes nodes. Different top items in one
 * archive operation can sit under different folders, so all of their paths must join the busy check.
 */
async function db_discover_restore(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run } = args;
	const parents = new Map<Id<"files_nodes">, Doc<"files_nodes"> | null>();
	if (await files_subtree_ops_db_is_near_limits(ctx)) return { kind: "continue" };
	// This index keeps its order when an archived item is renamed or moved.
	// Convex allows one paginated query per mutation. Small restores use `take` so several operations
	// can still finish in one request. Larger ones read one page per step.
	const firstPage = run.checkCursor.treePath
		? null
		: await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation", (q) =>
					q
						.eq("organizationId", run.organizationId)
						.eq("workspaceId", run.workspaceId).eq("moveCohortId", undefined)
						.eq("archiveOperationId", run.archiveOperationId),
				)
				.take(PAGE_SIZE + 1);
	if (!(firstPage && firstPage.length <= PAGE_SIZE)) {
		if (args.budget.hasPaginated) return { kind: "continue" };
		args.budget.hasPaginated = true;
	}
	const page =
		firstPage && firstPage.length <= PAGE_SIZE
			? { page: firstPage, isDone: true, continueCursor: "" }
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_archiveOperation", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId).eq("moveCohortId", undefined)
							.eq("archiveOperationId", run.archiveOperationId),
					)
					.paginate({ cursor: run.checkCursor.treePath || null, numItems: PAGE_SIZE });
	for (const node of page.page) {
		const parentId = node.parentId;
		let parent = parentId === files_ROOT_ID ? null : parents.get(parentId);
		if (parent === undefined && parentId !== files_ROOT_ID) {
			parent = await ctx.db.get("files_nodes", parentId);
			parents.set(parentId, parent);
		}
		if (!parent || parent.archiveOperationId !== run.archiveOperationId) add_discover_tree_path(run, node.treePath);
	}
	if (!page.isDone) {
		run.checkCursor = { ...run.checkCursor, treePath: page.continueCursor };
		return { kind: "continue" };
	}

	const op = await ctx.db.get("files_subtree_ops", args.opId);
	if (!op || op.kind !== "restore") throw should_never_happen("Restore is missing its subtree op", { opId: args.opId });
	const blocker = await files_subtree_ops_db_find_blocker(ctx, {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		treePaths: run.discoverTreePaths,
		waiter: op,
	});
	await ctx.db.patch("files_subtree_ops", op._id, {
		treePaths: run.discoverTreePaths,
		status: blocker ? "queued" : "running",
		blockedByOpId: blocker?._id ?? null,
	});
	// A restore that waits finds its paths again when it starts, so it starts from an empty list.
	run.discoverTreePaths = [];
	run.checkCursor = { rootIndex: 0, treePath: "" };
	run.phase = "check";
	return blocker ? { kind: "blocked" } : { kind: "done" };
}

/**
 * Check every node of the operation before the restore writes anything. Also check each top item: an
 * item whose parent is not in the operation. Keep the top items whose folder is archived by another
 * operation in `rootNodeIds`. They land at the workspace root. This list is fixed here. A folder
 * archived later, during the job, keeps its restored items inside.
 */
async function db_check_restore(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	const parents = new Map<Id<"files_nodes">, Doc<"files_nodes"> | null>();
	let readCount = 0;

	while (true) {
		if (readCount >= CHECK_STEP_MAX_NODES || (await files_subtree_ops_db_is_near_limits(ctx))) {
			return { kind: "continue" };
		}

		const cursorTreePath = run.checkCursor.treePath;
		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
				q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId).eq("moveCohortId", undefined)
					.eq("archiveOperationId", run.archiveOperationId)
					.gt("treePath", cursorTreePath),
			)
			.take(PAGE_SIZE);
		const isLastPage = page.length < PAGE_SIZE;
		const lastNode = page.at(-1);
		// Nodes archived together can share a `treePath`: a file made during the archive job with the name
		// of one it already archived. The next page starts after this `treePath`, so read the rest of the
		// last group now. Two nodes can have the same `_creationTime`, so read from that time on and skip
		// the nodes the page already has.
		if (!isLastPage && lastNode) {
			const pageIds = new Set(page.map((node) => node._id));
			const sameTreePath = (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId).eq("moveCohortId", undefined)
							.eq("archiveOperationId", run.archiveOperationId)
							.eq("treePath", lastNode.treePath)
							.gte("_creationTime", lastNode._creationTime),
					)
					.take(CHECK_STEP_MAX_NODES + 1 + pageIds.size)
			).filter((node) => !pageIds.has(node._id));
			if (sameTreePath.length > CHECK_STEP_MAX_NODES)
				return { kind: "failed", nay: { message: "Too many archived items share one path." } };
			page.push(...sameTreePath);
		}
		readCount += page.length;

		const refusal = await db_check_writable_nodes({ ctx, ...args, nodes: page });
		if (refusal) return refusal;

		for (const node of page) {
			progress.discovered += 1;

			const parentId = node.parentId;
			let parent = parentId === files_ROOT_ID ? null : parents.get(parentId);
			if (parent === undefined && parentId !== files_ROOT_ID) {
				parent = await ctx.db.get("files_nodes", parentId);
				parents.set(parentId, parent);
			}
			// A folder of the same operation brings this item back when the walk reaches it.
			if (parent && parent.archiveOperationId === run.archiveOperationId) continue;
			if (!parent) continue;

			const folderRefusal = await db_check_restore_folder({ ctx, ...args, folder: parent });
			if (folderRefusal) return folderRefusal;

			// When another job is restoring the old folder, the item joins that job and comes back inside
			// the folder. A restore of several operations at once relies on this.
			const parentOperationId = parent.archiveOperationId;
			const parentRun =
				parentOperationId !== null &&
				(await ctx.db
					.query("files_archive_runs")
					.withIndex("by_organization_workspace_archiveOperation_active", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId)
							.eq("archiveOperationId", parentOperationId)
							.eq("active", true),
					)
					.first());
			// An archive job of the old folder is still writing that operation, so the item cannot join it.
			if (parentRun && parentRun.kind === "archive") {
				return {
					kind: "failed",
					nay: { name: "busy", message: "These items are being archived. Wait for it to finish." },
				};
			}
			if (parentOperationId !== null && !parentRun) {
				const moveRefusal = await db_check_restore_move({ ctx, ...args, node });
				if (moveRefusal) return moveRefusal;
				if (run.rootNodeIds.length >= MAX_ROOT_LANDINGS) {
					return { kind: "failed", nay: { message: "This archive has too many items to restore at once." } };
				}
				run.rootNodeIds.push(node._id);
			}
		}

		if (isLastPage) return { kind: "done" };
		run.checkCursor = { ...run.checkCursor, treePath: page.at(-1)!.treePath };
	}
}

/**
 * Find a free name for Keep both: `name-2.md`, `name-3.md`, and so on.
 */
async function db_find_free_name(
	args: StepArgs & {
		ctx: MutationCtx;
		node: Doc<"files_nodes">;
		parentId: Doc<"files_nodes">["parentId"];
	},
) {
	const { ctx, node, parentId } = args;

	const dot = node.kind === "file" ? node.name.indexOf(".", 1) : -1;
	const base = dot < 0 ? node.name : node.name.slice(0, dot);
	const extension = dot < 0 ? "" : node.name.slice(dot);
	for (let counter = 2; counter <= MAX_NAME_ATTEMPTS; counter++) {
		const name = `${base}-${counter}${extension}`;
		const occupant = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", args.run.organizationId)
					.eq("workspaceId", args.run.workspaceId).eq("moveCohortId", undefined)
					.eq("parentId", parentId)
					.eq("name", name)
					.eq("archiveOperationId", null),
			)
			.first();
		if (!occupant) return name;
	}
	return null;
}

/**
 * Bring back one top item of the operation: under its parent when the parent is active, at the
 * workspace root when the check said so, or into the parent's archive when that parent is archived
 * and not landing here. A name clash pauses the job until the person chooses.
 */
async function db_restore_top(
	args: StepArgs & {
		ctx: MutationCtx;
		node: Doc<"files_nodes">;
	},
): Promise<StepOutcome | null> {
	const { ctx, node, ...previousArgs } = args;

	const { run, progress } = previousArgs;
	if (!args.membership) return MEMBERSHIP_LOST;

	// Read the parent again. This step may have just restored it.
	const parent = node.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", node.parentId);
	const parentOperationId = parent?.archiveOperationId ?? null;
	let landing: Doc<"files_nodes"> | null;
	if (parent && parentOperationId === null) {
		landing = parent;
	} else if (parentOperationId === null || run.rootNodeIds.includes(node._id)) {
		landing = null;
	}
	// The parent was skipped, or somebody archived it during the job. Keep the node with it, so no
	// active node sits inside an archived folder. The walk below it moves its items there too.
	else {
		const refusal = await db_check_writable_nodes({ ctx, ...previousArgs, nodes: [node] });
		if (refusal) return refusal;
		await files_nodes_db_archive_node(ctx, {
			node,
			archiveOperationId: parentOperationId,
			updatedBy: args.userAuth.id,
			now: args.now,
		});
		args.writeState.isWritten = true;
		progress.skipped += 1;
		return null;
	}
	const landingParentId = landing?._id ?? files_ROOT_ID;

	// Locks and access may change during the job. Nodes already restored stay restored.
	const refusal =
		(await db_check_writable_nodes({ ctx, ...previousArgs, nodes: [node] })) ??
		(landing ? await db_check_restore_folder({ ctx, ...previousArgs, folder: landing }) : null) ??
		(parent && parent !== landing ? await db_check_restore_folder({ ctx, ...previousArgs, folder: parent }) : null) ??
		(landingParentId !== node.parentId ? await db_check_restore_move({ ctx, ...previousArgs, node }) : null);
	if (refusal) return refusal;

	return await db_land_node({ ctx, ...previousArgs, node, landing });
}

/**
 * Bring back one item of the operation into `landing`, or into the workspace root when it is null.
 * An active item with the same name there pauses the job until the person chooses. This holds for a
 * top item and for an item inside a restored folder.
 */
async function db_land_node(
	args: StepArgs & {
		ctx: MutationCtx;
		node: Doc<"files_nodes">;
		landing: Doc<"files_nodes"> | null;
	},
): Promise<StepOutcome | null> {
	const { ctx, node, landing, ...previousArgs } = args;

	const { run, progress } = previousArgs;
	const landingParentId = landing?._id ?? files_ROOT_ID;

	let name = node.name;
	let replacedNode: Doc<"files_nodes"> | null = null;
	const occupant = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q
				.eq("organizationId", run.organizationId)
				.eq("workspaceId", run.workspaceId).eq("moveCohortId", undefined)
				.eq("parentId", landingParentId)
				.eq("name", node.name)
				.eq("archiveOperationId", null),
		)
		.first();
	if (occupant) {
		const membership = args.membership;
		if (!membership) return MEMBERSHIP_LOST;

		// A choice counts only for the clash it answered. A different occupant asks again.
		const choice =
			run.choice?.nodeId === node._id && run.choice.occupantId === occupant._id
				? run.choice.choice
				: node.kind === "file"
					? run.applyToRemaining.file
					: run.applyToRemaining.folder;
		// A Replace that is not possible here asks again, so the person can pick Keep both or Skip.
		if (
			choice === null ||
			(choice === "replace" &&
				!(await db_can_replace(ctx, {
					userAuth: args.userAuth,
					membership,
					node,
					occupant,
				})))
		) {
			run.conflict = { nodeId: node._id, occupantId: occupant._id };
			run.choice = null;
			run.revision += 1;
			return { kind: "paused" };
		}
		run.choice = null;

		if (choice === "skip") {
			run.skipOperationId ??= crypto.randomUUID();
			await files_nodes_db_archive_node(ctx, {
				node,
				archiveOperationId: run.skipOperationId,
				updatedBy: args.userAuth.id,
				now: args.now,
			});
			args.writeState.isWritten = true;
			progress.skipped += 1;
			return null;
		}

		if (choice === "keep_both") {
			const freeName = await db_find_free_name({ ctx, ...previousArgs, node, parentId: landingParentId });
			if (freeName === null) return { kind: "failed", nay: { message: "No free name was found." } };
			name = freeName;
		} else {
			replacedNode = occupant;
		}
	}

	await files_nodes_db_restore_node(ctx, {
		node,
		parent: landing,
		name,
		updatedBy: args.userAuth.id,
		now: args.now,
	});
	// Replace archives the occupant only after the restore, like a move. It gets its own operation id,
	// so it can come back alone. The pause check above already ran `db_can_replace` in this mutation.
	if (replacedNode) {
		await files_nodes_db_archive_node(ctx, {
			node: replacedNode,
			archiveOperationId: crypto.randomUUID(),
			updatedBy: args.userAuth.id,
			now: args.now,
		});
		args.budget.nodes -= 1;
	}
	args.writeState.isWritten = true;
	progress.completed += 1;
	return null;
}

/**
 * Pull the top items of the operation, at most one page at a time, and land each one. Then walk each
 * folder by `parentId`. A child of the operation comes back when its folder is active, or joins its
 * folder's archive when the folder was skipped. A name clash in an active folder asks, like a clash of
 * a top item. Every other child keeps its stamp and gets the new path and scope.
 *
 * The walk is done when no node of the operation is left. A node renamed to a name before the cursor
 * during the walk is still there, so the next pull finds it.
 */
async function db_apply_restore(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	let count = 0;
	let lastPullTopIds = new Set<Id<"files_nodes">>();

	while (true) {
		if (args.budget.nodes <= 0 || (count > 0 && (await files_subtree_ops_db_is_near_limits(ctx)))) {
			return { kind: "continue" };
		}

		const row = await files_subtree_ops_db_first_node(ctx, args.opId);
		if (!row) {
			const left = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
					q
						.eq("organizationId", run.organizationId)
						.eq("workspaceId", run.workspaceId).eq("moveCohortId", undefined)
						.eq("archiveOperationId", run.archiveOperationId),
				)
				.take(PAGE_SIZE);
			if (left.length === 0) return { kind: "done" };

			// Queue the top item of each node that is left. Its folder may be of the operation too. Keep the
			// folders read for this pull only: a later pull in this step may run after some came back.
			const parents = new Map<Id<"files_nodes">, Doc<"files_nodes"> | null>();
			const topIds = new Set<Id<"files_nodes">>();
			for (const node of left) {
				let top = node;
				while (top.parentId !== files_ROOT_ID) {
					let parent = parents.get(top.parentId);
					if (parent === undefined) {
						parent = await ctx.db.get("files_nodes", top.parentId);
						parents.set(top.parentId, parent);
					}
					if (!parent || parent.archiveOperationId !== run.archiveOperationId) break;
					top = parent;
				}
				topIds.add(top._id);
			}
			// Each top item leaves the operation when it lands, joins another archive, or is skipped. A
			// pull that finds only the top items the last pull of this step queued would repeat forever.
			if ([...topIds].every((nodeId) => lastPullTopIds.has(nodeId))) {
				throw should_never_happen("Restore pull found no new top item", {
					opId: args.opId,
					topIds: [...topIds],
				});
			}
			lastPullTopIds = topIds;
			await files_subtree_ops_db_enqueue_nodes(ctx, {
				opId: args.opId,
				nodes: [...topIds].map((nodeId) => ({ nodeId, nodeDone: false })),
			});
			continue;
		}
		// Count the row too. A step that only clears empty or deleted folders must still stop near the
		// limits.
		count += 1;

		const node = await ctx.db.get("files_nodes", row.nodeId);
		if (!node) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
			continue;
		}

		if (!row.nodeDone) {
			if (node.archiveOperationId === run.archiveOperationId) {
				const outcome = await db_restore_top({ ctx, ...args, node });
				if (outcome) return outcome;
				args.budget.nodes -= 1;
			}
			if (node.kind === "file") {
				await ctx.db.delete("files_subtree_op_nodes", row._id);
				continue;
			}
			await ctx.db.patch("files_subtree_op_nodes", row._id, { nodeDone: true });
		}

		// Read the folder again. The top item above may have just landed it.
		const folder = (await ctx.db.get("files_nodes", node._id))!;
		const next = await files_subtree_ops_db_next_children(ctx, { row, folder, budget: args.budget });
		if (!next) return { kind: "continue" };
		const folderIds = [];
		let pending: Array<Id<"files_nodes">> = [];
		for (const [index, child] of next.children.entries()) {
			// A file with many side docs writes a lot, so a full step can end inside the page. The children
			// it did not reach wait in `pending` for the next step.
			if (index > 0 && (args.budget.nodes <= 0 || (await files_subtree_ops_db_is_near_limits(ctx)))) {
				pending = next.children.slice(index).map((pendingChild) => pendingChild._id);
				break;
			}
			count += 1;

			let isWalked = child.kind === "folder";
			// A top item that lands at the workspace root has its own row.
			if (child.archiveOperationId === run.archiveOperationId && !run.rootNodeIds.includes(child._id)) {
				// Check the child again, like a top item. A lock or lost access set during the job stops it, even
				// on a folder this job already restored. A folder's lock does not block its children, so a child
				// that comes back into an active folder checks that folder too.
				const refusal =
					(await db_check_writable_nodes({ ctx, ...args, nodes: [child] })) ??
					(folder.archiveOperationId === null ? await db_check_restore_folder({ ctx, ...args, folder }) : null);
				if (refusal) return refusal;
				if (folder.archiveOperationId === null) {
					// Somebody may have made an item with this name after the folder came back. The job then
					// pauses. This child stays first in `pending`, and its row runs before the folders this page
					// restored. A clash in one of them would ask first and drop the choice for this child.
					const outcome = await db_land_node({ ctx, ...args, node: child, landing: folder });
					if (outcome) {
						await files_subtree_ops_db_save_page(ctx, {
							row,
							cursor: next.cursor,
							isDone: next.isDone,
							pending: next.children.slice(index).map((pendingChild) => pendingChild._id),
							folderIds,
							isRowFirst: true,
						});
						return outcome;
					}
				} else {
					await files_nodes_db_archive_node(ctx, {
						node: child,
						archiveOperationId: folder.archiveOperationId,
						updatedBy: args.userAuth.id,
						now: args.now,
					});
					await files_nodes_db_rebuild_node(ctx, { node: child, parent: folder });
					progress.skipped += 1;
				}
				// Count only the items the step writes, not the ones it reads.
				args.budget.nodes -= 1;
				args.writeState.isWritten = true;
			}
			// A folder of another archive that kept its path keeps the paths inside too. Skip its walk.
			else if (await files_nodes_db_rebuild_node(ctx, { node: child, parent: folder })) {
				args.budget.nodes -= 1;
				args.writeState.isWritten = true;
			} else {
				isWalked = false;
			}
			if (isWalked) {
				folderIds.push(child._id);
			}
		}
		await files_subtree_ops_db_save_page(ctx, {
			row,
			cursor: next.cursor,
			isDone: next.isDone,
			pending,
			folderIds,
			isRowFirst: false,
		});
	}
}

/**
 * Run one step: the check walk first, then the changes. A step that finishes the check goes on with
 * the changes in the same mutation, so a small request ends inside the request.
 */
async function db_step(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	if (args.run.phase === "discover") {
		const discovered = await db_discover_restore(ctx, args);
		if (discovered.kind !== "done") return discovered;
	}
	if (args.run.phase === "check") {
		const checked = args.run.kind === "archive" ? await db_check_archive(ctx, args) : await db_check_restore(ctx, args);
		if (checked.kind !== "done") return checked;
		args.run.phase = "apply";
		args.progress.total = args.progress.discovered;
		// The archive check emptied the queue. Keep one queue number for each named item. The apply stamps
		// the named items first and queues their folders with these numbers. The restore apply finds its
		// top items itself.
		if (args.run.kind === "archive") {
			await files_subtree_ops_db_reserve_sequences(ctx, { opId: args.opId, count: args.run.rootNodeIds.length });
			// End the public links under the items the check kept, before the first stamp. A queued, refused,
			// or stopped check never gets here, so its links stay.
			await files_share_links_db_delete_for_roots({
				ctx,
				organizationId: args.run.organizationId,
				workspaceId: args.run.workspaceId,
				rootNodeIds: args.run.rootNodeIds,
				state: args.shareLinkCleanup,
			});
		}
	}

	const outcome = args.run.kind === "archive" ? await db_apply_archive(ctx, args) : await db_apply_restore(ctx, args);
	if (args.writeState.isWritten) await files_media_validation_db_advance_version(ctx, args.run);
	// The check counted items that somebody else archived, deleted or moved out before the apply reached
	// them. The apply leaves them as they are, so count them as skipped. Then the counts add up to the total.
	if (args.run.kind === "archive" && outcome.kind === "done" && args.progress.total !== null) {
		args.progress.skipped += Math.max(
			0,
			args.progress.total - args.progress.completed - args.progress.skipped - args.progress.blocked,
		);
	}
	// Items created or joined during the job are counted too, so keep the total at least as big.
	if (args.progress.total !== null) {
		args.progress.total = Math.max(
			args.progress.total,
			args.progress.completed + args.progress.skipped + args.progress.blocked,
		);
	}
	return outcome;
}

async function db_finish_run(
	args: Omit<Parameters<typeof activities_db_finish>[1], "sourceId"> & {
		ctx: MutationCtx;
		runId: Id<"files_archive_runs">;
	},
) {
	const { ctx, runId, ...previousArgs } = args;

	await ctx.db.patch("files_archive_runs", runId, { active: false });
	await activities_db_finish(ctx, { sourceId: runId, ...previousArgs });

	// Deleting the op starts the jobs that waited for it, like the next restore of the same request.
	const op = await ctx.db
		.query("files_subtree_ops")
		.withIndex("by_archiveRun", (q) => q.eq("archiveRunId", runId))
		.unique();
	if (op) await files_subtree_ops_db_delete(ctx, { opId: op._id, now: args.now });
}

/**
 * Save a step's result on the run and its Activity, then schedule the next step or finish.
 */
async function db_settle_step(
	ctx: MutationCtx,
	args: {
		opId: Id<"files_subtree_ops">;
		runId: Id<"files_archive_runs">;
		activityId: Id<"activities">;
		run: RunFields;
		progress: RunProgress;
		outcome: StepOutcome;
		now: number;
	},
) {
	await ctx.db.patch("files_archive_runs", args.runId, args.run);
	await ctx.db.patch("activities", args.activityId, {
		progress: args.progress,
		...(args.outcome.kind === "paused"
			? { status: "awaiting_input" as const }
			: args.outcome.kind === "blocked"
				? { status: "queued" as const, feedVisible: false }
				: {}),
		deadlineAt:
			args.now +
			(args.outcome.kind === "paused" || args.outcome.kind === "blocked" ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
		updatedAt: args.now,
	});

	switch (args.outcome.kind) {
		case "blocked": {
			return;
		}
		case "continue": {
			await files_subtree_ops_db_schedule_step(ctx, { opId: args.opId, now: args.now });
			return;
		}
		case "paused": {
			return;
		}
		case "done": {
			await db_finish_run({
				ctx,
				runId: args.runId,
				status: activities_get_result_status(args.progress),
				errorMessage: null,
				now: args.now,
			});
			return;
		}
		case "failed": {
			// Nothing changed while the job was still checking. After that, the changed items keep the
			// job's operation id, so one Restore or Archive brings them back.
			const isPartway = args.progress.completed + args.progress.skipped > 0;
			await db_finish_run({
				ctx,
				runId: args.runId,
				status: "failed",
				errorMessage: isPartway ? `Stopped partway: ${args.outcome.nay.message}` : args.outcome.nay.message,
				errorCode: "failed",
				now: args.now,
			});
			return;
		}
		default:
			throw should_never_happen("Unknown archive step outcome", args.outcome satisfies never);
	}
}

/**
 * Archive or restore through the job. The caller checked only that the person can read the items
 * they named. The job's check decides which of them can be archived.
 * Returns null when the work finished inside this request with nothing refused. Otherwise returns the
 * job, with `isDone` true when it already finished, and the named items refused so far.
 *
 * Archive starts at once, even over a folder another job is archiving. Each job stamps only active
 * items, so neither overwrites the other's stamp. Restore of an operation that a job still writes is
 * refused. Restore waits while it overlaps another op, and after the job before it in its request.
 */
export async function files_archive_runs_db_start(
	ctx: MutationCtx,
	args: {
		kind: "archive" | "restore";
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		archiveOperationId: string;
		/**
		 * Archive: the named active items. Restore: empty; the check fills the items that land at the root.
		 */
		rootNodeIds: Array<Id<"files_nodes">>;
		/**
		 * Archive: named ids that are missing, in another workspace, or that the person cannot read. The
		 * job lists each one as "Not found", like `rm` does for a missing file, and archives the rest.
		 * Restore: empty.
		 */
		notFoundNodeIds: Array<Id<"files_nodes">>;
		/**
		 * Where readers see the items now. Restore passes its top item, because it has no named items yet.
		 */
		treePaths: string[];
		pendingUpdateCleanup: RunFields["pendingUpdateCleanup"];
		budget: { nodes: number; hasPaginated: boolean };
		/**
		 * The job before this one in the same Unarchive request. The jobs of one request run one
		 * at a time, so their steps do not write the same docs at the same moment.
		 */
		previousRunId: Id<"files_archive_runs"> | null;
		shareLinkCleanup: files_share_links_CleanupState;
	},
) {
	if (args.kind === "restore") {
		const busy = await ctx.db
			.query("files_archive_runs")
			.withIndex("by_organization_workspace_archiveOperation_active", (q) =>
				q
					.eq("organizationId", args.membership.organizationId)
					.eq("workspaceId", args.membership.workspaceId)
					.eq("archiveOperationId", args.archiveOperationId)
					.eq("active", true),
			)
			.first();
		if (busy) {
			return Result({
				_nay: {
					name: "busy",
					message:
						busy.kind === "archive"
							? "These items are being archived. Wait for it to finish."
							: "These items are being restored. Wait for it to finish.",
				},
			});
		}
	}

	const previousRun = args.previousRunId ? await ctx.db.get("files_archive_runs", args.previousRunId) : null;
	const previousOp = args.previousRunId ? await db_require_op(ctx, args.previousRunId) : null;
	const blocker =
		args.kind === "archive"
			? null
			: (previousOp ??
				(await files_subtree_ops_db_find_blocker(ctx, {
					organizationId: args.membership.organizationId,
					workspaceId: args.membership.workspaceId,
					treePaths: args.treePaths,
					waiter: null,
				})));

	const now = Date.now();
	const run: RunFields = {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		userId: args.userAuth.id,
		kind: args.kind,
		archiveOperationId: args.archiveOperationId,
		rootNodeIds: args.kind === "archive" ? args.rootNodeIds : [],
		phase: args.kind === "restore" ? "discover" : "check",
		checkCursor: { rootIndex: 0, treePath: "" },
		discoverTreePaths: [],
		applyRootIndex: 0,
		active: true,
		skipOperationId: null,
		conflict: null,
		choice: null,
		applyToRemaining: { file: null, folder: null },
		revision: 0,
		pendingUpdateCleanup: args.pendingUpdateCleanup,
		// Cancel on a clash wait ends every job of the request, so each job names the first one.
		requestFirstRunId: previousRun ? (previousRun.requestFirstRunId ?? previousRun._id) : null,
		checkNamedItem: null,
		refusedItems: args.notFoundNodeIds.map((nodeId) => ({ nodeId, refusal: { name: null, message: "Not found" } })),
	};
	const progress: RunProgress = {
		unit: "items",
		discovered: args.notFoundNodeIds.length,
		total: null,
		completed: 0,
		skipped: 0,
		failed: 0,
		blocked: args.notFoundNodeIds.length,
		canceled: 0,
	};

	const runId = await ctx.db.insert("files_archive_runs", run);
	const opId = await files_subtree_ops_db_insert(ctx, {
		op: {
			organizationId: args.membership.organizationId,
			workspaceId: args.membership.workspaceId,
			userId: args.userAuth.id,
			status: blocker ? "queued" : "running",
			blockedByOpId: blocker?._id ?? null,
			rootNodeIds: args.rootNodeIds,
			treePaths: args.treePaths,
			kind: args.kind,
			archiveRunId: runId,
		},
		now,
	});
	if (args.kind === "archive") {
		await files_subtree_ops_db_enqueue_nodes(ctx, {
			opId,
			nodes: args.rootNodeIds.map((nodeId) => ({ nodeId, nodeDone: false })),
		});
	}

	const stepArgs: StepArgs = {
		opId,
		run,
		progress,
		userAuth: args.userAuth,
		membership: args.membership,
		now,
		budget: args.budget,
		checkedScopes: new Map(),
		shareLinkCleanup: args.shareLinkCleanup,
		writeState: { isWritten: false },
	};
	// A Move in the workspace makes the first step wait too. The Move wakes the job when it ends.
	const paused =
		!blocker && (await files_subtree_ops_db_pause_for_move(ctx, (await ctx.db.get("files_subtree_ops", opId))!));
	const outcome = blocker || paused ? null : await db_step(ctx, stepArgs);
	// Work that ended inside the request, or a refusal before the first write, leaves no job. Work that
	// refused a named item keeps its job, so its Activity can list what was not archived.
	if (
		(outcome?.kind === "done" && progress.blocked === 0) ||
		(outcome?.kind === "failed" && !stepArgs.writeState.isWritten)
	) {
		await files_subtree_ops_db_delete(ctx, { opId, now });
		await ctx.db.delete("files_archive_runs", runId);
		return outcome.kind === "done" ? Result({ _yay: null }) : Result({ _nay: outcome.nay });
	}

	const activityId = await activities_db_start(ctx, {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		userId: args.userAuth.id,
		membershipId: args.membership._id,
		membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, args.membership),
		source: { kind: "files_archive_run", id: runId, archiveKind: args.kind },
		// Keep names and paths out of the title. The requester may lose access to the items later.
		title: args.kind === "archive" ? "Archive files" : "Restore files",
		targets: [],
		visibility: "requester",
		// A queued job shows no card until it starts.
		feedVisible: !blocker && outcome?.kind !== "blocked",
		status: blocker || outcome?.kind === "blocked" ? "queued" : "running",
		resultKind: "saved",
		progress,
		deadlineAt: now + (blocker || outcome?.kind === "blocked" ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
		now,
	});
	if (!outcome) {
		return Result({ _yay: { runId, activityId, isDone: false, notArchivedNodeIds: [] as Array<Id<"files_nodes">> } });
	}

	await db_settle_step(ctx, { opId, runId, activityId, run, progress, outcome, now });
	// A request that failed after some writes keeps them and a failed Activity. Answer with the error, so
	// the caller does not say the work goes on in the background.
	if (outcome.kind === "failed") {
		return Result({ _nay: { ...outcome.nay, message: `Stopped partway: ${outcome.nay.message}` } });
	}

	// A job that goes on in the background can refuse more named items in later steps.
	const notArchivedNodeIds = run.refusedItems.map((refusedItem) => refusedItem.nodeId);
	return Result({ _yay: { runId, activityId, isDone: outcome.kind === "done", notArchivedNodeIds } });
}

/**
 * One scheduled step of an archive or restore op. `files_subtree_ops.advance` checked the op.
 */
export async function files_archive_runs_db_advance(
	ctx: MutationCtx,
	args: { op: Extract<Doc<"files_subtree_ops">, { kind: "archive" | "restore" }>; now: number },
) {
	const storedRun = await ctx.db.get("files_archive_runs", args.op.archiveRunId);
	if (!storedRun?.active) return;

	// A step scheduled before a clash pause does nothing until the person answers.
	const activity = await db_require_activity(ctx, storedRun._id);
	if (activity.status === "awaiting_input") return;

	const { _id: runId, _creationTime: _runCreationTime, ...run } = storedRun;
	const progress = { ...activity.progress };
	const membership = await db_get_run_membership({ ctx, run: storedRun, activity });
	// An accepted agent delete keeps its proposal on the named folder until the check ends. If the
	// person discards it before that, nothing was archived yet, so the job ends.
	const deleteProposal =
		storedRun.pendingUpdateCleanup && storedRun.phase === "check" && storedRun.rootNodeIds[0]
			? await files_db_get_pending_update(ctx, {
					organizationId: storedRun.organizationId,
					workspaceId: storedRun.workspaceId,
					userId: storedRun.userId,
					target: { kind: "saved", id: storedRun.rootNodeIds[0] },
				})
			: null;
	const outcome: StepOutcome =
		storedRun.pendingUpdateCleanup && storedRun.phase === "check" && !deleteProposal?.pendingArchive
			? { kind: "failed", nay: { message: "The delete was discarded." } }
			: await db_step(ctx, {
					opId: args.op._id,
					run,
					progress,
					userAuth: { id: storedRun.userId },
					membership,
					now: args.now,
					budget: { nodes: files_archive_runs_STEP_MAX_NODES, hasPaginated: false },
					checkedScopes: new Map(),
					shareLinkCleanup: files_share_links_create_cleanup_state(),
					writeState: { isWritten: false },
				});

	await db_settle_step(ctx, {
		opId: args.op._id,
		runId,
		activityId: activity._id,
		run,
		progress,
		outcome,
		now: args.now,
	});
}

/**
 * The op this restore waited for ended. Start it. Its first step finds current root paths, then
 * checks access before anything changes.
 */
export async function files_archive_runs_db_promote(
	ctx: MutationCtx,
	args: { op: Extract<Doc<"files_subtree_ops">, { kind: "archive" | "restore" }>; now: number },
) {
	const run = (await ctx.db.get("files_archive_runs", args.op.archiveRunId))!;
	if (run.phase === "check") {
		// Archived items can move while this job waits. Find all current root paths again before writing.
		await ctx.db.patch("files_archive_runs", run._id, {
			phase: "discover",
			checkCursor: { rootIndex: 0, treePath: "" },
			rootNodeIds: [],
		});
	}
	const activity = await db_require_activity(ctx, args.op.archiveRunId);
	await ctx.db.patch("activities", activity._id, {
		status: "running",
		feedVisible: true,
		startedAt: args.now,
		deadlineAt: args.now + RUN_TIMEOUT_MS,
		updatedAt: args.now,
	});
	await files_subtree_ops_db_run(ctx, { opId: args.op._id, now: args.now });
}

/**
 * Finish the job at once. Items already changed keep the job's operation id, so they can be restored
 * or archived again as one unit. People can stop only a restore that waits for a clash choice. Data
 * deletion stops any job.
 *
 * A timeout does not stop a job that is not waiting for a choice. Archive has no Stop, so the deadline
 * only tells the recover cron to schedule the step again.
 */
export async function files_archive_runs_db_request_stop(
	ctx: MutationCtx,
	args: { runId: Id<"files_archive_runs">; reason: "user" | "timeout"; now: number },
) {
	const run = await ctx.db.get("files_archive_runs", args.runId);
	if (!run?.active) return;

	if (args.reason === "timeout") {
		const activity = await db_require_activity(ctx, run._id);
		if (activity.status !== "awaiting_input") {
			await ctx.db.patch("activities", activity._id, {
				deadlineAt: args.now + (activity.status === "queued" ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
			});
			await files_subtree_ops_db_recover(ctx, { opId: (await db_require_op(ctx, run._id))._id });
			return;
		}
	}

	// Cancel ends the whole request. End the jobs that wait behind this one first, so the end of this
	// job does not start them.
	if (args.reason === "user" && run.kind === "restore") {
		const requestFirstRunId = run.requestFirstRunId ?? run._id;
		// One request names at most 500 items, so it has at most 500 jobs. Each job waits for the one
		// made before it. End the newest first. Then no ended job has a waiter left to check again
		// against every op of the workspace.
		const requestRuns = await ctx.db
			.query("files_archive_runs")
			.withIndex("by_requestFirstRun_active", (q) => q.eq("requestFirstRunId", requestFirstRunId).eq("active", true))
			.order("desc")
			.collect();
		for (const queuedRun of requestRuns.filter((requestRun) => requestRun._id !== run._id)) {
			await db_finish_run({
				ctx,
				runId: queuedRun._id,
				status: "canceled",
				errorMessage: null,
				errorCode: "canceled",
				now: args.now,
			});
		}
	}

	await db_finish_run({
		ctx,
		runId: run._id,
		status: args.reason === "timeout" ? "timed_out" : "canceled",
		errorMessage: args.reason === "timeout" ? "The restore waited too long for a choice." : null,
		errorCode: args.reason === "timeout" ? "timed_out" : "canceled",
		now: args.now,
	});
}

/**
 * The job the person owns, with its progress and the clash it waits on. The clash name and paths are
 * shown only when the person may read the node.
 * `archived` lists the other named items of an archive, and `notArchived` the named items it refused.
 * Both name only nodes of the run's workspace that the person can still read.
 */
export const get = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_archive_runs"),
	},
	returns: v.union(
		v.object({
			kind: app_convex_schema.tables.files_archive_runs.validator.fields.kind,
			revision: v.number(),
			activity: doc(app_convex_schema, "activities"),
			controls: v.object({ canStop: v.boolean(), canRetry: v.boolean(), canDismiss: v.boolean() }),
			conflict: v.union(
				v.object({
					kind: v.union(v.literal("file"), v.literal("folder")),
					name: v.union(v.string(), v.null()),
					path: v.union(v.string(), v.null()),
					occupantPath: v.union(v.string(), v.null()),
					canReplace: v.boolean(),
				}),
				v.null(),
			),
			archived: v.array(v.object({ nodeId: v.id("files_nodes"), name: v.union(v.string(), v.null()) })),
			notArchived: v.array(
				v.object({
					nodeId: v.id("files_nodes"),
					name: v.union(v.string(), v.null()),
					message: v.string(),
				}),
			),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return null;
		const { userAuth, run, activity, membership } = owned._yay;

		const refusedNodeIds = new Set(run.refusedItems.map((refusedItem) => refusedItem.nodeId));
		// Restore's `rootNodeIds` are not the items the person named, so only an archive lists them.
		const archivedNodeIds =
			run.kind === "archive" ? run.rootNodeIds.filter((nodeId) => !refusedNodeIds.has(nodeId)) : [];
		// A named id that was not found can belong to another workspace. Never name it.
		const namedNodes = (
			await Promise.all([...refusedNodeIds, ...archivedNodeIds].map((nodeId) => ctx.db.get("files_nodes", nodeId)))
		).flatMap((node) => (node && node.workspaceId === run.workspaceId ? [node] : []));
		// Name an item only while the person may still read it.
		const workspaceRead = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		const readableNodes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			userId: userAuth.id,
			nodes: namedNodes,
			hasWorkspaceRead: !workspaceRead._nay,
		});
		const nameByNodeId = new Map(readableNodes.map((node) => [node._id, node.name]));
		const notArchived = run.refusedItems.map((refusedItem) => ({
			nodeId: refusedItem.nodeId,
			name: nameByNodeId.get(refusedItem.nodeId) ?? null,
			message: refusedItem.refusal.message,
		}));
		const archived = archivedNodeIds.map((nodeId) => ({ nodeId, name: nameByNodeId.get(nodeId) ?? null }));

		let conflict = null;
		// A job stopped while it waited keeps its last clash. Show it only while the job waits.
		if (run.conflict && activity.status === "awaiting_input") {
			const [node, occupant] = await Promise.all([
				ctx.db.get("files_nodes", run.conflict.nodeId),
				ctx.db.get("files_nodes", run.conflict.occupantId),
			]);
			if (node && occupant) {
				const [nodeReadable, occupantReadable] = await Promise.all(
					[node, occupant].map((fileNode) =>
						access_control_db_authorize_membership(ctx, {
							userAuth,
							membership,
							permission: "content.read",
							fileNode,
						}),
					),
				);
				conflict = {
					kind: node.kind,
					name: nodeReadable._nay ? null : node.name,
					path: nodeReadable._nay ? null : node.path,
					occupantPath: occupantReadable._nay ? null : occupant.path,
					canReplace: await db_can_replace(ctx, { userAuth, membership, node, occupant }),
				};
			}
		}

		return {
			kind: run.kind,
			revision: run.revision,
			activity,
			controls: activities_get_controls(activity, userAuth.id),
			conflict,
			archived,
			notArchived,
		};
	},
});

/**
 * Answer the clash a restore job waits on, then go on. `revision` pins the clash the person saw.
 */
export const resolve_conflicts = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_archive_runs"),
		revision: v.number(),
		choice: v.union(v.literal("keep_both"), v.literal("skip"), v.literal("replace")),
		applyToRemaining: app_convex_schema.tables.files_archive_runs.validator.fields.applyToRemaining,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;
		const { userAuth, run, activity, membership } = owned._yay;

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });

		if (activity.status !== "awaiting_input" || !run.conflict || run.revision !== args.revision)
			return Result({ _nay: { message: "The conflicts changed. Review them again." } });
		const now = Date.now();
		if (activity.deadlineAt <= now) {
			await files_archive_runs_db_request_stop(ctx, { runId: run._id, reason: "timeout", now });
			return Result({ _nay: { message: "The restore timed out." } });
		}

		const [node, occupant] = await Promise.all([
			ctx.db.get("files_nodes", run.conflict.nodeId),
			ctx.db.get("files_nodes", run.conflict.occupantId),
		]);
		// The step asks again when Replace is not possible, so this refusal only gives a clear message sooner.
		if (
			args.choice === "replace" &&
			node &&
			occupant &&
			!(await db_can_replace(ctx, { userAuth, membership, node, occupant }))
		)
			return Result({
				_nay: {
					message:
						"Replace needs the same kind, an empty folder, and write access to the item in the way and everything inside it.",
				},
			});

		await ctx.db.patch("files_archive_runs", run._id, {
			choice: { ...run.conflict, choice: args.choice },
			conflict: null,
			applyToRemaining: args.applyToRemaining,
		});
		await ctx.db.patch("activities", activity._id, {
			status: "running",
			deadlineAt: now + RUN_TIMEOUT_MS,
			updatedAt: now,
		});
		await files_subtree_ops_db_schedule_step(ctx, { opId: (await db_require_op(ctx, run._id))._id, now });
		return Result({ _yay: null });
	},
});

/**
 * Deletion callers drain this before deleting memberships and files. History cleanup calls it too.
 */
export async function files_archive_runs_db_delete_run_batch(
	ctx: MutationCtx,
	args: { runId: Id<"files_archive_runs"> },
) {
	const run = await ctx.db.get("files_archive_runs", args.runId);
	if (!run) return { done: true, deletedCount: 0 };

	// Stop first, so a step that is already scheduled writes nothing.
	await files_archive_runs_db_request_stop(ctx, { runId: run._id, reason: "user", now: Date.now() });
	const activity = await activities_db_require_by_source_id(ctx, run._id);
	const deletedActivity = await activities_db_delete(ctx, activity._id);
	if (!deletedActivity.done) return deletedActivity;

	await ctx.db.delete("files_archive_runs", run._id);
	return { done: true, deletedCount: deletedActivity.deletedCount + 1 };
}
