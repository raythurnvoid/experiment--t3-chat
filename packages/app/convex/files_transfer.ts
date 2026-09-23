import { vOnCompleteArgs, vWorkId, Workpool, type WorkId } from "@convex-dev/workpool";
import { compareValues, v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { Result } from "common/errors-as-values-utils.ts";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
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
import { organizations_db_get_membership } from "./organizations.ts";
import {
	ai_chat_files_db_check_copy_admission,
	ai_chat_files_db_check_copy_sources,
	ai_chat_files_db_get_bash_transfer,
	ai_chat_files_db_link_bash_transfer,
	ai_chat_files_db_link_copy_admission,
	ai_chat_files_db_seal_copy_admission,
} from "./ai_chat_files.ts";
import { ai_chat_workspaces_db_resolve } from "./ai_chat_workspaces.ts";
import {
	organizations_membership_lifetimes_db_ensure,
	organizations_membership_lifetimes_db_get,
} from "./organizations_membership_lifetimes.ts";
import app_convex_schema, {
	files_pending_parent_validator,
	files_pending_target_validator,
	files_transfer_source_version_validator,
} from "./schema.ts";
import {
	authorize_file_write,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_copied_from_policy_fields,
	files_nodes_db_move_nodes,
	files_nodes_db_require_user_writable,
	files_nodes_db_require_user_writable_or_matching_policy,
	files_nodes_db_require_copiable_write_policy,
	files_nodes_db_get_content_version,
} from "./files_nodes.ts";
import { files_visible_db_create_reader, type files_visible_internal_list_Result } from "./files_visible.ts";
import {
	files_pending_nodes_db_create,
	files_pending_nodes_db_discard,
	files_pending_nodes_db_resolve_saved_parent,
} from "./files_pending_nodes.ts";
import {
	files_pending_holds_db_acquire,
	files_pending_holds_db_finish,
	files_pending_holds_db_release_producer_batch,
} from "./files_pending_holds.ts";
import {
	files_db_schedule_pending_update_cleanup,
	files_db_patch_pending_update,
	files_db_get_pending_update,
} from "../server/files.ts";
import type { upsert_file_pending_move_in_db_Result } from "./files_pending_updates.ts";
import { files_metadata_db_read_entries } from "./files_metadata.ts";
import {
	files_nodes_content_db_discard_transfer_file_attempt,
	files_nodes_content_db_discard_transfer_file_capture,
} from "./files_nodes_content.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	path_join,
	server_convex_get_user_fallback_to_anonymous,
	should_never_happen,
} from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	files_normalize_file_rename_name,
	files_normalize_name,
	files_ROOT_ID,
	files_TRANSFER_SELECTION_PAGE_SIZE,
	type files_PendingParent,
	type files_PendingTarget,
	type files_VisibleEntry,
} from "../shared/files.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

const MAX_SELECTED_NODES = 200;
const DISCOVERY_PAGE_SIZE = 50;
const MAX_NAME_ATTEMPTS = 100;
const MAX_NAME_LOOKUPS_PER_BATCH = 200;
const MAX_IN_FLIGHT = 2;
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const CHOICE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const STOP_BATCH_SIZE = 50;

const files_transfer_workpool = new Workpool(components.files_transfer_workpool, {
	maxParallelism: MAX_IN_FLIGHT,
	retryActionsByDefault: false,
});

async function db_require_activity(ctx: QueryCtx | MutationCtx, runId: Id<"files_transfer_runs">) {
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

async function db_get_current_activity(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; workspaceId: Id<"organizations_workspaces"> },
) {
	for (const status of ["queued", "running", "awaiting_input", "stopping"] as const) {
		const activity = await ctx.db
			.query("activities")
			.withIndex("by_user_workspace_source_kind_status", (q) =>
				q
					.eq("userId", args.userId)
					.eq("workspaceId", args.workspaceId)
					.eq("source.kind", "files_transfer_run")
					.eq("status", status),
			)
			.unique();
		if (activity) return activity;
	}
	return null;
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
 * Recheck the chat and both captured memberships before any transfer work.
 */
async function db_get_run_memberships(
	ctx: QueryCtx | MutationCtx,
	run: Doc<"files_transfer_runs">,
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
	const membership = await organizations_db_get_membership(ctx, {
		userId: run.userId,
		membershipId: activity.membershipId,
	});
	if (!membership) return null;
	if (run.origin.kind === "agent") {
		const thread = await ctx.db.get("ai_chat_threads", run.origin.threadId);
		if (
			!thread ||
			thread.archived ||
			thread.createdBy !== run.userId ||
			thread.organizationId !== run.organizationId ||
			thread.workspaceId !== run.workspaceId
		)
			return null;
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: run.userId },
			membership,
			permission: "content.read",
		});
		if (authorized._nay) return null;
	}

	const memberships = await Promise.all(
		[run.sourceScope, run.destinationScope].map(async (scope) => {
			const currentLifetime = await organizations_membership_lifetimes_db_get(ctx, {
				workspaceId: scope.workspaceId,
				userId: run.userId,
			});
			if (
				!currentLifetime?.active ||
				currentLifetime.membershipId !== scope.membershipId ||
				currentLifetime.lifetime !== scope.membershipLifetime
			)
				return null;
			const current = await organizations_db_get_membership(ctx, {
				userId: run.userId,
				membershipId: scope.membershipId,
			});
			if (!current || current.organizationId !== scope.organizationId || current.workspaceId !== scope.workspaceId)
				return null;
			const workspace = await ctx.db.get("organizations_workspaces", scope.workspaceId);
			return workspace && workspace.pluginDataPurgeStartedAt === undefined ? current : null;
		}),
	);
	const [source, destination] = memberships;
	return source && destination ? { source, destination } : null;
}

export async function files_transfer_db_get_job_copy(
	ctx: QueryCtx | MutationCtx,
	args: { runId: Id<"files_transfer_runs">; invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number },
) {
	const [run, invocation] = await Promise.all([
		ctx.db.get("files_transfer_runs", args.runId),
		ctx.db.get("ai_chat_bash_invocations", args.invocationId),
	]);
	const copy = invocation?.job?.copy;
	if (
		!run ||
		!invocation ||
		invocation.status !== "running" ||
		!copy ||
		copy.phase === "admitting" ||
		copy.runId !== run._id ||
		copy.commandNumber !== args.commandNumber ||
		run.kind !== "copy" ||
		run.publication !== "proposal" ||
		run.bashJob?.invocationId !== invocation._id ||
		run.bashJob.commandNumber !== args.commandNumber ||
		run.userId !== invocation.userId ||
		run.organizationId !== invocation.organizationId ||
		run.workspaceId !== invocation.workspaceId ||
		run.origin.kind !== "agent" ||
		run.origin.threadId !== invocation.threadId
	)
		return Result({ _nay: { name: "stale_job", message: "This Copy is no longer attached to the command." } });
	const activity = await db_require_activity(ctx, run._id);
	if (
		activity.membershipId !== invocation.membershipId ||
		activity.membershipLifetime !== invocation.membershipLifetime ||
		!(await db_get_run_memberships(ctx, run, activity))
	)
		return Result({ _nay: { name: "permission_denied", message: "This Copy is no longer available." } });
	// A finished Copy still needs the original access checks before shell continuation.
	return Result({ _yay: { run, activity } });
}

async function db_get_entry(
	ctx: QueryCtx | MutationCtx,
	run: Pick<Doc<"files_transfer_runs">, "organizationId" | "workspaceId" | "userId" | "sourceView">,
	target: files_PendingTarget,
	reader: Awaited<ReturnType<typeof files_visible_db_create_reader>>,
): Promise<files_VisibleEntry | null> {
	if (run.sourceView === "draft") return await reader.resolveTarget(target);
	if (target.kind !== "saved") return null;
	const node = await ctx.db.get("files_nodes", target.id);
	if (
		!node ||
		node.organizationId !== run.organizationId ||
		node.workspaceId !== run.workspaceId ||
		node.archiveOperationId !== null ||
		!(await reader.canRead(node))
	)
		return null;
	return { kind: "saved", node, pendingUpdate: null, path: node.path };
}

export function files_transfer_source_versions_equal(
	left: NonNullable<Doc<"files_transfer_items">["capture"]>["sourceVersion"] | null,
	right: NonNullable<Doc<"files_transfer_items">["capture"]>["sourceVersion"] | null,
): boolean {
	if (left === null || right === null) return left === right;
	if (
		left.kind !== right.kind ||
		left.contentType !== right.contentType ||
		left.textKind !== right.textKind ||
		left.collaborationEnabled !== right.collaborationEnabled
	)
		return false;
	if (left.kind === "asset" && right.kind === "asset") return left.assetId === right.assetId;
	if (left.kind === "yjs" && right.kind === "yjs")
		return (
			left.lastSequenceId === right.lastSequenceId &&
			left.lineageGeneration === right.lineageGeneration &&
			left.sequence === right.sequence
		);
	return (
		left.kind === "pending" &&
		right.kind === "pending" &&
		left.pendingUpdateId === right.pendingUpdateId &&
		left.revision === right.revision &&
		left.privateVersion?.creationGeneration === right.privateVersion?.creationGeneration &&
		left.privateVersion?.structuralRevision === right.privateVersion?.structuralRevision &&
		files_transfer_source_versions_equal(left.savedVersion, right.savedVersion)
	);
}

export async function files_transfer_db_get_entry_version(ctx: QueryCtx | MutationCtx, entry: files_VisibleEntry) {
	const pending = entry.pendingUpdate;
	if (entry.node.kind !== "file") return null;
	if (pending && (entry.kind === "private" || pending.content || pending.pendingReplacement)) {
		const intent = pending.createIntent;
		const replacement = pending.pendingReplacement;
		const contentType =
			replacement?.contentType ??
			(intent && intent.kind !== "folder"
				? intent.contentType
				: entry.kind === "saved"
					? entry.node.contentType
					: null);
		if (contentType === null || (entry.kind === "private" && (!intent || pending.preparation))) return null;
		return {
			kind: "pending" as const,
			pendingUpdateId: pending._id,
			revision: pending.revision,
			savedVersion: entry.kind === "saved" ? await files_nodes_db_get_content_version(ctx, entry.node) : null,
			privateVersion:
				entry.kind === "private"
					? { creationGeneration: entry.node.creationGeneration, structuralRevision: entry.node.structuralRevision }
					: null,
			contentType,
			textKind: replacement
				? (replacement.yjsRootKind ?? null)
				: intent?.kind === "text"
					? intent.textKind
					: entry.kind === "saved"
						? entry.node.textKind
						: null,
			collaborationEnabled: replacement
				? replacement.yjsRootKind !== undefined && !replacement.nonCollaborative
				: intent?.kind === "text"
					? intent.collaborationEnabled
					: entry.kind === "saved"
						? entry.node.collaborationEnabled
						: null,
		};
	}
	return entry.kind === "saved" ? await files_nodes_db_get_content_version(ctx, entry.node) : null;
}

async function db_get_destination(
	ctx: QueryCtx | MutationCtx,
	args: {
		run: Pick<Doc<"files_transfer_runs">, "destinationScope" | "userId" | "sourceView">;
		membership: Doc<"organizations_workspaces_users">;
		parent: files_PendingParent;
		expectedPath: string;
		runWrittenWritePolicy?: Doc<"files_nodes">["writePolicy"];
	},
) {
	const scope = { ...args.run.destinationScope, userId: args.run.userId, sourceView: args.run.sourceView };
	const reader = await files_visible_db_create_reader(ctx, scope);
	let parent = args.parent;
	if (parent.kind === "private") {
		const privateNode = await ctx.db.get("files_pending_nodes", parent.id);
		if (privateNode?.state === "published") {
			const saved = await files_pending_nodes_db_resolve_saved_parent(ctx, { ...scope, parent });
			if (saved._nay) return saved;
			parent = saved._yay.parentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: saved._yay.parentId };
		}
	}
	const entry = parent.kind === "root" ? null : await db_get_entry(ctx, scope, parent, reader);
	if (parent.kind !== "root" && (!entry || entry.node.kind !== "folder" || entry.path !== args.expectedPath))
		return Result({ _nay: { message: "Destination changed" } });
	const node =
		entry?.kind === "saved"
			? entry.node
			: parent.kind === "private"
				? ((await reader.resolve(parent))?.accessNode ?? null)
				: null;

	const authorized = await authorize_file_write(ctx, {
		userAuth: { id: args.run.userId },
		membership: args.membership,
		nodeId: node?._id ?? files_ROOT_ID,
	});
	if (authorized._nay) return Result({ _nay: { message: "Permission denied" } });

	if (node) {
		const writable = await files_nodes_db_require_user_writable_or_matching_policy(ctx, {
			node,
			userId: args.run.userId,
			runWrittenWritePolicy: args.runWrittenWritePolicy,
		});
		if (writable._nay) return writable;
	}
	return Result({ _yay: { entry, parent } });
}

async function db_pause_item(
	ctx: MutationCtx,
	item: Doc<"files_transfer_items">,
	kind: NonNullable<Doc<"files_transfer_items">["conflictKind"]>,
) {
	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return;
	const activity = await db_require_activity(ctx, run._id);
	if (!activities_is_active(activity.status) || activity.status === "stopping") return;
	if (run.fixedDeadline) {
		await db_stop_run(ctx, run, kind === "source_changed" ? "Source changed" : "Destination changed");
		return;
	}

	if (kind !== "name_conflict") await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
	await ctx.db.patch("files_transfer_items", item._id, { state: "conflict", conflictKind: kind, choice: null });
	await ctx.db.patch("files_transfer_runs", run._id, { revision: run.revision + 1 });
	await ctx.db.patch("activities", activity._id, {
		status: "awaiting_input",
		progress: { ...activity.progress, blocked: activity.progress.blocked + 1 },
		deadlineAt: run.fixedDeadline ? activity.deadlineAt : Date.now() + CHOICE_TIMEOUT_MS,
		updatedAt: Date.now(),
	});
}

