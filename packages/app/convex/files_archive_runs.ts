// Archive and restore of a big folder do not fit in one mutation. This job changes a batch of nodes
// per step. Each node's side docs (text chunks, metadata docs) change in the same step as the node,
// so search and lists never see a node and its side docs disagree. A node with many side docs gets a
// saved scope job instead, and readers skip its docs until the job ends. The request runs a small first step
// itself (`files_archive_runs_REQUEST_MAX_NODES` stamps and `files_archive_runs_REQUEST_MAX_CHECK_NODES`
// checked nodes), so it answers fast. The archive request stamps only the named items, and the job
// stamps what is inside them. A small archive of files and empty folders, or a small restore, finishes
// inside the request and writes no run, no op, and no Activity, unless the archive refused a named item.
//
// The job is the archive or restore kind of a `files_subtree_ops` op, and it walks by `parentId`
// through that op's queue. Archive first checks every node inside and writes nothing (a fast archive
// skips this, see below). A refusal leaves
// out only the named item it is in, with everything inside it. Then the archive stamps every named item
// that passed, then the active children of each stamped folder, the first named item's folder
// first. A child that somebody moved out, or archived on their own, is not reached or keeps its own
// stamp. Restore finds the top items of the operation one page at a time, lands each one, then
// restores the items of the operation inside it. The other items inside get the new path and scope
// and keep their own stamp.
//
// A fast archive skips the check. The request first reads a few indexes for each named item
// (`files_archive_runs_db_check_fast`). When they prove that the check would pass for every named item,
// the request stamps the named items, so they leave the tree at once, and the job stamps the rest. When
// the indexes cannot decide for one named item, the whole archive runs the check, and the named items
// stay in the tree until the check passes.
//
// Forced archive visits children first and keeps denied branches active. It can stop between steps.
// Ordinary archive cannot stop after stamping a root. Restore stops while waiting for a clash choice.
//
// Delete permanently (the purge kind) walks archived items the same way as forced archive, children
// first. It deletes each node for good and keeps a folder while anything inside it stays.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { paginationOptsValidator, paginationResultValidator, type WithoutSystemFields } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { mutation } from "./functions.ts";
import {
	access_control_db_authorize_file_write,
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
	authorize_leaving_restricted_scope,
	files_nodes_db_archive_node,
	files_nodes_db_restore_node,
} from "./files_nodes.ts";
import { files_nodes_db_has_plugin_binding } from "./files_nodes_db.ts";
import {
	files_nodes_db_require_user_writable,
	files_nodes_db_require_writable,
	files_write_policy_db_is_within_scope,
	type files_nodes_WriteContext,
} from "../server/files-write-policy.ts";
import { files_write_policy_db_has_write_context_permission } from "./files_write_policy_db.ts";
import {
	files_subtree_ops_db_delete,
	files_subtree_ops_db_enqueue_nodes,
	files_subtree_ops_db_find_blocker,
	files_subtree_ops_db_insert,
	files_subtree_ops_db_insert_node,
	files_subtree_ops_db_is_near_limits,
	files_subtree_ops_db_count_recover,
	files_subtree_ops_db_recover,
	files_subtree_ops_db_run,
	files_subtree_ops_db_schedule_step,
	files_subtree_ops_db_find_blocked_paths,
	files_subtree_ops_db_first_node,
	files_subtree_ops_db_next_children,
	files_subtree_ops_db_pause_for_move,
	files_subtree_ops_db_reserve_sequences,
	files_subtree_ops_db_save_page,
} from "./files_subtree_ops_db.ts";
import { files_nodes_db_rebuild_node } from "./files_subtree_ops_rebuild.ts";
import { files_purge_db_drain_node_batch } from "./files_purge_db.ts";
import { organizations_db_get_membership } from "./organizations_memberships_db.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	public_api_credentials_db_get_write_context,
	public_api_credentials_db_is_live,
} from "./public_api_credentials_db.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	files_archive_runs_CHECK_STEP_MAX_NODES,
	files_archive_runs_REQUEST_MAX_CHECK_NODES,
	files_archive_runs_REQUEST_MAX_NODES,
} from "../server/files-archive-runs.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { files_move_reservations_db_find_blocker } from "../server/files-move-reservations.ts";
import {
	path_join,
	path_tree_prefix_upper_bound,
	server_convex_get_user_fallback_to_anonymous,
} from "../server/server-utils.ts";
import {
	files_archive_operation_id_new,
	files_check_name_and_path_length,
	files_NAME_MAX_LENGTH,
	files_PATH_MAX_LENGTH,
} from "../shared/files.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * A background apply step ends after this many nodes. On dev one archived node costs about 20 to 160 ms
 * of database time, about 60 ms most of the time (measured 2026-10-19). So a step stays near 2 seconds.
 */
export const files_archive_runs_STEP_MAX_NODES = 30;

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
 * Restore keeps the longest path inside at most this many top items, for Keep both. Past that, Keep
 * both uses the longest path of the whole job.
 */
const MAX_TOP_PATH_LENGTHS = 500;

/**
 * An archive or restore marks at most this many paths busy. Every op check reads each of them.
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
	runId: Id<"files_archive_runs">;
	/**
	 * A copy of the run that the step changes. The caller saves it.
	 */
	run: RunFields;
	progress: RunProgress;
	userAuth: { id: Id<"users"> };
	/**
	 * Who the archive checks act as. A job that an API key bound to a service account started checks
	 * access as the account. A restore always acts as the person.
	 */
	writeContext: files_nodes_WriteContext;
	/**
	 * Null when the requester left the workspace. The archive stamp walk goes on without them. The
	 * checks and a restore stop.
	 */
	membership: Doc<"organizations_workspaces_users"> | null;
	now: number;
	/**
	 * How many more nodes this mutation may change (`nodes`) and read for restore discovery or a check
	 * (`checkNodes`). A restore of several operations shares one budget across them, so one request
	 * cannot run past the mutation time limit. `hasPaginated` turns true after this mutation's one paginated read. Convex
	 * allows only one, so a later read that needs one ends the step.
	 */
	budget: { nodes: number; checkNodes: number; hasPaginated: boolean };
	/**
	 * True in the Archive or Restore request, false in a scheduled step. The archive request stamps only
	 * the named items, so the click answers fast. The job stamps what is inside them.
	 */
	isRequest: boolean;
	/**
	 * The restricted scopes already checked in this step. The key "" stands for no scope.
	 */
	checkedScopes: Map<string, boolean>;
	/**
	 * Turns true when this step changes a node. Helpers get a copy of these args, so this stays an object
	 * that every copy shares. A plain boolean set on a copy would never reach `db_step`.
	 */
	writeState: { isWritten: boolean };
	restoredParents: Map<Id<"files_nodes">, NonNullable<Doc<"files_subtree_op_nodes">["restoredParent"]>>;
	/**
	 * Purge: true once the person asked to stop. The job first finishes the node it is deleting.
	 */
	isStopping: boolean;
};

type StepOutcome =
	| { kind: "continue" }
	| { kind: "canceled" }
	| { kind: "blocked" }
	| { kind: "done" }
	| { kind: "paused" }
	| {
			kind: "failed";
			nay: { name?: string; message: string; data?: { refusedItems: RunFields["refusedItems"] } };
	  };

const MEMBERSHIP_LOST = {
	kind: "failed",
	nay: { message: "You can no longer change these files." },
} as const satisfies StepOutcome;

const API_KEY_LOST = {
	kind: "failed",
	nay: { message: "The API key that started this job was revoked or lost a required file scope." },
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
 * True while Delete permanently has started deleting a node and not finished it. The job may end only
 * when this is false, so no file is left half deleted.
 */
async function db_is_purging_node(ctx: MutationCtx, run: Doc<"files_archive_runs">) {
	const row = await files_subtree_ops_db_first_node(ctx, (await db_require_op(ctx, run._id))._id);
	const node = row && (await ctx.db.get("files_nodes", row.nodeId));
	return node?.purgeRunId === run._id;
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
 * The job's write context (the person, or the service account of its API key) must still write each
 * node the job changes: the node's own lock, and write access where it lives. Access is asked once per restricted scope, and once for the unrestricted part of
 * the workspace, so an ordinary tree costs one check per step.
 * A lock refusal also returns the locked node. The caller passed the write check for it, so they
 * may read it, and the refusal may name it.
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
		// Added people change access inside a scope, so the key is the pair.
		const scopeKey = `${node.restrictedScopeNodeId ?? ""}:${node.extendedScopeNodeId ?? ""}`;
		let allowed = args.checkedScopes.get(scopeKey);
		if (allowed === undefined) {
			allowed = await files_write_policy_db_has_write_context_permission(ctx, {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				writeContext: args.writeContext,
				membership,
				node,
				permission: "content.write",
			});
			args.checkedScopes.set(scopeKey, allowed);
		}
		if (!allowed) return { kind: "failed", nay: { message: "Permission denied" } } as const;
		// Restore preserves the archived item's flag. Its live parent list is checked separately.
		if (args.run.kind === "restore" && node.archiveOperationId === args.run.archiveOperationId) {
			if (
				!(await files_write_policy_db_is_within_scope(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					writeContext: args.writeContext,
					target: { kind: "node", node },
				}))
			)
				return { kind: "failed", nay: { message: "Permission denied" } } as const;
			continue;
		}

		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			writeContext: args.writeContext,
			target: { kind: "node", node },
		});
		if (writable._nay) return { kind: "failed", nay: writable._nay, node } as const;
	}
	return null;
}

/**
 * Removing a child changes its current parent's list, even when the child has its own access.
 */
