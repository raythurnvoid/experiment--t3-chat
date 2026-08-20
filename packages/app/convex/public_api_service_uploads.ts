/**
 * The `/api/v1/files/service-uploads/*` storage behind the routes in
 * `public_api_service_uploads_http.ts`.
 *
 * A sealed processing-phase service grant uploads a closed meeting's files here: it creates one
 * upload target per file under the grant's destination prefix, and finalizes each target after the
 * R2 pipeline confirmed the object. When the meeting is deleted later, a fresh grant sealed to the
 * same destination archives that whole folder, because deleting a file in this product means
 * archiving it. The generic `/api/v1/files/*` routes stay closed to service grants on purpose; this
 * narrower door is the only file surface a service reaches.
 *
 * Accounting: creating a target charges its declared size to the workspace's
 * `plugin_service_storage_bytes` quota, and that counter only grows. Deleting a stored file gives
 * nothing back, exactly like `public_api_upload_bytes` on the normal upload path. A file whose real
 * object turns out bigger than declared is charged the difference when it settles.
 *
 * The quota is a budget, not a guard. A signed PUT does not bind the object's length, so a service
 * can always store more than it declared; the settle below charges it, it does not prevent it.
 */
import { v } from "convex/values";
import type { RegisteredMutation } from "convex/server";

import { internalMutation, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { access_control_db_can_act_on_file_node, access_control_db_has_permission } from "./access_control.ts";
import {
	files_node_require_writable,
	files_nodes_db_archive_nodes,
	files_nodes_db_can_act_on_swept_nodes,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_hard_delete_node,
	files_nodes_db_require_swept_nodes_writable,
} from "./files_nodes.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	r2_create_asset_key,
	r2_create_upload_staging_key,
	r2_enqueue_object_deletion_job,
	r2_generate_upload_url,
	r2_get_bucket,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_UNFINALIZED_ASSET_TTL_MS,
} from "./r2_client.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	files_MAX_UPLOADS_BYTES,
	files_ROOT_ID,
	files_db_get_visible_node_by_path,
	files_get_editable_text_content_type,
} from "../server/files.ts";
import { server_path_normalize } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_normalize_name, files_normalize_upload_file_name } from "../shared/files.ts";
import { path_extract_segments_from, path_name_of } from "../shared/paths.ts";
import { public_api_is_path_inside_prefix } from "./public_api_http_auth.ts";

// #region shared

/** Same window as `/api/v1/files/upload-urls` mints (FILES_UPLOAD_URL_TTL_MS in public_api.ts). */
const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Names for the refusals whose HTTP status is not the default 400, read by the route module the
 * same way `plugins_data_http.ts` reads `plugins_data_RefusalName`.
 */
export type public_api_service_uploads_RefusalName = "conflict" | "storage_full" | "outside_destination";

const REFUSAL_CONFLICT: public_api_service_uploads_RefusalName = "conflict";
const REFUSAL_STORAGE_FULL: public_api_service_uploads_RefusalName = "storage_full";
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
	/** The destination the grant was sealed to. Every target path must live under it. */
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

/** Same shape rules as plugin-data idempotency keys: bounded, trimmed, no control characters. */
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
	if (!membership) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", grant.organizationId),
		ctx.db.get("organizations_workspaces", grant.workspaceId),
	]);
	if (!organization?.defaultWorkspaceId || !workspace || workspace.organizationId !== organization._id) {
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

	return Result({ _yay: { installation } });
}

