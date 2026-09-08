// The `/api/v1/files/service-uploads/*` storage behind the routes in
// `public_api_service_uploads_http.ts`.
//
// A sealed processing-phase service grant uploads a closed meeting's files here: it creates one
// upload target per file under the grant's destination prefix. The R2 event confirms and commits
// the target; the service polls finalize for that answer. When the meeting is deleted later, a fresh
// grant sealed to the same destination archives that whole folder, because deleting a file in this
// product means archiving it. The separate write and plugin-archive routes also accept sealed
// grants, with the same current account and file policy checks.
//
// Accounting: creating a target charges nothing. The size in the request is only the service's
// guess, and a signed PUT does not bind how many bytes actually arrive. The workspace is charged
// for the largest stored size R2 confirms across its attempts. Creating a target refuses a workspace
// whose `plugin_service_storage_bytes` quota is already full, which stops the next file rather than
// the current one. That counter only grows: deleting a stored file gives nothing back, exactly like
// `public_api_upload_bytes` on the normal upload path.
//
// The quota is a budget, not a guard. A signed PUT does not bind the object's length, so a service
// can always store more than it declared; the settle below charges it, it does not prevent it.

import { v } from "convex/values";
import type { RegisteredMutation } from "convex/server";

import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { access_control_db_can_act_on_file_node, access_control_db_has_permission } from "./access_control.ts";
import { billing_db_check_paid_plan, billing_db_emit_file_save, billing_pick_billed_user_id } from "./billing_db.ts";
import {
	files_nodes_db_archive_nodes,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_hard_delete_node,
	files_nodes_db_require_writable,
	files_nodes_db_require_write_policy_management,
	files_nodes_db_set_write_policy,
	type files_nodes_WriteContext,
} from "./files_nodes.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import {
	r2_create_asset_key,
	r2_enqueue_object_deletion_job,
	r2,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_UNFINALIZED_ASSET_TTL_MS,
} from "./r2_client.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	files_MAX_UPLOADS_BYTES,
	files_ROOT_ID,
	files_INVALID_CONTENT_TYPE_MESSAGE,
	files_db_get_visible_node_by_path,
	files_editable_text_content_type_of,
	files_normalize_content_type,
} from "../server/files.ts";
import { server_path_normalize } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_normalize_name, files_normalize_upload_file_name } from "../shared/files.ts";
import { path_extract_segments_from, path_name_of } from "../shared/paths.ts";
import { public_api_is_path_inside_prefix } from "./public_api_http_auth.ts";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";

// #region shared

/**
 * Same window as `/api/v1/files/upload-urls` mints (FILES_UPLOAD_URL_TTL_MS in public_api.ts).
 */
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
/**
 * Bound placeholder and target growth for one service processing run.
 */
const MAX_TARGETS_PER_UPLOAD_RUN = 16;
/**
 * Bound live cross-run cleanup for one target key inside one sealed destination.
 */
const MAX_LIVE_TARGETS_PER_DELETE_GROUP = 16;

/**
 * Names for the refusals whose HTTP status is not the default 400, read by the route module the
 * same way `plugins_data_http.ts` reads `plugins_data_RefusalName`.
 */
export type public_api_service_uploads_RefusalName =
	| "conflict"
	| "storage_full"
	| "plan_required"
	| "outside_destination";

const REFUSAL_CONFLICT: public_api_service_uploads_RefusalName = "conflict";
const REFUSAL_STORAGE_FULL: public_api_service_uploads_RefusalName = "storage_full";
const REFUSAL_PLAN_REQUIRED: public_api_service_uploads_RefusalName = "plan_required";
const REFUSAL_OUTSIDE_DESTINATION: public_api_service_uploads_RefusalName = "outside_destination";

/**
 * What the route hands the mutation after `public_api_authorize_request` resolved a
 * `plugin_service` principal. The grant id lets the mutation read the grant doc again inside its
 * own transaction, because a revocation can land between the token check and the write.
 */
const service_upload_principal_validator = v.object({
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	installationId: v.id("plugins_workspace_installations"),
	grantId: v.id("plugin_service_grants"),
	actorUserId: v.id("users"),
	principalKey: v.string(),
	/**
	 * The destination the grant was sealed to. Every target path must live under it.
	 */
	pathPrefix: v.string(),
});

type ServiceUploadPrincipal = {
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	installationId: Id<"plugins_workspace_installations">;
	grantId: Id<"plugin_service_grants">;
	actorUserId: Id<"users">;
	principalKey: string;
	pathPrefix: string;
};

/**
 * Same shape rules as plugin-data idempotency keys: bounded, trimmed, no control characters.
 */
function validate_key(raw: string, label: "Idempotency keys" | "Target keys") {
	if (raw.length === 0 || raw.length > 128) {
		return Result({ _nay: { message: `${label} must be 1 to 128 characters` } });
	}
	if (raw !== raw.trim()) {
		return Result({ _nay: { message: `${label} must not start or end with whitespace` } });
	}
	if (/[\p{Cc}\p{Cf}]/u.test(raw)) {
		return Result({ _nay: { message: `${label} must not contain control characters` } });
	}

	return Result({ _yay: raw });
}

/**
 * Prove the call may still upload for this grant, inside the same transaction as the write. The
 * token check at the HTTP boundary happened earlier and cannot see a grant revoked, an installation
 * disabled, a capability removed, or a role taken away since.
 */
async function db_authorize_service_upload(ctx: MutationCtx, principal: ServiceUploadPrincipal) {
	const now = Date.now();

	const grant = await ctx.db.get("plugin_service_grants", principal.grantId);
	if (
		!grant ||
		grant.revokedAt != null ||
		grant.expiresAt <= now ||
		grant.organizationId !== principal.organizationId ||
		grant.workspaceId !== principal.workspaceId ||
		grant.installationId !== principal.installationId ||
		grant.actorUserId !== principal.actorUserId ||
		grant.principalKey !== principal.principalKey
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	// Only a sealed processing grant uploads, and only to the destination it was sealed to.
	if (
		grant.phase !== "processing" ||
		!grant.scopes.includes("files:write") ||
		grant.destinationPathPrefix !== principal.pathPrefix
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	// The grant dies with its installation: disabling, uninstalling, or upgrading revokes it.
	const installation = await ctx.db.get("plugins_workspace_installations", grant.installationId);
	if (
		!installation ||
		installation.status !== "enabled" ||
		installation.pluginVersionId !== grant.pluginVersionId ||
		installation.organizationId !== grant.organizationId ||
		installation.workspaceId !== grant.workspaceId ||
		!installation.acceptedCapabilities.includes("plugin.service.connect")
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	if (!installation.acceptedCapabilities.includes("workspace.files.write")) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	if (!(await plugins_db_get_live_service_account(ctx, { installation, serviceAccountId: grant.serviceAccountId }))) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	// The grant acts for its actor, so the files it writes are judged with the actor's permissions.
	const actor = await ctx.db.get("users", grant.actorUserId);
	if (!actor || actor.deletedAt != null) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", grant.actorUserId)
				.eq("organizationId", grant.organizationId)
				.eq("workspaceId", grant.workspaceId),
		)
		.first();
	if (!membership || membership.pendingOrganizationRemoval) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", grant.organizationId),
		ctx.db.get("organizations_workspaces", grant.workspaceId),
	]);
	if (
		!organization?.defaultWorkspaceId ||
		!workspace ||
		workspace.organizationId !== organization._id ||
		workspace.pluginDataPurgeStartedAt !== undefined
	) {
		return Result({ _nay: { message: "Not found" } });
	}
	const allowed = await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: workspace._id,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: { kind: "workspace", id: String(workspace._id) },
		permission: "content.write",
		userId: grant.actorUserId,
	});
	if (!allowed) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({
		_yay: {
			installation,
			organization,
			workspace,
			defaultWorkspaceId: organization.defaultWorkspaceId,
			serviceAccountId: grant.serviceAccountId,
		},
	});
}

// #endregion shared

// #region targets