async function db_check_archive_parent(
	ctx: MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		writeContext: files_nodes_WriteContext;
		node: Doc<"files_nodes">;
		checkedScopes: StepArgs["checkedScopes"];
	},
) {
	const { organizationId, workspaceId } = args.membership;
	const parent = args.node.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.node.parentId);
	if (
		args.node.parentId !== files_ROOT_ID &&
		(!parent ||
			parent.organizationId !== organizationId ||
			parent.workspaceId !== workspaceId ||
			parent.kind !== "folder" ||
			parent.archiveOperationId !== null)
	)
		return Result({ _nay: { message: "Permission denied" } });
	const scopeKey = `${parent?.restrictedScopeNodeId ?? ""}:${parent?.extendedScopeNodeId ?? ""}`;
	let allowed = args.checkedScopes.get(scopeKey);
	if (allowed === undefined) {
		allowed = await files_write_policy_db_has_write_context_permission(ctx, {
			organizationId,
			workspaceId,
			membership: args.membership,
			writeContext: args.writeContext,
			node: parent,
			permission: "content.write",
		});
		args.checkedScopes.set(scopeKey, allowed);
	}
	if (!allowed) return Result({ _nay: { message: "Permission denied" } });
	if (!parent) return Result({ _yay: null });
	const writable = await files_nodes_db_require_writable(ctx, {
		organizationId,
		workspaceId,
		writeContext: args.writeContext,
		target: { kind: "node", node: parent },
	});
	if (writable._nay?.name === "read_only")
		return Result({
			_nay: {
				name: "read_only",
				message: `The folder "${parent.path}" is read-only. Unlock it before archiving items inside it.`,
			},
		});
	return writable;
}

/**
 * A restore changes the folder an item leaves and the folder it lands in, like a move. So both
 * folders must not be read-only. Name the folder only for somebody who may read it.
 */
async function db_check_restore_folder(
	args: StepArgs & {
		ctx: MutationCtx;
		folder: Doc<"files_nodes">;
		restoredParent?: Doc<"files_subtree_op_nodes">["restoredParent"];
	},
) {
	const { ctx, folder } = args;

	const membership = args.membership;
	if (!membership) return MEMBERSHIP_LOST;

	if (
		!(await files_write_policy_db_has_write_context_permission(ctx, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			writeContext: args.writeContext,
			membership,
			node: folder,
			permission: "content.write",
		}))
	)
		return { kind: "failed", nay: { message: "Permission denied" } } as const;
	const writable = await files_nodes_db_require_writable(ctx, {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		writeContext: args.writeContext,
		target: { kind: "node", node: folder },
	});
	if (!writable._nay) return null;
	// Trash has no live child list to protect. Scope and access checks still apply.
	if (writable._nay.name === "read_only" && folder.archiveOperationId !== null) return null;
	const receipt = args.restoredParent;
	if (
		writable._nay.name === "read_only" &&
		receipt &&
		folder.archiveOperationId === null &&
		receipt.nodeId === folder._id &&
		receipt.decisionId === folder.readOnlyDecisionId &&
		receipt.parentId === folder.parentId &&
		receipt.path === folder.path
	)
		return null;

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

	const authorizedTarget = await access_control_db_authorize_file_write(ctx, {
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
 * The reason saved for a refused named item, with how to fix it. `inside` is set when the refused node
 * is inside the named folder. Then the node's own message would blame the folder, so name the locked
 * node instead, or say that an item inside is refused. `lockedPath` is set only for a node the person
 * may read.
 */
function get_named_item_refusal(nay: { name?: string; message: string }, inside: { lockedPath: string | null } | null) {
	const name = nay.name ?? null;
	// A review refusal of an agent's delete asks for a new review. That message fits an item inside too.
	if (name === "needs_review") return { name, message: nay.message };
	if (name === "read_only") {
		const lockedItem = !inside ? "This item" : inside.lockedPath ? `"${inside.lockedPath}"` : "An item inside it";
		return { name, message: `${lockedItem} is read-only. Unlock it, then try again.` };
	}
	return { name, message: inside ? "You cannot change an item inside it." : nay.message };
}

/**
 * The answer when an archive refused every named item. One refusal keeps its own reason. Several get
 * one general reason.
 */
export function files_archive_runs_get_all_refused_nay(refusedItems: RunFields["refusedItems"]) {
	const refusal = refusedItems.length === 1 ? refusedItems[0]!.refusal : null;
	return refusal
		? { ...(refusal.name !== null ? { name: refusal.name } : {}), message: refusal.message }
		: { message: "None of these items can be archived. You cannot change them or items inside them." };
}

/**
 * Check each active node before writing anything. Trash items keep their existing archive.
 * The walk follows `parentId`
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

	while (true) {
		if (args.budget.checkNodes <= 0 || (await files_subtree_ops_db_is_near_limits(ctx))) {
			return { kind: "continue" };
		}

		const row = await files_subtree_ops_db_first_node(ctx, args.opId);
		if (!row) break;

		// Named item k has row number `namedCount - 1 - k`. Every folder the walk finds gets a higher
		// number, and the highest number runs first. So a row at `namedCount` or above is always inside
		// the named item the check is on. Drop the rows of a refused item without checking them.
		if (run.checkNamedItem?.isRefused && (row.sequence >= namedCount || row.nodeId === run.checkNamedItem.nodeId)) {
			await ctx.db.delete("files_subtree_op_nodes", row._id);
			args.budget.checkNodes -= 1;
			continue;
		}

		const node = await ctx.db.get("files_nodes", row.nodeId);
		// Only a named item's row starts with `nodeDone` false.
		if (!row.nodeDone) {
			args.budget.checkNodes -= 1;
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

			const parentCheck = await db_check_archive_parent(ctx, { ...args, membership: args.membership, node });
			if (parentCheck._nay) {
				refuse_named_item(args, { name: parentCheck._nay.name ?? null, message: parentCheck._nay.message });
				continue;
			}
			const refusal = await db_check_writable_nodes({ ctx, ...args, nodes: [node] });
			if (refusal) {
				if (refusal === MEMBERSHIP_LOST) return refusal;
				refuse_named_item(args, get_named_item_refusal(refusal.nay, null));
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

		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) => {
				const range = q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", node._id)
					.eq("archiveOperationId", null);
				return row.cursor ? range.gt("name", row.cursor.name) : range;
			})
			.take(PAGE_SIZE);
		const last = children.at(-1);
		const page = {
			children,
			cursor: last ? { mode: "after" as const, name: last.name, creationTime: last._creationTime } : row.cursor,
			isDone: children.length < PAGE_SIZE,
		};
		args.budget.checkNodes -= page.children.length;

		const activeNodes = page.children;
		const refusal = await db_check_writable_nodes({ ctx, ...args, nodes: activeNodes });
		if (refusal) {
			if (refusal === MEMBERSHIP_LOST) return refusal;
			refuse_named_item(
				args,
				get_named_item_refusal(refusal.nay, { lockedPath: "node" in refusal ? (refusal.node?.path ?? null) : null }),
			);
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
		// The message is general when several items are refused. `data` keeps each item's own reason for
		// the API, like the fast check's refusals in `files_nodes_db_archive_named_nodes`.
		return {
			kind: "failed",
			nay: { ...files_archive_runs_get_all_refused_nay(run.refusedItems), data: { refusedItems: run.refusedItems } },
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
		savedScope: "follow",
	});
	args.writeState.isWritten = true;
	args.progress.completed += 1;
	// A fast archive ran no check, so it learns the items while it stamps them.
	if (args.progress.total === null) args.progress.discovered += 1;
	args.budget.nodes -= 1;
}

async function db_finish_forced_item(
	ctx: MutationCtx,
	args: StepArgs & {
		row: Doc<"files_subtree_op_nodes">;
		reason?: "permission" | "changed" | "not_empty";
	},
) {
	if (args.reason) {
		await ctx.db.insert("files_archive_run_items", {
			runId: args.runId,
			order: args.progress.discovered,
			kind: "force_archive",
			nodeId: args.row.nodeId,
			reason: args.reason,
		});
		args.progress.blocked += 1;
		args.progress.discovered += 1;
		args.budget.nodes -= 1;
		if (args.row.forceArchive?.rootNodeId === args.row.nodeId) {
			args.run.refusedItems.push({
				nodeId: args.row.nodeId,
				refusal: { name: null, message: "Some items could not be archived. See the job results." },
			});
		}
	}
	if (args.row.forceArchive?.rootNodeId === args.row.nodeId) args.run.applyRootIndex += 1;
	await ctx.db.delete("files_subtree_op_nodes", args.row._id);
}

/**
 * Keep denied branches in place. Only an empty active folder may leave the tree.
 */
async function db_apply_forced_archive(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	if (!args.membership) return MEMBERSHIP_LOST;
	// A running Restore also repairs descendant paths. Queued work must never hold this job up.
	for (const kind of ["move", "scope", "restore"] as const) {
		const repair = await ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind_status", (q) =>
				q
					.eq("organizationId", args.run.organizationId)
					.eq("workspaceId", args.run.workspaceId)
					.eq("kind", kind)
					.eq("status", "running"),
			)
			.first();
		if (repair) return { kind: "continue" };
	}
	while (args.budget.nodes > 0 && args.budget.checkNodes > 0 && !(await files_subtree_ops_db_is_near_limits(ctx))) {
		const row = await files_subtree_ops_db_first_node(ctx, args.opId);
		if (!row) return { kind: "done" };
		const frame = row.forceArchive;
		if (!frame) throw should_never_happen("Forced archive has no saved parent", { rowId: row._id });
		args.budget.checkNodes -= 1;
		const node = await ctx.db.get("files_nodes", row.nodeId);
		if (!node || node.archiveOperationId !== null) {
			args.progress.skipped += 1;
			args.progress.discovered += 1;
			await db_finish_forced_item(ctx, { ...args, row });
			continue;
		}
		const root = node._id === frame.rootNodeId ? node : await ctx.db.get("files_nodes", frame.rootNodeId);
		if (
			!root ||
			root.archiveOperationId !== null ||
			root.treePath !== frame.rootTreePath ||
			node.organizationId !== args.run.organizationId ||
			node.workspaceId !== args.run.workspaceId ||
			node.parentId !== frame.parentId ||
			(node._id !== root._id && (root.kind !== "folder" || !node.treePath.startsWith(root.treePath)))
		) {
			await db_finish_forced_item(ctx, { ...args, row, reason: "changed" });
			continue;
		}
		const parentCheck = await db_check_archive_parent(ctx, { ...args, membership: args.membership, node });
		const refusal = parentCheck._nay || (await db_check_writable_nodes({ ctx, ...args, nodes: [node] }));
		if (refusal) {
			await db_finish_forced_item(ctx, { ...args, row, reason: "permission" });
			continue;
		}
		if (node.kind === "folder") {
			const children = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) => {
					const range = q
						.eq("organizationId", args.run.organizationId)
						.eq("workspaceId", args.run.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("parentId", node._id)
						.eq("archiveOperationId", null);
					return frame.afterName === null ? range : range.gt("name", frame.afterName);
				})
				.take(PAGE_SIZE);
			args.budget.checkNodes -= children.length;
			if (children.length > 0) {
				// Active sibling names are unique. Move holds the workspace until its physical cleanup ends.
				await ctx.db.patch("files_subtree_op_nodes", row._id, {
					forceArchive: { ...frame, afterName: children.at(-1)!.name },
				});
				await files_subtree_ops_db_enqueue_nodes(ctx, {
					opId: args.opId,
					nodes: children.map((child) => ({
						nodeId: child._id,
						nodeDone: false,
						forceArchive: { ...frame, parentId: node._id, afterName: null },
					})),
				});
				continue;
			}
			// A denied child or a new name behind the cursor keeps the folder active. Never rescan it.
			const remaining = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
					q
						.eq("organizationId", args.run.organizationId)
						.eq("workspaceId", args.run.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("parentId", node._id)
						.eq("archiveOperationId", null),
				)
				.first();
			if (remaining) {
				await db_finish_forced_item(ctx, { ...args, row, reason: "not_empty" });
				continue;
			}
		}
		await db_archive_node({ ctx, ...args, node });
		await db_finish_forced_item(ctx, { ...args, row });
	}
	return { kind: "continue" };
}