async function db_skip_item(ctx: MutationCtx, item: Doc<"files_transfer_items">) {
	if (item.state === "completed" || item.state === "skipped" || item.state === "failed" || item.state === "canceled")
		return;

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return;
	const activity = await db_require_activity(ctx, run._id);

	await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
	await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
	await ctx.db.patch("files_transfer_items", item._id, {
		state: "skipped",
		conflictKind: null,
		choice: "skip",
		plannedPath: null,
	});
	if (item.preparation)
		await files_pending_nodes_db_discard(ctx, {
			...run,
			...run.destinationScope,
			...item.preparation,
			expectedRevision: item.preparation.proposalRevision,
		});
	await ctx.db.patch("activities", activity._id, {
		progress: { ...activity.progress, skipped: activity.progress.skipped + 1 },
		updatedAt: Date.now(),
	});
}

async function db_cancel_items(ctx: MutationCtx, run: Doc<"files_transfer_runs">, now: number) {
	const activity = await db_require_activity(ctx, run._id);
	let canceled = 0;
	let blocked = 0;

	for (const state of ["pending", "waiting_media", "blocked", "conflict", "copying"] as const) {
		const items = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", state))
			.take(STOP_BATCH_SIZE - canceled);

		for (const item of items) {
			await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
			await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
			await ctx.db.patch("files_transfer_items", item._id, {
				state: "canceled",
				cancelReason: activity.errorCode === "timed_out" ? "timeout" : "stop",
				conflictKind: null,
				...(item.workId === null ? { attemptExpiresAt: null } : {}),
			});
			if (item.preparation)
				await files_pending_nodes_db_discard(ctx, {
					...run,
					...run.destinationScope,
					...item.preparation,
					expectedRevision: item.preparation.proposalRevision,
				});
		}

		canceled += items.length;
		if (state === "conflict") blocked += items.length;
		if (canceled === STOP_BATCH_SIZE) break;
	}

	if (canceled > 0) {
		await ctx.db.patch("activities", activity._id, {
			progress: {
				...activity.progress,
				blocked: activity.progress.blocked - blocked,
				canceled: activity.progress.canceled + canceled,
			},
			updatedAt: now,
		});
	}

	if (canceled === STOP_BATCH_SIZE) {
		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
	} else if (run.inFlight === 0) {
		await activities_db_finish(ctx, {
			sourceId: run._id,
			status:
				activity.errorCode === "timed_out"
					? "timed_out"
					: activity.errorCode === "canceled"
						? "canceled"
						: activity.progress.completed > 0
							? "partial"
							: "failed",
			errorMessage: activity.errorMessage,
			errorCode: activity.errorCode,
			now,
		});
		if (run.kind === "copy")
			await files_pending_holds_db_finish(ctx, { producer: { kind: "files_transfer_run", id: run._id } });
	}
}

async function db_stop_run(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	errorMessage: string | null,
	now = Date.now(),
	errorCode = errorMessage ? "failed" : "canceled",
) {
	const activity = await db_require_activity(ctx, run._id);
	if (!activities_is_active(activity.status)) return;
	if (activity.status === "stopping") {
		if (run.step !== "retry") await db_cancel_items(ctx, run, now);
		return;
	}

	await ctx.db.patch("activities", activity._id, {
		status: "stopping",
		stopRequestedAt: now,
		errorMessage,
		errorCode,
		updatedAt: now,
	});
	// Finish copying the frozen manifest under the Stop fence, so later retries lose no entries.
	if (run.step === "retry") {
		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
		return;
	}

	// MAX_IN_FLIGHT caps the workers, so this many items cover every live worker.
	const inFlightItems = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_work", (q) => q.eq("runId", run._id).gt("workId", null))
		.take(MAX_IN_FLIGHT);
	for (const item of inFlightItems) {
		if (item.workId) await files_transfer_workpool.cancel(ctx, item.workId);
		// A canceled worker's upload can still land, so hand its staged assets to the deletion ledger.
		await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
		await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
	}
	await db_cancel_items(ctx, run, now);
}

export async function files_transfer_db_request_stop(
	ctx: MutationCtx,
	args: { runId: Id<"files_transfer_runs">; reason: "user" | "timeout"; now: number },
) {
	const run = await ctx.db.get("files_transfer_runs", args.runId);
	if (!run) return;
	await db_stop_run(
		ctx,
		run,
		args.reason === "timeout" ? "Paste timed out" : null,
		args.now,
		args.reason === "timeout" ? "timed_out" : "canceled",
	);
}

function copy_candidate_name(kind: "file" | "folder", name: string, counter: number) {
	// Normalize before adding the counter so bare README keeps its .md extension.
	const normalized = kind === "folder" ? files_normalize_name("folder", name) : files_normalize_file_rename_name(name);
	if (normalized._nay) return normalized;
	name = normalized._yay;
	// A normalized file name never starts with a dot. `.env` becomes `untitled.env`, because an empty
	// base name falls back to "untitled". Start at index 1 so a leading dot could never be read as
	// the extension separator if that ever changes.
	const dot = kind === "file" ? name.indexOf(".", 1) : -1;
	const base = dot < 0 ? name : name.slice(0, dot);
	const extension = dot < 0 ? "" : name.slice(dot);
	const candidate = `${base}-copy-${counter}${extension}`;
	return kind === "folder" ? files_normalize_name("folder", candidate) : files_normalize_file_rename_name(candidate);
}

async function db_resolve_name(
	ctx: MutationCtx,
	args: {
		run: Doc<"files_transfer_runs">;
		item: Doc<"files_transfer_items">;
		membership: Doc<"organizations_workspaces_users">;
		parent: files_PendingParent;
		parentPath: string;
		reader?: Awaited<ReturnType<typeof files_visible_db_create_reader>>;
		reserved?: Set<string>;
		nameLookups?: { remaining: number };
	},
) {
	const scope = { ...args.run, ...args.run.destinationScope };
	const reader = args.reader ?? (await files_visible_db_create_reader(ctx, { ...scope, readLimit: 2048 }));
	const choice = args.item.choice ?? args.run.applyToRemaining[args.item.kind];
	// Publication keeps the planned name even when another worker finishes first.
	let targetName =
		(args.run.step === "apply" || args.run.step === "reserve") && args.item.plannedPath !== null
			? args.item.plannedPath.slice(args.item.plannedPath.lastIndexOf("/") + 1)
			: args.item.targetName;
	for (let counter = 0; counter <= MAX_NAME_ATTEMPTS;) {
		let name = targetName;
		if (counter > 0) {
			const renamed = copy_candidate_name(args.item.kind, args.item.targetName, counter);
			if (renamed._nay) return renamed;
			name = renamed._yay;
		}

		const path = path_join(args.parentPath, name);
		const claims =
			args.item.parentItemId === null
				? await ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_parentItem_plannedPath", (q) => {
							const matches = q.eq("runId", args.run._id).eq("parentItemId", null).eq("plannedPath", path);
							return args.run.step === "plan" ? matches.lt("order", args.item.order) : matches;
						})
						.take(2)
				: [];
		const reserved = args.reserved?.has(path) || claims.some((claim) => claim._id !== args.item._id);
		if (args.nameLookups) {
			if (args.nameLookups.remaining === 0)
				return Result({ _nay: { message: "Too many name conflicts. Select fewer items." } });
			args.nameLookups.remaining -= 1;
		}

		const savedOccupant =
			args.run.sourceView === "saved"
				? await ctx.db
						.query("files_nodes")
						.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
							q
								.eq("organizationId", scope.organizationId)
								.eq("workspaceId", scope.workspaceId)
								.eq("path", path)
								.eq("archiveOperationId", null),
						)
						.first()
				: null;
		const occupant: files_VisibleEntry | null =
			args.run.sourceView === "draft"
				? ((await reader.findPath(path))?.entry ?? null)
				: savedOccupant
					? { kind: "saved", node: savedOccupant, pendingUpdate: null, path: savedOccupant.path }
					: null;
		if (reader.exhausted) return Result({ _nay: { message: "The destination path needs too many reads" } });

		// Keep an existing literal target. Only normalize a free name, then check that name too.
		if (!occupant && counter === 0) {
			const normalized =
				args.item.kind === "folder" ? files_normalize_name("folder", name) : files_normalize_file_rename_name(name);
			if (normalized._nay) return normalized;
			if (normalized._yay !== name) {
				targetName = normalized._yay;
				continue;
			}
		}

		// Moving onto the source path does not change the file.
		const occupied =
			occupant &&
			!(args.run.kind === "move" && occupant.node._id === args.item.source.id) &&
			occupant.node._id !== args.item.preparation?.privateNodeId;
		if (occupied) {
			// An unreadable occupant answers "Permission denied" so its path stays hidden.
			const readable = await db_get_entry(
				ctx,
				scope,
				occupant.kind === "saved"
					? { kind: "saved", id: occupant.node._id }
					: { kind: "private", id: occupant.node._id },
				reader,
			);
			if (!readable) return Result({ _nay: { message: "Permission denied" } });
		}

		const policy = args.run.conflictPolicy[args.item.kind];
		// Bash -n skips later source branches. An existing destination folder still merges.
		const effective =
			reserved && args.run.origin.kind === "agent" && args.run.conflictPolicy.file === "skip"
				? "skip"
				: (choice ?? policy);

		if (!occupied && !reserved) {
			if (
				args.item.conflictTarget &&
				!(occupant && occupant.node._id === args.item.preparation?.privateNodeId) &&
				(effective === "replace" || effective === "merge" || effective === "replace_empty")
			) {
				await db_pause_item(ctx, args.item, "destination_changed");
				return Result({ _yay: null });
			}
			return Result({ _yay: { name, path, existing: null } });
		}

		if (
			args.item.plannedPath !== null &&
			occupied &&
			!args.item.conflictTarget &&
			effective !== "keep_both" &&
			effective !== "skip"
		) {
			await db_pause_item(ctx, args.item, "destination_changed");
			return Result({ _yay: null });
		}

		if (occupied && !reserved && (effective === "merge" || effective === "replace" || effective === "replace_empty")) {
			const target: files_PendingTarget =
				occupant.kind === "saved"
					? { kind: "saved", id: occupant.node._id }
					: { kind: "private", id: occupant.node._id };
			const version = await files_transfer_db_get_entry_version(ctx, occupant);

			if (
				args.item.conflictTarget &&
				(args.item.conflictTarget.kind !== target.kind ||
					args.item.conflictTarget.id !== target.id ||
					!files_transfer_source_versions_equal(args.item.conflictVersion, version))
			) {
				await db_pause_item(ctx, args.item, "destination_changed");
				return Result({ _yay: null });
			}

			if (occupant.node.kind !== args.item.kind)
				return Result({ _nay: { message: "The source and destination types differ" } });
			if (
				occupant.kind === "private" &&
				(!occupant.pendingUpdate.createIntent ||
					occupant.pendingUpdate.preparation ||
					(occupant.pendingUpdate.createIntent.kind === "text" && !occupant.pendingUpdate.content))
			)
				return Result({ _nay: { message: "The destination draft is still preparing" } });

			const source = await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_source", (q) =>
					q.eq("runId", args.run._id).eq("source.kind", target.kind).eq("source.id", target.id),
				)
				.first();
			if (source) return Result({ _nay: { message: "A copy cannot replace or merge into its sources" } });

			const accessNode = occupant.kind === "saved" ? occupant.node : (await reader.resolve(target))?.accessNode;
			const authorized = await authorize_file_write(ctx, {
				userAuth: { id: args.run.userId },
				membership: args.membership,
				nodeId: accessNode?._id ?? files_ROOT_ID,
			});
			if (authorized._nay) return Result({ _nay: { message: "Permission denied" } });
			if (accessNode) {
				const writable = await files_nodes_db_require_user_writable(ctx, { node: accessNode, userId: args.run.userId });
				if (writable._nay) return writable;
			}

			await ctx.db.patch("files_transfer_items", args.item._id, { conflictTarget: target, conflictVersion: version });
			return Result({ _yay: { name, path, existing: occupant } });
		}

		if (effective === "skip") {
			await db_skip_item(ctx, args.item);
			return Result({ _yay: null });
		}
		if (effective !== "keep_both") {
			if (effective === "error") return Result({ _nay: { message: "The destination already exists" } });
			if (reserved && effective !== "ask")
				return Result({ _nay: { message: "Several sources use the same destination" } });
			if (occupied)
				await ctx.db.patch("files_transfer_items", args.item._id, {
					conflictTarget:
						occupant.kind === "saved"
							? { kind: "saved", id: occupant.node._id }
							: { kind: "private", id: occupant.node._id },
					conflictVersion: await files_transfer_db_get_entry_version(ctx, occupant),
				});
			await db_pause_item(ctx, args.item, "name_conflict");
			return Result({ _yay: null });
		}
		counter += 1;
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
	args: {
		itemId: Id<"files_transfer_items">;
		attempt: number;
		workId?: NonNullable<Doc<"files_transfer_items">["workId"]>;
	},
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (
		!item ||
		item.attempt !== args.attempt ||
		(args.workId !== undefined && item.workId !== args.workId) ||
		item.state !== "copying"
	)
		return Result({ _yay: null });

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return Result({ _yay: null });
	const activity = await db_require_activity(ctx, run._id);
	if (activity.status !== "running" || (run.step !== "apply" && run.step !== "reserve")) return Result({ _yay: null });
	if (activity.deadlineAt <= Date.now()) {
		await files_transfer_db_request_stop(ctx, { runId: run._id, reason: "timeout", now: Date.now() });
		return Result({ _yay: null });
	}
	if (item.attemptExpiresAt !== null && item.attemptExpiresAt <= Date.now()) return Result({ _yay: null });

	// A lost membership or a changed destination stops the whole run.
	const memberships = await db_get_run_memberships(ctx, run, activity);
	if (!memberships) {
		await db_stop_run(ctx, run, "Permission denied");
		return Result({ _yay: null });
	}
	const membership = memberships.destination;

	const destination = await db_get_destination(ctx, {
		run,
		membership,
		parent: run.targetParent,
		expectedPath: run.targetPath,
	});
	if (destination._nay) {
		await db_stop_run(ctx, run, destination._nay.message);
		return Result({ _yay: null });
	}

	// A changed or unreadable source pauses only this item for a choice.
	const sourceScope = { ...run, ...run.sourceScope };
	const sourceReader = await files_visible_db_create_reader(ctx, sourceScope);
	const sourceEntry = await db_get_entry(ctx, sourceScope, item.source, sourceReader);
	if (!sourceEntry || sourceEntry.path !== item.sourcePath) {
		await db_pause_item(ctx, item, "source_changed");
		return Result({ _yay: null });
	}
	const copiedPolicies = files_nodes_db_copied_from_policy_fields({
		prev: sourceEntry.kind === "private" ? sourceEntry.pendingUpdate.copiedFrom : null,
		...(sourceEntry.kind === "saved"
			? {
					sourceWritePolicy: sourceEntry.node.writePolicy,
					sourceNewChildWritePolicy: sourceEntry.node.newChildWritePolicy,
				}
			: {}),
	});
	for (const writePolicy of [copiedPolicies.sourceWritePolicy, copiedPolicies.sourceNewChildWritePolicy]) {
		const allowed = await files_nodes_db_require_copiable_write_policy(ctx, {
			...run.destinationScope,
			writePolicy: writePolicy ?? null,
		});
		if (allowed._nay) return allowed;
	}

	let parent = run.preparedParent ?? destination._yay.parent;
	let parentPath = run.missingParentNames.reduce(path_join, run.targetPath);
	let runWrittenWritePolicy: Doc<"files_nodes">["writePolicy"] | undefined;
	if (item.parentItemId) {
		// A child copies into the folder its parent item produced.
		const parentItem = await ctx.db.get("files_transfer_items", item.parentItemId);
		if (!parentItem || parentItem.state !== "completed" || !parentItem.outputTarget || parentItem.outputPath === null) {
			await db_skip_item(ctx, item);
			return Result({ _yay: null });
		}
		parent = parentItem.outputTarget;
		parentPath = parentItem.outputPath;
		runWrittenWritePolicy = parentItem.outputWritePolicy;
		const parentDestination = await db_get_destination(ctx, {
			run,
			membership,
			parent,
			expectedPath: parentPath,
			runWrittenWritePolicy,
		});
		if (parentDestination._nay) {
			if (parentDestination._nay.name === "read_only") {
				return parentDestination;
			}

			await db_pause_item(ctx, item, "destination_changed");
			return Result({ _yay: null });
		}
		parent = parentDestination._yay.parent;
	}

	if (item.choice === "skip") {
		await db_skip_item(ctx, item);
		return Result({ _yay: null });
	}

	const resolved = await db_resolve_name(ctx, { run, item, membership, parent, parentPath });
	if (resolved._nay) return resolved;
	if (!resolved._yay) return Result({ _yay: null });
	if (item.preparation) {
		const privateNode = await ctx.db.get("files_pending_nodes", item.preparation.privateNodeId);
		const proposal = await ctx.db.get("files_pending_updates", item.preparation.pendingUpdateId);
		if (
			!privateNode ||
			privateNode.state !== "active" ||
			privateNode.creationGeneration !== item.preparation.creationGeneration ||
			privateNode.structuralRevision !== item.preparation.structuralRevision ||
			proposal?.revision !== item.preparation.proposalRevision ||
			proposal.preparation?.transferItemId !== item._id
		) {
			await files_transfer_db_fence_private_target(ctx, {
				privateNodeId: item.preparation.privateNodeId,
				reason: "discard",
			});
			return Result({ _yay: null });
		}
	}

	return Result({
		_yay: {
			run,
			item,
			sourceEntry,
			parent,
			name: resolved._yay.name,
			path: resolved._yay.path,
			existing: resolved._yay.existing,
			destinationMembership: membership,
			sourceMembership: memberships.source,
			copiedPolicies,
			runWrittenWritePolicy,
		},
	});
}