async function db_get_target(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		idempotencyKey: string;
		targetKey: string;
	},
) {
	return await ctx.db
		.query("plugin_service_storage_targets")
		.withIndex("by_organization_workspace_installation_idempotencyKey_targetKey", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("installationId", args.installationId)
				.eq("idempotencyKey", args.idempotencyKey)
				.eq("targetKey", args.targetKey),
		)
		.first();
}

async function db_get_destination(
	ctx: QueryCtx | MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		destinationPath: string;
	},
) {
	return await ctx.db
		.query("plugin_service_storage_destinations")
		.withIndex("by_organization_workspace_installation_destinationPath", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("installationId", args.installationId)
				.eq("destinationPath", args.destinationPath),
		)
		.first();
}

async function db_open_destination_epoch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		destinationPath: string;
		now: number;
	},
) {
	const existing = await db_get_destination(ctx, args);
	if (!existing) {
		await ctx.db.insert("plugin_service_storage_destinations", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			destinationPath: args.destinationPath,
			currentEpoch: 1,
			closedEpoch: 0,
			updatedAt: args.now,
		});
		return 1;
	}

	if (existing.currentEpoch > existing.closedEpoch) {
		return existing.currentEpoch;
	}
	const nextEpoch = existing.currentEpoch + 1;
	await ctx.db.patch("plugin_service_storage_destinations", existing._id, {
		currentEpoch: nextEpoch,
		updatedAt: args.now,
	});
	return nextEpoch;
}

async function db_close_destination(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		destinationPath: string;
		throughEpoch: number;
		now: number;
	},
) {
	const existing = await db_get_destination(ctx, args);
	if (existing) {
		await ctx.db.patch("plugin_service_storage_destinations", existing._id, {
			currentEpoch: Math.max(existing.currentEpoch, args.throughEpoch),
			closedEpoch: Math.max(existing.closedEpoch, args.throughEpoch),
			closedAt: args.now,
			updatedAt: args.now,
		});
		return;
	}
	await ctx.db.insert("plugin_service_storage_destinations", {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		installationId: args.installationId,
		destinationPath: args.destinationPath,
		currentEpoch: args.throughEpoch,
		closedEpoch: args.throughEpoch,
		closedAt: args.now,
		updatedAt: args.now,
	});
}

async function db_target_destination_is_closed(
	ctx: QueryCtx | MutationCtx,
	target: Doc<"plugin_service_storage_targets">,
) {
	const destination = await db_get_destination(ctx, {
		organizationId: target.organizationId,
		workspaceId: target.workspaceId,
		installationId: target.installationId,
		destinationPath: target.destinationPath,
	});
	return destination !== null && (target.destinationEpoch ?? 1) <= destination.closedEpoch;
}

/**
 * A current target must still belong to this installation and destination node.
 * Archive uses the saved destination node so a member rename does not strand cleanup.
 */
async function db_validate_target_node(
	ctx: QueryCtx | MutationCtx,
	args: {
		target: Doc<"plugin_service_storage_targets">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installation: Doc<"plugins_workspace_installations">;
		actorUserId: Id<"users">;
		pathPrefix: string;
		destinationNodeId: Id<"files_nodes">;
		node: Doc<"files_nodes">;
	},
) {
	const { target, node } = args;
	if (
		target.organizationId !== args.organizationId ||
		target.workspaceId !== args.workspaceId ||
		target.installationId !== args.installation._id ||
		target.destinationPath !== args.pathPrefix ||
		target.destinationNodeId !== args.destinationNodeId ||
		target.nodeId !== node._id ||
		node.organizationId !== args.organizationId ||
		node.workspaceId !== args.workspaceId ||
		target.movedOutAt !== undefined ||
		target.deleteRequestedAt !== undefined ||
		(target.state !== "pending" && target.state !== "committed") ||
		(await db_target_destination_is_closed(ctx, target))
	) {
		return false;
	}

	const destination = await ctx.db.get("files_nodes", args.destinationNodeId);
	if (
		!destination ||
		destination.kind !== "folder" ||
		destination.organizationId !== args.organizationId ||
		destination.workspaceId !== args.workspaceId
	) {
		return false;
	}

	let parentId = node.parentId;
	while (parentId !== files_ROOT_ID && parentId !== destination._id) {
		const parent = await ctx.db.get("files_nodes", parentId);
		if (!parent || parent.organizationId !== args.organizationId || parent.workspaceId !== args.workspaceId) {
			return false;
		}
		parentId = parent.parentId;
	}
	if (parentId !== destination._id) {
		return false;
	}

	// Passing a protected target retains its capability and human management ceiling.
	// An ordinary unprotected content update needs only its normal write authority.
	if (node.writePolicy?.mode === "writer") {
		if (!args.installation.acceptedCapabilities.includes("workspace.files.create-read-only")) {
			return false;
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization?.defaultWorkspaceId) {
			return false;
		}

		return await access_control_db_has_permission(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			defaultWorkspaceId: organization.defaultWorkspaceId,
			organizationOwnerUserId: organization.ownerUserId,
			resource: { kind: "file", id: String(node._id), restrictedScopeNodeId: node.restrictedScopeNodeId },
			userId: args.actorUserId,
			permission: "content.permissions.manage",
		});
	}

	return true;
}

/**
 * Path-based service file writes must validate a target when one exists.
 * A stale target never falls through to the separate no-target file rules.
 */
export async function public_api_service_uploads_db_validate_node_target(
	ctx: QueryCtx,
	args: {
		installation: Doc<"plugins_workspace_installations">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		actorUserId: Id<"users">;
		pathPrefix: string;
		node: Doc<"files_nodes">;
	},
) {
	const target = await ctx.db
		.query("plugin_service_storage_targets")
		.withIndex("by_node", (q) => q.eq("nodeId", args.node._id))
		.first();
	if (!target) {
		return true;
	}

	const destination = await files_db_get_visible_node_by_path(ctx, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		path: args.pathPrefix,
	});
	if (
		!destination ||
		destination.kind !== "folder" ||
		!public_api_is_path_inside_prefix(args.node.path, args.pathPrefix)
	) {
		return false;
	}

	return await db_validate_target_node(ctx, { ...args, target, destinationNodeId: destination._id });
}

/**
 * Recheck the live file before a grant reads or extends an existing target.
 */
async function db_authorize_live_target_node(
	ctx: MutationCtx,
	args: {
		target: Doc<"plugin_service_storage_targets">;
		principal: ServiceUploadPrincipal;
		serviceAccountId: Id<"access_control_service_accounts">;
	},
) {
	// Target keys are installation-wide, so the stored destination is the boundary between two
	// processing grants from the same installation.
	if (args.target.destinationPath !== args.principal.pathPrefix) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (args.target.movedOutAt !== undefined) {
		return Result({ _nay: { message: "Not found" } });
	}

	const node = await ctx.db.get("files_nodes", args.target.nodeId);
	if (!node) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (!public_api_is_path_inside_prefix(node.path, args.principal.pathPrefix)) {
		const now = Date.now();
		await ctx.db.patch("plugin_service_storage_targets", args.target._id, {
			movedOutAt: now,
			updatedAt: now,
		});
		return Result({ _nay: { message: "Not found" } });
	}

	if (node.archiveOperationId !== null) {
		return Result({ _nay: { message: "Not found" } });
	}
	if (
		!(await access_control_db_can_act_on_file_node(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			userId: args.principal.actorUserId,
			fileNode: node,
			serviceAccountId: args.serviceAccountId,
			permission: "content.write",
		}))
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	if (args.target.state === "pending" && node.assetId !== args.target.assetId) {
		return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This file's content changed" } });
	}

	// Do not check the file lock here. Creating the target accepted the upload, so a later lock does
	// not cancel its R2 completion or the retry URL needed to finish it.
	return Result({ _yay: node });
}

