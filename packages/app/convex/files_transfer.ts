import { vOnCompleteArgs, Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { activities_db_get_by_source_id } from "./activities.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import app_convex_schema from "./schema.ts";
import {
	authorize_file_write,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_move_nodes,
	files_nodes_db_require_user_writable,
} from "./files_nodes.ts";
import { files_metadata_db_read_entries } from "./files_metadata.ts";
import { files_nodes_content_db_discard_transfer_file_attempt } from "./files_nodes_content.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { path_join, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { files_normalize_file_rename_name, files_normalize_name, files_ROOT_ID } from "../shared/files.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

const MAX_SELECTED_NODES = 200;
const MAX_COPY_ITEMS = 10_000;
const DISCOVERY_PAGE_SIZE = 50;
const MAX_NAME_ATTEMPTS = 100;
const MAX_NAME_LOOKUPS_PER_BATCH = 200;
const MAX_IN_FLIGHT = 2;
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const CHOICE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const files_transfer_workpool = new Workpool(components.files_transfer_workpool, {
	maxParallelism: MAX_IN_FLIGHT,
	retryActionsByDefault: false,
});

/**
 * Patch the run and mirror it into its activity in the caller's transaction, so the feed never
 * disagrees with the run.
 */
async function db_patch_run(
	ctx: MutationCtx,
	runId: Id<"files_transfer_runs">,
	patch: Partial<
		Pick<
			Doc<"files_transfer_runs">,
			| "phase"
			| "active"
			| "revision"
			| "total"
			| "completed"
			| "skipped"
			| "failed"
			| "inFlight"
			| "applyToRemaining"
			| "errorMessage"
			| "expiresAt"
			| "finishedAt"
		>
	>,
) {
	const run = await ctx.db.get("files_transfer_runs", runId);
	if (!run) return;

	const now = Date.now();
	const next = { ...run, ...patch, updatedAt: now };
	await ctx.db.patch("files_transfer_runs", runId, { ...patch, updatedAt: now });

	const activity = await activities_db_get_by_source_id(ctx, runId);
	if (!activity) return;

	await ctx.db.patch("activities", activity._id, {
		status: next.active
			? "running"
			: next.phase === "completed"
				? "succeeded"
				: next.phase === "canceled"
					? "canceled"
					: "failed",
		source: {
			kind: "files_transfer_run",
			id: runId,
			transferKind: next.kind,
			phase: next.phase,
			total: next.total,
			completed: next.completed,
			skipped: next.skipped,
			failed: next.failed,
		},
		errorMessage: next.errorMessage,
		timeoutAt: next.expiresAt,
		...(next.finishedAt === null ? {} : { finishedAt: next.finishedAt }),
		updatedAt: now,
	});
}

async function db_get_owned_run(
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

/**
 * Resolve the requester's membership from a run doc, after checking the user and workspace still
 * exist.
 */
async function db_get_run_membership(ctx: QueryCtx | MutationCtx, run: Doc<"files_transfer_runs">) {
	const user = await ctx.db.get("users", run.userId);
	if (!user || user.deletedAt !== undefined) return null;

	const workspace = await ctx.db.get("organizations_workspaces", run.workspaceId);
	if (!workspace || workspace.organizationId !== run.organizationId || workspace.pluginDataPurgeStartedAt !== undefined)
		return null;

	return await organizations_db_get_membership(ctx, { userId: run.userId, membershipId: run.membershipId });
}

async function db_get_destination(
	ctx: QueryCtx | MutationCtx,
	args: {
		run: Pick<Doc<"files_transfer_runs">, "organizationId" | "workspaceId" | "userId">;
		membership: Doc<"organizations_workspaces_users">;
		parentId: Doc<"files_nodes">["parentId"];
		expectedPath: string;
	},
) {
	const node = args.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.parentId);
	if (
		args.parentId !== files_ROOT_ID &&
		(!node ||
			node.kind !== "folder" ||
			node.archiveOperationId !== null ||
			node.organizationId !== args.run.organizationId ||
			node.workspaceId !== args.run.workspaceId ||
			node.path !== args.expectedPath)
	) {
		return Result({ _nay: { message: "Destination changed" } });
	}

	const authorized = await authorize_file_write(ctx, {
		userAuth: { id: args.run.userId },
		membership: args.membership,
		nodeId: args.parentId,
	});
	if (authorized._nay) return Result({ _nay: { message: "Permission denied" } });

	if (node) {
		const writable = await files_nodes_db_require_user_writable(ctx, { node, userId: args.run.userId });
		if (writable._nay) return writable;
	}
	return Result({ _yay: node });
}

async function db_pause_item(
	ctx: MutationCtx,
	item: Doc<"files_transfer_items">,
	kind: NonNullable<Doc<"files_transfer_items">["conflictKind"]>,
) {
	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run || !run.active || run.phase === "stopping") return;

	await ctx.db.patch("files_transfer_items", item._id, { state: "conflict", conflictKind: kind, choice: null });
	await db_patch_run(ctx, run._id, {
		phase: "awaiting_choice",
		revision: run.revision + 1,
		expiresAt: Date.now() + CHOICE_TIMEOUT_MS,
	});
}