export async function files_transfer_db_fence_private_target(
	ctx: MutationCtx,
	args: { privateNodeId: Id<"files_pending_nodes">; reason: "discard" | "expired" },
) {
	const item = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_preparation_privateNode", (q) => q.eq("preparation.privateNodeId", args.privateNodeId))
		.first();
	if (
		!item ||
		item.state === "completed" ||
		item.state === "canceled" ||
		item.state === "failed" ||
		item.state === "skipped"
	)
		return;
	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return;
	const activity = await db_require_activity(ctx, run._id);
	if (item.workId) await files_transfer_workpool.cancel(ctx, item.workId);
	await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
	await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
	await ctx.db.patch("files_transfer_items", item._id, {
		state: "canceled",
		cancelReason: args.reason === "expired" ? "proposal_expiry" : "proposal_discard",
		conflictKind: null,
	});
	await ctx.db.patch("activities", activity._id, {
		progress: {
			...activity.progress,
			canceled: activity.progress.canceled + 1,
			blocked: activity.progress.blocked - (item.state === "conflict" ? 1 : 0),
		},
		updatedAt: Date.now(),
	});
	await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
}

async function db_hold_proposal(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	target: files_PendingTarget,
	role: "source" | "destination_parent" | "output",
	expectedOutputProposal?: Doc<"files_transfer_items">["outputProposal"],
) {
	const scope = role === "source" ? run.sourceScope : run.destinationScope;
	const pending = await files_db_get_pending_update(ctx, { ...scope, userId: run.userId, target });
	if (!pending) return;
	const node = target.kind === "private" ? await ctx.db.get("files_pending_nodes", target.id) : null;
	const outputProposal = {
		pendingUpdateId: pending._id,
		privateGeneration: node?.creationGeneration ?? null,
		replacementAssetId: pending.pendingReplacement?.assetId ?? null,
	};
	if (
		expectedOutputProposal &&
		(expectedOutputProposal.pendingUpdateId !== outputProposal.pendingUpdateId ||
			expectedOutputProposal.privateGeneration !== outputProposal.privateGeneration ||
			expectedOutputProposal.replacementAssetId !== outputProposal.replacementAssetId)
	)
		return;
	const held = await files_pending_holds_db_acquire(ctx, {
		producer: { kind: "files_transfer_run", id: run._id },
		pendingUpdateId: pending._id,
		target,
		privateGeneration: node?.creationGeneration ?? null,
		expectedRevision: pending.revision,
		role,
	});
	if (held._nay) throw convex_error(held._nay);
	return outputProposal;
}

export async function files_transfer_db_complete_copy_item(
	ctx: MutationCtx,
	args: {
		itemId: Id<"files_transfer_items">;
		attempt: number;
		workId?: NonNullable<Doc<"files_transfer_items">["workId"]>;
		target: files_PendingTarget;
		name: string;
		path: string;
		outcome?: "copied" | "merged";
	},
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (
		!item ||
		item.attempt !== args.attempt ||
		(args.workId !== undefined && item.workId !== args.workId) ||
		item.state === "completed"
	)
		return;

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return;
	const activity = await db_require_activity(ctx, run._id);
	// Ready output and its hold must be adopted together.
	const outputProposal =
		run.publication === "proposal" ? await db_hold_proposal(ctx, run, args.target, "output") : undefined;

	// Only folders store the value: they are the only items whose children read it.
	const savedTarget =
		args.target.kind === "saved" && item.kind === "folder" && (args.outcome ?? "copied") === "copied"
			? args.target
			: null;
	const outputPolicy =
		item.outputWritePolicy !== undefined || savedTarget === null
			? {}
			: await (async (/* iife */) => {
					const node = await ctx.db.get("files_nodes", savedTarget.id);
					if (!node) {
						return {};
					}

					// This node's children may be created while its policy still equals this value.
					return { outputWritePolicy: node.writePolicy };
				})();

	await ctx.db.patch("files_transfer_items", item._id, {
		state: "completed",
		conflictKind: null,
		outputTarget: args.target,
		outputProposal,
		outputMediaAssetId:
			item.capture?.sourceVersion.textKind === null &&
			(item.capture.sourceVersion.contentType.startsWith("image/") ||
				item.capture.sourceVersion.contentType.startsWith("video/"))
				? item.capture.artifact?.contentAssetId
				: undefined,
		outcome: args.outcome ?? "copied",
		outputName: args.name,
		outputPath: args.path,
		stagedAssetIds: [],
		// The saved file now owns these assets. Run cleanup must leave them alone.
		capture: item.capture ? { ...item.capture, artifact: null } : null,
		...(item.workId === null ? { attemptExpiresAt: null } : {}),
		...outputPolicy,
	});
	await ctx.db.patch("activities", activity._id, {
		progress: { ...activity.progress, completed: activity.progress.completed + 1 },
		deadlineAt: run.fixedDeadline ? activity.deadlineAt : Date.now() + RUN_TIMEOUT_MS,
		updatedAt: Date.now(),
	});
	await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
}