async function db_get_live_delete_group_targets(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		destinationPath: string;
		targetKey: string;
	},
) {
	const queryState = async (state: "pending" | "committed") =>
		await ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_delete_group_state", (q) =>
				q
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId)
					.eq("installationId", args.installationId)
					.eq("destinationPath", args.destinationPath)
					.eq("targetKey", args.targetKey)
					.eq("state", state)
					.eq("movedOutAt", undefined)
					.eq("deleteRequestedAt", undefined),
			)
			.take(MAX_LIVE_TARGETS_PER_DELETE_GROUP + 1);

	const pending = await queryState("pending");
	const committed = await queryState("committed");
	const now = Date.now();
	const destination = await db_get_destination(ctx, args);
	const attachedTargets: Array<Doc<"plugin_service_storage_targets">> = [];
	for (const target of [...pending, ...committed]) {
		if (destination && (target.destinationEpoch ?? 1) <= destination.closedEpoch) {
			await ctx.db.patch("plugin_service_storage_targets", target._id, {
				movedOutAt: now,
				updatedAt: now,
			});
			continue;
		}

		const node = await ctx.db.get("files_nodes", target.nodeId);
		if (node && !public_api_is_path_inside_prefix(node.path, target.destinationPath)) {
			await ctx.db.patch("plugin_service_storage_targets", target._id, {
				movedOutAt: now,
				updatedAt: now,
			});
			continue;
		}
		attachedTargets.push(target);
	}
	// A full page can hide more old rows. Save the detachments found on this page, then make the
	// caller retry instead of allowing an unbounded group through on partial information.
	if (pending.length > MAX_LIVE_TARGETS_PER_DELETE_GROUP || committed.length > MAX_LIVE_TARGETS_PER_DELETE_GROUP) {
		return null;
	}
	return attachedTargets.length > MAX_LIVE_TARGETS_PER_DELETE_GROUP ? null : attachedTargets;
}

export async function public_api_service_uploads_db_get_target_by_asset(
	ctx: QueryCtx | MutationCtx,
	assetId: Id<"files_r2_assets">,
) {
	const attempt = await ctx.db
		.query("plugin_service_storage_attempts")
		.withIndex("by_asset", (q) => q.eq("assetId", assetId))
		.first();
	return attempt ? await ctx.db.get("plugin_service_storage_targets", attempt.targetId) : null;
}

/**
 * Charge the largest stored size confirmed across this target's attempts. A retry or late event
 * only adds the increase. The winning file's size stays separate in `actualBytes`.
 */
async function db_charge_observed_bytes(
	ctx: MutationCtx,
	args: {
		target: Doc<"plugin_service_storage_targets">;
		observedBytes: number;
		now: number;
	},
) {
	const alreadyChargedBytes = args.target.chargedBytes;
	if (args.observedBytes <= alreadyChargedBytes) {
		return alreadyChargedBytes;
	}

	const quota = await quotas_db_get(ctx, {
		quotaName: "plugin_service_storage_bytes",
		organizationId: args.target.organizationId,
		workspaceId: args.target.workspaceId,
	});
	// The object already exists, so its bytes are charged even when they cross the ceiling. A signed
	// PUT cannot be held to a size, so this budget bills what was stored; it cannot prevent it.
	await ctx.db.patch("quotas", quota._id, {
		usedCount: quota.usedCount + (args.observedBytes - alreadyChargedBytes),
		updatedAt: args.now,
	});
	await ctx.db.patch("plugin_service_storage_targets", args.target._id, {
		chargedBytes: args.observedBytes,
		updatedAt: args.now,
	});

	return args.observedBytes;
}

/**
 * Record the canonical object's confirmed size and charge it.
 */
async function db_settle_canonicalized_target(
	ctx: MutationCtx,
	args: {
		target: Doc<"plugin_service_storage_targets">;
		actualBytes: number;
		now: number;
	},
) {
	await db_charge_observed_bytes(ctx, {
		target: args.target,
		observedBytes: args.actualBytes,
		now: args.now,
	});

	await ctx.db.patch("plugin_service_storage_targets", args.target._id, {
		state: "committed",
		actualBytes: args.actualBytes,
		updatedAt: args.now,
	});

	// Nothing is free: the stored file bills the workspace payer one cent, once per target.
	// Every caller refuses a non-pending target before reaching this settle, so the emit runs at
	// most once; the target id keeps the event's externalId deterministic on top of that.
	//
	// A missing organization or payer doc throws, which rolls back the `committed` patch above,
	// so a service write can never commit without its one billing event; the R2 event retries.
	const organization = await ctx.db.get("organizations", args.target.organizationId);
	if (!organization) {
		throw should_never_happen("target.organizationId points to a missing organizations doc", {
			targetId: args.target._id,
			organizationId: args.target.organizationId,
		});
	}

	const billedUserId = billing_pick_billed_user_id({ userId: args.target.createdBy, organization });
	const billedUser = await ctx.db.get("users", billedUserId);
	if (!billedUser) {
		throw should_never_happen("billedUserId points to a missing users doc", {
			targetId: args.target._id,
			userId: args.target.createdBy,
			billedUserId,
		});
	}
	// An anonymous payer with no usage snapshot would also make this emit throw, and that stays
	// unguarded on purpose: `create-target` already refused anyone without a paid plan, a paid
	// plan means a synced snapshot with a meter, and an anonymous user gets a synthetic snapshot
	// the moment the user doc is created. Whoever weakens the create-target plan gate later must
	// know it was also holding this up.
	await billing_db_emit_file_save(ctx, {
		billedUser,
		actorUserId: args.target.createdBy,
		organizationId: args.target.organizationId,
		workspaceId: args.target.workspaceId,
		nodeId: args.target.nodeId,
		version: args.target._id,
	});

	return args.actualBytes;
}

/**
 * Settle a service target in the same transaction that records its canonical R2 object.
 */
export async function public_api_service_uploads_db_settle_canonicalized_asset(
	ctx: MutationCtx,
	args: { assetId: Id<"files_r2_assets">; actualBytes: number; nodePath: string | null; now: number },
) {
	const target = await public_api_service_uploads_db_get_target_by_asset(ctx, args.assetId);
	if (!target || target.assetId !== args.assetId) {
		return;
	}
	if (
		target.movedOutAt === undefined &&
		args.nodePath !== null &&
		!public_api_is_path_inside_prefix(args.nodePath, target.destinationPath)
	) {
		await ctx.db.patch("plugin_service_storage_targets", target._id, {
			movedOutAt: args.now,
			updatedAt: args.now,
		});
	}

	if (target.state !== "pending") {
		return;
	}
	await db_settle_canonicalized_target(ctx, { target, actualBytes: args.actualBytes, now: args.now });
}

/**
 * Charge stored bytes from an old attempt without giving it publication authority.
 */
export async function public_api_service_uploads_db_record_untracked_asset_bytes(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetId: Id<"files_r2_assets">;
		observedBytes: number;
		now: number;
	},
) {
	const target = await public_api_service_uploads_db_get_target_by_asset(ctx, args.assetId);
	if (!target || target.organizationId !== args.organizationId || target.workspaceId !== args.workspaceId) {
		return;
	}
	// Receipts survive asset deletion. A late old PUT still uses this target's budget, but cannot
	// change its winning file, state, or one-time file-save charge.
	await db_charge_observed_bytes(ctx, {
		target,
		observedBytes: args.observedBytes,
		now: args.now,
	});
}

/**
 * If a pending target has lost its current asset doc, remove its unusable placeholder. Receipts
 * keep any earlier attempt's charge attached to the released target.
 */
async function db_release_expired_target(
	ctx: MutationCtx,
	args: {
		target: Doc<"plugin_service_storage_targets">;
		now: number;
	},
) {
	await ctx.db.patch("plugin_service_storage_targets", args.target._id, {
		state: "released",
		updatedAt: args.now,
	});
	await files_nodes_db_hard_delete_node(ctx, {
		organizationId: args.target.organizationId,
		workspaceId: args.target.workspaceId,
		nodeId: args.target.nodeId,
	});
}

const target_pending_response_validator = v.object({
	state: v.literal("pending"),
	path: v.string(),
	nodeId: v.string(),
	uploadUrl: v.string(),
	headers: v.record(v.string(), v.string()),
	uploadUrlExpiresAt: v.number(),
});

const target_committed_response_validator = v.object({
	state: v.literal("committed"),
	path: v.string(),
	nodeId: v.string(),
	actualBytes: v.number(),
});