async function db_skip_item(ctx: MutationCtx, item: Doc<"files_transfer_items">) {
	if (item.state === "completed" || item.state === "skipped" || item.state === "failed") return;

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return;

	await ctx.db.patch("files_transfer_items", item._id, { state: "skipped", conflictKind: null, choice: "skip" });
	await db_patch_run(ctx, run._id, { skipped: run.skipped + 1 });
}

async function db_stop_run(ctx: MutationCtx, run: Doc<"files_transfer_runs">, errorMessage: string | null) {
	if (!run.active) return;

	await db_patch_run(ctx, run._id, {
		phase: run.inFlight > 0 ? "stopping" : errorMessage ? "failed" : "canceled",
		active: run.inFlight > 0,
		errorMessage,
		finishedAt: run.inFlight > 0 ? null : Date.now(),
		expiresAt: Date.now() + (run.inFlight > 0 ? RUN_TIMEOUT_MS : RETENTION_MS),
	});

	// MAX_IN_FLIGHT caps the workers, so this many items cover every live worker.
	const inFlightItems = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_work", (q) => q.eq("runId", run._id).gt("workId", null))
		.take(MAX_IN_FLIGHT);
	for (const item of inFlightItems) {
		if (item.workId) await files_transfer_workpool.cancel(ctx, item.workId);
		// A canceled worker's upload can still land, so hand its staged assets to the deletion ledger.
		await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
	}
}

function copy_candidate_name(item: Doc<"files_transfer_items">, counter: number) {
	// Start at index 1 so a dotfile's leading dot is not taken as the extension separator.
	const dot = item.kind === "file" ? item.sourceName.indexOf(".", 1) : -1;
	const base = dot < 0 ? item.sourceName : item.sourceName.slice(0, dot);
	const extension = dot < 0 ? "" : item.sourceName.slice(dot);
	const candidate = `${base}-copy-${counter}${extension}`;
	return item.kind === "folder"
		? files_normalize_name("folder", candidate)
		: files_normalize_file_rename_name(candidate);
}

async function db_resolve_name(
	ctx: MutationCtx,
	args: {
		run: Doc<"files_transfer_runs">;
		item: Doc<"files_transfer_items">;
		membership: Doc<"organizations_workspaces_users">;
		parentId: Doc<"files_nodes">["parentId"];
		parentPath: string;
		reserved?: Set<string>;
		nameLookups?: { remaining: number };
	},
) {
	const choice = args.item.choice ?? args.run.applyToRemaining;
	let name = args.item.sourceName;
	for (let counter = 0; counter <= MAX_NAME_ATTEMPTS; counter += 1) {
		if (counter > 0) {
			const renamed = copy_candidate_name(args.item, counter);
			if (renamed._nay) return renamed;
			name = renamed._yay;
		}

		const path = path_join(args.parentPath, name);
		if (args.nameLookups) {
			if (args.nameLookups.remaining === 0)
				return Result({ _nay: { message: "Too many name conflicts. Select fewer items." } });
			args.nameLookups.remaining -= 1;
		}

		const occupant = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", args.run.organizationId)
					.eq("workspaceId", args.run.workspaceId)
					.eq("path", path)
					.eq("archiveOperationId", null),
			)
			.first();
		// A cut moved onto its own path is a no-op, not a conflict.
		const occupied = occupant && !(args.run.kind === "move" && occupant._id === args.item.sourceId);
		if (occupied) {
			// An unreadable occupant answers "Permission denied" so its path stays hidden.
			const readAuthorized = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: args.run.userId },
				membership: args.membership,
				permission: "content.read",
				fileNode: occupant,
			});
			if (readAuthorized._nay) return Result({ _nay: { message: "Permission denied" } });
		}
		if (!occupied && !args.reserved?.has(path)) return Result({ _yay: { name, path } });

		if (choice === "skip") {
			await db_skip_item(ctx, args.item);
			return Result({ _yay: null });
		}
		if (choice !== "keep_both") {
			await db_pause_item(ctx, args.item, "name_conflict");
			return Result({ _yay: null });
		}
	}
	return Result({ _nay: { message: "No free copy name found" } });
}

/**
 * Every folder/file publication re-validates its run, item, source, and destination here, so Stop
 * wins over later writes. A null _yay means the attempt was superseded, skipped, or paused for a
 * choice; the caller does nothing.
 */