export async function files_transfer_db_fail_copy_item(
	ctx: MutationCtx,
	args: {
		itemId: Id<"files_transfer_items">;
		attempt: number;
		workId?: NonNullable<Doc<"files_transfer_items">["workId"]>;
		message: string;
	},
) {
	const item = await ctx.db.get("files_transfer_items", args.itemId);
	if (
		!item ||
		item.attempt !== args.attempt ||
		(args.workId !== undefined && item.workId !== args.workId) ||
		item.state !== "copying"
	)
		return;

	const run = await ctx.db.get("files_transfer_runs", item.runId);
	if (!run) return;
	const activity = await db_require_activity(ctx, run._id);
	if (activity.status !== "running") return;

	await files_nodes_content_db_discard_transfer_file_attempt(ctx, args);
	await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
	await ctx.db.patch("files_transfer_items", item._id, { state: "failed", errorMessage: args.message });
	if (item.preparation)
		await files_pending_nodes_db_discard(ctx, {
			...run,
			...run.destinationScope,
			...item.preparation,
			expectedRevision: item.preparation.proposalRevision,
		});
	// Keep messages free of names, paths, and file content: run history can outlive source access.
	await ctx.db.patch("activities", activity._id, {
		progress: { ...activity.progress, failed: activity.progress.failed + 1 },
		errorMessage: activity.errorMessage ?? args.message,
		errorCode: "copy_failed",
		updatedAt: Date.now(),
	});
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

async function db_get_run_view(
	ctx: QueryCtx,
	run: Doc<"files_transfer_runs">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const activity = await db_require_activity(ctx, run._id);
	const conflicts = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "conflict"))
		.take(MAX_SELECTED_NODES);

	const sourceScope = { ...run, ...run.sourceScope };
	const reader = await files_visible_db_create_reader(ctx, sourceScope);
	const visibleConflicts = [];
	for (const item of conflicts) {
		// Hide names once the source is no longer readable; run history can outlive source access.
		const readable = (await db_get_entry(ctx, sourceScope, item.source, reader))?.path === item.sourcePath;
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
					.take(MAX_SELECTED_NODES)
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

		const activity = await db_get_current_activity(ctx, { userId: userAuth.id, workspaceId: membership.workspaceId });
		if (!activity || activity.source.kind !== "files_transfer_run") return [];
		const run = await ctx.db.get("files_transfer_runs", activity.source.id);
		return run ? [await db_get_run_view(ctx, run, membership)] : [];
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
		paginationOpts: paginationOptsValidator,
	},
	returns: v.union(paginationResultValidator(item_view_validator), v.null()),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) {
			if (owned._nay.message === "Unauthenticated") throw convex_error({ message: "Unauthenticated" });
			return null;
		}
		const { run } = owned._yay;
		const items = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_order", (q) => q.eq("runId", run._id))
			.paginate({ ...args.paginationOpts, numItems: Math.max(1, Math.min(50, args.paginationOpts.numItems)) });
		const sourceScope = { ...run, ...run.sourceScope };
		const sourceReader = await files_visible_db_create_reader(ctx, sourceScope);
		const reader = await files_visible_db_create_reader(ctx, { ...run, ...run.destinationScope });
		const page = [];
		for (const item of items.page) {
			const source = await db_get_entry(ctx, sourceScope, item.source, sourceReader);
			const output = item.outputTarget ? await reader.resolveTarget(item.outputTarget) : null;
			const conflict = item.conflictTarget ? await reader.resolveTarget(item.conflictTarget) : null;
			page.push({
				itemId: item._id,
				state: item.state,
				kind: item.kind,
				outcome: item.outcome,
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

async function db_insert_item(
	ctx: MutationCtx,
	args: Pick<
		Doc<"files_transfer_items">,
		| "organizationId"
		| "workspaceId"
		| "runId"
		| "source"
		| "sourceParent"
		| "sourceName"
		| "sourcePath"
		| "targetName"
		| "kind"
		| "parentItemId"
		| "order"
		| "discoveryDone"
	>,
) {
	return await ctx.db.insert("files_transfer_items", {
		...args,
		plannedPath: null,
		discoveryCursor: null,
		state: "pending",
		conflictKind: null,
		choice: null,
		conflictTarget: null,
		conflictVersion: null,
		preparation: null,
		outcome: null,
		cancelReason: null,
		errorCode: null,
		attempt: 0,
		workId: null,
		attemptExpiresAt: null,
		stagedAssetIds: [],
		capture: null,
		billedUserId: null,
		outputTarget: null,
		outputName: null,
		outputPath: null,
		errorMessage: null,
	});
}

async function db_start(
	ctx: MutationCtx,
	args: {
		membership: Doc<"organizations_workspaces_users">;
		sourceMembership: Doc<"organizations_workspaces_users">;
		destinationMembership: Doc<"organizations_workspaces_users">;
		requestId: string;
		kind: Doc<"files_transfer_runs">["kind"];
		sources: files_PendingTarget[];
		expectedSourceCount?: number;
		targetParent: files_PendingParent;
		targetPath: string;
		targetName: string | null;
		missingParentNames: string[];
		conflictPolicy: Doc<"files_transfer_runs">["conflictPolicy"];
		origin: Doc<"files_transfer_runs">["origin"];
		/**
		 * A transfer started by a background Bash job hides its Activity from the feed: the job's
		 * own Activity is the one row with the Stop button.
		 */
		feedVisible: boolean;
		executionDeadlineAt?: number;
	},
) {
	const { membership } = args;
	const sourceCount = args.expectedSourceCount ?? args.sources.length;
	if (!args.requestId || args.requestId.length > 128) return Result({ _nay: { message: "Invalid request ID" } });
	if (
		!Number.isSafeInteger(sourceCount) ||
		sourceCount < 1 ||
		args.sources.length === 0 ||
		args.sources.length > sourceCount ||
		(args.kind === "copy"
			? args.expectedSourceCount === undefined || args.sources.length > files_TRANSFER_SELECTION_PAGE_SIZE
			: args.sources.length > MAX_SELECTED_NODES)
	)
		return Result({ _nay: { name: "invalid_selection", message: "Invalid source count or selection page size" } });
	if (
		args.missingParentNames.length > 32 ||
		(args.kind === "move" && args.missingParentNames.length > 0) ||
		(args.targetName !== null && sourceCount !== 1)
	)
		return Result({ _nay: { message: "Invalid transfer destination" } });

	const user = await ctx.db.get("users", membership.userId);
	const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
	if (
		!user ||
		user.deletedAt !== undefined ||
		!workspace ||
		workspace.organizationId !== membership.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined
	)
		return Result({ _nay: { message: "Permission denied" } });

	if (args.kind === "move" && args.sourceMembership.workspaceId !== args.destinationMembership.workspaceId)
		return Result({
			_nay: {
				name: "cross_workspace_move",
				message:
					"Moves between workspaces are not allowed. Use cp to copy files instead, or cp -R for a folder. The originals will stay in place.",
			},
		});

	const sourceView = args.origin.kind === "agent" ? ("draft" as const) : ("saved" as const);
	const publication = args.origin.kind === "agent" ? ("proposal" as const) : ("saved" as const);
	const scope = {
		organizationId: membership.organizationId,
		workspaceId: membership.workspaceId,
		userId: membership.userId,
	};
	const sourceScope = {
		organizationId: args.sourceMembership.organizationId,
		workspaceId: args.sourceMembership.workspaceId,
		membershipId: args.sourceMembership._id,
		membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, args.sourceMembership),
	};
	const destinationScope = {
		organizationId: args.destinationMembership.organizationId,
		workspaceId: args.destinationMembership.workspaceId,
		membershipId: args.destinationMembership._id,
		membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, args.destinationMembership),
	};

	for (const name of args.missingParentNames) {
		const normalized = files_normalize_name("folder", name);
		if (normalized._nay || normalized._yay !== name) return Result({ _nay: { message: "Invalid folder name" } });
	}

	const requestHash = await crypto_sha256_hex(
		JSON.stringify([
			args.kind,
			sourceScope,
			destinationScope,
			sourceCount,
			args.sources,
			args.targetParent,
			args.targetPath,
			args.targetName,
			args.missingParentNames,
			args.conflictPolicy,
			args.origin,
			args.executionDeadlineAt !== undefined,
		]),
	);

	const previous = await ctx.db
		.query("files_transfer_runs")
		.withIndex("by_user_workspace_request", (q) =>
			q.eq("userId", membership.userId).eq("workspaceId", membership.workspaceId).eq("requestId", args.requestId),
		)
		.unique();
	if (previous) {
		if (previous.requestHash !== requestHash)
			return Result({
				_nay: { name: "request_changed", message: "This request ID was already used for another transfer" },
			});
		const activity = await db_require_activity(ctx, previous._id);
		return Result({ _yay: { runId: previous._id, activityId: activity._id } });
	}

	const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: membership.userId });
	if (rateLimit) return Result({ _nay: { message: rateLimit.message } });

	const activeActivity = await db_get_current_activity(ctx, scope);
	if (activeActivity && activeActivity.source.kind === "files_transfer_run")
		return Result({
			_nay: {
				name: "busy",
				message: "A transfer is already running in this workspace",
				data: { runId: activeActivity.source.id, activityId: activeActivity._id },
			},
		});

	const destination = await db_get_destination(ctx, {
		run: { ...scope, sourceView, destinationScope },
		membership: args.destinationMembership,
		parent: args.targetParent,
		expectedPath: args.targetPath,
	});
	if (destination._nay) return destination;

	const reader = await files_visible_db_create_reader(ctx, { ...sourceScope, userId: membership.userId });
	const entries: files_VisibleEntry[] = [];
	for (const target of args.kind === "move" ? args.sources : []) {
		if (entries.some((entry) => entry.kind === target.kind && entry.node._id === target.id)) continue;
		const entry = await db_get_entry(ctx, { ...scope, ...sourceScope, sourceView }, target, reader);
		if (!entry)
			return Result({
				_nay: { message: reader.exhausted ? "Select fewer items or shallower folders" : "Permission denied" },
			});
		if (entry.pendingUpdate?.preparation || (entry.kind === "private" && !entry.pendingUpdate.createIntent))
			return Result({ _nay: { name: "not_ready", message: "The source draft is still preparing" } });
		// Copy finishes discovery before output and checks replacement against every source.
		if (
			args.kind === "move" &&
			entry.node.kind === "folder" &&
			(args.targetPath === entry.path || args.targetPath.startsWith(entry.path + "/"))
		)
			return Result({ _nay: { message: "A folder cannot be transferred inside itself" } });
		entries.push(entry);
	}

	const roots = entries.filter(
		(entry) =>
			!entries.some(
				(parent) =>
					parent.node.kind === "folder" &&
					parent.node._id !== entry.node._id &&
					entry.path.startsWith(parent.path + "/"),
			),
	);

	if (args.targetName !== null && args.kind === "move") {
		const normalized =
			roots[0]!.node.kind === "folder"
				? files_normalize_name("folder", args.targetName)
				: files_normalize_file_rename_name(args.targetName);
		if (normalized._nay || !args.targetName || args.targetName === "." || /[/\\]/.test(args.targetName))
			return Result({ _nay: { message: "Invalid destination name" } });
	}

	const now = Date.now();
	if (
		args.executionDeadlineAt !== undefined &&
		(!Number.isFinite(args.executionDeadlineAt) || args.executionDeadlineAt <= now)
	)
		return Result({ _nay: { name: "timed_out", message: "Transfer timed out" } });

	const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
	const runId = await ctx.db.insert("files_transfer_runs", {
		...scope,
		sourceScope,
		destinationScope,
		requestId: args.requestId,
		requestHash,
		kind: args.kind,
		sourceView,
		publication,
		origin: args.origin,
		targetParent: args.targetParent,
		targetPath: args.targetPath,
		targetName: args.targetName,
		missingParentNames: args.missingParentNames,
		preparedParent: null,
		fixedDeadline: args.executionDeadlineAt !== undefined,
		conflictPolicy: args.conflictPolicy,
		step: args.kind === "copy" ? "uploading" : "discover",
		...(args.kind === "copy"
			? { selection: { expectedCount: sourceCount, count: args.sources.length, cursor: -1 } }
			: {}),
		planCursor: null,
		reserveCursor: null,
		retryOf: null,
		retryCursor: null,
		revision: 0,
		inFlight: 0,
		applyToRemaining: { file: null, folder: null },
	});

	if (args.kind === "copy") {
		for (const [order, source] of args.sources.entries()) {
			await ctx.db.insert("files_transfer_selection_items", { runId, order, source, path: null, kind: null });
		}
	}

	for (const [order, entry] of roots.entries()) {
		const source: files_PendingTarget =
			entry.kind === "saved" ? { kind: "saved", id: entry.node._id } : { kind: "private", id: entry.node._id };
		const sourceParent: files_PendingParent =
			entry.kind === "private"
				? entry.node.parent
				: (entry.pendingUpdate?.pendingMove?.destParent ??
					(entry.node.parentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: entry.node.parentId }));
		const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
		await db_insert_item(ctx, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			runId,
			source,
			sourceParent,
			sourceName: name,
			sourcePath: entry.path,
			targetName: args.targetName ?? name,
			kind: entry.node.kind,
			parentItemId: null,
			order,
			discoveryDone: args.kind === "move" || entry.node.kind === "file",
		});
	}

	const activityId = await activities_db_start(ctx, {
		...scope,
		membershipId: membership._id,
		membershipLifetime,
		status: "queued",
		visibility: "requester",
		feedVisible: args.feedVisible,
		source: { kind: "files_transfer_run", id: runId, transferKind: args.kind },
		progress: {
			unit: "files",
			discovered: roots.length,
			total: args.kind === "move" ? roots.length : null,
			completed: 0,
			skipped: 0,
			failed: 0,
			blocked: 0,
			canceled: 0,
		},
		resultKind: publication === "proposal" ? "ready_for_review" : "saved",
		title: args.kind === "move" ? "Move files" : "Copy files",
		targets: [],
		deadlineAt: args.executionDeadlineAt ?? now + RUN_TIMEOUT_MS,
		now,
	});
	if (args.kind === "copy" && sourceView === "draft") {
		const run = (await ctx.db.get("files_transfer_runs", runId))!;
		for (const source of args.sources) await db_hold_proposal(ctx, run, source, "source");
		if (args.targetParent.kind === "private") await db_hold_proposal(ctx, run, args.targetParent, "destination_parent");
	}

	if (args.kind === "move") await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId });
	return Result({ _yay: { runId, activityId } });
}

export const start = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		requestId: v.string(),
		kind: doc(app_convex_schema, "files_transfer_runs").fields.kind,
		expectedSourceCount: v.optional(v.number()),
		sourceIds: v.array(v.id("files_nodes")),
		targetParentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
	},
	returns: v_result({
		_yay: v.object({ runId: v.id("files_transfer_runs"), activityId: v.id("activities") }),
		_nay: { data: v.object({ runId: v.id("files_transfer_runs"), activityId: v.id("activities") }) },
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) return Result({ _nay: { message: "Unauthenticated" } });
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) return Result({ _nay: { message: "Unauthorized" } });
		const target = args.targetParentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.targetParentId);
		return await db_start(ctx, {
			membership,
			sourceMembership: membership,
			destinationMembership: membership,
			requestId: args.requestId,
			kind: args.kind,
			expectedSourceCount: args.expectedSourceCount,
			sources: args.sourceIds.map((id) => ({ kind: "saved", id })),
			targetParent:
				args.targetParentId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: args.targetParentId },
			targetPath: target?.path ?? "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "ask", folder: "ask" },
			origin: { kind: "clipboard" },
			feedVisible: true,
		});
	},
});

export const start_for_agent = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		sourceWorkspace: v.union(v.literal("current"), v.literal("personal")),
		destinationWorkspace: v.union(v.literal("current"), v.literal("personal")),
		invocation: v.optional(
			v.object({ id: v.id("ai_chat_bash_invocations"), commandNumber: v.number(), workId: v.optional(vWorkId) }),
		),
		requestId: v.string(),
		kind: doc(app_convex_schema, "files_transfer_runs").fields.kind,
		expectedSourceCount: v.optional(v.number()),
		sources: v.array(files_pending_target_validator),
		targetParent: files_pending_parent_validator,
		targetPath: v.string(),
		targetName: v.union(v.string(), v.null()),
		missingParentNames: v.array(v.string()),
		conflictPolicy: doc(app_convex_schema, "files_transfer_runs").fields.conflictPolicy,
		executionDeadlineAt: v.optional(v.number()),
	},
	returns: v_result({
		_yay: v.object({ runId: v.id("files_transfer_runs"), activityId: v.id("activities") }),
		_nay: { data: v.object({ runId: v.id("files_transfer_runs"), activityId: v.id("activities") }) },
	}),
	handler: async (ctx, args) => {
		const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (
			!membership?.active ||
			!thread ||
			thread.createdBy !== membership.userId ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId
		)
			return Result({ _nay: { message: "Unauthorized" } });

		const invocation = args.invocation ? await ctx.db.get("ai_chat_bash_invocations", args.invocation.id) : null;
		if (
			args.invocation &&
			(!invocation ||
				invocation.membershipId !== membership._id ||
				invocation.userId !== membership.userId ||
				invocation.threadId !== thread._id ||
				invocation.organizationId !== membership.organizationId ||
				invocation.workspaceId !== membership.workspaceId)
		)
			return Result({ _nay: { message: "Unauthorized" } });

		const existing = args.invocation
			? await ai_chat_files_db_get_bash_transfer(ctx, {
					invocationId: args.invocation.id,
					commandNumber: args.invocation.commandNumber,
				})
			: null;
		const job = args.invocation?.workId
			? {
					invocationId: args.invocation.id,
					commandNumber: args.invocation.commandNumber,
					workId: args.invocation.workId,
				}
			: null;
		const admission = job ? await ai_chat_files_db_check_copy_admission(ctx, job) : null;
		if (admission?._nay) return admission;
		const checkpoint = admission?._yay.checkpoint;
		if (
			(checkpoint && (args.kind !== "copy" || checkpoint.phase !== "admitting")) ||
			(!job && invocation?.job?.copy && invocation.job.copy.commandNumber === args.invocation?.commandNumber)
		)
			return Result({ _nay: { name: "stale_job", message: "This Copy must use its current Bash job checkpoint." } });
		if (
			invocation &&
			!existing &&
			(invocation.status !== "running" || (!job && invocation.transferDeadlineAt <= Date.now()))
		)
			return Result({ _nay: { name: "timed_out", message: "This Bash call has ended. Start a new command." } });
		// A user stop does not change the row status, so the flag is checked on its own.
		if (invocation?.job && !existing && invocation.job.stopRequestedAt !== null)
			return Result({ _nay: { name: "stopped", message: "This job is stopping. No new transfer can start." } });

		const agentSource = {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			threadId: thread._id,
			membershipId: membership._id,
			membershipLifetime:
				invocation?.membershipLifetime ?? (await organizations_membership_lifetimes_db_ensure(ctx, membership)),
		};
		const source = await ai_chat_workspaces_db_resolve(ctx, { source: agentSource, workspace: args.sourceWorkspace });
		if (source._nay) return source;
		const destination = await ai_chat_workspaces_db_resolve(ctx, {
			source: agentSource,
			workspace: args.destinationWorkspace,
		});
		if (destination._nay) return destination;
		const sourceMembership = (await ctx.db.get("organizations_workspaces_users", source._yay.membershipId))!;
		const destinationMembership = (await ctx.db.get("organizations_workspaces_users", destination._yay.membershipId))!;
		if (checkpoint?.phase === "admitting") {
			const sourceScope = {
				organizationId: sourceMembership.organizationId,
				workspaceId: sourceMembership.workspaceId,
				membershipId: sourceMembership._id,
				membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, sourceMembership),
			};
			const destinationScope = {
				organizationId: destinationMembership.organizationId,
				workspaceId: destinationMembership.workspaceId,
				membershipId: destinationMembership._id,
				membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, destinationMembership),
			};
			if (
				compareValues(checkpoint.sourceScope, sourceScope) !== 0 ||
				compareValues(checkpoint.destinationScope, destinationScope) !== 0 ||
				checkpoint.sourceWorkspace !== args.sourceWorkspace ||
				checkpoint.destinationWorkspace !== args.destinationWorkspace ||
				checkpoint.expectedSourceCount !== args.expectedSourceCount ||
				args.sources.length !== Math.min(files_TRANSFER_SELECTION_PAGE_SIZE, checkpoint.expectedSourceCount) ||
				compareValues(checkpoint.targetParent, args.targetParent) !== 0 ||
				checkpoint.targetPath !== args.targetPath ||
				checkpoint.targetName !== args.targetName ||
				compareValues(checkpoint.missingParentNames, args.missingParentNames) !== 0 ||
				compareValues(checkpoint.conflictPolicy, args.conflictPolicy) !== 0 ||
				(checkpoint.runId !== null && checkpoint.runId !== existing?.runId)
			)
				return Result({ _nay: { name: "request_changed", message: "Copy no longer matches the saved Bash input." } });
			const sources = await ai_chat_files_db_check_copy_sources(ctx, { ...job!, offset: 0, sources: args.sources });
			if (sources._nay) return sources;
		}

		const started = await db_start(ctx, {
			...args,
			membership,
			sourceMembership,
			destinationMembership,
			requestId: args.invocation ? `${args.invocation.id}:${args.invocation.commandNumber}` : args.requestId,
			executionDeadlineAt: job ? undefined : (invocation?.transferDeadlineAt ?? args.executionDeadlineAt),
			origin: { kind: "agent", threadId: args.threadId },
			// One command must not make two feed rows: a job's copy hides behind the job's Activity.
			feedVisible: !invocation?.job,
		});
		if (started._nay || !args.invocation) return started;

		const linked = await ai_chat_files_db_link_bash_transfer(ctx, {
			invocationId: args.invocation.id,
			commandNumber: args.invocation.commandNumber,
			...started._yay,
		});
		// The receipt and accepted run must commit together.
		if (linked._nay) throw convex_error(linked._nay);
		if (job) {
			await ctx.db.patch("files_transfer_runs", started._yay.runId, {
				bashJob: { invocationId: job.invocationId, commandNumber: job.commandNumber },
			});
			await ai_chat_files_db_link_copy_admission(ctx, { ...job, runId: started._yay.runId });
		}

		return started;
	},
});