type PurgeKeptReason = Extract<Doc<"files_archive_run_items">, { kind: "purge" }>["reason"];

/**
 * Why Delete permanently kept an item, in the words the job results show.
 */
const PURGE_KEPT_MESSAGES: Record<PurgeKeptReason, string> = {
	permission: "Permission denied",
	read_only: "This item is read-only. Turn off Read-only, then try again.",
	busy: "This item is in use. Try again in a moment.",
	changed: "This item moved or changed. Try again from its current folder.",
	not_empty: "This folder still holds items that could not be deleted.",
};

async function db_finish_purge_item(
	ctx: MutationCtx,
	args: StepArgs & {
		row: Doc<"files_subtree_op_nodes">;
		reason: PurgeKeptReason | null;
	},
) {
	if (args.reason) {
		await ctx.db.insert("files_archive_run_items", {
			runId: args.runId,
			order: args.progress.discovered,
			kind: "purge",
			nodeId: args.row.nodeId,
			reason: args.reason,
		});
		args.progress.blocked += 1;
		if (args.row.purge?.rootNodeId === args.row.nodeId) {
			args.run.refusedItems.push({
				nodeId: args.row.nodeId,
				refusal: {
					name: null,
					message:
						args.reason === "not_empty"
							? "Some items inside could not be deleted. See the job results."
							: PURGE_KEPT_MESSAGES[args.reason],
				},
			});
		}
	}
	args.progress.discovered += 1;
	args.budget.nodes -= 1;
	await ctx.db.delete("files_subtree_op_nodes", args.row._id);
}

/**
 * Whether Delete permanently must keep a node it did not start yet. Null when the node may go.
 */
async function db_check_purge_node(
	ctx: MutationCtx,
	args: StepArgs & {
		membership: Doc<"organizations_workspaces_users">;
		frame: NonNullable<Doc<"files_subtree_op_nodes">["purge"]>;
		node: Doc<"files_nodes">;
	},
): Promise<PurgeKeptReason | null> {
	const { frame, node } = args;

	// The person picked the named item in the Archived view. When it was restored, archived again or
	// moved since, they did not pick what is there now.
	const root = node._id === frame.rootNodeId ? node : await ctx.db.get("files_nodes", frame.rootNodeId);
	if (
		!root ||
		root.archiveOperationId !== frame.rootOperationId ||
		root.treePath !== frame.rootTreePath ||
		node.organizationId !== args.run.organizationId ||
		node.workspaceId !== args.run.workspaceId ||
		node.parentId !== frame.parentId ||
		(node._id !== root._id && (root.kind !== "folder" || !node.treePath.startsWith(root.treePath)))
	)
		return "changed";

	// Deleting for good needs Can manage, in every area the walk reaches. Added people change access
	// inside an area, so the key is the pair.
	const scopeKey = `${node.restrictedScopeNodeId ?? ""}:${node.extendedScopeNodeId ?? ""}`;
	let allowed = args.checkedScopes.get(scopeKey);
	if (allowed === undefined) {
		allowed = await files_write_policy_db_has_write_context_permission(ctx, {
			organizationId: args.membership.organizationId,
			workspaceId: args.membership.workspaceId,
			writeContext: args.writeContext,
			membership: args.membership,
			node,
			permission: "content.permissions.manage",
		});
		args.checkedScopes.set(scopeKey, allowed);
	}
	if (!allowed) return "permission";

	// Read-only is set on each locked node, so only this node is kept. Its folders then keep it too.
	if (node.readOnly) return "read_only";

	return null;
}

/**
 * Delete permanently. Walk each named item children first, and delete a folder only after everything
 * inside it. An item that must stay keeps its folders, so nothing it needs is deleted.
 *
 * Deleting one node takes several calls of `files_purge_db_drain_node_batch`, sometimes over several
 * steps. The first call sets the node's `purgeRunId`. From then on the walk finishes that node before
 * anything else, so no file is left half deleted. Stop and a lost membership end the job only between
 * nodes. The started node is always the first queue row, because the walk queues nothing while it
 * deletes a node.
 */
async function db_apply_purge(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	// A running Move, scope or Restore op rewrites paths and scopes page by page. Wait until it ends, so
	// the checks below see the final ones.
	for (const kind of ["move", "scope", "restore"] as const) {
		const repair = await ctx.db
			.query("files_subtree_ops")
			.withIndex("by_organization_workspace_kind_status", (q) =>
				q
					.eq("organizationId", args.run.organizationId)
					.eq("workspaceId", args.run.workspaceId)
					.eq("kind", kind)
					.eq("status", "running"),
			)
			.first();
		if (repair) return { kind: "continue" };
	}
	while (args.budget.nodes > 0 && args.budget.checkNodes > 0 && !(await files_subtree_ops_db_is_near_limits(ctx))) {
		const row = await files_subtree_ops_db_first_node(ctx, args.opId);
		if (!row) return { kind: "done" };
		const frame = row.purge;
		if (!frame) throw should_never_happen("Purge row has no named item", { rowId: row._id });
		args.budget.checkNodes -= 1;
		const node = await ctx.db.get("files_nodes", row.nodeId);
		const isStarted = node?.purgeRunId === args.runId;

		if (!isStarted) {
			if (args.isStopping) return { kind: "canceled" };
			if (!args.membership) return MEMBERSHIP_LOST;
		}
		if (!node) {
			args.progress.skipped += 1;
			await db_finish_purge_item(ctx, { ...args, row, reason: null });
			continue;
		}
		if (!isStarted && args.membership) {
			const reason = await db_check_purge_node(ctx, { ...args, membership: args.membership, frame, node });
			if (reason) {
				await db_finish_purge_item(ctx, { ...args, row, reason });
				continue;
			}
			// Queue the next page of children above the folder, so they go first. Archived children can
			// share a name, so the page goes by name and creation time.
			if (node.kind === "folder") {
				const page = await files_subtree_ops_db_next_children(ctx, { row, folder: node, budget: args.budget });
				if (!page) return { kind: "continue" };
				if (page.children.length > 0 || !page.isDone) {
					args.budget.checkNodes -= page.children.length;
					await ctx.db.patch("files_subtree_op_nodes", row._id, { cursor: page.cursor });
					await files_subtree_ops_db_enqueue_nodes(ctx, {
						opId: args.opId,
						nodes: page.children.map((child) => ({
							nodeId: child._id,
							nodeDone: false,
							purge: { ...frame, parentId: node._id },
						})),
					});
					continue;
				}
			}
		}

		const drained = await files_purge_db_drain_node_batch(ctx, {
			organizationId: args.run.organizationId,
			workspaceId: args.run.workspaceId,
			node,
			runId: args.runId,
		});
		args.budget.nodes -= 1;
		switch (drained.kind) {
			case "more": {
				args.writeState.isWritten = true;
				continue;
			}
			case "deleted": {
				args.writeState.isWritten = true;
				args.progress.completed += 1;
				await db_finish_purge_item(ctx, { ...args, row, reason: null });
				continue;
			}
			// Work that ends on its own still uses the node. Before the first write the job keeps it.
			// After that it must finish the node, so it tries again in the next step.
			case "busy": {
				if (isStarted) return { kind: "continue" };
				await db_finish_purge_item(ctx, { ...args, row, reason: "busy" });
				continue;
			}
			case "not_empty": {
				await db_finish_purge_item(ctx, { ...args, row, reason: "not_empty" });
				continue;
			}
			default:
				throw should_never_happen("Unknown purge drain result", drained satisfies never);
		}
	}
	return { kind: "continue" };
}