export async function files_transfer_db_prepare_copy_item(
	ctx: MutationCtx,
	args: { itemId: Id<"files_transfer_items">; attempt: number },
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (!item || item.attempt !== args.attempt || item.state !== "copying") return Result({ _yay: null });

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (
		!run ||
		run.phase !== "running" ||
		!run.active ||
		(item.attemptExpiresAt !== null && item.attemptExpiresAt <= Date.now())
	)
		return Result({ _yay: null });

	// A lost membership or a changed destination stops the whole run.
	const membership = await db_get_run_membership(ctx, run);
	if (!membership) {
		await db_stop_run(ctx, run, "Permission denied");
		return Result({ _yay: null });
	}

	const destination = await db_get_destination(ctx, {
		run,
		membership,
		parentId: run.targetParentId,
		expectedPath: run.targetPath,
	});
	if (destination._nay) {
		await db_stop_run(ctx, run, destination._nay.message);
		return Result({ _yay: null });
	}

	// A changed or unreadable source pauses only this item for a choice.
	const sourceNode = await ctx.db.get("files_nodes", item.sourceId);
	if (
		!sourceNode ||
		sourceNode.organizationId !== run.organizationId ||
		sourceNode.workspaceId !== run.workspaceId ||
		sourceNode.archiveOperationId !== null ||
		sourceNode.parentId !== item.sourceParentId ||
		sourceNode.name !== item.sourceName ||
		sourceNode.path !== item.sourcePath
	) {
		await db_pause_item(ctx, item, "source_changed");
		return Result({ _yay: null });
	}

	const readAuthorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: run.userId },
		membership,
		permission: "content.read",
		fileNode: sourceNode,
	});
	if (readAuthorized._nay) {
		await db_pause_item(ctx, item, "source_changed");
		return Result({ _yay: null });
	}

	let parentId = run.targetParentId;
	let parentPath = run.targetPath;
	if (item.parentItemId) {
		// A child copies into the folder its parent item produced.
		const parent = await ctx.db.get("files_transfer_items", item.parentItemId);
		if (!parent || parent.state !== "completed" || !parent.outputId || parent.outputPath === null) {
			await db_skip_item(ctx, item);
			return Result({ _yay: null });
		}
		parentId = parent.outputId;
		parentPath = parent.outputPath;
		const parentDestination = await db_get_destination(ctx, { run, membership, parentId, expectedPath: parentPath });
		if (parentDestination._nay) {
			await db_pause_item(ctx, item, "destination_changed");
			return Result({ _yay: null });
		}
	}

	if (item.choice === "skip") {
		await db_skip_item(ctx, item);
		return Result({ _yay: null });
	}

	const resolved = await db_resolve_name(ctx, { run, item, membership, parentId, parentPath });
	if (resolved._nay) return resolved;
	if (!resolved._yay) return Result({ _yay: null });

	return Result({
		_yay: { run, item, sourceNode, parentId, name: resolved._yay.name, path: resolved._yay.path, membership },
	});
}

export async function files_transfer_db_complete_copy_item(
	ctx: MutationCtx,
	args: { itemId: Id<"files_transfer_items">; attempt: number; nodeId: Id<"files_nodes">; name: string; path: string },
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (!item || item.attempt !== args.attempt || item.state === "completed") return;

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return;

	await ctx.db.patch("files_transfer_items", item._id, {
		state: "completed",
		conflictKind: null,
		outputId: args.nodeId,
		outputName: args.name,
		outputPath: args.path,
		stagedAssetIds: [],
		...(item.workId === null ? { attemptExpiresAt: null } : {}),
	});
	await db_patch_run(ctx, run._id, { completed: run.completed + 1, expiresAt: Date.now() + RUN_TIMEOUT_MS });
	await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
}

export async function files_transfer_db_fail_copy_item(
	ctx: MutationCtx,
	args: { itemId: Id<"files_transfer_items">; attempt: number; message: string },
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (!item || item.attempt !== args.attempt || item.state !== "copying") return;

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run || run.phase !== "running") return;

	await ctx.db.patch("files_transfer_items", item._id, { state: "failed", errorMessage: args.message });
	// Keep messages free of names, paths, and file content: run history can outlive source access.
	await db_patch_run(ctx, run._id, { failed: run.failed + 1, errorMessage: run.errorMessage ?? args.message });
}