async function db_get_agent_run(
	ctx: QueryCtx | MutationCtx,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
		threadId: Id<"ai_chat_threads">;
		runId: Id<"files_transfer_runs">;
	},
) {
	const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
	const thread = await ctx.db.get("ai_chat_threads", args.threadId);
	const run = await ctx.db.get("files_transfer_runs", args.runId);
	if (
		!membership?.active ||
		!thread ||
		!run ||
		thread.createdBy !== membership.userId ||
		thread.organizationId !== membership.organizationId ||
		thread.workspaceId !== membership.workspaceId ||
		run.userId !== membership.userId ||
		run.organizationId !== membership.organizationId ||
		run.workspaceId !== membership.workspaceId
	)
		return null;
	return run;
}

async function db_check_copy_job(
	ctx: QueryCtx | MutationCtx,
	run: Doc<"files_transfer_runs">,
	job?: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number; workId: WorkId },
) {
	if (!run.bashJob && !job) return Result({ _yay: null });
	if (!job || run.bashJob?.invocationId !== job.invocationId || run.bashJob.commandNumber !== job.commandNumber)
		return Result({ _nay: { name: "stale_job", message: "This Copy must use its current Bash job checkpoint." } });
	const checked = await ai_chat_files_db_check_copy_admission(ctx, job);
	if (checked._nay) return checked;
	if (checked._yay.checkpoint.runId !== run._id)
		return Result({ _nay: { name: "stale_job", message: "This Bash Copy checkpoint belongs to another transfer." } });
	return Result({ _yay: null });
}

async function db_append_sources(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	args: {
		offset: number;
		sources: files_PendingTarget[];
		job?: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number; workId: WorkId };
	},
) {
	const job = await db_check_copy_job(ctx, run, args.job);
	if (job._nay) return job;
	if (args.job) {
		const sources = await ai_chat_files_db_check_copy_sources(ctx, {
			...args.job,
			offset: args.offset,
			sources: args.sources,
		});
		if (sources._nay) return sources;
	}
	const activity = await db_require_activity(ctx, run._id);
	if (!(await db_get_run_memberships(ctx, run, activity))) return Result({ _nay: { message: "Permission denied" } });
	if (
		!run.selection ||
		!Number.isSafeInteger(args.offset) ||
		args.offset < 0 ||
		args.offset > run.selection.count ||
		args.sources.length < 1 ||
		args.sources.length > files_TRANSFER_SELECTION_PAGE_SIZE ||
		args.offset + args.sources.length > run.selection.expectedCount
	)
		return Result({ _nay: { name: "invalid_selection", message: "Invalid source page position or size" } });

	if (args.offset < run.selection.count) {
		const existing = await ctx.db
			.query("files_transfer_selection_items")
			.withIndex("by_run_order", (q) =>
				q
					.eq("runId", run._id)
					.gte("order", args.offset)
					.lt("order", args.offset + args.sources.length),
			)
			.take(files_TRANSFER_SELECTION_PAGE_SIZE);
		if (
			existing.length !== args.sources.length ||
			existing.some((item, index) => {
				const source = args.sources[index]!;
				return item.source.kind !== source.kind || item.source.id !== source.id;
			})
		)
			return Result({
				_nay: { name: "request_changed", message: "This source page was already sent with different items" },
			});
		return Result({ _yay: null });
	}
	if (run.step !== "uploading")
		return Result({ _nay: { name: "selection_sealed", message: "This Copy selection is already closed" } });
	const now = Date.now();
	if (!activities_is_active(activity.status) || activity.status === "stopping" || activity.deadlineAt <= now)
		return Result({ _nay: { name: "timed_out", message: "This Copy request has ended" } });
	for (const [index, source] of args.sources.entries()) {
		await ctx.db.insert("files_transfer_selection_items", {
			runId: run._id,
			order: args.offset + index,
			source,
			path: null,
			kind: null,
		});
		if (run.sourceView === "draft") await db_hold_proposal(ctx, run, source, "source");
	}
	await ctx.db.patch("files_transfer_runs", run._id, {
		selection: { ...run.selection, count: run.selection.count + args.sources.length },
	});
	await ctx.db.patch("activities", activity._id, {
		deadlineAt: run.fixedDeadline ? activity.deadlineAt : now + RUN_TIMEOUT_MS,
		updatedAt: now,
	});
	return Result({ _yay: null });
}

async function db_seal(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	job?: { invocationId: Id<"ai_chat_bash_invocations">; commandNumber: number; workId: WorkId },
) {
	const checked = await db_check_copy_job(ctx, run, job);
	if (checked._nay) return checked;
	const activity = await db_require_activity(ctx, run._id);
	if (!(await db_get_run_memberships(ctx, run, activity))) return Result({ _nay: { message: "Permission denied" } });
	if (!run.selection)
		return Result({ _nay: { name: "invalid_selection", message: "This transfer has no Copy selection" } });
	if (run.step !== "uploading") return Result({ _yay: null });
	if (run.selection.count !== run.selection.expectedCount)
		return Result({ _nay: { name: "incomplete_selection", message: "Send all sources before starting Copy" } });
	const now = Date.now();
	if (!activities_is_active(activity.status) || activity.status === "stopping" || activity.deadlineAt <= now)
		return Result({ _nay: { name: "timed_out", message: "This Copy request has ended" } });
	await ctx.db.patch("files_transfer_runs", run._id, { step: "select" });
	await ctx.db.patch("activities", activity._id, {
		deadlineAt: run.fixedDeadline ? activity.deadlineAt : now + RUN_TIMEOUT_MS,
		updatedAt: now,
	});
	await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
	if (job)
		await ai_chat_files_db_seal_copy_admission(ctx, {
			...job,
			runId: run._id,
			deadlineAt: run.fixedDeadline ? activity.deadlineAt : now + RUN_TIMEOUT_MS,
			now,
		});
	return Result({ _yay: null });
}

export const append_sources = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_transfer_runs"),
		offset: v.number(),
		sourceIds: v.array(v.id("files_nodes")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;
		return await db_append_sources(ctx, owned._yay.run, {
			offset: args.offset,
			sources: args.sourceIds.map((id) => ({ kind: "saved", id })),
		});
	},
});

export const seal = mutation({
	args: { membershipId: v.id("organizations_workspaces_users"), runId: v.id("files_transfer_runs") },
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;
		return await db_seal(ctx, owned._yay.run);
	},
});

export const append_sources_for_agent = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		runId: v.id("files_transfer_runs"),
		offset: v.number(),
		sources: v.array(files_pending_target_validator),
		job: v.optional(
			v.object({ invocationId: v.id("ai_chat_bash_invocations"), commandNumber: v.number(), workId: vWorkId }),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const run = await db_get_agent_run(ctx, args);
		if (!run) return Result({ _nay: { message: "Not found" } });
		return await db_append_sources(ctx, run, args);
	},
});

export const seal_for_agent = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		runId: v.id("files_transfer_runs"),
		job: v.optional(
			v.object({ invocationId: v.id("ai_chat_bash_invocations"), commandNumber: v.number(), workId: vWorkId }),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const run = await db_get_agent_run(ctx, args);
		if (!run) return Result({ _nay: { message: "Not found" } });
		return await db_seal(ctx, run, args.job);
	},
});

/**
 * The lane check a background Bash job polls before it starts a copy: one transfer per user and
 * workspace, and four jobs can share that lane. This query never charges the rate limiter, unlike
 * a refused `start_for_agent`. Fenced like `db_get_agent_run`.
 */
export const get_current_activity_for_agent = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
	},
	returns: v.union(
		v.object({
			activityId: v.id("activities"),
			status: doc(app_convex_schema, "activities").fields.status,
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
		const thread = await ctx.db.get("ai_chat_threads", args.threadId);
		if (
			!membership?.active ||
			!thread ||
			thread.createdBy !== membership.userId ||
			thread.organizationId !== membership.organizationId ||
			thread.workspaceId !== membership.workspaceId
		)
			return null;
		const activity = await db_get_current_activity(ctx, {
			userId: membership.userId,
			workspaceId: membership.workspaceId,
		});
		return activity ? { activityId: activity._id, status: activity.status } : null;
	},
});

export const get_for_agent = internalQuery({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		runId: v.id("files_transfer_runs"),
	},
	returns: v.union(
		v.object({
			runId: v.id("files_transfer_runs"),
			publication: doc(app_convex_schema, "files_transfer_runs").fields.publication,
			step: doc(app_convex_schema, "files_transfer_runs").fields.step,
			selection: v.union(v.object({ expectedCount: v.number(), count: v.number() }), v.null()),
			activity: doc(app_convex_schema, "activities"),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const run = await db_get_agent_run(ctx, args);
		if (!run) return null;
		return {
			runId: run._id,
			publication: run.publication,
			step: run.step,
			selection: run.selection ? { expectedCount: run.selection.expectedCount, count: run.selection.count } : null,
			activity: await db_require_activity(ctx, run._id),
		};
	},
});

export const stop_for_agent = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		threadId: v.id("ai_chat_threads"),
		runId: v.id("files_transfer_runs"),
		reason: v.union(v.literal("user"), v.literal("timeout")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const run = await db_get_agent_run(ctx, args);
		if (!run) return Result({ _nay: { message: "Not found" } });
		await files_transfer_db_request_stop(ctx, { runId: run._id, reason: args.reason, now: Date.now() });
		return Result({ _yay: null });
	},
});