/**
 * Stamp every named item first, so each one leaves the file tree at once. Then stamp the active
 * children of each folder this job stamped, the first named item's folder first. A stamped child
 * leaves the index range the page reads, so each page starts again from the first active child, and
 * a folder is done when that range is empty. The request stops before the first child (`isRequest`).
 *
 * The check already ran on every node, or the request proved with index reads that it would pass
 * (`files_archive_runs_db_check_fast`). The job cannot stop. So a lock or grant that changes
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
		// everything inside. Count it as skipped. The check counted it already, but a fast archive ran no check.
		if (!node || node.archiveOperationId !== null) {
			args.progress.skipped += 1;
			if (args.progress.total === null) args.progress.discovered += 1;
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
		// The request stamps no child here, so it skips the stamp budget. It reads one queue row and one
		// child for each named folder. So 10 named files and empty folders still end inside the request.
		if (
			(!args.isRequest && args.budget.nodes <= 0) ||
			(count > 0 && (await files_subtree_ops_db_is_near_limits(ctx)))
		) {
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
					.eq("workspaceId", run.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", node._id)
					.eq("archiveOperationId", null),
			)
			.take(args.isRequest ? 1 : PAGE_SIZE);
		// The request reads one child only to learn whether the folder is empty. An empty named folder ends
		// inside the request. A folder with an active child keeps its queue row, and the job stamps the children.
		if (args.isRequest && children.length > 0) return { kind: "continue" };
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
 * active child, and write access to the item in the way. Trash children keep their own archive.
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
					.eq("workspaceId", args.occupant.workspaceId)
					.eq("moveCohortId", undefined)
					.eq("parentId", args.occupant._id)
					.eq("archiveOperationId", null),
			)
			.first();
		if (activeChild) return false;
	}

	const authorized = await access_control_db_authorize_file_write(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		nodeId: args.occupant._id,
	});
	if (authorized._nay) return false;
	const writable = await files_nodes_db_require_user_writable(ctx, { node: args.occupant, userId: args.userAuth.id });
	if (writable._nay) return false;
	// Archived children keep their own stamps and never block replacing an active empty folder.
	return true;
}

/**
 * Add a top item's path to the paths the restore marks busy. A path inside a folder path of the list
 * is covered already. The list keeps at most `MAX_DISCOVER_TREE_PATHS` paths, so an archive of many top
 * items cannot make it grow. Past that, the two paths with the longest shared folder merge into that folder.
 * The folder can be `/`, which marks the whole workspace busy.
 */
function add_discover_tree_path(run: Pick<RunFields, "discoverTreePaths">, treePath: string) {
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
		// In sorted order, the two paths with the longest shared folder are next to each other. So
		// compare neighbors only: comparing every pair of long paths takes too long for 500 named items.
		const sorted = run.discoverTreePaths.toSorted();
		let folder = "/";
		for (const [index, first] of sorted.slice(0, -1).entries()) {
			const second = sorted[index + 1]!;
			let length = 0;
			while (length < first.length && first[length] === second[length]) length += 1;
			const shared = first.slice(0, first.lastIndexOf("/", length - 1) + 1);
			if (shared.length > folder.length) folder = shared;
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
	if (args.budget.checkNodes <= 0 || (await files_subtree_ops_db_is_near_limits(ctx))) return { kind: "continue" };
	// This index keeps its order when an archived item is renamed or moved.
	// Convex allows one paginated query per mutation. Small restores use `take` so several operations
	// can still finish in one request. Larger ones read one page per step. A page is as big as the check
	// budget left, because each step costs about one second of scheduler wait. 50 items per page made a
	// 416-item restore spend 9 steps here.
	const pageSize = args.budget.checkNodes;
	const firstPage = run.checkCursor.treePath
		? null
		: await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_archiveOperation", (q) =>
					q
						.eq("organizationId", run.organizationId)
						.eq("workspaceId", run.workspaceId)
						.eq("moveCohortId", undefined)
						.eq("archiveOperationId", run.archiveOperationId),
				)
				.take(pageSize + 1);
	if (!(firstPage && firstPage.length <= pageSize)) {
		if (args.budget.hasPaginated) return { kind: "continue" };
		args.budget.hasPaginated = true;
	}
	const page =
		firstPage && firstPage.length <= pageSize
			? { page: firstPage, isDone: true, continueCursor: "" }
			: await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_archiveOperation", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("archiveOperationId", run.archiveOperationId),
					)
					.paginate({ cursor: run.checkCursor.treePath || null, numItems: pageSize });
	args.budget.checkNodes -= page.page.length;
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
 * How many characters longer an item's path gets when the restore lands it, and its top item. A top
 * item lands in its active parent, or at the workspace root when `rootNodeIds` has it. An item inside
 * follows its top item. `landings` keeps the answers, so each folder is read once per step.
 */
async function db_get_restore_landing(
	ctx: MutationCtx,
	args: {
		run: RunFields;
		node: Doc<"files_nodes">;
		parents: Map<Id<"files_nodes">, Doc<"files_nodes"> | null>;
		landings: Map<Id<"files_nodes">, { growth: number; topId: Id<"files_nodes"> }>;
	},
): Promise<{ growth: number; topId: Id<"files_nodes"> }> {
	const { run, node, parents, landings } = args;

	const known = landings.get(node._id);
	if (known !== undefined) return known;
	const parentId = node.parentId;
	let parent = parentId === files_ROOT_ID ? null : parents.get(parentId);
	if (parent === undefined && parentId !== files_ROOT_ID) {
		parent = await ctx.db.get("files_nodes", parentId);
		parents.set(parentId, parent);
	}
	const landing =
		parent && parent.archiveOperationId === run.archiveOperationId
			? await db_get_restore_landing(ctx, { ...args, node: parent })
			: {
					growth: !parent
						? 0
						: parent.archiveOperationId === null
							? path_join(parent.path, node.name).length - node.path.length
							: run.rootNodeIds.includes(node._id)
								? path_join("/", node.name).length - node.path.length
								: // The item joins the restore of its folder. The landing check catches a path that got too long.
									0,
					topId: node._id,
				};
	landings.set(node._id, landing);
	return landing;
}

/**
 * Count one item whose new path would be over the limit. Keep the longest one, so the message can name it.
 */
function add_long_path(run: RunFields, item: { name: string; length: number }) {
	run.longPaths = {
		...(run.longPaths && run.longPaths.length >= item.length ? run.longPaths : item),
		count: (run.longPaths?.count ?? 0) + 1,
	};
}

/**
 * Say how many items would get a path over the limit and name the longest one, like
 * "3 items would have paths over 1,024 characters, like …/report.md (1,031)".
 */
function get_long_paths_text(longPaths: NonNullable<RunFields["longPaths"]>) {
	const limit = files_PATH_MAX_LENGTH.toLocaleString("en-US");
	const example = `…/${longPaths.name} (${longPaths.length.toLocaleString("en-US")})`;
	return longPaths.count === 1
		? `1 item would have a path over ${limit} characters: ${example}`
		: `${longPaths.count} items would have paths over ${limit} characters, like ${example}`;
}

/**
 * Say which items stayed archived because their paths got too long after the check, or null.
 */
function get_long_paths_end_text(run: Pick<RunFields, "longPaths" | "longPathOperationId">) {
	const longPaths = run.longPaths;
	if (!longPaths || run.longPathOperationId === undefined) return null;
	const example = `…/${longPaths.name} (${longPaths.length.toLocaleString("en-US")} characters)`;
	return longPaths.count === 1
		? `1 item stayed archived because its path would be too long: ${example}. Shorten a folder name, then restore it again.`
		: `${longPaths.count} items stayed archived because their paths would be too long, like ${example}. Shorten a folder name, then restore them again.`;
}

/**
 * Check every node of the operation before the restore writes anything. Also check each top item: an
 * item whose parent is not in the operation. Keep the top items whose folder is archived by another
 * operation in `rootNodeIds`. They land at the workspace root. This list is fixed here. A folder
 * archived later, during the job, keeps its restored items inside.
 * A restore that would make any path too long is refused here, so the person can fix it before any write.
 */
async function db_check_restore(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	const parents = new Map<Id<"files_nodes">, Doc<"files_nodes"> | null>();
	const landings = new Map<Id<"files_nodes">, { growth: number; topId: Id<"files_nodes"> }>();

	while (true) {
		if (args.budget.checkNodes <= 0 || (await files_subtree_ops_db_is_near_limits(ctx))) {
			return { kind: "continue" };
		}

		const cursorTreePath = run.checkCursor.treePath;
		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
				q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId)
					.eq("moveCohortId", undefined)
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
							.eq("workspaceId", run.workspaceId)
							.eq("moveCohortId", undefined)
							.eq("archiveOperationId", run.archiveOperationId)
							.eq("treePath", lastNode.treePath)
							.gte("_creationTime", lastNode._creationTime),
					)
					.take(files_archive_runs_CHECK_STEP_MAX_NODES + 1 + pageIds.size)
			).filter((node) => !pageIds.has(node._id));
			if (sameTreePath.length > files_archive_runs_CHECK_STEP_MAX_NODES)
				return { kind: "failed", nay: { message: "Too many archived items share one path." } };
			page.push(...sameTreePath);
		}
		args.budget.checkNodes -= page.length;

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

		// The top items of this page know where they land now. A path over the normal limit needs its
		// first Archive allowance. A child archived on its own may have taken a longer path
		// from its folder since then, and it cannot come back with it.
		for (const node of page) {
			const { growth, topId } = await db_get_restore_landing(ctx, { run, node, parents, landings });
			const length = node.path.length + growth;
			run.maxPathLength = Math.max(run.maxPathLength ?? 0, length);
			// Keep the longest path inside each top item too, for a Keep both of that folder.
			const top = run.topMaxPathLengths?.find((item) => item.nodeId === topId);
			if (top) top.length = Math.max(top.length, length);
			else if ((run.topMaxPathLengths?.length ?? 0) < MAX_TOP_PATH_LENGTHS) {
				run.topMaxPathLengths = [...(run.topMaxPathLengths ?? []), { nodeId: topId, length }];
			}
			if (length > files_PATH_MAX_LENGTH && length > (node.archivedPathLength ?? files_PATH_MAX_LENGTH)) {
				add_long_path(run, { name: node.name, length });
			}
		}

		if (isLastPage && run.longPaths) {
			return {
				kind: "failed",
				nay: {
					name: "path_too_long",
					message: `Can't restore. ${get_long_paths_text(run.longPaths)}. Shorten a folder name, then restore again.`,
				},
			};
		}
		if (isLastPage) return { kind: "done" };
		run.checkCursor = { ...run.checkCursor, treePath: page.at(-1)!.treePath };
	}
}