const run_view_validator = v.object({
	_id: v.id("files_transfer_runs"),
	kind: doc(app_convex_schema, "files_transfer_runs").fields.kind,
	phase: doc(app_convex_schema, "files_transfer_runs").fields.phase,
	revision: v.number(),
	total: v.number(),
	completed: v.number(),
	skipped: v.number(),
	failed: v.number(),
	errorMessage: v.union(v.string(), v.null()),
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

async function db_get_run_view(
	ctx: QueryCtx,
	run: Doc<"files_transfer_runs">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const conflicts = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "conflict"))
		.take(MAX_SELECTED_NODES);

	const visibleConflicts = await Promise.all(
		conflicts.map(async (item) => {
			const node = await ctx.db.get("files_nodes", item.sourceId);
			const readAuthorized =
				node &&
				node.path === item.sourcePath &&
				node.organizationId === run.organizationId &&
				node.workspaceId === run.workspaceId
					? await access_control_db_authorize_membership(ctx, {
							userAuth: { id: run.userId },
							membership,
							permission: "content.read",
							fileNode: node,
						})
					: null;
			// Hide names once the source is no longer readable; run history can outlive source access.
			const readable = readAuthorized !== null && !readAuthorized._nay;
			return {
				itemId: item._id,
				sourceName: readable ? item.sourceName : null,
				sourcePath: readable ? item.sourcePath : null,
				targetName: readable ? item.sourceName : null,
				kind: item.conflictKind ?? ("source_changed" as const),
			};
		}),
	);

	const movedItems =
		run.kind === "move"
			? await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "completed"))
					.take(MAX_SELECTED_NODES)
			: [];

	return {
		_id: run._id,
		kind: run.kind,
		phase: run.phase,
		revision: run.revision,
		total: run.total,
		completed: run.completed,
		skipped: run.skipped,
		failed: run.failed,
		errorMessage: run.errorMessage,
		conflicts: visibleConflicts,
		movedNodeIds: movedItems.map((item) => item.sourceId),
	};
}

export const get = query({
	args: { membershipId: v.id("organizations_workspaces_users"), runId: v.id("files_transfer_runs") },
	returns: v.union(run_view_validator, v.null()),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) {
			if (owned._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		return await db_get_run_view(ctx, owned._yay.run, owned._yay.membership);
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

		const run = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_user_workspace_active", (q) =>
				q.eq("userId", userAuth.id).eq("workspaceId", membership.workspaceId).eq("active", true),
			)
			.unique();
		return run ? [await db_get_run_view(ctx, run, membership)] : [];
	},
});

export const start = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		requestId: v.string(),
		kind: v.union(v.literal("move"), v.literal("copy")),
		sourceIds: v.array(v.id("files_nodes")),
		targetParentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
	},
	returns: v_result({ _yay: v.object({ runId: v.id("files_transfer_runs") }) }),
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
			args.requestId.length > 128 ||
			args.sourceIds.length === 0 ||
			args.sourceIds.length > MAX_SELECTED_NODES
		) {
			return Result({ _nay: { message: "Select between 1 and 200 items" } });
		}

		const user = await ctx.db.get("users", userAuth.id);
		if (!user) return Result({ _nay: { message: "Unauthenticated" } });
		if (user.deletedAt !== undefined) return Result({ _nay: { message: "Unauthorized" } });

		const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
		if (
			!workspace ||
			workspace.organizationId !== membership.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		// A retried start after a lost response returns the first run.
		const previous = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_user_workspace_request", (q) =>
				q.eq("userId", userAuth.id).eq("workspaceId", membership.workspaceId).eq("requestId", args.requestId),
			)
			.unique();
		if (previous) return Result({ _yay: { runId: previous._id } });

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });

		const activeRun = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_user_workspace_active", (q) =>
				q.eq("userId", userAuth.id).eq("workspaceId", membership.workspaceId).eq("active", true),
			)
			.unique();
		if (activeRun) return Result({ _nay: { message: "A Paste is already running in this workspace" } });

		const target = args.targetParentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.targetParentId);
		const scope = {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
		};
		const destination = await db_get_destination(ctx, {
			run: scope,
			membership,
			parentId: args.targetParentId,
			expectedPath: target?.path ?? "/",
		});
		if (destination._nay) return destination;

		const nodes: Doc<"files_nodes">[] = [];
		for (const nodeId of new Set(args.sourceIds)) {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (
				!node ||
				node.organizationId !== membership.organizationId ||
				node.workspaceId !== membership.workspaceId ||
				node.archiveOperationId !== null
			) {
				return Result({ _nay: { message: "Not found" } });
			}
			const readAuthorized = await access_control_db_authorize_membership(ctx, {
				userAuth,
				membership,
				permission: "content.read",
				fileNode: node,
			});
			if (readAuthorized._nay) return Result({ _nay: { message: "Permission denied" } });
			if (args.kind === "move" && target && (node._id === target._id || target.path.startsWith(`${node.path}/`))) {
				return Result({ _nay: { message: "A folder cannot be moved inside itself" } });
			}
			nodes.push(node);
		}

		// A selected folder already covers its children; keep only the top selections.
		const roots = nodes.filter(
			(node) =>
				!nodes.some(
					(parent) => parent.kind === "folder" && parent._id !== node._id && node.path.startsWith(`${parent.path}/`),
				),
		);

		const now = Date.now();
		const runId = await ctx.db.insert("files_transfer_runs", {
			...scope,
			membershipId: membership._id,
			requestId: args.requestId,
			kind: args.kind,
			targetParentId: args.targetParentId,
			targetPath: target?.path ?? "/",
			phase: "checking",
			active: true,
			revision: 0,
			total: roots.length,
			completed: 0,
			skipped: 0,
			failed: 0,
			inFlight: 0,
			applyToRemaining: null,
			errorMessage: null,
			expiresAt: now + RUN_TIMEOUT_MS,
			finishedAt: null,
			updatedAt: now,
		});
		for (const [order, node] of roots.entries()) {
			await ctx.db.insert("files_transfer_items", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				runId,
				sourceId: node._id,
				sourceParentId: node.parentId,
				sourceName: node.name,
				sourcePath: node.path,
				kind: node.kind,
				parentItemId: null,
				order,
				// Cut moves whole roots in one transaction, so it discovers no children.
				discoveryDone: args.kind === "move" || node.kind === "file",
				discoveryCursor: null,
				state: "pending",
				conflictKind: null,
				choice: null,
				attempt: 0,
				workId: null,
				attemptExpiresAt: null,
				stagedAssetIds: [],
				billedUserId: null,
				outputId: null,
				outputName: null,
				outputPath: null,
				errorMessage: null,
			});
		}

		await ctx.db.insert("activities", {
			...scope,
			status: "running",
			source: {
				kind: "files_transfer_run",
				id: runId,
				transferKind: args.kind,
				phase: "checking",
				total: roots.length,
				completed: 0,
				skipped: 0,
				failed: 0,
			},
			title: args.kind === "move" ? "Move files" : "Copy files",
			errorMessage: null,
			targets: [],
			timeoutAt: now + RUN_TIMEOUT_MS,
			archivedAt: 0,
			updatedAt: now,
		});
		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId });
		return Result({ _yay: { runId } });
	},
});