export const resolve_conflicts = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_transfer_runs"),
		revision: v.number(),
		choices: v.array(
			v.object({
				itemId: v.id("files_transfer_items"),
				choice: v.union(v.literal("keep_both"), v.literal("skip"), v.literal("merge"), v.literal("replace")),
				reviewedTarget: v.optional(files_pending_target_validator),
				reviewedVersion: v.optional(v.union(files_transfer_source_version_validator, v.null())),
			}),
		),
		applyToRemaining: doc(app_convex_schema, "files_transfer_runs").fields.applyToRemaining,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;

		const { run } = owned._yay;
		if (run.kind === "move" && args.applyToRemaining.folder === "merge")
			return Result({ _nay: { message: "Moving into a nonempty folder cannot merge its contents" } });
		const activity = await db_require_activity(ctx, run._id);
		// The revision pins the conflict set the user reviewed; a new conflict bumps it.
		if (activity.status !== "awaiting_input" || run.revision !== args.revision)
			return Result({ _nay: { message: "The conflicts changed. Review them again." } });
		if (!(await db_get_run_memberships(ctx, run, activity))) return Result({ _nay: { message: "Permission denied" } });
		if (activity.deadlineAt <= Date.now()) {
			await files_transfer_db_request_stop(ctx, { runId: run._id, reason: "timeout", now: Date.now() });
			return Result({ _nay: { message: "Paste timed out" } });
		}

		if (
			args.choices.length === 0 ||
			args.choices.length > MAX_SELECTED_NODES ||
			new Set(args.choices.map((choice) => choice.itemId)).size !== args.choices.length
		) {
			return Result({ _nay: { message: "Choose how to handle each conflict" } });
		}

		const items = await Promise.all(args.choices.map((choice) => ctx.db.get("files_transfer_items", choice.itemId)));
		const reader = await files_visible_db_create_reader(ctx, { ...run, ...run.destinationScope });
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
			const choice = args.choices[index]!;
			if (choice.choice === "replace" || choice.choice === "merge") {
				if (
					(choice.choice === "replace"
						? item.kind !== "file" && run.kind !== "move"
						: item.kind !== "folder" || run.kind === "move") ||
					!choice.reviewedTarget ||
					!item.conflictTarget ||
					choice.reviewedTarget.kind !== item.conflictTarget.kind ||
					choice.reviewedTarget.id !== item.conflictTarget.id ||
					choice.reviewedVersion === undefined ||
					!files_transfer_source_versions_equal(choice.reviewedVersion, item.conflictVersion)
				)
					return Result({ _nay: { message: "Review this exact destination before replacing or merging it" } });
				const current = await reader.resolveTarget(item.conflictTarget);
				if (
					!current ||
					!files_transfer_source_versions_equal(
						await files_transfer_db_get_entry_version(ctx, current),
						choice.reviewedVersion,
					)
				)
					return Result({ _nay: { message: "The destination changed. Review it again." } });
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

		await ctx.db.patch("files_transfer_runs", run._id, {
			step: undiscovered ? "discover" : run.step === "apply" ? "apply" : "plan",
			planCursor: null,
			reserveCursor: null,
			applyToRemaining: args.applyToRemaining,
		});
		await ctx.db.patch("activities", activity._id, {
			status: conflict ? "awaiting_input" : "running",
			progress: {
				...activity.progress,
				total: undiscovered ? null : activity.progress.discovered,
				blocked: activity.progress.blocked - args.choices.length,
			},
			deadlineAt: run.fixedDeadline
				? activity.deadlineAt
				: Date.now() + (conflict ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
			updatedAt: Date.now(),
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

		await files_transfer_db_request_stop(ctx, { runId: owned._yay.run._id, reason: "user", now: Date.now() });
		return Result({ _yay: null });
	},
});

/**
 * A new run copies the old manifest and reads current source versions.
 */
export const retry_remaining = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		runId: v.id("files_transfer_runs"),
		requestId: v.string(),
	},
	returns: v_result({ _yay: v.object({ runId: v.id("files_transfer_runs"), activityId: v.id("activities") }) }),
	handler: async (ctx, args) => {
		const owned = await db_get_owned_run(ctx, args);
		if (owned._nay) return owned;
		const { run, membership } = owned._yay;
		if (!args.requestId || args.requestId.length > 128) return Result({ _nay: { message: "Invalid request ID" } });

		const activity = await db_require_activity(ctx, run._id);
		const memberships = await db_get_run_memberships(ctx, run, activity);
		if (!memberships) return Result({ _nay: { message: "Permission denied" } });

		const requestHash = await crypto_sha256_hex(JSON.stringify(["retry", run._id]));
		const previous = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_user_workspace_request", (q) =>
				q.eq("userId", run.userId).eq("workspaceId", run.workspaceId).eq("requestId", args.requestId),
			)
			.unique();
		if (previous) {
			if (previous.requestHash !== requestHash)
				return Result({ _nay: { message: "This request ID was already used for another transfer" } });
			return Result({ _yay: { runId: previous._id, activityId: (await db_require_activity(ctx, previous._id))._id } });
		}

		// Retry reuses the old item list. It is complete only after discovery set the total.
		if (!activities_is_active(activity.status) && activity.progress.total === null)
			return Result({
				_nay: { message: "This copy stopped before it found all its files. Start a new copy instead." },
			});
		if (!activities_get_controls(activity, run.userId).canRetry)
			return Result({ _nay: { message: "This transfer has no stopped or failed work to retry" } });

		const successor = await ctx.db
			.query("files_transfer_runs")
			.withIndex("by_retryOf", (q) => q.eq("retryOf", run._id))
			.first();
		if (successor)
			return Result({
				_yay: { runId: successor._id, activityId: (await db_require_activity(ctx, successor._id))._id },
			});

		if (await db_get_current_activity(ctx, run))
			return Result({ _nay: { message: "A transfer is already running in this workspace" } });
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: run.userId });
		if (rateLimit) return Result({ _nay: { message: rateLimit.message } });

		const destination = await db_get_destination(ctx, {
			run,
			membership: memberships.destination,
			parent: run.targetParent,
			expectedPath: run.targetPath,
		});
		if (destination._nay) return destination;

		const { _id, _creationTime, ...fields } = run;
		const runId = await ctx.db.insert("files_transfer_runs", {
			...fields,
			requestId: args.requestId,
			requestHash,
			retryOf: _id,
			selection: undefined,
			bashJob: undefined,
			outputReviewUntil: undefined,
			retryCursor: null,
			step: "retry",
			planCursor: null,
			reserveCursor: null,
			revision: 0,
			inFlight: 0,
			fixedDeadline: false,
			applyToRemaining: { file: null, folder: null },
		});

		const now = Date.now();
		const activityId = await activities_db_start(ctx, {
			organizationId: run.organizationId,
			workspaceId: run.workspaceId,
			userId: run.userId,
			membershipId: membership._id,
			membershipLifetime: await organizations_membership_lifetimes_db_ensure(ctx, membership),
			source: { kind: "files_transfer_run", id: runId, transferKind: run.kind },
			visibility: "requester",
			// A retry of a job-owned copy stays out of the feed like its source.
			feedVisible: activity.feedVisible,
			status: "queued",
			progress: {
				unit: "files",
				discovered: 0,
				total: null,
				completed: 0,
				skipped: 0,
				failed: 0,
				blocked: 0,
				canceled: 0,
			},
			resultKind: run.publication === "proposal" ? "ready_for_review" : "saved",
			title: "Retry remaining files",
			targets: [],
			deadlineAt: now + RUN_TIMEOUT_MS,
			now,
		});

		// These parents are not manifest items, so hold them before the first retry page.
		if (run.kind === "copy" && run.publication === "proposal") {
			const retry = (await ctx.db.get("files_transfer_runs", runId))!;
			if (run.targetParent.kind === "private")
				await db_hold_proposal(ctx, retry, run.targetParent, "destination_parent");
			if (run.preparedParent?.kind === "private")
				await db_hold_proposal(ctx, retry, run.preparedParent, "destination_parent");
		}

		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId });
		return Result({ _yay: { runId, activityId } });
	},
});

// #region advance

async function db_copy_retry_manifest(ctx: MutationCtx, run: Doc<"files_transfer_runs">) {
	if (!run.retryOf) throw should_never_happen("Retry run has no source run", { runId: run._id });
	const previous = await ctx.db.get("files_transfer_runs", run.retryOf);
	if (!previous) {
		await db_stop_run(ctx, run, "The previous transfer is no longer available");
		return;
	}

	const items = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_order", (q) => q.eq("runId", previous._id).gt("order", run.retryCursor ?? -1))
		.take(DISCOVERY_PAGE_SIZE);
	const activity = await db_require_activity(ctx, run._id);
	const progress = { ...activity.progress };

	for (const item of items) {
		const oldParent = item.parentItemId ? await ctx.db.get("files_transfer_items", item.parentItemId) : null;
		const parent = oldParent
			? await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) =>
						q.eq("runId", run._id).eq("source.kind", oldParent.source.kind).eq("source.id", oldParent.source.id),
					)
					.first()
			: null;

		const eligible =
			(item.state === "failed" ||
				item.state === "blocked" ||
				item.state === "conflict" ||
				(item.state === "canceled" && (item.cancelReason === "stop" || item.cancelReason === "timeout"))) &&
			parent?.state !== "skipped" &&
			parent?.state !== "canceled";

		const { _id, _creationTime, ...fields } = item;
		await ctx.db.insert("files_transfer_items", {
			...fields,
			runId: run._id,
			parentItemId: parent?._id ?? null,
			discoveryDone: true,
			discoveryCursor: null,
			workId: null,
			attemptExpiresAt: null,
			stagedAssetIds: [],
			capture: null,
			attempt: 0,
			billedUserId: null,
			...(eligible
				? {
						state: "pending" as const,
						preparation: null,
						outputTarget: null,
						outputProposal: undefined,
						outputName: null,
						outputPath: null,
						outcome: null,
						conflictKind: null,
						conflictTarget: null,
						conflictVersion: null,
						plannedPath: null,
						choice: null,
						cancelReason: null,
						errorMessage: null,
						errorCode: null,
					}
				: {}),
		});
		// A later replacement at the same target is not this completed output.
		if (run.publication === "proposal" && item.state === "completed" && item.outputTarget && item.outputProposal)
			await db_hold_proposal(ctx, run, item.outputTarget, "output", item.outputProposal);
		if (run.sourceView === "draft" && eligible) await db_hold_proposal(ctx, run, item.source, "source");

		progress.discovered += 1;
		if (!eligible) {
			if (item.state === "completed") progress.completed += 1;
			else if (item.state === "skipped") progress.skipped += 1;
			else progress.canceled += 1;
		}
	}

	const done = items.length < DISCOVERY_PAGE_SIZE;
	await ctx.db.patch("files_transfer_runs", run._id, {
		retryCursor: items.at(-1)?.order ?? run.retryCursor,
		...(done ? { step: "plan" as const } : {}),
	});
	await ctx.db.patch("activities", activity._id, {
		progress: { ...progress, total: done ? progress.discovered : null },
		updatedAt: Date.now(),
	});

	await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
}

async function db_select_sources(ctx: MutationCtx, run: Doc<"files_transfer_runs">) {
	const selection = run.selection!;
	const items = await ctx.db
		.query("files_transfer_selection_items")
		.withIndex("by_run_order", (q) => q.eq("runId", run._id).gt("order", selection.cursor))
		.take(8);
	const activity = await db_require_activity(ctx, run._id);
	const scope = { ...run, ...run.sourceScope };
	const reader = await files_visible_db_create_reader(ctx, { ...scope, readLimit: 2048 });
	let cursor = selection.cursor;
	let added = 0;
	for (const item of items) {
		const first = await ctx.db
			.query("files_transfer_selection_items")
			.withIndex("by_run_source_order", (q) =>
				q.eq("runId", run._id).eq("source.kind", item.source.kind).eq("source.id", item.source.id),
			)
			.first();
		if (first!._id !== item._id) {
			cursor = item.order;
			continue;
		}
		const entry = await db_get_entry(ctx, scope, item.source, reader);
		if (reader.exhausted && cursor !== selection.cursor) break;
		if (!entry || (run.step === "normalize" && entry.path !== item.path)) {
			await db_stop_run(ctx, run, reader.exhausted ? "The source path needs too many reads" : "Permission denied");
			return;
		}
		if (entry.pendingUpdate?.preparation || (entry.kind === "private" && !entry.pendingUpdate.createIntent)) {
			await db_stop_run(ctx, run, "The source draft is still preparing");
			return;
		}
		if (run.step === "select") {
			await ctx.db.patch("files_transfer_selection_items", item._id, { path: entry.path, kind: entry.node.kind });
		} else {
			// All pages have paths now, so a later selected ancestor also covers this child.
			let covered = false;
			let parentPath = entry.path.slice(0, entry.path.lastIndexOf("/"));
			while (parentPath) {
				const ancestor = await ctx.db
					.query("files_transfer_selection_items")
					.withIndex("by_run_path", (q) => q.eq("runId", run._id).eq("path", parentPath))
					.first();
				if (ancestor?.kind === "folder") {
					covered = true;
					break;
				}
				parentPath = parentPath.slice(0, parentPath.lastIndexOf("/"));
			}
			if (!covered) {
				const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
				const targetName = run.targetName ?? name;
				const normalized =
					entry.node.kind === "folder"
						? files_normalize_name("folder", targetName)
						: files_normalize_file_rename_name(targetName);
				if (normalized._nay || !targetName || targetName === "." || /[/\\]/.test(targetName)) {
					await db_stop_run(ctx, run, "Invalid destination name");
					return;
				}
				await db_insert_item(ctx, {
					organizationId: run.organizationId,
					workspaceId: run.workspaceId,
					runId: run._id,
					source: item.source,
					sourceParent:
						entry.kind === "private"
							? entry.node.parent
							: (entry.pendingUpdate?.pendingMove?.destParent ??
								(entry.node.parentId === files_ROOT_ID
									? { kind: "root" }
									: { kind: "saved", id: entry.node.parentId })),
					sourceName: name,
					sourcePath: entry.path,
					targetName,
					kind: entry.node.kind,
					parentItemId: null,
					order: activity.progress.discovered + added,
					discoveryDone: entry.node.kind === "file",
				});
				added++;
			}
		}
		cursor = item.order;
	}
	const done = cursor + 1 === selection.count;
	await ctx.db.patch("files_transfer_runs", run._id, {
		selection: { ...selection, cursor: done && run.step === "select" ? -1 : cursor },
		...(done ? { step: run.step === "select" ? ("normalize" as const) : ("discover" as const) } : {}),
	});
	await ctx.db.patch("activities", activity._id, {
		progress: { ...activity.progress, discovered: activity.progress.discovered + added },
		deadlineAt: run.fixedDeadline ? activity.deadlineAt : Date.now() + RUN_TIMEOUT_MS,
		updatedAt: Date.now(),
	});
	await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
}