/**
 * The longest Keep both name for `node` next to `occupant`. A path over the normal limit needs its
 * first Archive allowance. A folder's new name makes each path inside longer too, so it may grow only by
 * what the longest path inside it leaves free. A folder that is not a top item, or one past the
 * `topMaxPathLengths` list, uses the longest path of the whole job.
 */
function get_keep_both_max_length(args: { run: RunFields; node: Doc<"files_nodes">; occupant: Doc<"files_nodes"> }) {
	const { run, node, occupant } = args;

	const parentLength = occupant.path.length - occupant.name.length;
	const oldLength = node.archivedPathLength ?? files_PATH_MAX_LENGTH;
	const maxLength = Math.min(files_NAME_MAX_LENGTH, Math.max(files_PATH_MAX_LENGTH, oldLength) - parentLength);
	const longest = run.topMaxPathLengths?.find((item) => item.nodeId === node._id)?.length ?? run.maxPathLength ?? 0;
	return node.kind === "folder"
		? Math.min(maxLength, node.name.length + Math.max(0, files_PATH_MAX_LENGTH - longest))
		: maxLength;
}

/**
 * Find a free name for Keep both: `name-2.md`, `name-3.md`, and so on. Returns null when no free name
 * fits in `maxLength`.
 */
async function db_find_free_name(args: {
	ctx: QueryCtx | MutationCtx;
	run: RunFields;
	node: Doc<"files_nodes">;
	parentId: Doc<"files_nodes">["parentId"];
	maxLength: number;
}) {
	const { ctx, node, parentId } = args;

	for (let counter = 2; counter <= MAX_NAME_ATTEMPTS; counter++) {
		let dot = node.kind === "file" ? node.name.indexOf(".", 1) : -1;
		const counterSuffix = `-${counter}`;
		// Keep compound extensions unless the counter leaves no base character.
		if (dot >= 0 && args.maxLength - counterSuffix.length - (node.name.length - dot) < 1)
			dot = node.name.lastIndexOf(".");
		const base = dot < 0 ? node.name : node.name.slice(0, dot);
		const suffix = `${counterSuffix}${dot < 0 ? "" : node.name.slice(dot)}`;
		// Cut the base, so a long name still gets a free name inside the limit. Keep at least one character.
		if (args.maxLength - suffix.length < 1) return null;
		const name = `${base.slice(0, args.maxLength - suffix.length)}${suffix}`;
		const occupant = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q
					.eq("organizationId", args.run.organizationId)
					.eq("workspaceId", args.run.workspaceId)
					.eq("moveCohortId", undefined)
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
			savedScope: "follow",
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
	// A plugin decides who reads the whole bound area, so a restricted item cannot come back into one.
	if (
		node.restrictedScopeNodeId === node._id &&
		landing?.restrictedScopeNodeId &&
		(await files_nodes_db_has_plugin_binding(ctx, landing.restrictedScopeNodeId))
	) {
		return {
			kind: "failed",
			nay: {
				message:
					"A plugin decides who can read the folder it comes back to, so a restricted item cannot be restored there.",
			},
		};
	}

	let name = node.name;
	let replacedNode: Doc<"files_nodes"> | null = null;
	let isSkipped = false;
	const occupant = await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
			q
				.eq("organizationId", run.organizationId)
				.eq("workspaceId", run.workspaceId)
				.eq("moveCohortId", undefined)
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
		const freeName =
			choice === "keep_both"
				? await db_find_free_name({
						ctx,
						run,
						node,
						parentId: landingParentId,
						maxLength: get_keep_both_max_length({ run, node, occupant }),
					})
				: null;
		// A Replace or a Keep both that is not possible here asks again, so the person can pick another choice.
		if (
			choice === null ||
			(choice === "keep_both" && freeName === null) ||
			(choice === "replace" &&
				!(await db_can_replace(ctx, {
					userAuth: args.userAuth,
					membership,
					node,
					occupant,
				})))
		) {
			// Nobody can answer a question for an API job, so it stops with the reason, like an API move.
			// The API sets a choice for files and folders, so only a Keep both with no free name gets here.
			if (run.credentialId !== undefined) {
				return {
					kind: "failed",
					nay: {
						message: `"${node.name}" clashes with an item in the folder it comes back to, and Keep both found no name that fits. Rename or move that item, then restore again.`,
					},
				};
			}
			run.conflict = { nodeId: node._id, occupantId: occupant._id };
			run.choice = null;
			run.revision += 1;
			return { kind: "paused" };
		}
		run.choice = null;

		if (choice === "skip") {
			isSkipped = true;
		} else if (freeName !== null) {
			name = freeName;
			// Each path inside the folder gets longer too.
			if (node.kind === "folder") {
				run.maxPathLength = (run.maxPathLength ?? 0) + Math.max(0, name.length - node.name.length);
			}
		} else {
			replacedNode = occupant;
		}
	}

	// Recheck the landing path. An item that joined another restore may now be too long.
	// It stays archived under its own operation id. The job reports it when it ends.
	const path = path_join(landing?.path ?? "/", name);
	let skipOperationId = null;
	if (isSkipped) {
		run.skipOperationId ??= files_archive_operation_id_new(args.now);
		skipOperationId = run.skipOperationId;
	} else if (
		files_check_name_and_path_length({ path, oldPathLength: node.archivedPathLength ?? files_PATH_MAX_LENGTH })._nay
	) {
		add_long_path(run, { name: node.name, length: path.length });
		run.longPathOperationId ??= files_archive_operation_id_new(args.now);
		skipOperationId = run.longPathOperationId;
	}
	if (skipOperationId !== null) {
		await files_nodes_db_archive_node(ctx, {
			node,
			archiveOperationId: skipOperationId,
			updatedBy: args.userAuth.id,
			now: args.now,
			savedScope: "follow",
		});
		// Nobody saw the clash of an API job, so list the item. It stays in the Trash.
		if (isSkipped && run.credentialId !== undefined) {
			await ctx.db.insert("files_archive_run_items", {
				runId: args.runId,
				order: progress.completed + progress.skipped,
				kind: "restore",
				// The item keeps its old path in the Trash. `path` is where it would have landed.
				path: node.path,
				newPath: null,
			});
		}
		args.writeState.isWritten = true;
		progress.skipped += 1;
		return null;
	}

	await files_nodes_db_restore_node(ctx, {
		node,
		parent: landing,
		name,
		updatedBy: args.userAuth.id,
		now: args.now,
	});
	if (node.kind === "folder") {
		args.restoredParents.set(node._id, {
			nodeId: node._id,
			decisionId: node.readOnlyDecisionId,
			parentId: landingParentId,
			path,
		});
	}
	// Replace archives the occupant only after the restore, like a move. It gets its own operation id,
	// so it can come back alone. The pause check above already ran `db_can_replace` in this mutation.
	if (replacedNode) {
		await files_nodes_db_archive_node(ctx, {
			node: replacedNode,
			archiveOperationId: files_archive_operation_id_new(args.now),
			updatedBy: args.userAuth.id,
			now: args.now,
			savedScope: "follow",
		});
		args.budget.nodes -= 1;
	}
	// Nobody saw the clash of an API job, so list the new name. Otherwise the caller cannot find the item.
	if (name !== node.name && run.credentialId !== undefined) {
		await ctx.db.insert("files_archive_run_items", {
			runId: args.runId,
			order: progress.completed + progress.skipped,
			kind: "restore",
			path: node.path,
			newPath: path,
		});
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
						.eq("workspaceId", run.workspaceId)
						.eq("moveCohortId", undefined)
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
			await ctx.db.patch("files_subtree_op_nodes", row._id, {
				nodeDone: true,
				restoredParent: args.restoredParents.get(node._id),
			});
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
				// The run may finish a folder it just restored with the same read-only decision. A later
				// decision or changed location ends that receipt. Access is checked every time.
				const refusal =
					(await db_check_writable_nodes({ ctx, ...args, nodes: [child] })) ??
					(folder.archiveOperationId === null
						? await db_check_restore_folder({
								ctx,
								...args,
								folder,
								restoredParent: args.restoredParents.get(folder._id) ?? row.restoredParent,
							})
						: null);
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
							restoredParents: args.restoredParents,
						});
						return outcome;
					}
				} else {
					await files_nodes_db_archive_node(ctx, {
						node: child,
						archiveOperationId: folder.archiveOperationId,
						updatedBy: args.userAuth.id,
						now: args.now,
						savedScope: "follow",
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
			restoredParents: args.restoredParents,
		});
	}
}

/**
 * Run once before the first stamp of an archive, after its check or right away for a fast archive.
 * The queue is empty then. Keep one queue number for each named item. The apply stamps the named items
 * first and queues their folders with these numbers. Each stamp ends that item's public link, so this
 * needs no link work. A queued, refused, or stopped check never stamps, so its links stay.
 */
async function db_begin_archive_apply(ctx: MutationCtx, args: StepArgs) {
	await files_subtree_ops_db_reserve_sequences(ctx, { opId: args.opId, count: args.run.rootNodeIds.length });
}

/**
 * Run one step: the check walk first, then the changes. A step that finishes the check goes on with
 * the changes in the same mutation, so a small restore, or a small archive of files and empty folders,
 * ends inside the request.
 */
