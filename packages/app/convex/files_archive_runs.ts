// Archive and restore of a big folder do not fit in one mutation. This job changes a batch of nodes
// per step. Each node's side docs (text chunks, metadata docs) change in the same step as the node,
// so search and lists never see a node and its side docs disagree. A small request finishes inside
// the request and writes no run and no Activity.
//
// Archive walks the active nodes under each named item from the end of the tree, so a folder is
// archived only after everything inside it. Restore walks the nodes of one archive operation from
// the start of the tree, so a folder comes back before everything inside it. Neither walk keeps a
// cursor, and both read the live paths, so moves and new files during the job stay correct.

import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { WithoutSystemFields } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import {
	activities_db_delete,
	activities_db_finish,
	activities_db_require_by_source_id,
	activities_db_start,
	activities_get_controls,
	activities_get_result_status,
	activities_is_active,
} from "./activities_db.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import {
	authorize_file_write,
	authorize_leaving_restricted_scope,
	files_nodes_db_archive_node,
	files_nodes_db_require_swept_nodes_writable,
	files_nodes_db_require_user_writable,
	files_nodes_db_restore_node,
} from "./files_nodes.ts";
import {
	files_pending_updates_db_remove_archived_node_proposal,
	files_pending_updates_db_require_reviewed_archive_node,
} from "./files_pending_updates.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { files_db_get_pending_update, files_ROOT_ID } from "../server/files.ts";
import { path_tree_prefix_upper_bound, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * An apply step ends after this many nodes. On dev, one archived node costs about 8.5 ms of
 * database time and one restored node about 16 ms, so a step stays near 1 to 3 seconds.
 */
export const files_archive_runs_STEP_MAX_NODES = 150;

/**
 * A check step reads at most this many nodes. It writes nothing, so it can read more than an apply step.
 */
const CHECK_STEP_MAX_NODES = 500;

/**
 * A step also ends when less than this share of a transaction limit is left. A file with many text
 * chunks writes far more than its node, so the node count alone is not enough.
 */
const METRICS_MIN_REMAINING_SHARE = 0.25;

const PAGE_SIZE = 50;
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
 * Keep both tries `name-2`, `name-3`, and so on up to this counter.
 */
const MAX_NAME_ATTEMPTS = 100;

type RunFields = WithoutSystemFields<Doc<"files_archive_runs">>;
type RunProgress = NonNullable<Doc<"activities">["progress"]>;

type StepArgs = {
	/**
	 * A copy of the run that the step changes. The caller saves it.
	 */
	run: RunFields;
	progress: RunProgress;
	userAuth: { id: Id<"users"> };
	membership: Doc<"organizations_workspaces_users">;
	now: number;
	/**
	 * How many more nodes this mutation may change. A restore of several operations shares one budget
	 * across them, so one request cannot run past the mutation time limit.
	 */
	budget: { nodes: number };
	/**
	 * The restricted scopes already checked in this step. The key "" stands for no scope.
	 */
	checkedScopes: Map<string, boolean>;
	isWritten: boolean;
};

type StepOutcome =
	| { kind: "continue" }
	| { kind: "done" }
	| { kind: "paused" }
	| { kind: "failed"; nay: { name?: string; message: string } };

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

/**
 * Recheck the membership the job started with. A leave and re-join gives a new lifetime, so it stops
 * the job even though the person is a member again.
 */
async function db_get_run_membership(
	ctx: QueryCtx | MutationCtx,
	run: Doc<"files_archive_runs">,
	activity: Awaited<ReturnType<typeof db_require_activity>>,
) {
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
	const membership = await db_get_run_membership(ctx, run, activity);
	if (!membership || membership._id !== args.membershipId) return Result({ _nay: { message: "Not found" } });
	return Result({ _yay: { userAuth, run, activity, membership } });
}

async function db_is_near_limits(ctx: MutationCtx) {
	const metrics = await ctx.meta.getTransactionMetrics();
	return [
		metrics.bytesRead,
		metrics.bytesWritten,
		metrics.documentsRead,
		metrics.documentsWritten,
		metrics.databaseQueries,
	].some((metric) => metric.remaining < (metric.used + metric.remaining) * METRICS_MIN_REMAINING_SHARE);
}

/**
 * The person must still write each node the job changes: the node's own lock, and write access
 * where it lives. Access is asked once per restricted scope, and once for the unrestricted part of
 * the workspace, so an ordinary tree costs one check per step.
 */
async function db_check_writable_nodes(ctx: MutationCtx, args: StepArgs, nodes: readonly Doc<"files_nodes">[]) {
	for (const node of nodes) {
		const scopeKey = node.restrictedScopeNodeId ?? "";
		let allowed = args.checkedScopes.get(scopeKey);
		if (allowed === undefined) {
			const authorized = await access_control_db_authorize_membership(ctx, {
				userAuth: args.userAuth,
				membership: args.membership,
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
async function db_check_restore_folder(ctx: MutationCtx, args: StepArgs, folder: Doc<"files_nodes">) {
	const writable = await files_nodes_db_require_user_writable(ctx, { node: folder, userId: args.userAuth.id });
	if (!writable._nay) return null;

	const readable = await access_control_db_authorize_membership(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
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
 * leave the item's restricted folder, like `move_nodes`. An item that is its own restricted folder
 * keeps its scope wherever it lands, so it needs neither.
 */
async function db_check_restore_move(ctx: MutationCtx, args: StepArgs, node: Doc<"files_nodes">) {
	if (node.restrictedScopeNodeId === node._id) return null;

	const authorizedTarget = await authorize_file_write(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		nodeId: files_ROOT_ID,
	});
	if (authorizedTarget._nay) return { kind: "failed", nay: authorizedTarget._nay } as const;

	const authorizedLeaving = await authorize_leaving_restricted_scope(ctx, {
		userAuth: args.userAuth,
		membership: args.membership,
		fileNode: node,
		destParentId: files_ROOT_ID,
	});
	if (authorizedLeaving._nay) return { kind: "failed", nay: authorizedLeaving._nay } as const;

	return null;
}

/**
 * Whether an archived node found under the root's path really sits inside the root. An older archived
 * tree can have the same paths, so follow parent ids up to the root.
 */
async function db_is_descendant(
	ctx: MutationCtx,
	node: Doc<"files_nodes">,
	root: Doc<"files_nodes">,
	cache: Map<Id<"files_nodes">, boolean>,
) {
	const visited: Array<Id<"files_nodes">> = [];
	let parentId = node.parentId;
	let result = false;
	while (true) {
		if (parentId === root._id) {
			result = true;
			break;
		}
		if (parentId === files_ROOT_ID) break;
		const cached = cache.get(parentId);
		if (cached !== undefined) {
			result = cached;
			break;
		}
		const parent = await ctx.db.get("files_nodes", parentId);
		if (!parent || !parent.treePath.startsWith(root.treePath)) break;
		visited.push(parentId);
		parentId = parent.parentId;
	}
	for (const id of visited) cache.set(id, result);
	return result;
}

/**
 * Check everything the archive will change before it writes anything: each active node, and each
 * archived node inside, which must not be hidden while it is read-only.
 */
async function db_check_archive(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	const descendantCache = new Map<Id<"files_nodes">, boolean>();
	let readCount = 0;

	while (run.checkCursor.rootIndex < run.rootNodeIds.length) {
		if (readCount >= CHECK_STEP_MAX_NODES || (await db_is_near_limits(ctx))) return { kind: "continue" };

		const root = await ctx.db.get("files_nodes", run.rootNodeIds[run.checkCursor.rootIndex]!);
		// A named item that is gone or archived by now leaves nothing to archive.
		if (!root || root.archiveOperationId !== null) {
			run.checkCursor = { rootIndex: run.checkCursor.rootIndex + 1, treePath: "" };
			continue;
		}

		if (run.checkCursor.treePath === "") {
			const refusal = await db_check_writable_nodes(ctx, args, [root]);
			if (refusal) return refusal;
			progress.discovered += 1;
			if (root.kind === "file") {
				run.checkCursor = { rootIndex: run.checkCursor.rootIndex + 1, treePath: "" };
				continue;
			}
			run.checkCursor = { ...run.checkCursor, treePath: root.treePath };
		}

		// If the folder moved during the check, its old path would read other folders. Check it again
		// from its new path. The apply steps check every node anyway.
		const cursorTreePath = run.checkCursor.treePath.startsWith(root.treePath)
			? run.checkCursor.treePath
			: root.treePath;
		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_treePath", (q) =>
				q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId)
					.gt("treePath", cursorTreePath)
					.lt("treePath", path_tree_prefix_upper_bound(root.treePath)),
			)
			.take(PAGE_SIZE);
		const isLastPage = page.length < PAGE_SIZE;
		const lastNode = page.at(-1);
		// Archived nodes can share a `treePath`. The next page starts after this `treePath`, so read the
		// rest of the last group now. Two nodes can have the same `_creationTime`, so read from that time
		// on and skip the nodes the page already has.
		if (!isLastPage && lastNode) {
			const pageIds = new Set(page.map((node) => node._id));
			const sameTreePath = (
				await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_treePath", (q) =>
						q
							.eq("organizationId", run.organizationId)
							.eq("workspaceId", run.workspaceId)
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

		const activeNodes = page.filter((node) => node.archiveOperationId === null);
		const refusal = await db_check_writable_nodes(ctx, args, activeNodes);
		if (refusal) return refusal;

		// Archive does not change archived nodes inside. But it must not hide a read-only one under a
		// newly archived folder. Use a general error when the person cannot see it.
		const archivedNodes: Array<Doc<"files_nodes">> = [];
		for (const node of page) {
			if (node.archiveOperationId !== null && (await db_is_descendant(ctx, node, root, descendantCache))) {
				archivedNodes.push(node);
			}
		}
		const archivedProtected = await files_nodes_db_require_swept_nodes_writable(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			writeContext: {
				writer: { kind: "user", userId: args.userAuth.id },
				actorUserId: args.userAuth.id,
				resourceScope: { kind: "workspace" },
				policyReach: "ancestors",
			},
			nodes: archivedNodes,
		});
		if (archivedProtected._nay) return { kind: "failed", nay: archivedProtected._nay };

		progress.discovered += activeNodes.length;
		run.checkCursor = isLastPage
			? { rootIndex: run.checkCursor.rootIndex + 1, treePath: "" }
			: { ...run.checkCursor, treePath: page.at(-1)!.treePath };
	}

	return { kind: "done" };
}

/**
 * Archive the active nodes under each named item, from the end of the tree, and the item itself last.
 *
 * Each page is the last active nodes under the item. When a folder is in the page, every active node
 * after it in tree order is in the page too, and its contents come after it. So a folder is archived
 * only after everything inside it, and no active node ever sits inside an archived folder. A node
 * created inside during the job lands in the same range and is archived by a later page.
 */
async function db_apply_archive(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	let count = 0;

	while (run.applyRootIndex < run.rootNodeIds.length) {
		const root = await ctx.db.get("files_nodes", run.rootNodeIds[run.applyRootIndex]!);
		// Archived by this job, or by somebody else in the meantime. Either way nothing is left.
		if (!root || root.archiveOperationId !== null) {
			run.applyRootIndex += 1;
			continue;
		}

		const page =
			root.kind === "folder"
				? await ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
							q
								.eq("organizationId", run.organizationId)
								.eq("workspaceId", run.workspaceId)
								.eq("archiveOperationId", null)
								.gt("treePath", root.treePath)
								.lt("treePath", path_tree_prefix_upper_bound(root.treePath)),
						)
						.order("desc")
						.take(PAGE_SIZE)
				: [];
		const nodes = page.length < PAGE_SIZE ? [...page, root] : page;

		for (const node of nodes) {
			if (args.budget.nodes <= 0 || (count > 0 && (await db_is_near_limits(ctx)))) return { kind: "continue" };

			// Locks and access may change during the job. Nodes already archived stay archived with this
			// job's operation id, so one Restore brings them back.
			const refusal = await db_check_writable_nodes(ctx, args, [node]);
			if (refusal) return refusal;

			await files_nodes_db_archive_node(ctx, {
				node,
				archiveOperationId: run.archiveOperationId,
				updatedBy: args.userAuth.id,
				now: args.now,
			});
			if (run.pendingUpdateCleanup) {
				await files_pending_updates_db_remove_archived_node_proposal(ctx, {
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					userId: args.userAuth.id,
					nodeId: node._id,
				});
			}
			args.isWritten = true;
			progress.completed += 1;
			count += 1;
			args.budget.nodes -= 1;
		}

		if (nodes.at(-1) === root) run.applyRootIndex += 1;
	}

	return { kind: "done" };
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
					.eq("workspaceId", args.occupant.workspaceId)
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
					.eq("workspaceId", args.occupant.workspaceId)
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
 * Check every node of the operation before the restore writes anything. Also find the items whose
 * folder is archived by another operation. They land at the workspace root.
 * The list is fixed here. A folder archived later, during the job, keeps its restored items inside.
 */
async function db_check_restore(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	const parents = new Map<Id<"files_nodes">, Doc<"files_nodes"> | null>();
	let readCount = 0;

	while (true) {
		if (readCount >= CHECK_STEP_MAX_NODES || (await db_is_near_limits(ctx))) return { kind: "continue" };

		const cursorTreePath = run.checkCursor.treePath;
		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
				q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId)
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

		const refusal = await db_check_writable_nodes(ctx, args, page);
		if (refusal) return refusal;

		for (const node of page) {
			progress.discovered += 1;
			if (node.parentId === files_ROOT_ID) continue;

			let parent = parents.get(node.parentId);
			if (parent === undefined) {
				parent = await ctx.db.get("files_nodes", node.parentId);
				parents.set(node.parentId, parent);
			}
			// A folder of the same operation is checked as a node of its own.
			if (!parent || parent.archiveOperationId === run.archiveOperationId) continue;

			const folderRefusal = await db_check_restore_folder(ctx, args, parent);
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
					nay: { name: "busy", message: "These items are being archived. Wait for it to finish or stop it." },
				};
			}
			if (parentOperationId !== null && !parentRun) {
				const moveRefusal = await db_check_restore_move(ctx, args, node);
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
	ctx: MutationCtx,
	args: StepArgs,
	node: Doc<"files_nodes">,
	parentId: Doc<"files_nodes">["parentId"],
) {
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
					.eq("workspaceId", args.run.workspaceId)
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
 * Restore the nodes of the operation from the start of the tree, so each folder comes back before
 * what is inside it. Each node lands under its parent's current path, so a folder that moved during
 * the job takes its contents along.
 */
async function db_apply_restore(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	const { run, progress } = args;
	let count = 0;

	while (true) {
		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_archiveOperation_treePath", (q) =>
				q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId)
					.eq("archiveOperationId", run.archiveOperationId),
			)
			.take(PAGE_SIZE);
		if (page.length === 0) return { kind: "done" };

		for (const node of page) {
			if (args.budget.nodes <= 0 || (count > 0 && (await db_is_near_limits(ctx)))) return { kind: "continue" };
			count += 1;
			args.budget.nodes -= 1;

			// Read the parent again for each node. This step may have just restored it.
			const parent = node.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", node.parentId);
			const parentOperationId = parent?.archiveOperationId ?? null;
			let landing: Doc<"files_nodes"> | null;
			if (parent && parentOperationId === null) {
				landing = parent;
			} else if (parentOperationId === null || run.rootNodeIds.includes(node._id)) {
				landing = null;
			}
			// The parent was skipped, or somebody archived it during the job. Keep the node with it, so
			// no active node sits inside an archived folder.
			else {
				const refusal = await db_check_writable_nodes(ctx, args, [node]);
				if (refusal) return refusal;
				await files_nodes_db_archive_node(ctx, {
					node,
					archiveOperationId: parentOperationId,
					updatedBy: args.userAuth.id,
					now: args.now,
				});
				args.isWritten = true;
				progress.skipped += 1;
				continue;
			}
			const landingParentId = landing?._id ?? files_ROOT_ID;

			// Locks and access may change during the job. Nodes already restored stay restored.
			const refusal =
				(await db_check_writable_nodes(ctx, args, [node])) ??
				(landing ? await db_check_restore_folder(ctx, args, landing) : null) ??
				(parent && parent !== landing ? await db_check_restore_folder(ctx, args, parent) : null) ??
				(landingParentId !== node.parentId ? await db_check_restore_move(ctx, args, node) : null);
			if (refusal) return refusal;

			let name = node.name;
			let replacedNode: Doc<"files_nodes"> | null = null;
			const occupant = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", run.organizationId)
						.eq("workspaceId", run.workspaceId)
						.eq("parentId", landingParentId)
						.eq("name", node.name)
						.eq("archiveOperationId", null),
				)
				.first();
			if (occupant) {
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
							membership: args.membership,
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
					args.isWritten = true;
					progress.skipped += 1;
					continue;
				}

				if (choice === "keep_both") {
					const freeName = await db_find_free_name(ctx, args, node, landingParentId);
					if (freeName === null) return { kind: "failed", nay: { message: "No free name was found." } };
					name = freeName;
				} else {
					replacedNode = occupant;
				}
			}

			const restored = await files_nodes_db_restore_node(ctx, {
				node,
				parent: landing,
				name,
				updatedBy: args.userAuth.id,
				now: args.now,
			});
			if (restored._nay) return { kind: "failed", nay: restored._nay };
			// Replace archives the occupant only after the restore worked, so a refused restore keeps it. It
			// gets its own operation id, so it can come back alone. The pause check above already ran
			// `db_can_replace` in this mutation.
			if (replacedNode) {
				await files_nodes_db_archive_node(ctx, {
					node: replacedNode,
					archiveOperationId: crypto.randomUUID(),
					updatedBy: args.userAuth.id,
					now: args.now,
				});
				args.budget.nodes -= 1;
			}
			args.isWritten = true;
			progress.completed += 1;
			// Items that moved with the folder cost writes too.
			args.budget.nodes -= restored._yay.movedDocCount;
		}
	}
}

/**
 * Run one step: the check walk first, then the changes. A step that finishes the check goes on with
 * the changes in the same mutation, so a small request ends inside the request.
 */
async function db_step(ctx: MutationCtx, args: StepArgs): Promise<StepOutcome> {
	if (args.run.phase === "check") {
		const checked = args.run.kind === "archive" ? await db_check_archive(ctx, args) : await db_check_restore(ctx, args);
		if (checked.kind !== "done") return checked;
		args.run.phase = "apply";
		args.progress.total = args.progress.discovered;
	}

	const outcome = args.run.kind === "archive" ? await db_apply_archive(ctx, args) : await db_apply_restore(ctx, args);
	if (args.isWritten) await files_media_validation_db_advance_version(ctx, args.run);
	// Items created or joined during the job are counted too, so keep the total at least as big.
	if (args.progress.total !== null) {
		args.progress.total = Math.max(args.progress.total, args.progress.completed + args.progress.skipped);
	}
	return outcome;
}

async function db_finish_run(
	ctx: MutationCtx,
	run: Pick<Doc<"files_archive_runs">, "_id" | "kind" | "requestFirstRunId">,
	args: Omit<Parameters<typeof activities_db_finish>[1], "sourceId">,
) {
	const activity = await db_require_activity(ctx, run._id);
	await ctx.db.patch("files_archive_runs", run._id, { active: false });
	await activities_db_finish(ctx, { sourceId: run._id, ...args });

	// The restore jobs of one request run one at a time, so their steps do not write the same docs at
	// the same moment. When a job that was running ends, start the oldest queued job of the same
	// request. Another request has its own running job, so starting one of its jobs would run two at
	// once. A queued job that ends, or a job that ended before, starts nothing, so each end starts one
	// job. Mark it running here, not in its first step, so a second job that ends before that step
	// starts a different one.
	if (run.kind !== "restore" || !activities_is_active(activity.status) || activity.status === "queued") return;
	const nextRun = await ctx.db
		.query("files_archive_runs")
		.withIndex("by_requestFirstRun_active", (q) =>
			q.eq("requestFirstRunId", run.requestFirstRunId ?? run._id).eq("active", true),
		)
		.first();
	if (nextRun) {
		const nextActivity = await db_require_activity(ctx, nextRun._id);
		await ctx.db.patch("activities", nextActivity._id, {
			status: "running",
			startedAt: args.now,
			deadlineAt: args.now + RUN_TIMEOUT_MS,
			updatedAt: args.now,
		});
		await ctx.scheduler.runAfter(0, internal.files_archive_runs.advance, { runId: nextRun._id });
	}
}

/**
 * Save a step's result on the run and its Activity, then schedule the next step or finish.
 */
async function db_settle_step(
	ctx: MutationCtx,
	args: {
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
		...(args.outcome.kind === "paused" ? { status: "awaiting_input" as const } : {}),
		deadlineAt: args.now + (args.outcome.kind === "paused" ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
		updatedAt: args.now,
	});

	switch (args.outcome.kind) {
		case "continue": {
			await ctx.scheduler.runAfter(0, internal.files_archive_runs.advance, { runId: args.runId });
			return;
		}
		case "paused": {
			return;
		}
		case "done": {
			await db_finish_run(
				ctx,
				{ ...args.run, _id: args.runId },
				{
					status: activities_get_result_status(args.progress),
					errorMessage: null,
					now: args.now,
				},
			);
			return;
		}
		case "failed": {
			// Nothing changed while the job was still checking. After that, the changed items keep the
			// job's operation id, so one Restore or Archive brings them back.
			const isPartway = args.progress.completed + args.progress.skipped > 0;
			await db_finish_run(
				ctx,
				{ ...args.run, _id: args.runId },
				{
					status: "failed",
					errorMessage: isPartway ? `Stopped partway: ${args.outcome.nay.message}` : args.outcome.nay.message,
					errorCode: "failed",
					now: args.now,
				},
			);
			return;
		}
		default:
			throw should_never_happen("Unknown archive step outcome", args.outcome satisfies never);
	}
}

/**
 * Refuse work on an item that a running job is changing. A second archive over the same folder would
 * split it into two operations, and restoring an operation while it is still being written would
 * race with the job.
 */
async function db_find_busy_run(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		kind: "archive" | "restore";
		archiveOperationId: string;
		nodes: readonly Doc<"files_nodes">[];
	},
) {
	if (args.kind === "restore") {
		return await ctx.db
			.query("files_archive_runs")
			.withIndex("by_organization_workspace_archiveOperation_active", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("archiveOperationId", args.archiveOperationId)
					.eq("active", true),
			)
			.first();
	}

	for await (const run of ctx.db
		.query("files_archive_runs")
		.withIndex("by_organization_workspace_active_kind", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("active", true)
				.eq("kind", "archive"),
		)) {
		for (const rootNodeId of run.rootNodeIds) {
			const root = await ctx.db.get("files_nodes", rootNodeId);
			// A named item the job already archived no longer blocks new work.
			if (!root || root.archiveOperationId !== null) continue;
			// Only a folder's `treePath` ends with "/", so a prefix match never mixes up siblings.
			const overlaps = args.nodes.some(
				(node) =>
					node._id === root._id ||
					(node.kind === "folder" && root.treePath.startsWith(node.treePath)) ||
					(root.kind === "folder" && node.treePath.startsWith(root.treePath)),
			);
			if (overlaps) return run;
		}
	}
	return null;
}

/**
 * Archive or restore through the job. The caller already checked the items the person named.
 * Returns null when the work finished inside this request, or the job that goes on in the background.
 */
export async function files_archive_runs_db_start(
	ctx: MutationCtx,
	args: {
		kind: "archive" | "restore";
		userAuth: { id: Id<"users"> };
		membership: Doc<"organizations_workspaces_users">;
		archiveOperationId: string;
		/**
		 * Archive: the named active items. Restore: empty; the check fills it.
		 */
		rootNodeIds: Array<Id<"files_nodes">>;
		pendingUpdateCleanup: RunFields["pendingUpdateCleanup"];
		budget: { nodes: number };
		/**
		 * Set on a restore that waits behind the first job of its Unarchive request. It writes nothing
		 * now. It starts when the running job of the same request ends.
		 */
		requestFirstRunId: Id<"files_archive_runs"> | null;
	},
) {
	const queued = args.requestFirstRunId !== null;
	const rootNodes = (await Promise.all(args.rootNodeIds.map((id) => ctx.db.get("files_nodes", id)))).filter(
		(node) => node !== null,
	);
	const busy = await db_find_busy_run(ctx, {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		kind: args.kind,
		archiveOperationId: args.archiveOperationId,
		nodes: rootNodes,
	});
	if (busy) {
		return Result({
			_nay: {
				name: "busy",
				message:
					busy.kind === "archive"
						? "These items are being archived. Wait for it to finish or stop it."
						: "These items are being restored. Wait for it to finish or stop it.",
			},
		});
	}

	const now = Date.now();
	const run: RunFields = {
		organizationId: args.membership.organizationId,
		workspaceId: args.membership.workspaceId,
		userId: args.userAuth.id,
		kind: args.kind,
		archiveOperationId: args.archiveOperationId,
		rootNodeIds: args.rootNodeIds,
		phase: "check",
		checkCursor: { rootIndex: 0, treePath: "" },
		applyRootIndex: 0,
		active: true,
		skipOperationId: null,
		conflict: null,
		choice: null,
		applyToRemaining: { file: null, folder: null },
		revision: 0,
		pendingUpdateCleanup: args.pendingUpdateCleanup,
		requestFirstRunId: args.requestFirstRunId,
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

	const stepArgs: StepArgs = {
		run,
		progress,
		userAuth: args.userAuth,
		membership: args.membership,
		now,
		budget: args.budget,
		checkedScopes: new Map(),
		isWritten: false,
	};
	const outcome = queued ? null : await db_step(ctx, stepArgs);
	if (outcome?.kind === "done") return Result({ _yay: null });
	// A refusal before the first write changed nothing, so the request returns it and makes no job.
	if (outcome?.kind === "failed" && !stepArgs.isWritten) return Result({ _nay: outcome.nay });

	const runId = await ctx.db.insert("files_archive_runs", run);
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
		feedVisible: true,
		status: queued ? "queued" : "running",
		resultKind: "saved",
		progress,
		// A queued job may wait while the job before it waits for a clash choice, so it gets as long. The
		// deadline check gives it more time while that job is still active.
		deadlineAt: now + (queued ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
		now,
	});
	if (!outcome) return Result({ _yay: { runId, activityId } });

	await db_settle_step(ctx, { runId, activityId, run, progress, outcome, now });
	// A request that failed after some writes keeps them and a failed Activity. Answer with the error, so
	// the caller does not say the work goes on in the background.
	if (outcome.kind === "failed") {
		return Result({ _nay: { ...outcome.nay, message: `Stopped partway: ${outcome.nay.message}` } });
	}
	return Result({ _yay: { runId, activityId } });
}

export const advance = internalMutation({
	args: { runId: v.id("files_archive_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const storedRun = await ctx.db.get("files_archive_runs", args.runId);
		if (!storedRun?.active) return null;

		// Stop and the deadline finish the Activity. A step scheduled before that does nothing, and so
		// does a step while the job waits for a choice.
		const activity = await db_require_activity(ctx, storedRun._id);
		if (!activities_is_active(activity.status) || activity.status === "awaiting_input") return null;
		const now = Date.now();
		if (activity.deadlineAt <= now) {
			await files_archive_runs_db_request_stop(ctx, { runId: storedRun._id, reason: "timeout", now });
			return null;
		}

		const { _id: runId, _creationTime: _runCreationTime, ...run } = storedRun;
		const progress = { ...activity.progress };
		const membership = await db_get_run_membership(ctx, storedRun, activity);
		// An accepted agent delete keeps its proposal on the named folder until the folder is archived
		// last. If the person discards it during the job, stop the job.
		const deleteProposal =
			storedRun.pendingUpdateCleanup && storedRun.rootNodeIds[0]
				? await files_db_get_pending_update(ctx, {
						organizationId: storedRun.organizationId,
						workspaceId: storedRun.workspaceId,
						userId: storedRun.userId,
						target: { kind: "saved", id: storedRun.rootNodeIds[0] },
					})
				: null;
		const outcome: StepOutcome = !membership
			? { kind: "failed", nay: { message: "You can no longer change these files." } }
			: storedRun.pendingUpdateCleanup && !deleteProposal?.pendingArchive
				? { kind: "failed", nay: { message: "The delete was discarded." } }
				: await db_step(ctx, {
						run,
						progress,
						userAuth: { id: storedRun.userId },
						membership,
						now,
						budget: { nodes: files_archive_runs_STEP_MAX_NODES },
						checkedScopes: new Map(),
						isWritten: false,
					});

		await db_settle_step(ctx, { runId, activityId: activity._id, run, progress, outcome, now });
		return null;
	},
});

/**
 * Finish the job at once. Items already changed keep the job's operation id, so they can be restored
 * or archived again as one unit.
 */
export async function files_archive_runs_db_request_stop(
	ctx: MutationCtx,
	args: { runId: Id<"files_archive_runs">; reason: "user" | "timeout"; now: number },
) {
	const run = await ctx.db.get("files_archive_runs", args.runId);
	if (!run) return;

	// A queued restore waits for the jobs of its request ahead of it, and one of them can wait up to
	// 24 h for a clash choice, more than once. So while an earlier job of the same request is still
	// active, give the queued job more time instead of ending it. Keep `updatedAt`: nothing about the
	// job changed.
	if (args.reason === "timeout" && run.requestFirstRunId !== null) {
		const requestFirstRunId = run.requestFirstRunId;
		const activity = await db_require_activity(ctx, run._id);
		const firstRun = await ctx.db.get("files_archive_runs", requestFirstRunId);
		// The index keeps creation order, so the first active job of the request is the earliest.
		const earliestActiveRun = firstRun?.active
			? firstRun
			: await ctx.db
					.query("files_archive_runs")
					.withIndex("by_requestFirstRun_active", (q) =>
						q.eq("requestFirstRunId", requestFirstRunId).eq("active", true),
					)
					.first();
		if (activity.status === "queued" && earliestActiveRun && earliestActiveRun._id !== run._id) {
			await ctx.db.patch("activities", activity._id, { deadlineAt: args.now + CHOICE_TIMEOUT_MS });
			return;
		}
	}

	await db_finish_run(ctx, run, {
		status: args.reason === "timeout" ? "timed_out" : "canceled",
		errorMessage: args.reason === "timeout" ? "The archive job reached its time limit." : null,
		errorCode: args.reason === "timeout" ? "timed_out" : "canceled",
		now: args.now,
	});
}

/**
 * The job the person owns, with its progress and the clash it waits on. The clash name and paths are
 * shown only when the person may read the node.
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
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return null;
		const { userAuth, run, activity, membership } = owned._yay;

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
					message: "Replace needs the same kind, an empty folder, and write access to the item in the way and everything inside it.",
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
		await ctx.scheduler.runAfter(0, internal.files_archive_runs.advance, { runId: run._id });
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