async function db_get_quota(ctx: MutationCtx, workspaceId: Id<"organizations_workspaces">) {
	return await ctx.db
		.query("quotas")
		.withIndex("by_workspace_quotaName", (q) =>
			q.eq("workspaceId", workspaceId).eq("quotaName", "plugin_service_storage_bytes"),
		)
		.first();
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

/**
 * Move an upload from "declared" to "stored". The R2 pipeline confirmed the object and patched the
 * asset's real size, so the target records what was really stored.
 */
async function db_settle_canonicalized_target(
	ctx: MutationCtx,
	args: {
		target: Doc<"plugin_service_storage_targets">;
		asset: Doc<"files_r2_assets">;
		now: number;
	},
) {
	const actualBytes = args.asset.size;
	// A signed PUT does not bind the object's length, so the real object can be bigger than the
	// declaration. Charge the difference now, over the ceiling if it must be — the object already
	// exists, so refusing here would only make the books lie. A smaller object gives nothing back:
	// this counter only grows.
	const residual = actualBytes - args.target.declaredBytes;
	if (residual > 0) {
		const quota = await db_get_quota(ctx, args.target.workspaceId);
		if (quota) {
			console.warn("Service upload stored more than it declared", {
				targetId: args.target._id,
				declaredBytes: args.target.declaredBytes,
				actualBytes,
				residual,
			});
			await ctx.db.patch("quotas", quota._id, {
				usedCount: quota.usedCount + residual,
				updatedAt: args.now,
			});
		}
	}

	await ctx.db.patch("plugin_service_storage_targets", args.target._id, {
		state: "committed",
		actualBytes,
		updatedAt: args.now,
	});

	return actualBytes;
}

/**
 * An upload that can never finish: the unfinalized-asset cleanup deleted its asset doc. Delete the
 * placeholder file so the service can retry under a new target key. The bytes it declared stay
 * charged, because this quota never gives anything back.
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
		const requestFingerprint = JSON.stringify({ path: args.path, contentType: args.contentType, size: args.size });
		const existingTarget = await db_get_target(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			idempotencyKey: idempotencyKey._yay,
			targetKey: targetKey._yay,
		});
		if (existingTarget) {
			if (existingTarget.requestFingerprint !== requestFingerprint) {
				return Result({
					_nay: { name: REFUSAL_CONFLICT, message: "This target key was already used for a different file" },
				});
			}
			if (existingTarget.state === "released") {
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This target was already released" } });
			}
			if (existingTarget.state === "committed") {
				return Result({
					_yay: {
						state: "committed" as const,
						path: existingTarget.path,
						nodeId: String(existingTarget.nodeId),
						actualBytes: existingTarget.actualBytes ?? existingTarget.declaredBytes,
					},
				});
			}

			// A pending replay behaves like a remint: the same staging key gets a fresh URL, nothing new
			// is created and nothing more is charged.
			const asset = await ctx.db.get("files_r2_assets", existingTarget.assetId);
			if (!asset) {
				await db_release_expired_target(ctx, { target: existingTarget, now });
				return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This target's upload expired" } });
			}
			if (asset.r2Key !== undefined) {
				const actualBytes = await db_settle_canonicalized_target(ctx, {
					target: existingTarget,
					asset,
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
			return await db_remint_pending_target(ctx, { target: existingTarget, asset, now });
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
					.eq("archiveOperationId", undefined),
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
		for (let index = 1; index < segments.length; index++) {
			const ancestorPath = `/${segments.slice(0, index).join("/")}`;
			const ancestor = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.principal.organizationId)
						.eq("workspaceId", args.principal.workspaceId)
						.eq("path", ancestorPath)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (!ancestor) {
				continue;
			}
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
			const ancestorWritable = files_node_require_writable(ancestor);
			if (ancestorWritable._nay) {
				return ancestorWritable;
			}
		}

		// Charge the declared bytes once the path and permissions passed, the same place and the same
		// way `/api/v1/files/upload-urls` charges `public_api_upload_bytes`. The counter is monotonic
		// on purpose: deleting the file later gives nothing back, so this is a coarse per-workspace
		// budget rather than storage accounting. Seeded lazily because existing workspaces have no doc
		// for this quota.
		// TODO: gate uploads by plan tier here once free and anonymous workspaces stop being allowed
		// to store plugin service files at all.
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
		if (quota.usedCount + args.size > quota.maxCount) {
			return Result({
				_nay: { name: REFUSAL_STORAGE_FULL, message: "This workspace has used its plugin service storage" },
			});
		}
		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount + args.size,
			updatedAt: now,
		});

		// A recognized text extension runs the same upload conversion as a member upload, so a
		// service-uploaded `.md` or `.txt` becomes a normal editable file. Everything else stays a
		// stored blob with `processingWorkId: null` up front. Plugin upload events stay off for
		// every service upload either way; `plugins_runtime_db_enqueue_upload_completed_runs`
		// refuses assets owned by a service storage target.
		const editableTextContentType = files_get_editable_text_content_type(name);
		const assetId = await ctx.db.insert("files_r2_assets", {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			kind: "upload",
			r2Bucket: r2_get_bucket(),
			size: args.size,
			...(editableTextContentType === null ? { processingWorkId: null } : {}),
			createdBy: args.principal.actorUserId,
			unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
			updatedAt: now,
		});

		// A recognized text extension stores the classifier's type; anything else keeps the client
		// value, same as the public upload path.
		const storedContentType = editableTextContentType ?? args.contentType;
		const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			userId: args.principal.actorUserId,
			parentId: files_ROOT_ID,
			path: args.path,
			kind: "file",
			contentType: storedContentType,
			assetId,
			// Name the plugin that uploaded the file, so a member reading the file later can see
			// which installation put it there.
			metadata: [
				{ key: "source", value: "plugin" },
				{ key: "original-name", value: name },
				{ key: "plugin-name", value: installation.pluginName },
			],
			now,
		});
		// The validation above cleared every failure this helper can hit. Throw so a surprise rolls
		// the whole call back instead of leaving charged quota bytes with no file.
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

		const uploadStagingR2Key = r2_create_upload_staging_key({
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			assetId,
		});
		const uploadUrlExpiresAt = now + UPLOAD_URL_TTL_MS;
		await ctx.db.patch("files_r2_assets", assetId, {
			uploadStagingR2Key,
			uploadUrlExpiresAt,
		});
		const signedUpload = await r2_generate_upload_url(uploadStagingR2Key);

		await ctx.db.insert("plugin_service_storage_targets", {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			installationId: installation._id,
			idempotencyKey: idempotencyKey._yay,
			targetKey: targetKey._yay,
			requestFingerprint,
			destinationPath: args.principal.pathPrefix,
			destinationNodeId: destination._id,
			path: args.path,
			contentType: storedContentType,
			declaredBytes: args.size,
			actualBytes: null,
			nodeId: nodeIdResult._yay,
			assetId,
			state: "pending",
			createdBy: args.principal.actorUserId,
			updatedAt: now,
		});

		return Result({
			_yay: {
				state: "pending" as const,
				path: args.path,
				nodeId: String(nodeIdResult._yay),
				uploadUrl: signedUpload.url,
				headers: { "Content-Type": storedContentType },
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
 * Reissue an upload URL for a pending target's existing staging key. Nothing new is created and
 * nothing more is charged; the URL window and the cleanup deadline move forward because the service
 * is visibly still working on this upload.
 */
async function db_remint_pending_target(
	ctx: MutationCtx,
	args: { target: Doc<"plugin_service_storage_targets">; asset: Doc<"files_r2_assets">; now: number },
) {
	const uploadStagingR2Key = args.asset.uploadStagingR2Key;
	if (uploadStagingR2Key === undefined) {
		// The create patched the staging key in the same transaction that inserted the target doc.
		throw should_never_happen("Pending service upload target without a staging key", {
			targetId: args.target._id,
		});
	}

	const uploadUrlExpiresAt = args.now + UPLOAD_URL_TTL_MS;
	await ctx.db.patch("files_r2_assets", args.asset._id, {
		uploadUrlExpiresAt,
		unfinalizedExpiresAt: args.now + r2_UNFINALIZED_ASSET_TTL_MS,
		updatedAt: args.now,
	});
	const signedUpload = await r2_generate_upload_url(uploadStagingR2Key);

	return Result({
		_yay: {
			state: "pending" as const,
			path: args.target.path,
			nodeId: String(args.target.nodeId),
			uploadUrl: signedUpload.url,
			headers: { "Content-Type": args.target.contentType },
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
		if (target.state === "released") {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This target was already released" } });
		}

		const now = Date.now();
		if (target.state === "committed") {
			return Result({
				_yay: {
					state: "committed" as const,
					path: target.path,
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
			const actualBytes = await db_settle_canonicalized_target(ctx, { target, asset, now });
			return Result({
				_yay: { state: "committed" as const, path: target.path, nodeId: String(target.nodeId), actualBytes },
			});
		}

		return await db_remint_pending_target(ctx, { target, asset, now });
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
		if (target.state === "committed") {
			return Result({
				_yay: {
					state: "committed" as const,
					path: target.path,
					nodeId: String(target.nodeId),
					actualBytes: target.actualBytes ?? target.declaredBytes,
				},
			});
		}
		if (target.state === "released") {
			return Result({
				_yay: { state: "released" as const, path: target.path, nodeId: String(target.nodeId), actualBytes: null },
			});
		}

		const now = Date.now();
		const asset = await ctx.db.get("files_r2_assets", target.assetId);
		// The cleanup gave up on this upload and deleted its asset doc, so the object can never be
		// confirmed. Release the target so the declared bytes go back to the envelope and the service
		// can retry under a new target key.
		if (!asset) {
			await db_release_expired_target(ctx, { target, now });
			return Result({
				_yay: { state: "released" as const, path: target.path, nodeId: String(target.nodeId), actualBytes: null },
			});
		}
		// Not canonicalized yet: the PUT or the R2 event is still in flight. The service polls again.
		if (asset.r2Key === undefined) {
			return Result({
				_yay: { state: "pending" as const, path: target.path, nodeId: String(target.nodeId), actualBytes: null },
			});
		}

		const actualBytes = await db_settle_canonicalized_target(ctx, { target, asset, now });
		return Result({
			_yay: { state: "committed" as const, path: target.path, nodeId: String(target.nodeId), actualBytes },
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
 * Delete the files a target key names, for a service that must really remove what its run stored.
 * The Council delete does not: it archives its whole destination folder through
 * `archive_destination` below, because archiving is what deleting a file means to a member. The
 * lookup goes by installation and target key, fenced to the presenting grant's sealed destination:
 * a grant sealed to another folder must not even learn that the key exists.
 *
 * Every match inside the fence is deleted. A second processing run can store another file under the
 * same target key on a different path, and a caller asking for that key wants both gone; refusing
 * the ambiguity instead would wedge the caller with no way out.
 *
 * An upload that never finished is cancelled here too: its placeholder file is empty, so there is
 * nothing to keep. This is also the only way to get rid of one, which is why the route deletes it
 * instead of refusing while it is still pending.
 *
 * Deleting never gives quota bytes back. The counter only grows, so the bytes this run charged stay
 * charged. `deleteRequestedAt` marks a committed target so the physical settlement in
 * `settle_object_deletion_job` keeps a released tombstone instead of consuming the doc, which is
 * what makes a replayed delete keep answering.
 */
export const delete_upload_target = internalMutation({
	args: {
		principal: service_upload_principal_validator,
		idempotencyKey: v.string(),
		targetKey: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			state: v.union(v.literal("deleting"), v.literal("deleted")),
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

		const candidates = await ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_organization_workspace_installation_targetKey", (q) =>
				q
					.eq("organizationId", args.principal.organizationId)
					.eq("workspaceId", args.principal.workspaceId)
					.eq("installationId", installation._id)
					.eq("targetKey", targetKey._yay),
			)
			.collect();
		const matches = candidates.filter((target) =>
			public_api_is_path_inside_prefix(target.path, args.principal.pathPrefix),
		);
		if (matches.length === 0) {
			return Result({ _nay: { message: "Not found" } });
		}
		// A lock is a member saying "leave this alone". Hard-delete stays the door this route is, but
		// it must refuse a locked file the same way archive does. Check every match before the first
		// write, so one locked file refuses the whole call instead of half-deleting the rest.
		for (const target of matches) {
			if (target.state === "released" || target.deleteRequestedAt !== undefined) {
				continue;
			}
			const node = await ctx.db.get("files_nodes", target.nodeId);
			if (!node) {
				continue;
			}
			const writable = files_node_require_writable(node);
			if (writable._nay) {
				return writable;
			}
		}

		const now = Date.now();
		for (const target of matches) {
			// A replay (deleteRequestedAt set) and a released tombstone are already handled; touching
			// their deletion jobs again would only advance job generations for nothing.
			if (target.state === "released" || target.deleteRequestedAt !== undefined) {
				continue;
			}

			// Enqueue the cleanup jobs before deleting the docs, so a crash between the two still leaves
			// every key a job. The canonical key is deterministic, so a missing asset doc cannot orphan
			// the object.
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
			});
			if (asset?.uploadStagingR2Key !== undefined && asset.uploadStagingR2Key !== liveR2Key) {
				await r2_enqueue_object_deletion_job(ctx, {
					organizationId: target.organizationId,
					workspaceId: target.workspaceId,
					r2Key: asset.uploadStagingR2Key,
					reason: "upload_staging",
					putMayArriveUntil:
						(asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt ?? now) + r2_PUT_MAY_ARRIVE_MARGIN_MS,
				});
			}

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

			// A committed file waits for R2 to confirm the canonical object is gone, and that settlement
			// turns this mark into a released tombstone. An upload that never finished has no confirmed
			// object to wait for, so it is released right here.
			await ctx.db.patch("plugin_service_storage_targets", target._id, {
				...(target.state === "committed" ? { deleteRequestedAt: now } : { state: "released" as const }),
				updatedAt: now,
			});
		}

		// Committed matches wait for their physical deletion to settle; cancelled and released ones are
		// done. The reply reads the pre-patch docs on purpose: a target deleted in this very call is
		// "deleting", not "deleted".
		const state = matches.some((target) => target.state === "committed") ? ("deleting" as const) : ("deleted" as const);
		return Result({
			_yay: { state, paths: matches.map((target) => target.path).sort() },
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
 * grant was sealed to.
 */
const MAX_ARCHIVE_NODES = 256;

/** Load at most `maxNodes` descendants. One extra read proves that the subtree is too large. */
async function db_collect_bounded_descendants(
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
 * operation id covers the folder and its whole subtree, which is what lets a member restore the
 * set later. The stored bytes stay charged, because the files still exist: only the confirmed
 * physical deletion of an object refunds them, and nothing here deletes an object.
 *
 * The seal is the fence. The door takes no path, so a grant can only ever archive its own
 * destination, and `workspace.files.write` plus that seal is what makes archiving inside it a write
 * the service may do. A member can still have put something of their own in the folder, so inside
 * the fence the door asks the same questions `archive_nodes` asks a member: a restricted subtree
 * the actor cannot write, or a read-only node, refuses the whole call. The delete workflow fails
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

		const stableTarget = await ctx.db
			.query("plugin_service_storage_targets")
			.withIndex("by_organization_workspace_installation_destinationPath", (q) =>
				q
					.eq("organizationId", args.principal.organizationId)
					.eq("workspaceId", args.principal.workspaceId)
					.eq("installationId", authorized._yay.installation._id)
					.eq("destinationPath", args.principal.pathPrefix),
			)
			.first();
		const legacyTarget = stableTarget
			? null
			: await ctx.db
					.query("plugin_service_storage_targets")
					.withIndex("by_organization_workspace_installation_path", (q) =>
						q
							.eq("organizationId", args.principal.organizationId)
							.eq("workspaceId", args.principal.workspaceId)
							.eq("installationId", authorized._yay.installation._id)
							.gte("path", `${args.principal.pathPrefix}/`)
							.lt("path", `${args.principal.pathPrefix}0`),
					)
					.first();
		const targetAtDestination = stableTarget ?? legacyTarget;
		if (stableTarget && !stableTarget.destinationNodeId) {
			return Result({
				_nay: { name: REFUSAL_CONFLICT, message: "This destination is missing its stable folder identity" },
			});
		}
		const destination = targetAtDestination?.destinationNodeId
			? await ctx.db.get("files_nodes", targetAtDestination.destinationNodeId)
			: await files_db_get_visible_node_by_path(ctx, {
					organizationId: args.principal.organizationId,
					workspaceId: args.principal.workspaceId,
					path: args.principal.pathPrefix,
				});
		if (!destination) {
			// A target proves this folder once existed. Refuse old, unbackfilled data instead of treating
			// a renamed folder as a successful delete.
			if (targetAtDestination) {
				return Result({
					_nay: { name: REFUSAL_CONFLICT, message: "This destination needs its stable folder identity backfilled" },
				});
			}
			return Result({ _yay: { archivedNodes: 0 } });
		}
		if (
			destination.organizationId !== args.principal.organizationId ||
			destination.workspaceId !== args.principal.workspaceId ||
			destination.kind !== "folder"
		) {
			return Result({ _nay: { name: REFUSAL_CONFLICT, message: "This destination is no longer a meeting folder" } });
		}
		if (destination.archiveOperationId !== undefined) {
			return Result({ _yay: { archivedNodes: 0 } });
		}

		// The grant carries workspace `content.write`, and a restricted folder subtracts from that: it
		// grants access only to whoever was named on the scope. So ask about the destination node
		// itself. The sweep below deliberately skips the destination's own scope, because this is the
		// check that is supposed to have answered for it.
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.principal.organizationId,
				workspaceId: args.principal.workspaceId,
				userId: args.principal.actorUserId,
				fileNode: destination,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Follow parent ids, not paths. Active and archived trees can hold the same path.
		const descendants = await db_collect_bounded_descendants(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			parentId: destination._id,
			maxNodes: MAX_ARCHIVE_NODES - 1,
		});
		if (descendants === null) {
			return Result({
				_nay: {
					message: `A destination archives at most ${MAX_ARCHIVE_NODES} files and folders; move some out and try again`,
				},
			});
		}
		const activeDescendants = descendants.filter((descendant) => descendant.archiveOperationId === undefined);

		// A member can nest a restricted folder in here, and the seal says nothing about that folder.
		// Ask what the member archive asks, so the actor cannot archive through the service what they
		// could not archive from the file tree.
		if (
			!(await files_nodes_db_can_act_on_swept_nodes(ctx, {
				organizationId: args.principal.organizationId,
				workspaceId: args.principal.workspaceId,
				userId: args.principal.actorUserId,
				rootScopeNodeId: destination.restrictedScopeNodeId,
				nodes: activeDescendants,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// A lock is a member saying "leave this alone", and archiving would move it out of the tree.
		for (const node of [destination, ...activeDescendants]) {
			const writable = files_node_require_writable(node);
			if (writable._nay) {
				return writable;
			}
		}

		// Archived children stay archived. But a read-only one must not end up hidden under a newly
		// archived parent, so it refuses here the same way it refuses a member.
		const archivedProtected = await files_nodes_db_require_swept_nodes_writable(ctx, {
			organizationId: args.principal.organizationId,
			workspaceId: args.principal.workspaceId,
			userId: args.principal.actorUserId,
			nodes: descendants.filter((descendant) => descendant.archiveOperationId !== undefined),
		});
		if (archivedProtected._nay) {
			return archivedProtected;
		}

		await files_nodes_db_archive_nodes(ctx, {
			nodeIds: [destination._id, ...activeDescendants.map((descendant) => descendant._id)],
			updatedBy: args.principal.actorUserId,
			now: Date.now(),
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
 * One bounded drain pass for an uninstall or a workspace teardown, called from
 * `plugins_data_db_drain_batch` beside the other plugin tables.
 *
 * An uninstall touches no files at all. The uploaded files belong to the workspace, not to the
 * plugin that put them there, so removing the plugin must leave every one of them alone — including
 * a placeholder whose upload never finished, which is just an empty file a member can delete.
 * Only a workspace-wide drain (null installation) deletes the target docs, because the workspace's
 * files and quota docs are being deleted with it.
 */
export async function public_api_service_uploads_db_drain_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations"> | null;
		batchSize: number;
	},
) {
	if (args.installationId === null) {
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
	}

	return { done: true, deletedCount: 0 };
}

// #endregion deletion