async function db_step(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	// Each deleted node advances its own media validation version.
	if (args.run.kind === "purge") {
		const outcome = await db_apply_purge(ctx, args);
		if (outcome.kind === "done") args.progress.total = args.progress.discovered;
		return outcome;
	}
	if (args.run.kind === "archive" && args.run.force) {
		const outcome = await db_apply_forced_archive(ctx, args);
		if (args.writeState.isWritten) await files_media_validation_db_advance_version(ctx, args.run);
		if (outcome.kind === "done") args.progress.total = args.progress.discovered;
		return outcome;
	}
	if (args.run.phase === "discover") {
		const discovered = await db_discover_restore(ctx, args);
		if (discovered.kind !== "done") return discovered;
	}
	if (args.run.phase === "check") {
		const checked = args.run.kind === "archive" ? await db_check_archive(ctx, args) : await db_check_restore(ctx, args);
		if (checked.kind !== "done") return checked;
		args.run.phase = "apply";
		args.progress.total = args.progress.discovered;
		// The restore apply finds its top items itself.
		if (args.run.kind === "archive") await db_begin_archive_apply(ctx, args);
	}

	const outcome = args.run.kind === "archive" ? await db_apply_archive(ctx, args) : await db_apply_restore(ctx, args);
	if (args.writeState.isWritten) await files_media_validation_db_advance_version(ctx, args.run);
	// A fast archive learns its items while it stamps them. Set the total when the last one is stamped.
	if (args.run.kind === "archive" && outcome.kind === "done" && args.progress.total === null) {
		args.progress.total = args.progress.discovered;
	}
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
		case "canceled": {
			await db_finish_run({
				ctx,
				runId: args.runId,
				status: "canceled",
				errorMessage: null,
				errorCode: "canceled",
				now: args.now,
			});
			return;
		}
		case "done": {
			// Items that stayed archived because their path got too long make the job only partly done.
			const status = activities_get_result_status(args.progress);
			await db_finish_run({
				ctx,
				runId: args.runId,
				status: status === "succeeded" && args.run.longPathOperationId !== undefined ? "partial" : status,
				errorMessage: get_long_paths_end_text(args.run),
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
				errorMessage: [
					isPartway ? `Stopped partway: ${args.outcome.nay.message}` : args.outcome.nay.message,
					get_long_paths_end_text(args.run),
				]
					.filter((text) => text !== null)
					.join(" "),
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
 * The fast check reads every subtree op of the workspace to learn whether one overlaps the named items.
 * Past this many it gives up and the job runs the full check, because a partial read could miss an op.
 */
const FAST_CHECK_MAX_OPS = 500;

/**
 * Decide with index reads only whether the archive check would pass for `nodes`: the named items the
 * write context may write, with no named item inside another. Then the request stamps the named items itself,
 * and the job runs no check.
 *
 * Returns the named items to refuse now, with the reason the check would give, and `isFast`: true when
 * every other named item is proven to pass. When even one is not proven, the whole archive runs the
 * check, so one job keeps one set of rules. Every node read is one `.first()` on an index range, and the
 * op read stops at `FAST_CHECK_MAX_OPS`, so the cost does not grow with the size of a folder.
 */
export async function files_archive_runs_db_check_fast(
	ctx: MutationCtx,
	args: {
		writeContext: files_nodes_WriteContext;
		membership: Doc<"organizations_workspaces_users">;
		nodes: Doc<"files_nodes">[];
	},
) {
	const { organizationId, workspaceId } = args.membership;
	const refusals = new Map<Id<"files_nodes">, RunFields["refusedItems"][number]["refusal"]>();
	if (args.writeContext.force) return { refusals, isFast: false };

	// Check the item and the direct parent whose child list changes.
	const checkedScopes = new Map<string, boolean>();
	for (const node of args.nodes) {
		const parentCheck = await db_check_archive_parent(ctx, { ...args, node, checkedScopes });
		if (parentCheck._nay) {
			refusals.set(node._id, { name: parentCheck._nay.name ?? null, message: parentCheck._nay.message });
			continue;
		}
		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId,
			workspaceId,
			writeContext: args.writeContext,
			target: { kind: "node", node },
		});
		if (writable._nay) refusals.set(node._id, get_named_item_refusal(writable._nay, null));
	}
	const nodes = args.nodes.filter((node) => !refusals.has(node._id));

	// The index answers below are right only while nothing rewrites paths or scopes under these items.
	// A Move, a running scope or move op, or any op on these paths does that page by page. Too many named
	// items would also make the request stamp less than all of them.
	const isQuiet = await (async (/* iife */) => {
		if (nodes.length > files_archive_runs_REQUEST_MAX_NODES) return false;
		if (await files_move_reservations_db_find_blocker(ctx.db, { wholeWorkspace: { organizationId, workspaceId } }))
			return false;
		for (const kind of ["scope", "move"] as const) {
			const op = await ctx.db
				.query("files_subtree_ops")
				.withIndex("by_organization_workspace_kind_status", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("kind", kind)
						.eq("status", "running"),
				)
				.first();
			if (op) return false;
		}
		const blocked = await files_subtree_ops_db_find_blocked_paths(ctx, {
			organizationId,
			workspaceId,
			treePaths: nodes.map((node) => node.treePath),
			maxOps: FAST_CHECK_MAX_OPS,
		});
		return blocked !== null && !blocked.includes(true);
	})();
	if (!isQuiet) return { refusals, isFast: false };

	const organization = await ctx.db.get("organizations", organizationId);
	// A service account is never the owner, even when the person behind its key is.
	const { subject } = args.writeContext;
	const isOwner = subject.kind === "user" && organization?.ownerUserId === subject.userId;

	let isFast = true;
	for (const node of nodes) {
		// A file has nothing inside.
		if (node.kind === "file") continue;

		const area = node.isRestrictedScopeRoot ? node._id : node.restrictedScopeNodeId;
		const treePathEnd = path_tree_prefix_upper_bound(node.treePath);

		// The caller proved write access in the item's own area. A restricted folder inside is another
		// area, so only the check can ask it. "Add people" only adds access, so it needs no read. The
		// owner may write every area.
		if (!isOwner) {
			const restrictedRoot = await ctx.db
				.query("files_nodes")
				.withIndex("by_org_ws_parentScope_archive_treePath", (q) =>
					q
						.eq("organizationId", organizationId)
						.eq("workspaceId", workspaceId)
						.eq("moveCohortId", undefined)
						.eq("parentScopeNodeId", area)
						.eq("archiveOperationId", null)
						.gt("treePath", node.treePath)
						.lt("treePath", treePathEnd),
				)
				.first();
			if (restrictedRoot) {
				isFast = false;
				continue;
			}
		}

		const readOnly = await ctx.db
			.query("files_nodes")
			.withIndex("by_org_ws_archive_readOnly_treePath", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("workspaceId", workspaceId)
					.eq("moveCohortId", undefined)
					.eq("archiveOperationId", null)
					.eq("readOnly", true)
					.gt("treePath", node.treePath)
					.lt("treePath", treePathEnd),
			)
			.first();
		if (readOnly) {
			// Name the item only in an area the person can read.
			if (isOwner || readOnly.restrictedScopeNodeId === area) {
				refusals.set(
					node._id,
					get_named_item_refusal({ name: "read_only", message: "" }, { lockedPath: readOnly.path }),
				);
			} else {
				isFast = false;
			}
			continue;
		}
	}

	return { refusals, isFast };
}

/**
 * Archive or restore through the job. The caller checked that the person can write the items they
 * named. The job's check decides which of them can be archived, unless the archive is fast.
 * Returns null when the work finished inside this request with nothing refused. Otherwise returns the
 * job, with `isDone` true when it already finished, the named items refused so far, the named items
 * not stamped yet, and `isChecking` true while the check still runs before any stamp.
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
		/**
		 * The API key that started the job, or null for the app.
		 */
		credentialId: Id<"api_credentials"> | null;
		force?: boolean;
		archiveOperationId: string;
		/**
		 * Archive: the named active items. Restore: empty; the check fills the items that land at the root.
		 */
		rootNodeIds: Array<Id<"files_nodes">>;
		/**
		 * Archive: named ids refused before the job: "Not found" for a missing id or one in another
		 * workspace, "Permission denied" for one the person cannot change, and the refusals of
		 * `files_archive_runs_db_check_fast`. The job lists each one, like `rm` does, and archives the
		 * rest. Restore: empty.
		 */
		refusedNodes: RunFields["refusedItems"];
		/**
		 * True when `files_archive_runs_db_check_fast` proved that the check would pass. The job then
		 * starts with the stamps and runs no check. Restore: false.
		 */
		isFast: boolean;
		/**
		 * Where readers see the items now. Restore passes its top item, because it has no named items yet.
		 */
		treePaths: string[];
		budget: StepArgs["budget"];
		/**
		 * The job before this one in the same Unarchive request. The jobs of one request run one
		 * at a time, so their steps do not write the same docs at the same moment.
		 */
		previousRunId: Id<"files_archive_runs"> | null;
		/**
		 * Restore: the clash choices made before the job starts. The app passes nulls and asks at each
		 * clash. Archive: nulls.
		 */
		applyToRemaining: RunFields["applyToRemaining"];
	},
) {
	const force = args.force ?? false;
	if (
		force &&
		(args.credentialId === null ||
			!(await public_api_credentials_db_is_live(ctx, {
				credentialId: args.credentialId,
				userId: args.userAuth.id,
				workspaceId: args.membership.workspaceId,
				scopes: ["files:write", "files:read-only"],
			})))
	)
		return Result({ _nay: { message: "Permission denied" } });
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

	// An archive can name 500 items. Merge their paths like a restore does, so every later op check
	// reads at most `MAX_DISCOVER_TREE_PATHS` paths from this op.
	const busyPaths = { discoverTreePaths: [] as string[] };
	for (const treePath of args.treePaths) add_discover_tree_path(busyPaths, treePath);

	const previousRun = args.previousRunId ? await ctx.db.get("files_archive_runs", args.previousRunId) : null;
	const previousOp = args.previousRunId ? await db_require_op(ctx, args.previousRunId) : null;
	const blocker =
		args.kind === "archive"
			? null
			: (previousOp ??
				(await files_subtree_ops_db_find_blocker(ctx, {
					organizationId: args.membership.organizationId,
					workspaceId: args.membership.workspaceId,
					treePaths: busyPaths.discoverTreePaths,
					waiter: null,
				})));

	const now = Date.now();
	const run: RunFields = {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		userId: args.userAuth.id,
		credentialId: args.credentialId ?? undefined,
		force,
		kind: args.kind,
		archiveOperationId: args.archiveOperationId,
		rootNodeIds: args.kind === "archive" ? args.rootNodeIds : [],
		phase: args.kind === "restore" ? "discover" : force || args.isFast ? "apply" : "check",
		checkCursor: { rootIndex: 0, treePath: "" },
		discoverTreePaths: [],
		applyRootIndex: 0,
		active: true,
		skipOperationId: null,
		conflict: null,
		choice: null,
		applyToRemaining: args.applyToRemaining,
		revision: 0,
		// Cancel on a clash wait ends every job of the request, so each job names the first one.
		requestFirstRunId: previousRun ? (previousRun.requestFirstRunId ?? previousRun._id) : null,
		checkNamedItem: null,
		refusedItems: args.refusedNodes,
	};
	const progress: RunProgress = {
		unit: "items",
		discovered: args.refusedNodes.length,
		total: null,
		completed: 0,
		skipped: 0,
		failed: 0,
		blocked: args.refusedNodes.length,
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
			treePaths: busyPaths.discoverTreePaths,
			kind: args.kind,
			archiveRunId: runId,
		},
		now,
	});
	// The check walks from a queue row for each named item. A fast archive runs no check.
	if (args.kind === "archive" && force) {
		const nodes = [];
		for (const nodeId of args.rootNodeIds) {
			const node = await ctx.db.get("files_nodes", nodeId);
			nodes.push({
				nodeId,
				nodeDone: false,
				forceArchive: {
					rootNodeId: nodeId,
					rootTreePath: node?.treePath ?? "",
					parentId: node?.parentId ?? files_ROOT_ID,
					afterName: null,
				},
			});
		}
		await files_subtree_ops_db_enqueue_nodes(ctx, { opId, nodes });
	} else if (args.kind === "archive" && !args.isFast) {
		await files_subtree_ops_db_enqueue_nodes(ctx, {
			opId,
			nodes: args.rootNodeIds.map((nodeId) => ({ nodeId, nodeDone: false })),
		});
	}

	const stepArgs: StepArgs = {
		opId,
		runId,
		run,
		progress,
		userAuth: args.userAuth,
		writeContext: await public_api_credentials_db_get_write_context(ctx, {
			credentialId: args.credentialId,
			userId: args.userAuth.id,
			force,
		}),
		membership: args.membership,
		now,
		budget: args.budget,
		isRequest: true,
		checkedScopes: new Map(),
		writeState: { isWritten: false },
		restoredParents: new Map(),
		isStopping: false,
	};
	// A Move in the workspace makes the first step wait too. The Move wakes the job when it ends. A fast
	// archive already proved that no Move runs.
	const paused =
		!blocker &&
		(!args.isFast || force) &&
		(await files_subtree_ops_db_pause_for_move(ctx, (await ctx.db.get("files_subtree_ops", opId))!));
	if (args.isFast && !force) await db_begin_archive_apply(ctx, stepArgs);
	const outcome = blocker || paused ? null : await db_step(ctx, stepArgs);
	// Work that ended inside the request, or a refusal before the first write, leaves no job. Work that
	// refused a named item keeps its job, so its Activity can list what was not archived. So does a
	// restore that kept items archived because their paths got too long, so its Activity says so. So
	// does a restore an API key started, so a retry with the same request id finds it.
	if (
		(outcome?.kind === "done" &&
			progress.blocked === 0 &&
			run.longPathOperationId === undefined &&
			!(args.kind === "restore" && args.credentialId !== null)) ||
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
		source: { kind: "files_archive_run", id: runId, archiveKind: args.kind, force },
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
	if (outcome) {
		await db_settle_step(ctx, { opId, runId, activityId, run, progress, outcome, now });
		// A request that failed after some writes keeps them and a failed Activity. Answer with the error, so
		// the caller does not say the work goes on in the background. `data` names the job, so an API
		// caller can read what the job did before it stopped.
		if (outcome.kind === "failed") {
			return Result({
				_nay: { ...outcome.nay, message: `Stopped partway: ${outcome.nay.message}`, data: { runId, activityId } },
			});
		}
	}

	// A job that goes on in the background can refuse more named items in later steps. A named item that
	// is neither stamped nor refused yet stays in the tree until a later step stamps it.
	const notArchivedNodeIds = run.refusedItems.map((refusedItem) => refusedItem.nodeId);
	const refusedItems = run.refusedItems.map(({ nodeId, refusal }) => ({ nodeId, message: refusal.message }));
	const waitingNodeIds =
		run.kind === "archive"
			? (run.phase === "apply" ? run.rootNodeIds.slice(run.applyRootIndex) : run.rootNodeIds).filter(
					(nodeId) => !notArchivedNodeIds.includes(nodeId),
				)
			: [];
	return Result({
		_yay: {
			runId,
			activityId,
			isDone: outcome?.kind === "done",
			notArchivedNodeIds,
			refusedItems,
			waitingNodeIds,
			isChecking: run.kind === "archive" && run.phase === "check",
		},
	});
}