export const create_upload_target = internalMutation({
	args: {
		principal: service_upload_principal_validator,
		idempotencyKey: v.string(),
		targetKey: v.string(),
		path: v.string(),
		contentType: v.string(),
		size: v.number(),
		readOnly: v.boolean(),
		nonCollaborative: v.boolean(),
	},
	returns: v_result({
		_yay: v.union(target_pending_response_validator, target_committed_response_validator),
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_service_upload(ctx, args.principal);
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const idempotencyKey = validate_key(args.idempotencyKey, "Idempotency keys");
		if (idempotencyKey._nay) {
			return idempotencyKey;
		}
		const targetKey = validate_key(args.targetKey, "Target keys");
		if (targetKey._nay) {
			return targetKey;
		}

		// The same path rules as `/api/v1/files/upload-urls`: canonical absolute path, an upload file
		// name, valid folder segments, and a bounded size.
		if (!args.path.startsWith("/") || args.path === "/" || server_path_normalize(args.path) !== args.path) {
			return Result({ _nay: { message: "Path must be absolute and normalized" } });
		}
		const name = path_name_of(args.path);
		if (files_normalize_upload_file_name(name) !== name) {
			return Result({ _nay: { message: "Path ends in an invalid file name" } });
		}
		for (const segment of path_extract_segments_from(args.path).slice(0, -1)) {
			const normalizedSegment = files_normalize_name("folder", segment);
			if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
				return Result({ _nay: { message: "Path contains an invalid folder name" } });
			}
		}

		if (!Number.isInteger(args.size) || args.size < 1 || args.size > files_MAX_UPLOADS_BYTES) {
			return Result({ _nay: { message: "File too large" } });
		}
		// The service always names the type. It decides how the upload is processed, so a broken
		// value is refused instead of guessed from the name.
		const contentType = files_normalize_content_type(args.contentType);
		if (contentType === null) {
			return Result({ _nay: { message: files_INVALID_CONTENT_TYPE_MESSAGE } });
		}
		if (args.nonCollaborative && files_editable_text_content_type_of(contentType) === null) {
			return Result({ _nay: { message: "Only editable text files can be non-collaborative" } });
		}

		// The seal is the consent: files may land under this prefix and nowhere else. The prefix
		// itself is a folder, so a path equal to it is refused too.
		if (
			!public_api_is_path_inside_prefix(args.path, args.principal.pathPrefix) ||
			args.path === args.principal.pathPrefix
		) {
			return Result({
				_nay: { name: REFUSAL_OUTSIDE_DESTINATION, message: "Path is outside this grant's destination" },
			});
		}

		const now = Date.now();
		// Fingerprint the normalized type, so a replay that spells the same type differently
		// (`Text/Plain`) still matches its first request.
		const requestFingerprint = JSON.stringify({
			path: args.path,
			contentType,
			size: args.size,
			readOnly: args.readOnly,
			nonCollaborative: args.nonCollaborative,
		});
		const existingTarget = await db_get_target(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			idempotencyKey: idempotencyKey._yay,
			targetKey: targetKey._yay,
		});
		if (existingTarget) {
			if (existingTarget.destinationPath !== args.principal.pathPrefix) {
				return Result({ _nay: { message: "Not found" } });
			}
			if (existingTarget.movedOutAt !== undefined) {
				return Result({ _nay: { message: "Not found" } });
			}
			if (await db_target_destination_is_closed(ctx, existingTarget)) {
				return Result({ _nay: { message: "Not found" } });
			}
			if (existingTarget.requestFingerprint !== requestFingerprint) {
				return Result({
					_nay: { name: REFUSAL_CONFLICT, message: "This target key was already used for a different file" },
				});
			}
			if (existingTarget.state === "released" || existingTarget.deleteRequestedAt !== undefined) {
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This target was already released" } });
			}
			const liveNode = await db_authorize_live_target_node(ctx, {
				target: existingTarget,
				principal: args.principal,
				serviceAccountId: authorized._yay.serviceAccountId,
			});
			if (liveNode._nay) {
				return liveNode;
			}
			const liveTarget =
				liveNode._yay.path === existingTarget.path ? existingTarget : { ...existingTarget, path: liveNode._yay.path };
			if (existingTarget.state === "committed") {
				return Result({
					_yay: {
						state: "committed" as const,
						path: liveNode._yay.path,
						nodeId: String(existingTarget.nodeId),
						actualBytes: existingTarget.actualBytes ?? existingTarget.declaredBytes,
					},
				});
			}

			// A pending replay behaves like a remint: it gets a fresh URL. The target stays the same and
			// still charges nothing.
			const asset = await ctx.db.get("files_r2_assets", existingTarget.assetId);
			if (!asset) {
				await db_release_expired_target(ctx, { target: existingTarget, now });
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This target's upload expired" } });
			}
			if (asset.r2Key !== undefined) {
				const actualBytes = await db_settle_canonicalized_target(ctx, {
					target: existingTarget,
					actualBytes: asset.size,
					now,
				});
				return Result({
					_yay: {
						state: "committed" as const,
						path: existingTarget.path,
						nodeId: String(existingTarget.nodeId),
						actualBytes,
					},
				});
			}

			return await db_remint_pending_target(ctx, { target: liveTarget, asset, now });
		}

		// A service never overwrites. A meeting's files land on fresh paths; a collision means either a
		// replay under a new target key (a caller bug) or a member's file, and both must survive.
		const existingNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", args.principal.organizationId)
					.eq("workspaceId", args.principal.workspaceId)
					.eq("path", args.path)
					.eq("archiveOperationId", null),
			)
			.first();
		if (existingNode) {
			// Check access first so a restricted file the actor cannot see still answers Permission
			// denied instead of revealing that the path is taken.
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					userId: args.principal.actorUserId,
					fileNode: existingNode,
					serviceAccountId: authorized._yay.serviceAccountId,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "A file already exists at this path" } });
		}

		// Ancestor pass, same as `/api/v1/files/upload-urls`: a restricted, file-owned, or read-only
		// ancestor refuses cleanly before anything is written.
		const segments = path_extract_segments_from(args.path);
		let effectiveDestinationAclNode: Doc<"files_nodes"> | null = null;
		for (let index = 1; index < segments.length; index++) {
			const ancestorPath = `/${segments.slice(0, index).join("/")}`;
			const ancestor = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.principal.organizationId)
						.eq("workspaceId", args.principal.workspaceId)
						.eq("path", ancestorPath)
						.eq("archiveOperationId", null),
				)
				.first();
			if (!ancestor) {
				continue;
			}
			effectiveDestinationAclNode = ancestor;
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					userId: args.principal.actorUserId,
					fileNode: ancestor,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			if (ancestor.kind !== "folder") {
				return Result({ _nay: { message: "An intermediate segment is owned by a file" } });
			}
		}

		const writeContext: files_nodes_WriteContext = {
			writer: { kind: "service_account", serviceAccountId: authorized._yay.serviceAccountId },
			actorUserId: args.principal.actorUserId,
			resourceScope: {
				kind: "create",
				parentNodeId: effectiveDestinationAclNode?._id ?? files_ROOT_ID,
				path: args.path,
			},
			policyReach: "direct",
		};
		const writeTarget = { kind: "create" as const, parentNode: effectiveDestinationAclNode, path: args.path };
		const accountCanWrite = await access_control_db_has_permission(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			defaultWorkspaceId: authorized._yay.defaultWorkspaceId,
			organizationOwnerUserId: authorized._yay.organization.ownerUserId,
			resource: effectiveDestinationAclNode
				? {
						kind: "file",
						id: String(effectiveDestinationAclNode._id),
						restrictedScopeNodeId: effectiveDestinationAclNode.restrictedScopeNodeId,
					}
				: { kind: "workspace", id: String(args.principal.workspaceId) },
			serviceAccountId: authorized._yay.serviceAccountId,
			permission: "content.write",
		});
		if (!accountCanWrite) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const writable = await files_nodes_db_require_writable(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			writeContext,
			target: writeTarget,
		});
		if (writable._nay) {
			return writable;
		}
		const writePolicy = args.readOnly ? { mode: "writer" as const, writer: writeContext.writer } : undefined;

		if (args.readOnly && !installation.acceptedCapabilities.includes("workspace.files.create-read-only")) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		if (writePolicy) {
			const management = await files_nodes_db_require_write_policy_management(ctx, {
				organizationId: args.principal.organizationId,
				workspaceId: args.principal.workspaceId,
				writeContext,
				target: writeTarget,
				writePolicy,
			});
			if (management._nay) {
				return management;
			}
		}

		const runTargets = await ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_organization_workspace_installation_idempotencyKey_targetKey", (q) =>
				q
					.eq("organizationId", args.principal.organizationId)
					.eq("workspaceId", args.principal.workspaceId)
					.eq("installationId", installation._id)
					.eq("idempotencyKey", idempotencyKey._yay),
			)
			.take(MAX_TARGETS_PER_UPLOAD_RUN);
		if (runTargets.length >= MAX_TARGETS_PER_UPLOAD_RUN) {
			return Result({ _nay: { message: "An upload run holds at most 16 targets" } });
		}
		const liveDeleteGroup = await db_get_live_delete_group_targets(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			destinationPath: args.principal.pathPrefix,
			targetKey: targetKey._yay,
		});
		if (liveDeleteGroup === null || liveDeleteGroup.length >= MAX_LIVE_TARGETS_PER_DELETE_GROUP) {
			return Result({ _nay: { message: "A destination holds at most 16 live targets under one target key" } });
		}

		// Storing files for a service costs real money, so only a workspace that pays for usage may
		// start one. This is the door that can actually stop an upload: the quota below can only bill
		// what R2 already stored, because a signed PUT does not bind how many bytes arrive. The plan
		// belongs to whoever pays for this workspace, which in an owner-billed organization is the
		// owner and not the member whose grant is presenting.
		const billedUserId = billing_pick_billed_user_id({
			userId: args.principal.actorUserId,
			organization: authorized._yay.organization,
		});
		const paidPlan = await billing_db_check_paid_plan(ctx, { userId: billedUserId });
		if (!paidPlan.hasPaidPlan) {
			return Result({
				_nay: {
					name: REFUSAL_PLAN_REQUIRED,
					message: "This workspace's plan does not include plugin service file storage",
				},
			});
		}

		// Nothing is charged here. The size in the request is only the service's guess, and a signed
		// PUT does not bind how many bytes actually arrive, so charging it would bill a number nobody
		// can hold the caller to. The real size is charged once, when R2 confirms the stored object.
		//
		// What this door does is refuse a workspace that is already over its budget, which stops the
		// next file rather than the current one. Seeded lazily because existing workspaces have no
		// doc for this quota.
		const quotaId = await quotas_db_ensure(ctx, {
			quotaName: "plugin_service_storage_bytes",
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			now,
		});
		const quota = await ctx.db.get("quotas", quotaId);
		if (!quota) {
			// Unreachable: quotas_db_ensure returned this id in the same transaction.
			throw should_never_happen("quotas_db_ensure returned a missing quota doc", { quotaId });
		}
		if (quota.usedCount >= quota.maxCount) {
			return Result({
				_nay: { name: REFUSAL_STORAGE_FULL, message: "This workspace has used its plugin service storage" },
			});
		}

		// A recognized text extension runs the same upload conversion as a member upload, so a
		// service-uploaded `.md` or `.txt` becomes a normal editable file. Everything else stays a
		// stored blob with `processingWorkId: null` up front.
		//
		// Plugin upload events stay off for every service upload either way;
		// `plugins_runtime_db_enqueue_upload_completed_runs` refuses assets owned by a service
		// storage target.
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			kind: "upload",
			r2Bucket: r2.config.bucket,
			size: args.size,
			...(files_editable_text_content_type_of(contentType) === null ? { processingWorkId: null } : {}),
			createdBy: args.principal.actorUserId,
			unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
			updatedAt: now,
		});

		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			userId: args.principal.actorUserId,
			parentId: files_ROOT_ID,
			path: args.path,
			kind: "file",
			contentType,
			assetId,
			createdNodesMetadata: [
				{ key: "source", value: "plugin" },
				{ key: "plugin-name", value: installation.pluginName },
			],
			metadata: [{ key: "original-name", value: name }],
			writeContext,
			...(writePolicy ? { writePolicy } : {}),
			now,
		});
		// The validation above cleared every failure this helper can hit. Throw so a surprise rolls
		// the whole call back instead of leaving a target row with no file.
		if (nodeIdResult._nay) {
			const errorMessage = "create_node_recursively_at_path failed after service upload validation";
			const errorData = { path: args.path, nay: nodeIdResult._nay };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const destination = await files_db_get_visible_node_by_path(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			path: args.principal.pathPrefix,
		});
		if (!destination || destination.kind !== "folder") {
			const errorMessage = "Service upload created a file without its sealed destination folder";
			const errorData = { path: args.path, destinationPath: args.principal.pathPrefix };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const uploadKey = r2_create_asset_key({
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			assetId,
		});
		const uploadUrlExpiresAt = now + UPLOAD_URL_TTL_MS;
		await ctx.db.patch("files_r2_assets", assetId, {
			uploadUrlExpiresAt,
		});
		const signedUpload = await r2.generateUploadUrl(uploadKey, {
			createOnly: true,
			expiresIn: UPLOAD_URL_TTL_MS / 1000,
		});
		const destinationEpoch = await db_open_destination_epoch(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			destinationPath: args.principal.pathPrefix,
			now,
		});

		const targetId = await ctx.db.insert("plugin_service_storage_targets", {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			idempotencyKey: idempotencyKey._yay,
			targetKey: targetKey._yay,
			requestFingerprint,
			readOnly: args.readOnly,
			nonCollaborative: args.nonCollaborative,
			destinationPath: args.principal.pathPrefix,
			destinationNodeId: destination._id,
			destinationEpoch,
			path: args.path,
			contentType,
			declaredBytes: args.size,
			actualBytes: null,
			chargedBytes: 0,
			nodeId: nodeIdResult._yay,
			assetId,
			state: "pending",
			createdBy: args.principal.actorUserId,
			updatedAt: now,
		});
		await ctx.db.insert("plugin_service_storage_attempts", {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			targetId,
			assetId,
		});

		return Result({
			_yay: {
				state: "pending" as const,
				path: args.path,
				nodeId: String(nodeIdResult._yay),
				uploadUrl: signedUpload.url,
				headers: { "Content-Type": contentType, "If-None-Match": "*" },
				uploadUrlExpiresAt,
			},
		});
	},
});