export const resolve_conflicts = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_transfer_runs"),
		revision: v.number(),
		choices: v.array(
			v.object({ itemId: v.id("files_transfer_items"), choice: v.union(v.literal("keep_both"), v.literal("skip")) }),
		),
		applyToRemaining: v.union(v.literal("keep_both"), v.literal("skip"), v.null()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;

		const { run } = owned._yay;
		// The revision pins the conflict set the user reviewed; a new conflict bumps it.
		if (run.phase !== "awaiting_choice" || run.revision !== args.revision)
			return Result({ _nay: { message: "The conflicts changed. Review them again." } });

		if (
			args.choices.length === 0 ||
			args.choices.length > MAX_SELECTED_NODES ||
			new Set(args.choices.map((choice) => choice.itemId)).size !== args.choices.length
		) {
			return Result({ _nay: { message: "Choose how to handle each conflict" } });
		}

		const items = await Promise.all(args.choices.map((choice) => ctx.db.get("files_transfer_items", choice.itemId)));
		for (const [index, item] of items.entries()) {
			// Only a name conflict accepts keep_both; a changed source or destination can only be skipped.
			if (
				!item ||
				item.runId !== run._id ||
				item.state !== "conflict" ||
				(item.conflictKind !== "name_conflict" && args.choices[index]!.choice !== "skip")
			) {
				return Result({ _nay: { message: "The conflicts changed. Review them again." } });
			}
		}

		for (const choice of args.choices) {
			await ctx.db.patch("files_transfer_items", choice.itemId, {
				state: "pending",
				conflictKind: null,
				choice: choice.choice,
			});
		}

		const conflict = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "conflict"))
			.first();
		const undiscovered = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_discoveryDone_order", (q) => q.eq("runId", run._id).eq("discoveryDone", false))
			.first();

		await db_patch_run(ctx, run._id, {
			phase: conflict ? "awaiting_choice" : undiscovered ? "checking" : "running",
			applyToRemaining: args.applyToRemaining,
			expiresAt: Date.now() + (conflict ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
		});
		if (!conflict) await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
		return Result({ _yay: null });
	},
});

export const stop = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), runId: v.id("files_transfer_runs") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;

		await db_stop_run(ctx, owned._yay.run, null);
		return Result({ _yay: null });
	},
});

// #region advance