/**
 * Delete permanently through the job. The caller checked that each named node is archived, that the
 * person can manage it, and that no named node is inside another one. The job checks every node
 * inside again and keeps what it may not delete.
 *
 * Returns `runId` null when the work finished inside this request with nothing kept. The counts are
 * of named items only.
 */
export async function files_archive_runs_db_start_purge(
	ctx: MutationCtx,
	args: {
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		nodes: Doc<"files_nodes">[];
	},
) {
	const { organizationId, workspaceId } = args.membership;

	// A restore or another purge of these paths waits for this job, and this job waits for them.
	const busyPaths = { discoverTreePaths: [] as string[] };
	for (const node of args.nodes) add_discover_tree_path(busyPaths, node.treePath);
	const blocker = await files_subtree_ops_db_find_blocker(ctx, {
		organizationId,
		workspaceId,
		treePaths: busyPaths.discoverTreePaths,
		waiter: null,
	});

	const now = Date.now();
	const run: RunFields = {
		organizationId,
		workspaceId,
		userId: args.userAuth.id,
		force: false,
		kind: "purge",
		// The named items can come from several archive operations. A new id matches none of them, so
		// the restore busy check never refuses because of this job. Restore waits for the paths instead.
		archiveOperationId: files_archive_operation_id_new(now),
		rootNodeIds: args.nodes.map((node) => node._id),
		phase: "apply",
		checkCursor: { rootIndex: 0, treePath: "" },
		discoverTreePaths: [],
		applyRootIndex: 0,
		active: true,
		skipOperationId: null,
		conflict: null,
		choice: null,
		applyToRemaining: { file: null, folder: null },
		revision: 0,
		requestFirstRunId: null,
		checkNamedItem: null,
		refusedItems: [],
	};
	const progress: RunProgress = {
		unit: "items",
		discovered: 0,
		total: null,
		completed: 0,
		skipped: 0,
		failed: 0,
		blocked: 0,
		canceled: 0,
	};

	const runId = await ctx.db.insert("files_archive_runs", run);
	const opId = await files_subtree_ops_db_insert(ctx, {
		op: {
			organizationId,
			workspaceId,
			userId: args.userAuth.id,
			status: blocker ? "queued" : "running",
			blockedByOpId: blocker?._id ?? null,
			rootNodeIds: run.rootNodeIds,
			treePaths: busyPaths.discoverTreePaths,
			kind: "purge",
			archiveRunId: runId,
		},
		now,
	});
	await files_subtree_ops_db_enqueue_nodes(ctx, {
		opId,
		nodes: args.nodes.map((node) => ({
			nodeId: node._id,
			nodeDone: false,
			purge: {
				rootNodeId: node._id,
				rootTreePath: node.treePath,
				rootOperationId: node.archiveOperationId!,
				parentId: node.parentId,
			},
		})),
	});

	const stepArgs: StepArgs = {
		opId,
		runId,
		run,
		progress,
		userAuth: args.userAuth,
		writeContext: await public_api_credentials_db_get_write_context(ctx, {
			credentialId: null,
			userId: args.userAuth.id,
			force: false,
		}),
		membership: args.membership,
		now,
		budget: {
			nodes: files_archive_runs_REQUEST_MAX_NODES,
			checkNodes: files_archive_runs_REQUEST_MAX_CHECK_NODES,
			hasPaginated: false,
		},
		isRequest: true,
		checkedScopes: new Map(),
		writeState: { isWritten: false },
		restoredParents: new Map(),
		isStopping: false,
	};
	// A Move holds nodes that the "no child" read cannot see, so the first step waits for it too.
	const paused =
		!blocker && (await files_subtree_ops_db_pause_for_move(ctx, (await ctx.db.get("files_subtree_ops", opId))!));
	const outcome = blocker || paused ? null : await db_step(ctx, stepArgs);

	const counts = {
		itemCount: args.nodes.length,
		// A named item is gone only once the job deleted it. The job reads at most 500 of them.
		deletedCount: (await Promise.all(run.rootNodeIds.map((nodeId) => ctx.db.get("files_nodes", nodeId)))).filter(
			(node) => node === null,
		).length,
		keptCount: run.refusedItems.length,
	};
	// Work that ended inside the request with nothing kept leaves no job.
	if (
		(outcome?.kind === "done" && progress.blocked === 0) ||
		(outcome?.kind === "failed" && !stepArgs.writeState.isWritten)
	) {
		await files_subtree_ops_db_delete(ctx, { opId, now });
		await ctx.db.delete("files_archive_runs", runId);
		return outcome.kind === "done" ? Result({ _yay: { runId: null, ...counts } }) : Result({ _nay: outcome.nay });
	}

	const activityId = await activities_db_start(ctx, {
		organizationId,
		workspaceId,
		userId: args.userAuth.id,
		membershipId: args.membership._id,
		membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, args.membership),
		source: { kind: "files_archive_run", id: runId, archiveKind: "purge", force: false },
		// Keep names and paths out of the title. The requester may lose access to the items later.
		title: "Delete files",
		targets: [],
		visibility: "requester",
		// A queued job shows no card until it starts.
		feedVisible: !blocker,
		status: blocker ? "queued" : "running",
		resultKind: "saved",
		progress,
		deadlineAt: now + (blocker ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
		now,
	});
	if (outcome) await db_settle_step(ctx, { opId, runId, activityId, run, progress, outcome, now });
	return Result({ _yay: { runId, ...counts } });
}