async function db_discover(ctx: MutationCtx, run: Doc<"files_transfer_runs">) {
	const activity = await db_require_activity(ctx, run._id);
	const item = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_discoveryDone_order", (q) => q.eq("runId", run._id).eq("discoveryDone", false))
		.first();
	const sourceScope = { ...run, ...run.sourceScope };
	const reader = await files_visible_db_create_reader(ctx, sourceScope);

	if (item) {
		const parent = item.parentItemId ? await ctx.db.get("files_transfer_items", item.parentItemId) : null;
		if (item.choice === "skip" || parent?.state === "skipped" || parent?.state === "canceled") {
			await db_skip_item(ctx, item);
			await ctx.db.patch("files_transfer_items", item._id, { discoveryDone: true });
			await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
			return;
		}

		const source = await db_get_entry(ctx, sourceScope, item.source, reader);
		if (!source || source.path !== item.sourcePath) {
			await db_pause_item(ctx, item, "source_changed");
			return;
		}

		const children: Array<{ target: files_PendingTarget; name: string; path: string; kind: "file" | "folder" }> = [];
		let isDone: boolean;
		let continueCursor: string | null;

		if (run.sourceView === "draft") {
			const listed = (await ctx.runQuery(internal.files_visible.internal_list, {
				organizationId: sourceScope.organizationId,
				workspaceId: sourceScope.workspaceId,
				visibilityUserId: run.userId,
				overlayUserId: run.userId,
				requireComplete: true,
				folderPath: source.path,
				mode: "children",
				cursor: item.discoveryCursor,
				numItems: DISCOVERY_PAGE_SIZE,
			})) as files_visible_internal_list_Result;
			if (listed._nay) {
				await db_stop_run(ctx, run, listed._nay.message);
				return;
			}
			if (listed._yay.items.some((child) => child.preparing)) {
				await db_pause_item(ctx, item, "source_changed");
				return;
			}

			children.push(...listed._yay.items);
			isDone = listed._yay.isDone;
			continueCursor = listed._yay.continueCursor;
		} else {
			if (source.kind !== "saved") return;
			const page = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_archiveOperation_name", (q) =>
					q
						.eq("organizationId", sourceScope.organizationId)
						.eq("workspaceId", sourceScope.workspaceId)
						.eq("parentId", source.node._id)
						.eq("archiveOperationId", null),
				)
				.paginate({ cursor: item.discoveryCursor, numItems: DISCOVERY_PAGE_SIZE });

			for (const child of page.page) {
				if (!(await reader.canRead(child))) {
					await db_stop_run(ctx, run, "Permission denied");
					return;
				}
				children.push({
					target: { kind: "saved", id: child._id },
					name: child.name,
					path: child.path,
					kind: child.kind,
				});
			}

			isDone = page.isDone;
			continueCursor = page.continueCursor;
		}

		let added = 0;
		for (const child of children) {
			const existing = await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_source", (q) =>
					q.eq("runId", run._id).eq("source.kind", child.target.kind).eq("source.id", child.target.id),
				)
				.unique();
			if (existing) continue;

			await db_insert_item(ctx, {
				organizationId: run.organizationId,
				workspaceId: run.workspaceId,
				runId: run._id,
				source: child.target,
				sourceParent: item.source,
				sourceName: child.name,
				sourcePath: child.path,
				targetName: child.name,
				kind: child.kind,
				parentItemId: item._id,
				order: activity.progress.discovered + added,
				discoveryDone: child.kind === "file",
			});
			if (run.sourceView === "draft") await db_hold_proposal(ctx, run, child.target, "source");
			added += 1;
		}

		await ctx.db.patch("files_transfer_items", item._id, {
			discoveryDone: isDone,
			discoveryCursor: isDone ? null : continueCursor,
		});
		await ctx.db.patch("activities", activity._id, {
			progress: { ...activity.progress, discovered: activity.progress.discovered + added },
			deadlineAt: run.fixedDeadline ? activity.deadlineAt : Date.now() + RUN_TIMEOUT_MS,
			updatedAt: Date.now(),
		});

		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
		return;
	}

	const currentActivity = await db_require_activity(ctx, run._id);
	if (currentActivity.status === "running" || currentActivity.status === "awaiting_input")
		await ctx.db.patch("activities", currentActivity._id, {
			progress: { ...currentActivity.progress, total: currentActivity.progress.discovered },
			updatedAt: Date.now(),
		});

	if (currentActivity.status === "running") {
		await ctx.db.patch("files_transfer_runs", run._id, { step: "plan" });
		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
	}
}

async function db_plan(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const pageSize = run.kind === "move" ? MAX_SELECTED_NODES : DISCOVERY_PAGE_SIZE;
	const items = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_order", (q) => q.eq("runId", run._id).gt("order", run.planCursor ?? -1))
		.take(pageSize);
	const sourceScope = { ...run, ...run.sourceScope };
	const reader = await files_visible_db_create_reader(ctx, sourceScope);
	const nameLookups = { remaining: MAX_NAME_LOOKUPS_PER_BATCH };
	let cursor = run.planCursor;

	for (const item of items) {
		// Leave the next item for another step if its name search could exceed this step's budget.
		if (run.kind === "copy" && nameLookups.remaining < MAX_NAME_ATTEMPTS + 2) break;
		const parent = item.parentItemId ? await ctx.db.get("files_transfer_items", item.parentItemId) : null;
		if (item.state === "completed" || item.state === "canceled" || item.state === "conflict") {
			cursor = item.order;
			continue;
		}
		if (item.state === "skipped" || item.choice === "skip" || parent?.state === "skipped") {
			if (item.state !== "skipped") await db_skip_item(ctx, item);
			cursor = item.order;
			continue;
		}

		const source = await db_get_entry(ctx, sourceScope, item.source, reader);
		if (reader.exhausted && cursor !== run.planCursor) break;
		if (!source || source.path !== item.sourcePath) {
			await db_pause_item(ctx, item, "source_changed");
			return;
		}

		const parentPath = parent
			? (parent.outputPath ?? parent.plannedPath)
			: run.missingParentNames.reduce(path_join, run.targetPath);
		// A parent conflict also leaves its descendants unplanned. Review restarts this scan.
		if (!parentPath) {
			cursor = item.order;
			continue;
		}

		if (parent?.state === "completed" && parent.outputTarget) {
			const destination = await db_get_destination(ctx, {
				run,
				membership,
				parent: parent.outputTarget,
				expectedPath: parentPath,
				runWrittenWritePolicy: parent.outputWritePolicy,
			});
			if (destination._nay) {
				await db_pause_item(ctx, item, "destination_changed");
				return;
			}
		}

		const resolved = await db_resolve_name(ctx, {
			run,
			item,
			membership,
			parent: run.targetParent,
			parentPath,
			nameLookups,
		});
		if (resolved._nay) {
			await db_stop_run(ctx, run, resolved._nay.message);
			return;
		}
		if (!resolved._yay) {
			const current = await ctx.db.get("files_transfer_items", item._id);
			if (current?.state === "skipped" || current?.state === "conflict") {
				cursor = item.order;
				continue;
			}
			return;
		}

		await ctx.db.patch("files_transfer_items", item._id, { plannedPath: resolved._yay.path });
		cursor = item.order;
		await ctx.db.patch("files_transfer_runs", run._id, { planCursor: cursor });
	}

	const done = items.length < pageSize && (items.length === 0 || cursor === items.at(-1)!.order);
	const conflict = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "conflict"))
		.first();
	await ctx.db.patch("files_transfer_runs", run._id, {
		planCursor: cursor,
		...(done && !conflict
			? {
					step:
						run.sourceScope.workspaceId === run.destinationScope.workspaceId
							? ("apply" as const)
							: ("reserve" as const),
				}
			: {}),
	});
	const activity = await db_require_activity(ctx, run._id);
	if (activities_is_active(activity.status) && activity.status !== "stopping") {
		await ctx.db.patch("activities", activity._id, {
			status: done && conflict ? "awaiting_input" : "running",
			deadlineAt: run.fixedDeadline
				? activity.deadlineAt
				: Date.now() + (done && conflict ? CHOICE_TIMEOUT_MS : RUN_TIMEOUT_MS),
			updatedAt: Date.now(),
		});
	}

	if (!done || !conflict) await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
}

async function db_commit_move(
	ctx: MutationCtx,
	run: Doc<"files_transfer_runs">,
	membership: Doc<"organizations_workspaces_users">,
) {
	const scope = { ...run, ...run.sourceScope };
	const reader = await files_visible_db_create_reader(ctx, scope);
	if (run.publication === "proposal") {
		const item = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "pending"))
			.first();
		if (!item) {
			const activity = await db_require_activity(ctx, run._id);
			await activities_db_finish(ctx, {
				sourceId: run._id,
				status: activities_get_result_status(activity.progress),
				errorMessage: activity.errorMessage,
				now: Date.now(),
			});
			return;
		}

		const source = await db_get_entry(ctx, scope, item.source, reader);
		if (!source || source.path !== item.sourcePath) {
			await db_pause_item(ctx, item, "source_changed");
			return;
		}

		const resolved = await db_resolve_name(ctx, {
			run,
			item,
			membership,
			parent: run.targetParent,
			parentPath: run.targetPath,
			reader,
		});
		if (resolved._nay) {
			await db_stop_run(ctx, run, resolved._nay.message);
			return;
		}

		if (resolved._yay) {
			const moved = (await ctx.runMutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: run.userId,
				target: item.source,
				destParent: run.targetParent,
				destName: resolved._yay.name,
				replace: resolved._yay.existing !== null,
				threadId: run.origin.kind === "agent" ? run.origin.threadId : undefined,
			})) as upsert_file_pending_move_in_db_Result;
			if (moved._nay) {
				await db_stop_run(ctx, run, moved._nay.message);
				return;
			}

			await ctx.db.patch("files_transfer_items", item._id, {
				state: "completed",
				outcome: moved._yay.fromPath === moved._yay.destPath ? "unchanged" : "moved",
				outputTarget: item.source,
				outputName: resolved._yay.name,
				outputPath: moved._yay.destPath,
			});

			const activity = await db_require_activity(ctx, run._id);
			await ctx.db.patch("activities", activity._id, {
				progress: { ...activity.progress, completed: activity.progress.completed + 1 },
				updatedAt: Date.now(),
				deadlineAt: run.fixedDeadline ? activity.deadlineAt : Date.now() + RUN_TIMEOUT_MS,
			});
		}

		await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
		return;
	}

	if (run.targetParent.kind === "private") return;
	const targetParentId = run.targetParent.kind === "root" ? files_ROOT_ID : run.targetParent.id;
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
		replacement?: NonNullable<Parameters<typeof files_nodes_db_move_nodes>[1]["items"][number]["replacement"]>;
	}> = [];
	for (const item of items) {
		if (item.state === "skipped") continue;
		if (item.choice === "skip") {
			await db_skip_item(ctx, item);
			continue;
		}

		const source = item.source.kind === "saved" ? await ctx.db.get("files_nodes", item.source.id) : null;
		if (
			!source ||
			source.archiveOperationId !== null ||
			source.path !== item.sourcePath ||
			source.parentId !== (item.sourceParent.kind === "root" ? files_ROOT_ID : item.sourceParent.id) ||
			source.name !== item.sourceName
		) {
			await db_pause_item(ctx, item, "source_changed");
			continue;
		}

		const resolved = await db_resolve_name(ctx, {
			run,
			item,
			membership,
			parent: run.targetParent,
			parentPath: run.targetPath,
			reserved,
			nameLookups,
		});
		if (resolved._nay) {
			await db_stop_run(ctx, run, resolved._nay.message);
			return;
		}
		if (resolved._yay) {
			reserved.add(resolved._yay.path);
			moveItems.push({
				nodeId: source._id,
				expected: { parentId: source.parentId, name: item.sourceName, path: item.sourcePath },
				destName: resolved._yay.name,
				...(resolved._yay.existing?.kind === "saved" && item.conflictVersion?.kind !== "pending"
					? {
							replacement: { nodeId: resolved._yay.existing.node._id, contentVersion: item.conflictVersion },
						}
					: {}),
			});
		}
	}

	// A late conflict must stop the whole move before it publishes.
	const activity = await db_require_activity(ctx, run._id);
	if (activity.status !== "running") return;

	const move = await files_nodes_db_move_nodes(ctx, {
		userAuth: { id: run.userId },
		membership,
		items: moveItems,
		targetParentId,
		expectedTargetPath: run.targetPath,
	});
	if (move._nay) {
		await db_stop_run(ctx, run, move._nay.message);
		return;
	}

	const movedById = new Map(move._yay.moved.map((node) => [node.nodeId, node]));
	const unchanged = new Set(move._yay.unchangedNodeIds);
	for (const item of items) {
		if (item.source.kind !== "saved") continue;
		const moved = movedById.get(item.source.id);
		if (!moved && !unchanged.has(item.source.id)) continue;
		await ctx.db.patch("files_transfer_items", item._id, {
			state: "completed",
			outputTarget: item.source,
			outcome: moved ? "moved" : "unchanged",
			outputName: moved?.name ?? item.sourceName,
			outputPath: moved?.path ?? item.sourcePath,
		});
	}

	await ctx.db.patch("activities", activity._id, {
		progress: { ...activity.progress, completed: movedById.size + unchanged.size },
		updatedAt: Date.now(),
	});
	await activities_db_finish(ctx, {
		sourceId: run._id,
		status: "succeeded",
		errorMessage: null,
		now: Date.now(),
	});
}

async function db_prepare_parent_folders(ctx: MutationCtx, run: Doc<"files_transfer_runs">) {
	if (run.missingParentNames.length === 0) return true;
	const scope = { ...run, ...run.destinationScope };
	const reader = await files_visible_db_create_reader(ctx, scope);
	let parent = run.preparedParent ?? run.targetParent;
	let parentPath = run.targetPath;
	if (run.preparedParent && parent.kind !== "root") {
		let entry = await reader.resolveTarget(parent);
		if (!entry && parent.kind === "private") {
			const saved = await files_pending_nodes_db_resolve_saved_parent(ctx, { ...scope, parent });
			if (!saved._nay && saved._yay.parentId !== files_ROOT_ID) {
				parent = { kind: "saved", id: saved._yay.parentId };
				entry = await reader.resolveTarget(parent);
			}
		}
		if (!entry) {
			await db_stop_run(ctx, run, "Destination changed");
			return false;
		}
		parentPath = entry.path;
	}
	const paths = run.missingParentNames.map((_name, index) =>
		run.missingParentNames.slice(0, index + 1).reduce(path_join, run.targetPath),
	);
	const completed = parentPath === run.targetPath ? 0 : paths.indexOf(parentPath) + 1;
	if (completed === run.missingParentNames.length) return true;
	if ((parentPath !== run.targetPath && completed === 0) || (await reader.findPath(paths[completed]!))) {
		await db_stop_run(ctx, run, "Destination changed");
		return false;
	}
	const created = await files_pending_nodes_db_create(ctx, {
		...scope,
		parent,
		name: run.missingParentNames[completed]!,
		kind: "folder",
		threadId: run.origin.kind === "agent" ? run.origin.threadId : undefined,
	});
	if (created._nay) {
		await db_stop_run(ctx, run, created._nay.message);
		return false;
	}
	await files_db_patch_pending_update(ctx, created._yay.pendingUpdateId, {
		createIntent: { kind: "folder", metadata: [] },
	});
	await files_db_schedule_pending_update_cleanup(ctx, {
		pendingUpdateId: created._yay.pendingUpdateId,
		expectedUpdatedAt: created._yay.updatedAt,
	});
	const held = await files_pending_holds_db_acquire(ctx, {
		producer: { kind: "files_transfer_run", id: run._id },
		pendingUpdateId: created._yay.pendingUpdateId,
		target: { kind: "private", id: created._yay.privateNodeId },
		privateGeneration: 1,
		expectedRevision: 1,
		role: "output",
	});
	if (held._nay) throw convex_error(held._nay);
	await ctx.db.patch("files_transfer_runs", run._id, {
		preparedParent: { kind: "private", id: created._yay.privateNodeId },
	});
	await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
	return false;
}