async function db_discover(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const item = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_discoveryDone_order", (q) => q.eq("runId", run._id).eq("discoveryDone", false))
		.first();
	if (item) {
		const parent = item.parentItemId ? await ctx.db.get("files_transfer_items", item.parentItemId) : null;
		if (item.choice === "skip" || parent?.state === "skipped") {
			await db_skip_item(ctx, item);
			await ctx.db.patch("files_transfer_items", item._id, { discoveryDone: true });
			await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
			return;
		}

		const source = await ctx.db.get("files_nodes", item.sourceId);
		if (
			!source ||
			source.archiveOperationId !== null ||
			source.parentId !== item.sourceParentId ||
			source.path !== item.sourcePath
		) {
			await db_pause_item(ctx, item, "source_changed");
			return;
		}

		const readAuthorized = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: run.userId },
			membership,
			permission: "content.read",
			fileNode: source,
		});
		if (readAuthorized._nay) {
			await db_stop_run(ctx, run, "Permission denied");
			return;
		}

		const page = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
				q
					.eq("organizationId", run.organizationId)
					.eq("workspaceId", run.workspaceId)
					.eq("parentId", source._id)
					.eq("archiveOperationId", null),
			)
			.paginate({ cursor: item.discoveryCursor, numItems: DISCOVERY_PAGE_SIZE });
		if (run.total + page.page.length > MAX_COPY_ITEMS) {
			await db_stop_run(ctx, run, "This copy is too large. Select fewer items.");
			return;
		}

		for (const child of page.page) {
			const childReadAuthorized = await access_control_db_authorize_membership(ctx, {
				userAuth: { id: run.userId },
				membership,
				permission: "content.read",
				fileNode: child,
			});
			if (childReadAuthorized._nay) {
				await db_stop_run(ctx, run, "Permission denied");
				return;
			}
		}

		let added = 0;
		for (const child of page.page) {
			const existing = await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_source", (q) => q.eq("runId", run._id).eq("sourceId", child._id))
				.unique();
			if (existing) continue;
			await ctx.db.insert("files_transfer_items", {
				organizationId: run.organizationId,
				workspaceId: run.workspaceId,
				runId: run._id,
				sourceId: child._id,
				sourceParentId: child.parentId,
				sourceName: child.name,
				sourcePath: child.path,
				kind: child.kind,
				parentItemId: item._id,
				order: run.total + added,
				discoveryDone: child.kind === "file",
				discoveryCursor: null,
				state: "pending",
				conflictKind: null,
				choice: null,
				attempt: 0,
				workId: null,
				attemptExpiresAt: null,
				stagedAssetIds: [],
				billedUserId: null,
				outputId: null,
				outputName: null,
				outputPath: null,
				errorMessage: null,
			});
			added += 1;
		}

		await ctx.db.patch("files_transfer_items", item._id, {
			discoveryDone: page.isDone,
			discoveryCursor: page.isDone ? null : page.continueCursor,
		});
		await db_patch_run(ctx, run._id, { total: run.total + added, expiresAt: Date.now() + RUN_TIMEOUT_MS });
		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
		return;
	}

	const roots = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_parentItem", (q) => q.eq("runId", run._id).eq("parentItemId", null))
		.take(MAX_SELECTED_NODES);
	const reserved = new Set<string>();
	const nameLookups = { remaining: MAX_NAME_LOOKUPS_PER_BATCH };
	for (const root of roots) {
		if (root.state === "skipped") continue;
		if (root.choice === "skip") {
			await db_skip_item(ctx, root);
			continue;
		}

		const resolved = await db_resolve_name(ctx, {
			run,
			item: root,
			membership,
			parentId: run.targetParentId,
			parentPath: run.targetPath,
			reserved,
			nameLookups,
		});
		if (resolved._nay) {
			// Name resolution may have patched this run (pause or stop); act on the fresh doc.
			const current = await ctx.db.get("files_transfer_runs", run._id);
			if (current) await db_stop_run(ctx, current, resolved._nay.message);
			return;
		}
		if (resolved._yay) reserved.add(resolved._yay.path);
	}

	// Name resolution above may have paused or stopped this run; re-read it before moving on.
	const current = await ctx.db.get("files_transfer_runs", run._id);
	if (current?.phase === "checking") {
		await db_patch_run(ctx, run._id, { phase: "running" });
		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
	}
}

async function db_commit_move(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const items = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_order", (q) => q.eq("runId", run._id))
		.take(MAX_SELECTED_NODES);

	const reserved = new Set<string>();
	const nameLookups = { remaining: MAX_NAME_LOOKUPS_PER_BATCH };
	const moveItems: Array<{
		nodeId: Id<"files_nodes">;
		expected: { parentId: Doc<"files_nodes">["parentId"]; name: string; path: string };
		destName: string;
	}> = [];
	for (const item of items) {
		if (item.state === "skipped") continue;
		if (item.choice === "skip") {
			await db_skip_item(ctx, item);
			continue;
		}

		const source = await ctx.db.get("files_nodes", item.sourceId);
		if (
			!source ||
			source.archiveOperationId !== null ||
			source.path !== item.sourcePath ||
			source.parentId !== item.sourceParentId ||
			source.name !== item.sourceName
		) {
			await db_pause_item(ctx, item, "source_changed");
			continue;
		}

		const resolved = await db_resolve_name(ctx, {
			run,
			item,
			membership,
			parentId: run.targetParentId,
			parentPath: run.targetPath,
			reserved,
			nameLookups,
		});
		if (resolved._nay) {
			// Name resolution may have patched this run (pause or stop); act on the fresh doc.
			const current = await ctx.db.get("files_transfer_runs", run._id);
			if (current) await db_stop_run(ctx, current, resolved._nay.message);
			return;
		}
		if (resolved._yay) {
			reserved.add(resolved._yay.path);
			moveItems.push({
				nodeId: item.sourceId,
				expected: { parentId: item.sourceParentId, name: item.sourceName, path: item.sourcePath },
				destName: resolved._yay.name,
			});
		}
	}

	// Name resolution above may have paused or stopped this run; re-read it before moving on.
	const current = await ctx.db.get("files_transfer_runs", run._id);
	if (!current || current.phase !== "running") return;

	const move = await files_nodes_db_move_nodes(ctx, {
		userAuth: { id: run.userId },
		membership,
		items: moveItems,
		targetParentId: run.targetParentId,
		expectedTargetPath: run.targetPath,
	});
	if (move._nay) {
		await db_stop_run(ctx, current, move._nay.message);
		return;
	}

	const movedById = new Map(move._yay.moved.map((node) => [node.nodeId, node]));
	const unchanged = new Set(move._yay.unchangedNodeIds);
	for (const item of items) {
		const moved = movedById.get(item.sourceId);
		if (!moved && !unchanged.has(item.sourceId)) continue;
		await ctx.db.patch("files_transfer_items", item._id, {
			state: "completed",
			outputId: item.sourceId,
			outputName: moved?.name ?? item.sourceName,
			outputPath: moved?.path ?? item.sourcePath,
		});
	}

	await db_patch_run(ctx, run._id, {
		completed: movedById.size + unchanged.size,
		phase: "completed",
		active: false,
		finishedAt: Date.now(),
		expiresAt: Date.now() + RETENTION_MS,
	});
}