/**
 * One scheduled step of an archive, restore or purge op. `files_subtree_ops.advance` checked the op.
 */
export async function files_archive_runs_db_advance(
	ctx: MutationCtx,
	args: { op: Extract<Doc<"files_subtree_ops">, { kind: "archive" | "restore" | "purge" }>; now: number },
) {
	const storedRun = await ctx.db.get("files_archive_runs", args.op.archiveRunId);
	if (!storedRun?.active) return;

	// A step scheduled before a clash pause does nothing until the person answers.
	const activity = await db_require_activity(ctx, storedRun._id);
	if (activity.status === "awaiting_input") return;

	const { _id: runId, _creationTime: _runCreationTime, ...run } = storedRun;
	const progress = { ...activity.progress };
	const membership = await db_get_run_membership({ ctx, run: storedRun, activity });
	// A job an API key started stops its checks once the key is revoked or loses write, or its service
	// account is revoked, like a lost membership. Only the steps check this, so the person still sees
	// the job in the app.
	const isApiKeyLost =
		storedRun.credentialId !== undefined &&
		!(await public_api_credentials_db_is_live(ctx, {
			credentialId: storedRun.credentialId,
			userId: storedRun.userId,
			workspaceId: storedRun.workspaceId,
			scopes: storedRun.force ? ["files:write", "files:read-only"] : ["files:write"],
		}));
	const stepOutcome = await db_step(ctx, {
		opId: args.op._id,
		runId,
		run,
		progress,
		userAuth: { id: storedRun.userId },
		// When the key is lost, the step gets no membership, so no check runs. So read the key only while
		// it is live. A data purge may have deleted it.
		writeContext: await public_api_credentials_db_get_write_context(ctx, {
			credentialId: isApiKeyLost ? null : (storedRun.credentialId ?? null),
			userId: storedRun.userId,
			force: !isApiKeyLost && storedRun.force,
		}),
		membership: isApiKeyLost ? null : membership,
		now: args.now,
		budget: {
			nodes: files_archive_runs_STEP_MAX_NODES,
			checkNodes: files_archive_runs_CHECK_STEP_MAX_NODES,
			hasPaginated: false,
		},
		isRequest: false,
		checkedScopes: new Map(),
		writeState: { isWritten: false },
		restoredParents: new Map(),
		isStopping: activity.status === "stopping",
	});
	const outcome = isApiKeyLost && stepOutcome === MEMBERSHIP_LOST ? API_KEY_LOST : stepOutcome;

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
	args: { op: Extract<Doc<"files_subtree_ops">, { kind: "archive" | "restore" | "purge" }>; now: number },
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
 * or archived again as one unit. People can stop only a restore that waits for a clash choice. Workspace
 * deletion stops any job. User deletion lets an archive that stamps items finish first.
 *
 * A timeout does not stop a job that is not waiting for a choice. Archive has no Stop, so the deadline
 * only tells the recover cron to schedule the step again.
 *
 * Delete permanently can also be stopped, but only between nodes. While it deletes a node, a Stop marks
 * the Activity "stopping", and the next step ends the job after that node. A step that keeps failing
 * ends it only between nodes too.
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
			const opId = (await db_require_op(ctx, run._id))._id;
			// Before the apply phase the job changed nothing, so a step that keeps failing ends it. An apply
			// must go on: items it did not reach would stay active, with their links, inside the archived folder.
			if (
				(await files_subtree_ops_db_count_recover(ctx, { opId, activity })) &&
				(run.phase !== "apply" ||
					(run.kind === "archive" && run.force) ||
					(run.kind === "purge" && !(await db_is_purging_node(ctx, run))))
			) {
				await db_finish_run({
					ctx,
					runId: run._id,
					status: "failed",
					errorMessage: run.force
						? "A step of this job kept failing, so it stopped. Completed changes were kept."
						: "A step of this job kept failing, so it stopped. Nothing was changed.",
					errorCode: "failed",
					now: args.now,
				});
				return;
			}
			await ctx.db.patch("activities", activity._id, {
				deadlineAt: args.now + (activity.status === "queued" ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
			});
			await files_subtree_ops_db_recover(ctx, { opId });
			return;
		}
	}

	// Delete permanently stops only between nodes. While it deletes one, the next step ends the job
	// after that node.
	if (args.reason === "user" && run.kind === "purge" && (await db_is_purging_node(ctx, run))) {
		const activity = await db_require_activity(ctx, run._id);
		if (activity.status !== "stopping") {
			await ctx.db.patch("activities", activity._id, {
				status: "stopping",
				stopRequestedAt: args.now,
				updatedAt: args.now,
			});
		}
		return;
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
		errorMessage:
			[args.reason === "timeout" ? "The restore waited too long for a choice." : null, get_long_paths_end_text(run)]
				.filter((text) => text !== null)
				.join(" ") || null,
		errorCode: args.reason === "timeout" ? "timed_out" : "canceled",
		now: args.now,
	});
}

/**
 * The job the person owns, with its progress and the clash it waits on. The clash name and paths are
 * shown only when the person may read the node.
 * `archived` lists the paths of the other named items of an archive, and `notArchived` the paths of the
 * items it refused. Both show only nodes of the run's workspace that the person can still read.
 */
export const get = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_archive_runs"),
	},
	returns: v.union(
		v.object({
			kind: app_convex_schema.tables.files_archive_runs.validator.fields.kind,
			force: v.boolean(),
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
					canKeepBoth: v.boolean(),
				}),
				v.null(),
			),
			archived: v.array(v.object({ nodeId: v.id("files_nodes"), path: v.union(v.string(), v.null()) })),
			notArchived: v.array(
				v.object({
					nodeId: v.id("files_nodes"),
					path: v.union(v.string(), v.null()),
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
		const readableNodes = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			subject: { kind: "user", userId: userAuth.id, plugin: null },
			nodes: namedNodes,
		});
		const pathByNodeId = new Map(readableNodes.map((node) => [node._id, node.path]));
		const notArchived = run.refusedItems.map((refusedItem) => ({
			nodeId: refusedItem.nodeId,
			path: pathByNodeId.get(refusedItem.nodeId) ?? null,
			message: refusedItem.refusal.message,
		}));
		const archived = archivedNodeIds
			.filter(
				(nodeId) =>
					!run.force ||
					namedNodes.some((node) => node._id === nodeId && node.archiveOperationId === run.archiveOperationId),
			)
			.map((nodeId) => ({ nodeId, path: pathByNodeId.get(nodeId) ?? null }));

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
					// Keep both is not possible when no new name keeps the paths inside the limit.
					canKeepBoth:
						(await db_find_free_name({
							ctx,
							run,
							node,
							parentId: occupant.parentId,
							maxLength: get_keep_both_max_length({ run, node, occupant }),
						})) !== null,
				};
			}
		}

		return {
			kind: run.kind,
			force: run.force,
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
 * Outcomes keep their place in the page even when the item is no longer readable.
 */
export const list_outcomes = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_archive_runs"),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			order: v.number(),
			kind: v.union(v.literal("refused"), v.literal("retained_folder")),
			path: v.union(v.string(), v.null()),
			message: v.string(),
		}),
	),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (
			owned._nay ||
			(owned._yay.run.kind !== "purge" && (owned._yay.run.kind !== "archive" || !owned._yay.run.force))
		) {
			return { page: [], isDone: true, continueCursor: "" };
		}
		const { userAuth, membership, run } = owned._yay;
		const result = await ctx.db
			.query("files_archive_run_items")
			.withIndex("by_run_order", (q) => q.eq("runId", run._id))
			.paginate(args.paginationOpts);
		const page = await Promise.all(
			result.page.map(async (item) => {
				if (item.kind === "restore")
					throw should_never_happen("Forced archive has a restore outcome", { itemId: item._id });
				const node = await ctx.db.get("files_nodes", item.nodeId);
				const readable =
					node &&
					node.organizationId === run.organizationId &&
					node.workspaceId === run.workspaceId &&
					!(
						await access_control_db_authorize_membership(ctx, {
							userAuth,
							membership,
							permission: "content.read",
							fileNode: node,
						})
					)._nay;
				return {
					order: item.order,
					kind: readable && item.reason === "not_empty" ? ("retained_folder" as const) : ("refused" as const),
					path: readable ? node.path : null,
					message: !readable
						? "Permission denied"
						: item.kind === "purge"
							? PURGE_KEPT_MESSAGES[item.reason]
							: item.reason === "permission"
								? "Permission denied"
								: item.reason === "changed"
									? "This item moved or changed. Try again from its current folder."
									: "This folder still contains items. Review the skipped items, then try again.",
				};
			}),
		);
		return { ...result, page };
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

	// Stop first, so a step that is already scheduled writes nothing. A purge that deletes a node does
	// not stop at once, and this deletion cannot wait, so end it here.
	await files_archive_runs_db_request_stop(ctx, { runId: run._id, reason: "user", now: Date.now() });
	if ((await ctx.db.get("files_archive_runs", run._id))?.active) {
		await db_finish_run({
			ctx,
			runId: run._id,
			status: "canceled",
			errorMessage: null,
			errorCode: "canceled",
			now: Date.now(),
		});
	}
	// A restore can list many renamed or skipped items, so delete them 50 per call.
	const items = await ctx.db
		.query("files_archive_run_items")
		.withIndex("by_run_order", (q) => q.eq("runId", run._id))
		.take(50);
	for (const item of items) await ctx.db.delete("files_archive_run_items", item._id);
	if (items.length > 0) return { done: false, deletedCount: items.length };

	const activity = await activities_db_require_by_source_id(ctx, run._id);
	const deletedActivity = await activities_db_delete(ctx, activity._id);
	if (!deletedActivity.done) return deletedActivity;

	await ctx.db.delete("files_archive_runs", run._id);
	return { done: true, deletedCount: deletedActivity.deletedCount + 1 };
}