export const advance = internalMutation({
	args: { runId: v.id("files_transfer_runs") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get("files_transfer_runs", args.runId);
		if (!run) return null;
		const activity = await db_require_activity(ctx, run._id);
		if (!activities_is_active(activity.status)) return null;
		if (activity.status === "stopping") {
			if (run.step === "retry") {
				await db_copy_retry_manifest(ctx, run);
				return null;
			}
			await db_cancel_items(ctx, run, Date.now());
			return null;
		}
		if (activity.deadlineAt <= Date.now()) {
			await files_transfer_db_request_stop(ctx, { runId: run._id, reason: "timeout", now: Date.now() });
			return null;
		}
		if (activity.status === "awaiting_input") return null;
		if (run.step === "uploading") return null;

		const memberships = await db_get_run_memberships(ctx, run, activity);
		if (!memberships) {
			await db_stop_run(ctx, run, "Permission denied");
			return null;
		}
		const membership = memberships.destination;

		const destination = await db_get_destination(ctx, {
			run,
			membership,
			parent: run.targetParent,
			expectedPath: run.targetPath,
		});
		if (destination._nay) {
			await db_stop_run(ctx, run, destination._nay.message);
			return null;
		}

		if (activity.status === "queued") {
			await ctx.db.patch("activities", activity._id, {
				status: "running",
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
		}
		if (run.step === "retry") {
			await db_copy_retry_manifest(ctx, run);
			return null;
		}
		if (run.step === "select" || run.step === "normalize") {
			await db_select_sources(ctx, run);
			return null;
		}
		if (run.step === "discover") {
			await db_discover(ctx, run);
			return null;
		}
		if (run.step === "plan") {
			await db_plan(ctx, run, membership);
			return null;
		}
		if (!(await db_prepare_parent_folders(ctx, run))) return null;
		// Start refuses cross-workspace Move, and Retry keeps the old scopes, so every Move is in one workspace.
		if (run.kind === "move") {
			await db_commit_move(ctx, run, membership);
			return null;
		}
		if (run.inFlight >= MAX_IN_FLIGHT) return null;

		const item = await ctx.db
			.query("files_transfer_items")
			.withIndex("by_run_state_order", (q) => {
				const pending = q.eq("runId", run._id).eq("state", "pending");
				return run.step === "reserve" ? pending.gt("order", run.reserveCursor ?? -1) : pending;
			})
			.first();
		if (!item) {
			if (run.step === "reserve") {
				await ctx.db.patch("files_transfer_runs", run._id, { step: "apply" });
				await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
				return null;
			}
			if (run.inFlight === 0) {
				// Selected media must be ready before document copies capture their exact versions.
				const waiting = await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_state_order", (q) => q.eq("runId", run._id).eq("state", "waiting_media"))
					.take(DISCOVERY_PAGE_SIZE);
				if (waiting.length > 0) {
					for (const next of waiting) await ctx.db.patch("files_transfer_items", next._id, { state: "pending" });
					await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
					return null;
				}
				await activities_db_finish(ctx, {
					sourceId: run._id,
					status: activities_get_result_status(activity.progress),
					errorMessage: activity.errorMessage,
					errorCode: activity.errorCode,
					now: Date.now(),
				});
				await files_pending_holds_db_finish(ctx, { producer: { kind: "files_transfer_run", id: run._id } });
			}
			return null;
		}

		// An old worker must finish its callback before a resolved conflict starts a new attempt.
		if (item.workId !== null) return null;
		if (run.step === "reserve") await ctx.db.patch("files_transfer_runs", run._id, { reserveCursor: item.order });

		const parent = item.parentItemId ? await ctx.db.get("files_transfer_items", item.parentItemId) : null;
		if (
			item.choice === "skip" ||
			(parent && (parent.state === "skipped" || parent.state === "failed" || parent.state === "canceled"))
		) {
			await db_skip_item(ctx, item);
			await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
			return null;
		}

		// Reservation creates IDs, not a content worker, so it does not spend a retry.
		const attempt = item.attempt + (run.step === "reserve" ? 0 : 1);
		await ctx.db.patch("files_transfer_items", item._id, {
			state: "copying",
			attempt,
			attemptExpiresAt: Date.now() + ATTEMPT_TIMEOUT_MS,
		});

		const prepared = await files_transfer_db_prepare_copy_item(ctx, { itemId: item._id, attempt });
		if (prepared._nay) {
			await files_transfer_db_fail_copy_item(ctx, { itemId: item._id, attempt, message: prepared._nay.message });
			await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
			return null;
		}
		if (!prepared._yay) {
			await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
			return null;
		}
		const {
			sourceEntry,
			parent: outputParent,
			name,
			path,
			existing,
			runWrittenWritePolicy,
			copiedPolicies,
		} = prepared._yay;

		// Folder merge retains the destination identity, metadata, and unrelated children.
		if (item.kind === "folder" && existing) {
			await files_transfer_db_complete_copy_item(ctx, {
				itemId: item._id,
				attempt,
				target:
					existing.kind === "saved"
						? { kind: "saved", id: existing.node._id }
						: { kind: "private", id: existing.node._id },
				name,
				path,
				outcome: "merged",
			});
			return null;
		}

		if (run.publication === "proposal" && !item.preparation && !existing) {
			const created = await files_pending_nodes_db_create(ctx, {
				organizationId: run.destinationScope.organizationId,
				workspaceId: run.destinationScope.workspaceId,
				userId: run.userId,
				parent: outputParent,
				name,
				kind: item.kind,
				threadId: run.origin.kind === "agent" ? run.origin.threadId : undefined,
				...(item.kind === "file" ? { preparation: { transferItemId: item._id, creationGeneration: 1 } } : {}),
			});
			if (created._nay) {
				await files_transfer_db_fail_copy_item(ctx, { itemId: item._id, attempt, message: created._nay.message });
				await ctx.scheduler.runAfter(0, internal.files_transfer.advance, args);
				return null;
			}

			if (item.kind === "folder") {
				const metadata =
					sourceEntry.kind === "private"
						? sourceEntry.pendingUpdate.createIntent!.metadata
						: await files_metadata_db_read_entries(ctx, {
								organizationId: run.sourceScope.organizationId,
								workspaceId: run.sourceScope.workspaceId,
								fileNodeId: sourceEntry.node._id,
							});
				await files_db_patch_pending_update(ctx, created._yay.pendingUpdateId, {
					createIntent: { kind: "folder", metadata },
					copiedFrom: {
						target: item.source,
						path: item.sourcePath,
						...copiedPolicies,
					},
				});
			} else {
				await ctx.db.patch("files_transfer_items", item._id, {
					preparation: {
						privateNodeId: created._yay.privateNodeId,
						pendingUpdateId: created._yay.pendingUpdateId,
						creationGeneration: 1,
						structuralRevision: 1,
						proposalRevision: 1,
					},
				});
			}

			await files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: created._yay.pendingUpdateId,
				expectedUpdatedAt: created._yay.updatedAt,
			});
			if (item.kind === "file") {
				const held = await files_pending_holds_db_acquire(ctx, {
					producer: { kind: "files_transfer_run", id: run._id },
					pendingUpdateId: created._yay.pendingUpdateId,
					target: { kind: "private", id: created._yay.privateNodeId },
					privateGeneration: 1,
					expectedRevision: 1,
					role: "preparing_output",
				});
				if (held._nay) throw convex_error(held._nay);
			}

			if (item.kind === "folder") {
				await files_transfer_db_complete_copy_item(ctx, {
					itemId: item._id,
					attempt,
					target: { kind: "private", id: created._yay.privateNodeId },
					name,
					path,
				});
				return null;
			}
		}

		// Saved folders have no bytes to stage and publish in this transaction.
		if (item.kind === "folder") {
			if (outputParent.kind === "private") return null;
			const metadata =
				sourceEntry.kind === "private"
					? sourceEntry.pendingUpdate.createIntent!.metadata
					: await files_metadata_db_read_entries(ctx, {
							organizationId: run.sourceScope.organizationId,
							workspaceId: run.sourceScope.workspaceId,
							fileNodeId: sourceEntry.node._id,
						});

			const copied = await files_nodes_db_create_node_recursively_at_path(ctx, {
				userId: run.userId,
				organizationId: run.destinationScope.organizationId,
				workspaceId: run.destinationScope.workspaceId,
				parentId: outputParent.kind === "root" ? files_ROOT_ID : outputParent.id,
				path: name,
				kind: "folder",
				metadata,
				expectedParentWritePolicy: runWrittenWritePolicy,
				// A copy keeps the source folder's own rule and default. Read here on the server;
				// the destination default never replaces them.
				...(sourceEntry.kind === "saved"
					? {
							writePolicy: sourceEntry.node.writePolicy,
							newChildWritePolicy: sourceEntry.node.newChildWritePolicy ?? null,
							trustPolicySource: true as const,
						}
					: {}),
				now: Date.now(),
			});
			if (copied._nay) throw convex_error({ message: "Could not copy folder", cause: copied._nay });

			await files_transfer_db_complete_copy_item(ctx, {
				itemId: item._id,
				attempt,
				target: { kind: "saved", id: copied._yay },
				name,
				path,
			});
			return null;
		}

		// Documents need stable destination media IDs before any file content is copied.
		if (run.step === "reserve") {
			const version = await files_transfer_db_get_entry_version(ctx, sourceEntry);
			const isMedia = /^(image|video)\//.test(version?.contentType ?? "");
			await ctx.db.patch("files_transfer_items", item._id, {
				state: isMedia ? "pending" : "waiting_media",
				attemptExpiresAt: null,
			});
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
		await ctx.db.patch("files_transfer_runs", run._id, { inFlight: run.inFlight + 1 });
		await ctx.db.patch("activities", activity._id, {
			deadlineAt: run.fixedDeadline ? activity.deadlineAt : Date.now() + RUN_TIMEOUT_MS,
			updatedAt: Date.now(),
		});

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
	await ctx.db.patch("files_transfer_runs", run._id, { inFlight });

	const activity = await db_require_activity(ctx, run._id);
	if (activity.status === "stopping") {
		await db_cancel_items(ctx, { ...run, inFlight }, now);
		return;
	}

	if (item.state === "copying") {
		if (activity.status === "awaiting_input" || item.attempt < MAX_ATTEMPTS) {
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
		const activity = await db_require_activity(ctx, run._id);
		if (activity.status === "running" || activity.status === "stopping")
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
	const activity = await db_require_activity(ctx, run._id);
	const copyingRetry = await ctx.db
		.query("files_transfer_runs")
		.withIndex("by_retryOf", (q) => q.eq("retryOf", runId).eq("step", "retry"))
		.first();
	if (copyingRetry) return { done: false, deletedCount: 0 };

	if (activities_is_active(activity.status)) {
		await db_stop_run(ctx, run, null);
		if (run.step === "retry") return { done: false, deletedCount: 0 };
	}

	const batchSize = Math.max(1, Math.min(50, args.batchSize));
	const selection = await ctx.db
		.query("files_transfer_selection_items")
		.withIndex("by_run_order", (q) => q.eq("runId", runId))
		.take(batchSize);
	if (selection.length) {
		for (const item of selection) await ctx.db.delete("files_transfer_selection_items", item._id);
		return { done: false, deletedCount: selection.length };
	}
	const items = await ctx.db
		.query("files_transfer_items")
		.withIndex("by_run_order", (q) => q.eq("runId", runId))
		.take(batchSize);
	for (const item of items) {
		await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId: item._id, attempt: item.attempt });
		await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
		await ctx.db.delete("files_transfer_items", item._id);
	}
	if (items.length === batchSize) return { done: false, deletedCount: items.length };

	// The Stop fence and deleted work items prevent late workers from publishing.
	await activities_db_finish(ctx, { sourceId: runId, status: "canceled", errorMessage: null, now: Date.now() });
	if (run.kind === "copy")
		await files_pending_holds_db_finish(ctx, { producer: { kind: "files_transfer_run", id: runId } });
	const holds = await files_pending_holds_db_release_producer_batch(ctx, {
		producer: { kind: "files_transfer_run", id: runId },
	});
	if (!holds.done || holds.deletedCount) return { done: false, deletedCount: items.length + holds.deletedCount };

	const deletedActivity = await activities_db_delete(ctx, activity._id);
	if (!deletedActivity.done) return { done: false, deletedCount: items.length + deletedActivity.deletedCount };

	await ctx.db.delete("files_transfer_runs", runId);
	return { done: true, deletedCount: items.length + 1 + deletedActivity.deletedCount };
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
export const recover_expired_attempts = internalMutation({
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
			if (!run) {
				await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
				continue;
			}
			const activity = await db_require_activity(ctx, run._id);
			if (!activities_is_active(activity.status)) {
				await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: item._id });
				continue;
			}
			await db_finish_copy_attempt(ctx, item, run, now);
			if (activity.status === "running" || activity.status === "stopping")
				await ctx.scheduler.runAfter(0, internal.files_transfer.advance, { runId: run._id });
		}
		return null;
	},
});