export type public_api_service_uploads_create_upload_target_Result =
	typeof create_upload_target extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Start a fresh attempt for this pending file. Nothing is charged here. The caller sends the whole
 * file again; the old URL can only create an object that cleanup already owns.
 */
async function db_remint_pending_target(
	ctx: MutationCtx,
	args: { target: Doc<"plugin_service_storage_targets">; asset: Doc<"files_r2_assets">; now: number },
) {
	const uploadUrlExpiresAt = args.now + UPLOAD_URL_TTL_MS;
	const assetId = await ctx.db.insert("files_r2_assets", {
		organizationId: args.target.organizationId,
		workspaceId: args.target.workspaceId,
		kind: "upload",
		r2Bucket: r2.config.bucket,
		size: args.target.declaredBytes,
		...(files_editable_text_content_type_of(args.target.contentType) === null ? { processingWorkId: null } : {}),
		createdBy: args.target.createdBy,
		uploadUrlExpiresAt,
		unfinalizedExpiresAt: args.now + r2_UNFINALIZED_ASSET_TTL_MS,
		updatedAt: args.now,
	});
	await ctx.db.insert("plugin_service_storage_attempts", {
		organizationId: args.target.organizationId,
		workspaceId: args.target.workspaceId,
		targetId: args.target._id,
		assetId,
	});

	await ctx.db.patch("plugin_service_storage_targets", args.target._id, { assetId, updatedAt: args.now });
	await ctx.db.patch("files_nodes", args.target.nodeId, { assetId, updatedAt: args.now });

	await r2_enqueue_object_deletion_job(ctx, {
		organizationId: args.target.organizationId,
		workspaceId: args.target.workspaceId,
		r2Key: r2_create_asset_key({
			organizationId: args.target.organizationId,
			workspaceId: args.target.workspaceId,
			assetId: args.asset._id,
		}),
		reason: "untracked_asset_event",
		putMayArriveUntil: (args.asset.uploadUrlExpiresAt ?? args.now) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
	});
	await ctx.db.delete("files_r2_assets", args.asset._id);

	const uploadKey = r2_create_asset_key({
		organizationId: args.target.organizationId,
		workspaceId: args.target.workspaceId,
		assetId,
	});
	const signedUpload = await r2.generateUploadUrl(uploadKey, {
		createOnly: true,
		expiresIn: UPLOAD_URL_TTL_MS / 1000,
	});

	return Result({
		_yay: {
			state: "pending" as const,
			path: args.target.path,
			nodeId: String(args.target.nodeId),
			uploadUrl: signedUpload.url,
			headers: { "Content-Type": args.target.contentType, "If-None-Match": "*" },
			uploadUrlExpiresAt,
		},
	});
}