export const advance = internalMutation({
	args: { runId: v.id("files_transfer_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_transfer_runs", args.runId);
		if (!run || !run.active || run.phase === "awaiting_choice" || run.phase === "stopping") return null;
		if (run.expiresAt <= Date.now()) {
			await db_stop_run(ctx, run, "Paste timed out");
			return null;
		}

		const membership = await db_get_run_membership(ctx, run);
		if (!membership) {
			await db_stop_run(ctx, run, "Permission denied");
			return null;
		}

		const destination = await db_get_destination(ctx, {
			run,
			membership,
			parentId: run.targetParentId,
			expectedPath: run.targetPath,
		});
		if (destination._nay) {
			await db_stop_run(ctx, run, destination._nay.message);
			return null;
		}

		if (run.phase === "checking") {
			await db_discover(ctx, run, membership);
			return null;
		}
		if (run.kind === "move") {
			await db_commit_move(ctx, run, membership);
			return null;
		}
		if (run.inFlight >= MAX_IN_FLIGHT) return null;

		const item = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "pending"))
			.first();
		if (!item) {
			if (run.inFlight === 0)
				await db_patch_run(ctx, run._id, {
					phase: run.failed ? "failed" : "completed",
					active: false,
					finishedAt: Date.now(),
					expiresAt: Date.now() + RETENTION_MS,
				});
			return null;
		}

		// An old worker must finish its callback before a resolved conflict starts a new attempt.
		if (item.workId !== null) return null;

		const parent = item.parentItemId ? await ctx.db.get("files_transfer_items", item.parentItemId) : null;
		if (item.choice === "skip" || (parent && (parent.state === "skipped" || parent.state === "failed"))) {
			await db_skip_item(ctx, item);
			await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
			return null;
		}

		const attempt = item.attempt + 1;
		await ctx.db.patch("files_transfer_items", item._id, {
			state: "copying",
			attempt,
			attemptExpiresAt: Date.now() + ATTEMPT_TIMEOUT_MS,
		});

		// Folders have no bytes to stage, so they publish inline instead of through the worker.
		if (item.kind === "folder") {
			const prepared = await files_transfer_db_prepare_copy_item(ctx, { itemId: item._id, attempt });
			if (prepared._nay) {
				await files_transfer_db_fail_copy_item(ctx, { itemId: item._id, attempt, message: prepared._nay.message });
			} else if (prepared._yay) {
				const metadata = await files_metadata_db_read_entries(ctx, {
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					fileNodeId: item.sourceId,
				});
				const copied = await files_nodes_db_create_node_recursively_at_path(ctx, {
					userId: run.userId,
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					parentId: prepared._yay.parentId,
					path: prepared._yay.name,
					kind: "folder",
					metadata,
					now: Date.now(),
				});
				if (copied._nay) throw convex_error({ message: "Could not copy folder", cause: copied._nay });
				await files_transfer_db_complete_copy_item(ctx, {
					itemId: item._id,
					attempt,
					nodeId: copied._yay,
					name: prepared._yay.name,
					path: prepared._yay.path,
				});
			}
			await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
			return null;
		}
		const workId = await files_transfer_workpool.enqueueAction(
			ctx,
			internal.files_nodes_content.copy_transfer_file,
			{ itemId: item._id, attempt },
			{
				retry: false,
				onComplete: internal.files_transfer.handle_copy_complete,
				context: { itemId: item._id, attempt },
			},
		);
		await ctx.db.patch("files_transfer_items", item._id, { workId });
		await db_patch_run(ctx, run._id, { inFlight: run.inFlight + 1, expiresAt: Date.now() + RUN_TIMEOUT_MS });
		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
		return null;
	},
});