export const remint_upload_target = internalMutation({
	args: {
		principal: service_upload_principal_validator,
		idempotencyKey: v.string(),
		targetKey: v.string(),
	},
	returns: v_result({
		_yay: v.union(target_pending_response_validator, target_committed_response_validator),
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_service_upload(ctx, args.principal);
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const target = await db_get_target(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			idempotencyKey: args.idempotencyKey,
			targetKey: args.targetKey,
		});
		if (!target) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (target.destinationPath !== args.principal.pathPrefix) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (target.movedOutAt !== undefined) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (await db_target_destination_is_closed(ctx, target)) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (target.state === "released" || target.deleteRequestedAt !== undefined) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This target was already released" } });
		}
		const liveNode = await db_authorize_live_target_node(ctx, {
			target,
			principal: args.principal,
			serviceAccountId: authorized._yay.serviceAccountId,
		});
		if (liveNode._nay) {
			return liveNode;
		}
		const liveTarget = liveNode._yay.path === target.path ? target : { ...target, path: liveNode._yay.path };

		const now = Date.now();
		if (target.state === "committed") {
			return Result({
				_yay: {
					state: "committed" as const,
					path: liveNode._yay.path,
					nodeId: String(target.nodeId),
					actualBytes: target.actualBytes ?? target.declaredBytes,
				},
			});
		}

		const asset = await ctx.db.get("files_r2_assets", target.assetId);
		if (!asset) {
			await db_release_expired_target(ctx, { target, now });
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This target's upload expired" } });
		}
		// The object already reached its canonical key: a fresh URL would be useless, so answer
		// committed instead, settling the books on the way.
		if (asset.r2Key !== undefined) {
			const actualBytes = await db_settle_canonicalized_target(ctx, {
				target,
				actualBytes: asset.size,
				now,
			});
			return Result({
				_yay: { state: "committed" as const, path: liveNode._yay.path, nodeId: String(target.nodeId), actualBytes },
			});
		}

		return await db_remint_pending_target(ctx, { target: liveTarget, asset, now });
	},
});

export type public_api_service_uploads_remint_upload_target_Result =
	typeof remint_upload_target extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const finalize_upload_target = internalMutation({
	args: {
		principal: service_upload_principal_validator,
		idempotencyKey: v.string(),
		targetKey: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			state: v.union(v.literal("pending"), v.literal("committed"), v.literal("released")),
			path: v.string(),
			nodeId: v.string(),
			actualBytes: v.union(v.number(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_service_upload(ctx, args.principal);
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const target = await db_get_target(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			idempotencyKey: args.idempotencyKey,
			targetKey: args.targetKey,
		});
		if (!target) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (target.destinationPath !== args.principal.pathPrefix) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (target.movedOutAt !== undefined) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (await db_target_destination_is_closed(ctx, target)) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (target.state === "released" || target.deleteRequestedAt !== undefined) {
			return Result({
				_yay: {
					state: "released" as const,
					path: target.path,
					nodeId: String(target.nodeId),
					actualBytes: target.actualBytes,
				},
			});
		}

		const liveNode = await db_authorize_live_target_node(ctx, {
			target,
			principal: args.principal,
			serviceAccountId: authorized._yay.serviceAccountId,
		});
		if (liveNode._nay) {
			return liveNode;
		}
		if (target.state === "committed") {
			return Result({
				_yay: {
					state: "committed" as const,
					path: liveNode._yay.path,
					nodeId: String(target.nodeId),
					actualBytes: target.actualBytes ?? target.declaredBytes,
				},
			});
		}

		const now = Date.now();
		const asset = await ctx.db.get("files_r2_assets", target.assetId);
		// A missing current asset cannot finish. Keep the released target and any earlier charges.
		if (!asset) {
			await db_release_expired_target(ctx, { target, now });
			return Result({
				_yay: {
					state: "released" as const,
					path: liveNode._yay.path,
					nodeId: String(target.nodeId),
					actualBytes: null,
				},
			});
		}
		// Not canonicalized yet: the PUT or the R2 event is still in flight. The service polls again.
		if (asset.r2Key === undefined) {
			return Result({
				_yay: {
					state: "pending" as const,
					path: liveNode._yay.path,
					nodeId: String(target.nodeId),
					actualBytes: null,
				},
			});
		}

		const actualBytes = await db_settle_canonicalized_target(ctx, {
			target,
			actualBytes: asset.size,
			now,
		});
		return Result({
			_yay: { state: "committed" as const, path: liveNode._yay.path, nodeId: String(target.nodeId), actualBytes },
		});
	},
});

export type public_api_service_uploads_finalize_upload_target_Result =
	typeof finalize_upload_target extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion targets

// #region delete

/**
 * Delete the files a target key names. A committed upload is a normal member file, so deleting it
 * archives the file and keeps its content. An unfinished upload only has an empty placeholder, so
 * deleting it cancels the upload and removes that placeholder. The lookup goes by installation,
 * sealed destination, and target key. It reads only live targets;
 * one representative deleting or released target gives a bounded replay answer.
 *
 * Every live match still inside the fence is handled. A second processing run can store another file
 * under the same target key on a different path, and a caller asking for that key wants both gone.
 * The group is capped where targets are created, so this all-or-nothing mutation stays bounded.
 *
 * An upload that never finished is cancelled here too: its placeholder file is empty, so there is
 * nothing to keep. This is also the only way to get rid of one, which is why the route deletes it
 * instead of refusing while it is still pending.
 *
 * Deleting never gives quota bytes back. The counter only grows, so the bytes this run charged stay
 * charged. `deleteRequestedAt` marks an archived committed target. Late attempts can only raise its
 * charged maximum, never change its winning size. The released target also answers delete replays.
 */
export const delete_upload_target = internalMutation({
	args: {
		principal: service_upload_principal_validator,
		idempotencyKey: v.string(),
		targetKey: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			state: v.literal("deleted"),
			paths: v.array(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_service_upload(ctx, args.principal);
		if (authorized._nay) {
			return authorized;
		}
		const installation = authorized._yay.installation;

		const idempotencyKey = validate_key(args.idempotencyKey, "Idempotency keys");
		if (idempotencyKey._nay) {
			return idempotencyKey;
		}
		const targetKey = validate_key(args.targetKey, "Target keys");
		if (targetKey._nay) {
			return targetKey;
		}

		const liveTargets = await db_get_live_delete_group_targets(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			destinationPath: args.principal.pathPrefix,
			targetKey: targetKey._yay,
		});
		if (liveTargets === null) {
			return Result({ _nay: { message: "A destination holds at most 16 live targets under one target key" } });
		}

		const matches: Array<{
			target: Doc<"plugin_service_storage_targets">;
			node: Doc<"files_nodes"> | null;
			path: string;
		}> = [];
		for (const target of liveTargets) {
			const node = await ctx.db.get("files_nodes", target.nodeId);
			// A member may move a service file after upload. The old seal no longer reaches that live
			// node, and its new path must not appear in this response.
			if (node && !public_api_is_path_inside_prefix(node.path, args.principal.pathPrefix)) {
				continue;
			}
			matches.push({ target, node, path: node?.path ?? target.path });
		}

		const releasedCandidate = await ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_delete_group_state", (q) =>
				q
					.eq("organizationId", args.principal.organizationId)
					.eq("workspaceId", args.principal.workspaceId)
					.eq("installationId", installation._id)
					.eq("destinationPath", args.principal.pathPrefix)
					.eq("targetKey", targetKey._yay)
					.eq("state", "released")
					.eq("movedOutAt", undefined),
			)
			.order("desc")
			.first();
		const releasedTarget =
			releasedCandidate && !(await db_target_destination_is_closed(ctx, releasedCandidate)) ? releasedCandidate : null;
		if (matches.length === 0 && !releasedTarget) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Preflight every matching node before changing policies or archiving files.
		const policiesToClear: Array<{ node: Doc<"files_nodes">; writeContext: files_nodes_WriteContext }> = [];
		for (const match of matches) {
			if (!match.node) {
				continue;
			}
			const writeContext: files_nodes_WriteContext = {
				writer: { kind: "service_account", serviceAccountId: authorized._yay.serviceAccountId },
				actorUserId: args.principal.actorUserId,
				resourceScope: { kind: "node", nodeId: match.node._id },
				policyReach: "direct",
			};
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					userId: args.principal.actorUserId,
					serviceAccountId: authorized._yay.serviceAccountId,
					fileNode: match.node,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			const writable = await files_nodes_db_require_writable(ctx, {
				organizationId: args.principal.organizationId,
				workspaceId: args.principal.workspaceId,
				writeContext,
				target: { kind: "node", node: match.node },
			});
			if (writable._nay) {
				return writable;
			}
			if (
				!(await db_validate_target_node(ctx, {
					target: match.target,
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					installation,
					actorUserId: args.principal.actorUserId,
					pathPrefix: args.principal.pathPrefix,
					destinationNodeId: match.target.destinationNodeId,
					node: match.node,
				}))
			) {
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This upload target is no longer available" } });
			}
			if (match.target.state === "committed" && match.node.writePolicy !== null) {
				const management = await files_nodes_db_require_write_policy_management(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					writeContext,
					target: { kind: "node", node: match.node },
					writePolicy: null,
				});
				if (management._nay) {
					return management;
				}
				policiesToClear.push({ node: match.node, writeContext });
			}
		}

		const now = Date.now();
		const committedNodes = matches.flatMap((match) =>
			match.target.state === "committed" && match.node && match.node.archiveOperationId === null ? [match.node] : [],
		);
		if (committedNodes.length > 0) {
			for (const plan of policiesToClear) {
				const cleared = await files_nodes_db_set_write_policy(ctx, { ...plan, writePolicy: null });
				if (cleared._nay) {
					const message = "Service archive policy clear failed after validation";
					console.error(message, { nodeId: plan.node._id, nay: cleared._nay });
					throw should_never_happen(message, { nodeId: plan.node._id, nay: cleared._nay });
				}
			}
			// Archive every committed match together, like one member delete action.
			await files_nodes_db_archive_nodes(ctx, {
				nodeIds: committedNodes.map((node) => node._id),
				updatedBy: args.principal.actorUserId,
				now,
			});
		}

		for (const match of matches) {
			const { target } = match;
			if (target.state === "committed") {
				await ctx.db.patch("plugin_service_storage_targets", target._id, {
					state: "released",
					deleteRequestedAt: now,
					...(match.path === target.path ? {} : { path: match.path }),
					updatedAt: now,
				});
				continue;
			}

			// The signed URL can recreate this object after an early delete. Keep its exact-key job
			// through the write window before removing the placeholder and asset.
			const asset = await ctx.db.get("files_r2_assets", target.assetId);
			const liveR2Key =
				asset?.r2Key ??
				r2_create_asset_key({
					organizationId: target.organizationId,
					workspaceId: target.workspaceId,
					assetId: target.assetId,
				});
			await r2_enqueue_object_deletion_job(ctx, {
				organizationId: target.organizationId,
				workspaceId: target.workspaceId,
				r2Key: liveR2Key,
				reason: "untracked_asset_event",
				putMayArriveUntil: (asset?.uploadUrlExpiresAt ?? now + UPLOAD_URL_TTL_MS) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
			});

			// Deletes the file node and its asset doc. If the node is already gone, delete the asset doc
			// directly so nothing keeps pointing at the doomed object.
			await files_nodes_db_hard_delete_node(ctx, {
				organizationId: target.organizationId,
				workspaceId: target.workspaceId,
				nodeId: target.nodeId,
			});
			const assetAfter = await ctx.db.get("files_r2_assets", target.assetId);
			if (assetAfter) {
				await ctx.db.delete("files_r2_assets", assetAfter._id);
			}

			// An unfinished upload has no confirmed object to keep, so release it right here.
			await ctx.db.patch("plugin_service_storage_targets", target._id, {
				state: "released",
				...(match.path === target.path ? {} : { path: match.path }),
				updatedAt: now,
			});
		}

		const replayPath = releasedTarget?.path;
		const paths = matches.map((match) => match.path);
		if (replayPath && !paths.includes(replayPath)) {
			paths.push(replayPath);
		}
		return Result({
			_yay: { state: "deleted", paths: paths.sort() },
		});
	},
});

export type public_api_service_uploads_delete_upload_target_Result =
	typeof delete_upload_target extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion delete

// #region archive

/**
 * A meeting folder holds a handful of files. This bounds what one archive call patches, whatever a
 * grant was sealed to. Shared with the `/api/v1/files/plugin-archive` door so both archives keep
 * the same ceiling.
 */
export const public_api_service_uploads_MAX_ARCHIVE_NODES = 256;

/**
 * Load at most `maxNodes` descendants. One extra read proves that the subtree is too large.
 */
export async function public_api_service_uploads_db_collect_bounded_descendants(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		parentId: Id<"files_nodes">;
		maxNodes: number;
	},
) {
	const descendants: Array<Doc<"files_nodes">> = [];
	const stack = [args.parentId];

	while (stack.length > 0) {
		const parentId = stack.pop();
		if (parentId === undefined) {
			continue;
		}
		const remaining = args.maxNodes - descendants.length;
		const children = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("parentId", parentId),
			)
			.take(remaining + 1);
		if (children.length > remaining) {
			return null;
		}
		for (const child of children) {
			descendants.push(child);
			stack.push(child._id);
		}
	}

	return descendants;
}

/**
 * Archive the folder this grant was sealed to, with everything still active inside it.
 *
 * The meeting is gone, so its files must leave the workspace tree. They are real committed files
 * though, and in this product deleting a file means archiving it, so the service archives too. One
 * operation id covers the folder and its whole subtree. Local policies are cleared only when the
 * actor and account can manage them, so a member can restore the set later. The stored
 * bytes stay charged. This quota only grows, so neither archive nor physical deletion gives bytes
 * back.
 *
 * The seal is the fence. The door takes no path, so a grant can only ever archive its own
 * destination. The accepted capability, actor permissions, account grants, and current policies
 * must all allow the archive. A member can still have put something of their own in the folder,
 * so a refusal anywhere in the subtree refuses the whole call. The delete workflow fails
 * visibly on a refusal and can be retried once the member clears what blocked it.
 *
 * No idempotency key: a replay finds nothing active at the destination and archives zero nodes.
 */