/**
 * Callbacks and expiry share the same Stop and retry rules.
 */
async function db_finish_copy_attempt(
	ctx: MutationCtx,
	item: Doc<"files_transfer_items">,
	run: Doc<"files_transfer_runs">,
	now: number,
) {
	const inFlight = item.workId ? run.inFlight - 1 : run.inFlight;
	await db_patch_run(ctx, run._id, { inFlight });

	if (run.phase === "stopping") {
		if (inFlight === 0)
			await db_patch_run(ctx, run._id, {
				phase: run.errorMessage ? "failed" : "canceled",
				active: false,
				finishedAt: now,
				expiresAt: now + RETENTION_MS,
			});
		return;
	}

	if (item.state === "copying") {
		if (run.phase === "awaiting_choice" || item.attempt < MAX_ATTEMPTS) {
			await ctx.db.patch("files_transfer_items", item._id, { state: "pending" });
		} else {
			await files_transfer_db_fail_copy_item(ctx, {
				itemId: item._id,
				attempt: item.attempt,
				message: "Could not copy file",
			});
		}
	}
}

export const handle_copy_complete = internalMutation({
	args: vOnCompleteArgs(v.object({ itemId: v.id("files_transfer_items"), attempt: v.number() })),
	returns: v.null(),
	handler: async (ctx, args) => {
		const item = await ctx.db.get("files_transfer_items", args.context.itemId);
		// A canceled or superseded worker's callback must no-op.
		if (!item || item.attempt !== args.context.attempt || item.workId !== args.workId) return null;

		const run = await ctx.db.get("files_transfer_runs", item.runId);
		if (!run) return null;

		await files_nodes_content_db_discard_transfer_file_attempt(ctx, args.context);
		await ctx.db.patch("files_transfer_items", item._id, { workId: null, attemptExpiresAt: null });
		await db_finish_copy_attempt(ctx, item, run, Date.now());

		// A failed attempt retries after a short pause.
		if (run.phase === "running")
			await ctx.scheduler.runAfter(args.result.kind === "failed" ? 1000 : 0, internal.files_transfer.advance, {
				runId: run._id,
			});
		return null;
	},
});

// #endregion advance

/**
 * Deletion callers drain this before deleting memberships, files, and assets.
 */
export async function files_transfer_db_delete_run_batch(
	ctx: MutationCtx,
	args: { runId: Id<"files_transfer_runs">; batchSize: number },
) {
	const { runId } = args;
	const run = await ctx.db.get("files_transfer_runs", runId);
	if (!run) return { done: true, deletedCount: 0 };

	if (run.active) {
		await db_stop_run(ctx, run, null);
		// Deletion cannot wait for in-flight callbacks, so force the run inactive. A late worker's
		// publish is still refused by the run-phase check in prepare_copy_item.
		await db_patch_run(ctx, runId, { active: false, phase: "canceled", expiresAt: Date.now(), finishedAt: Date.now() });
	}

	const batchSize = Math.max(1, Math.min(50, args.batchSize));
	const items = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_order", (q) => q.eq("runId", runId))
		.take(batchSize);
	for (const item of items) {
		await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
		await ctx.db.delete("files_transfer_items", item._id);
	}
	if (items.length === batchSize) return { done: false, deletedCount: items.length };

	const activity = await activities_db_get_by_source_id(ctx, runId);
	if (activity) await ctx.db.delete("activities", activity._id);

	await ctx.db.delete("files_transfer_runs", runId);
	return { done: true, deletedCount: items.length + 1 + (activity ? 1 : 0) };
}

export const delete_run_batch = internalMutation({
	args: { runId: v.id("files_transfer_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const deleted = await files_transfer_db_delete_run_batch(ctx, { ...args, batchSize: 50 });
		if (!deleted.done) {
			await ctx.scheduler.runAfter(0, internal.files_transfer.delete_run_batch, args);
		}
		return null;
	},
});

/**
 * Expired attempts cannot publish, even if their action returns after its worker was canceled.
 */
export const recover_expired = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const now = Date.now();
		const items = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_attemptExpiresAt", (q) => q.gt("attemptExpiresAt", null).lte("attemptExpiresAt", now))
			.take(50);
		for (const item of items) {
			const run = await ctx.db.get("files_transfer_runs", item.runId);
			if (item.workId) await files_transfer_workpool.cancel(ctx, item.workId);
			await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
			await ctx.db.patch("files_transfer_items", item._id, { workId: null, attemptExpiresAt: null });
			if (!run || !run.active) continue;
			await db_finish_copy_attempt(ctx, item, run, now);
			if (run.phase === "running") await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
		}

		const runs = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
			.take(50);
		for (const run of runs) {
			if (run.active) await db_stop_run(ctx, run, "Paste timed out");
			else await ctx.scheduler.runAfter(0, internal.files_transfer.delete_run_batch, { runId: run._id });
		}
		return null;
	},
});