export const archive_destination = internalMutation({
	args: {
		principal: service_upload_principal_validator,
	},
	returns: v_result({ _yay: v.object({ archivedNodes: v.number() }) }),
	handler: async (ctx, args) => {
		const authorized = await db_authorize_service_upload(ctx, args.principal);
		if (authorized._nay) {
			return authorized;
		}
		const now = Date.now();

		const stableTarget = await ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_organization_workspace_installation_destinationPath", (q) =>
				q
					.eq("organizationId", args.principal.organizationId)
					.eq("workspaceId", args.principal.workspaceId)
					.eq("installationId", authorized._yay.installation._id)
					.eq("destinationPath", args.principal.pathPrefix),
			)
			// A later run can recreate an archived destination at the same path. Follow that newest
			// generation, while the stable node id still preserves a member rename.
			.order("desc")
			.first();
		if (!stableTarget) {
			return Result({ _yay: { archivedNodes: 0 } });
		}
		if (await db_target_destination_is_closed(ctx, stableTarget)) {
			return Result({ _yay: { archivedNodes: 0 } });
		}
		let destination = await ctx.db.get("files_nodes", stableTarget.destinationNodeId);
		if (!destination) {
			// A target proves this folder existed. Refuse instead of telling the caller its delete worked.
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This destination folder no longer exists" } });
		}
		if (
			destination.organizationId !== args.principal.organizationId ||
			destination.workspaceId !== args.principal.workspaceId ||
			destination.kind !== "folder"
		) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This destination is no longer a meeting folder" } });
		}
		if (destination.archiveOperationId !== null) {
			// A member can restore an older generation after a newer folder used the same path. Follow
			// that active folder only when a target proves this installation created that exact node.
			const restoredDestination = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.principal.organizationId)
						.eq("workspaceId", args.principal.workspaceId)
						.eq("path", args.principal.pathPrefix)
						.eq("archiveOperationId", null),
				)
				.first();
			const restoredTarget =
				restoredDestination?.kind === "folder"
					? await ctx.db
							.query("plugin_service_storage_targets")
							.withIndex("by_org_workspace_installation_destinationPath_destinationNode", (q) =>
								q
									.eq("organizationId", args.principal.organizationId)
									.eq("workspaceId", args.principal.workspaceId)
									.eq("installationId", authorized._yay.installation._id)
									.eq("destinationPath", args.principal.pathPrefix)
									.eq("destinationNodeId", restoredDestination._id),
							)
							.first()
					: null;
			if (!restoredDestination || !restoredTarget || (await db_target_destination_is_closed(ctx, restoredTarget))) {
				await db_close_destination(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					installationId: authorized._yay.installation._id,
					destinationPath: args.principal.pathPrefix,
					throughEpoch: stableTarget.destinationEpoch ?? 1,
					now,
				});
				return Result({ _yay: { archivedNodes: 0 } });
			}
			destination = restoredDestination;
		}

		// Follow parent ids, not paths. Active and archived trees can hold the same path.
		const descendants = await public_api_service_uploads_db_collect_bounded_descendants(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			parentId: destination._id,
			maxNodes: public_api_service_uploads_MAX_ARCHIVE_NODES - 1,
		});
		if (descendants === null) {
			return Result({
				_nay: {
					message: `A destination archives at most ${public_api_service_uploads_MAX_ARCHIVE_NODES} files and folders; move some out and try again`,
				},
			});
		}

		const activeDescendants = descendants.filter((descendant) => descendant.archiveOperationId === null);

		const writeContext: files_nodes_WriteContext = {
			writer: { kind: "service_account", serviceAccountId: authorized._yay.serviceAccountId },
			actorUserId: args.principal.actorUserId,
			resourceScope: { kind: "subtree", nodeId: destination._id },
			policyReach: "direct",
		};
		const policiesToClear: Array<Doc<"files_nodes">> = [];

		// Archived descendants also need to remain restorable after this archive.
		for (const node of [destination, ...descendants]) {
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					userId: args.principal.actorUserId,
					serviceAccountId: authorized._yay.serviceAccountId,
					fileNode: node,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			const writable = await files_nodes_db_require_writable(ctx, {
				organizationId: args.principal.organizationId,
				workspaceId: args.principal.workspaceId,
				writeContext,
				target: { kind: "node", node },
			});
			if (writable._nay) {
				return writable;
			}

			const target = await ctx.db
				.query("plugin_service_storage_targets")
				.withIndex("by_node", (q) => q.eq("nodeId", node._id))
				.first();
			// A completed delete keeps its archived node and target as history.
			if (node.archiveOperationId !== null && target?.state === "released" && target.deleteRequestedAt !== undefined) {
				continue;
			}
			if (
				target &&
				!(await db_validate_target_node(ctx, {
					target,
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					installation: authorized._yay.installation,
					actorUserId: args.principal.actorUserId,
					pathPrefix: args.principal.pathPrefix,
					destinationNodeId: destination._id,
					node,
				}))
			) {
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This upload target is no longer available" } });
			}

			if (node.writePolicy !== null) {
				if (!authorized._yay.installation.acceptedCapabilities.includes("workspace.files.create-read-only")) {
					return Result({ _nay: { message: "Permission denied" } });
				}

				const management = await files_nodes_db_require_write_policy_management(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					writeContext,
					target: { kind: "node", node },
					writePolicy: null,
				});
				if (management._nay) {
					return management;
				}
				policiesToClear.push(node);
			}
		}

		await db_close_destination(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: authorized._yay.installation._id,
			destinationPath: args.principal.pathPrefix,
			throughEpoch: stableTarget.destinationEpoch ?? 1,
			now,
		});

		// A service archive ends this destination's service lifecycle. Keep the files restorable for
		// members, but do not let their old targets consume the cap or reopen old service calls.
		for (const node of descendants) {
			if (node.kind !== "file") {
				continue;
			}
			const target = await ctx.db
				.query("plugin_service_storage_targets")
				.withIndex("by_node", (q) => q.eq("nodeId", node._id))
				.first();
			if (
				target &&
				target.state !== "released" &&
				target.organizationId === args.principal.organizationId &&
				target.workspaceId === args.principal.workspaceId &&
				target.installationId === authorized._yay.installation._id &&
				target.destinationPath === args.principal.pathPrefix &&
				target.movedOutAt === undefined
			) {
				await ctx.db.patch("plugin_service_storage_targets", target._id, {
					movedOutAt: now,
					updatedAt: now,
				});
			}
		}

		for (const node of policiesToClear) {
			const cleared = await files_nodes_db_set_write_policy(ctx, { node, writeContext, writePolicy: null });
			if (cleared._nay) {
				const message = "Service archive policy clear failed after validation";
				console.error(message, { nodeId: node._id, nay: cleared._nay });
				throw should_never_happen(message, { nodeId: node._id, nay: cleared._nay });
			}
		}

		await files_nodes_db_archive_nodes(ctx, {
			nodeIds: [destination._id, ...activeDescendants.map((descendant) => descendant._id)],
			updatedBy: args.principal.actorUserId,
			now,
		});

		return Result({ _yay: { archivedNodes: activeDescendants.length + 1 } });
	},
});

export type public_api_service_uploads_archive_destination_Result =
	typeof archive_destination extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// #endregion archive

// #region deletion

/**
 * One bounded workspace drain pass, called from `data_deletion.ts` after files and assets
 * are gone and before upload quotas are removed.
 *
 * An uninstall touches no files at all. The uploaded files belong to the workspace, not to the
 * plugin that put them there, so removing the plugin must leave every one of them alone — including
 * a placeholder whose upload never finished, which is just an empty file a member can delete.
 * This workspace drain deletes the attempt receipts, destinations, and targets in that order.
 */
export async function public_api_service_uploads_db_drain_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		batchSize: number;
	},
) {
	const attempts = await ctx.db
		.query("plugin_service_storage_attempts")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (attempts.length > 0) {
		await Promise.all(attempts.map((attempt) => ctx.db.delete("plugin_service_storage_attempts", attempt._id)));
		return { done: false, deletedCount: attempts.length };
	}

	const destinations = await ctx.db
		.query("plugin_service_storage_destinations")
		.withIndex("by_organization_workspace", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (destinations.length > 0) {
		await Promise.all(
			destinations.map((destination) => ctx.db.delete("plugin_service_storage_destinations", destination._id)),
		);
		return { done: false, deletedCount: destinations.length };
	}

	const targets = await ctx.db
		.query("plugin_service_storage_targets")
		.withIndex("by_organization_workspace_installation_targetKey", (q) =>
			q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId),
		)
		.take(args.batchSize);
	if (targets.length > 0) {
		await Promise.all(targets.map((target) => ctx.db.delete("plugin_service_storage_targets", target._id)));
		return { done: false, deletedCount: targets.length };
	}

	return { done: true, deletedCount: 0 };
}

// #endregion deletion
