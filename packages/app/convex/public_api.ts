import { v, type Infer } from "convex/values";
import {
	internalMutation,
	internalQuery,
	mutation,
	query,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { z } from "zod";
import { access_control_db_can_act_on_file_node, access_control_db_has_permission } from "./access_control.ts";
import {
	ACTIVITIES_TIMEOUT_MAX_MS,
	activities_db_add_target,
	activities_db_get_by_source_id,
	activities_db_start,
} from "./activities.ts";
import { billing_db_check_paid_plan, billing_db_emit_file_save, billing_pick_billed_user_id } from "./billing_db.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_random_hex, crypto_sha256_hex, crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_path_normalize,
	server_path_parent_of,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { path_extract_segments_from, path_name_of } from "../shared/paths.ts";
import { files_normalize_name, files_normalize_upload_file_name } from "../shared/files.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_UPLOADS_BYTES,
	files_ROOT_ID,
	files_get_editable_text_content_type,
	files_get_signed_download_serving,
	files_get_utf8_byte_size,
	files_node_has_editable_text_content,
	files_node_has_editable_yjs_state,
	files_normalize_text_document_input,
	files_u8_to_array_buffer,
	type files_ContentType,
} from "../server/files.ts";
import { files_yjs_compute_diff_update_from_state_vector } from "../shared/files-yjs.ts";
import { files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { encodeStateVector } from "yjs";
import {
	files_node_require_writable,
	files_nodes_db_archive_nodes,
	files_nodes_db_create_node_recursively_at_path,
	type files_nodes_get_by_path_Result,
	type files_nodes_read_file_content_from_chunks_Result,
	type get_file_content_materialization_state_Result,
} from "./files_nodes.ts";
import {
	files_nodes_create_yjs_snapshot_update_from_text,
	files_nodes_db_fill_text_node_content,
	files_nodes_db_finalize_editable_text_node_creation,
	files_nodes_db_insert_file_content_docs,
	files_nodes_reconstruct_latest_file_content_from_materialization_state,
} from "./files_nodes_content.ts";
import type { r2_get_data_for_public_download_url_Result } from "./r2.ts";
import {
	r2_create_asset_key,
	r2_create_upload_staging_key,
	r2_enqueue_object_deletion_job,
	r2_generate_upload_url,
	r2_get_bucket,
	r2_get_download_url,
	r2_put_object,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_UNFINALIZED_ASSET_TTL_MS,
} from "./r2_client.ts";
import {
	public_api_PLUGIN_RUN_TOKEN_REGEX,
	public_api_PLUGIN_SERVICE_TOKEN_REGEX,
	public_api_PLUGIN_UI_TOKEN_REGEX,
	type public_api_Scope,
} from "../shared/public-api.ts";
import {
	public_api_authorize_key_inspection,
	public_api_authorize_request,
	public_api_is_path_inside_prefix,
	public_api_resolve_live_principal,
	public_api_settle_plugin_call_best_effort,
	public_api_visibility_user_id,
} from "./public_api_http_auth.ts";
import {
	public_api_service_uploads_db_can_clean_up_service_created_lock,
	public_api_service_uploads_db_can_release_plugin_named_lock,
} from "./public_api_service_uploads.ts";

/**
 * Local structural mirror of `stage_trusted_yjs_update`'s Result. Keep it local instead of
 * importing the exported Result type: public_api sits deep in the generated-API type graph, and
 * pulling another registered function's inferred Result type across modules is the shape of
 * import that has produced whole-API inference collapses before.
 */
type stage_trusted_yjs_update_LocalResult =
	| { _yay: { stageId: Id<"files_yjs_trusted_update_stages"> }; _nay?: undefined }
	| { _yay?: undefined; _nay: { message: string } };

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). Do not keep request state in module-level values.
export const experimental_reuseContext = true;

const FILES_READ_MAX_BYTES = 128_000;
const FILES_READ_MANY_MAX_ITEMS = 50;
const FILES_READ_MANY_MAX_CONTENT_BYTES = 384_000;
const FILES_DOWNLOAD_URL_MAX_TTL_SECONDS = 15 * 60;
// The signer timestamps after our pre-sign check, so leave one full second inside plugin authority.
const FILES_DOWNLOAD_URL_SIGNING_MARGIN_SECONDS = 1;
// Must stay <= the public_api_principal bucket capacity: a batch charges one unit per URL.
const FILES_DOWNLOAD_URLS_MAX_ITEMS = 20;
// Keep unauthenticated validation work small while still allowing a truncated client batch.
const FILES_DOWNLOAD_URLS_MAX_REQUEST_ITEMS = 100;
const FILES_DOWNLOAD_URLS_MAX_REQUEST_BYTES = 32_000;
const FILES_TOUCH_MAX_PATHS = 8;
// Must stay <= the public_api_principal bucket capacity: a batch charges one unit per minted URL.
const FILES_UPLOAD_URLS_MAX_ITEMS = 20;

/**
 * Keep signed upload URLs valid for 15 minutes. Store the expiry so cleanup knows when the URL can
 * no longer upload another object.
 */
const FILES_UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
// Must stay <= the public_api_files_write_bulk bucket capacity: the batch charges one token per file.
const FILES_WRITE_MANY_MAX_ITEMS = 20;
// Whole-request byte cap: 20 files near the per-file content limit plus JSON overhead.
const FILES_WRITE_MANY_MAX_REQUEST_BYTES = 8_000_000;
const ACTIVITIES_TITLE_MAX_CHARS = 120;

const TEXT_ENCODER = new TextEncoder();
const CREDENTIAL_KEY_PREFIX = "pk_";
const CREDENTIAL_KEY_ID_BYTES = 16;
const CREDENTIAL_SECRET_BYTES = 32;
const API_CREDENTIAL_NAME_MAX_CHARS = 80;
// Keep the API key list bounded. The active API credential quota is stored in `quotas`.
const API_CREDENTIAL_LIST_MAX = 100;
const PUBLIC_API_GRANT_TTL_MS = 10 * 60 * 1000;
const PUBLIC_API_GRANT_CLEANUP_BATCH_SIZE = 100;
const PLUGIN_SERVICE_GRANT_TOKEN_PREFIX = "psg_";
const PLUGIN_SERVICE_GRANT_TOKEN_BYTES = 32;
// One working day. A service that needs longer renews, so a stolen token stops working on its own
// instead of living as long as the work does.
const PLUGIN_SERVICE_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
// Six days: the recovery window a sealed processing grant gets to finish uploading a meeting's
// files after the meeting closes. Renewal rotates the token but never extends this deadline.
const PLUGIN_SERVICE_PROCESSING_GRANT_TTL_MS = 6 * 24 * 60 * 60 * 1000;
// Stages only need to outlive one write action; anything older is a crashed write. Keep this far
// below the 24 h unfinalized-asset TTL: the orphan sweeper in r2.ts does not check stage
// references, so a stage must always die before its staged asset docs become sweepable.
const FILE_WRITE_STAGE_TTL_MS = 15 * 60 * 1000;
const FILE_WRITE_STAGE_CLEANUP_BATCH_SIZE = 25;

/** Stops buffering an unauthenticated request as soon as it crosses the route limit. */
async function read_request_text_bounded(request: Request, maxBytes: number) {
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		byteLength += value.byteLength;
		if (byteLength > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

const grant_scopes_validator = v.array(
	v.union(v.literal("files:list" satisfies public_api_Scope), v.literal("files:read" satisfies public_api_Scope)),
);
const user_credential_scopes_validator = v.array(
	v.union(
		v.literal("files:list" satisfies public_api_Scope),
		v.literal("files:read" satisfies public_api_Scope),
		v.literal("files:write" satisfies public_api_Scope),
		v.literal("files:download" satisfies public_api_Scope),
		v.literal("plugin_data:read" satisfies public_api_Scope),
		v.literal("plugin_data:write" satisfies public_api_Scope),
	),
);
const plugin_run_scopes_validator = v.array(
	v.union(
		v.literal("files:list" satisfies public_api_Scope),
		v.literal("files:read" satisfies public_api_Scope),
		v.literal("files:write" satisfies public_api_Scope),
		v.literal("files:download" satisfies public_api_Scope),
		v.literal("secrets:read" satisfies public_api_Scope),
		v.literal("outbound:fetch" satisfies public_api_Scope),
		v.literal("activities:write" satisfies public_api_Scope),
		v.literal("plugin_data:read" satisfies public_api_Scope),
		v.literal("plugin_data:write" satisfies public_api_Scope),
	),
);
// Read-only by design: UI sessions never get write, secrets, or outbound scopes. Plugin data
// writes never use this token: a frame calls the `user_*` mutations in plugins_data.ts, which
// write as the acting member and check both the `plugin.data.user-write` capability and the
// member's own workspace content.write permission. `backend:invoke` is not a write scope on the
// frame itself: it only lets the frame start a plugin run, and that run's own token is what the
// backend writes with.
const plugin_ui_scopes_validator = v.array(
	v.union(
		v.literal("files:list" satisfies public_api_Scope),
		v.literal("files:read" satisfies public_api_Scope),
		v.literal("files:download" satisfies public_api_Scope),
		v.literal("plugin_data:read" satisfies public_api_Scope),
		v.literal("backend:invoke" satisfies public_api_Scope),
	),
);
const plugin_service_scopes_validator = v.array(
	v.union(
		v.literal("plugin_data:read" satisfies public_api_Scope),
		v.literal("plugin_data:write" satisfies public_api_Scope),
		v.literal("files:write" satisfies public_api_Scope),
	),
);

async function create_credential_secret(ctx: MutationCtx) {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const keyId = `${CREDENTIAL_KEY_PREFIX}${crypto_random_hex(CREDENTIAL_KEY_ID_BYTES)}`;
		const existing = await ctx.db
			.query("api_credentials")
			.withIndex("by_keyId", (q) => q.eq("keyId", keyId))
			.first();
		if (!existing) {
			const secret = crypto_random_hex(CREDENTIAL_SECRET_BYTES);
			return {
				keyId,
				secret,
				credential: `${keyId}.${secret}`,
				obfuscatedValue: `${keyId}.****${secret.slice(-4)}`,
				secretHash: await crypto_sha256_hex(secret),
			};
		}
	}

	throw should_never_happen("Failed to create unique API credential keyId");
}

async function authorize_credential_management(
	ctx: QueryCtx | MutationCtx,
	args: {
		membershipId: Id<"organizations_workspaces_users">;
	},
) {
	const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
	if (!userAuth || userAuth.isAnonymous) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	const user = await ctx.db.get("users", userAuth.id);
	if (!user || user.deletedAt != null || !user.clerkUserId) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	const membership = await ctx.db.get("organizations_workspaces_users", args.membershipId);
	if (!membership || !membership.active || membership.userId !== user._id) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", membership.organizationId),
		ctx.db.get("organizations_workspaces", membership.workspaceId),
	]);
	if (
		!organization ||
		!workspace ||
		!organization.defaultWorkspaceId ||
		workspace.organizationId !== organization._id ||
		membership.organizationId !== organization._id ||
		membership.workspaceId !== workspace._id
	) {
		return Result({ _nay: { message: "Unauthorized" } });
	}

	// API keys belong to one user: each user manages their own keys through their own membership.
	// Nobody manages keys for the whole workspace, so no permission is checked here. `mint_page_session`
	// checks when the token is created; here we do not need that, because every route that accepts a
	// `user_api_key` passes a required scope. File scopes map to an app permission during request auth,
	// so a key can never do more than the user who owns it: a scope they cannot use simply answers 403.
	return Result({ _yay: { user, membership, organization, workspace } });
}

/**
 * Pass `fileNode` when the answer is about one file. Without it the question is about the workspace,
 * and a restricted file would be judged by the caller's role, which is exactly what a restriction
 * takes away.
 */
async function has_workspace_content_permission(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		permission: "content.read" | "content.write";
		fileNode?: Doc<"files_nodes">;
	},
) {
	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", args.organizationId),
		ctx.db.get("organizations_workspaces", args.workspaceId),
	]);
	if (
		!organization ||
		!workspace ||
		!organization.defaultWorkspaceId ||
		workspace.organizationId !== organization._id
	) {
		return false;
	}

	return await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: workspace._id,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resource: args.fileNode
			? {
					kind: "file",
					id: String(args.fileNode._id),
					restrictedScopeNodeId: args.fileNode.restrictedScopeNodeId ?? null,
				}
			: { kind: "workspace", id: String(workspace._id) },
		permission: args.permission,
		userId: args.userId,
	});
}

/**
 * Reads both content permissions at once. `resolve_principal` returns them instead of deciding the
 * route's app permission itself, so its answer depends only on the token and can be cached per token.
 * The required scope maps to one permission later, in `public_api_resolve_live_principal`. Because
 * this is a Convex query, taking a role away updates the cached answer right away.
 */
async function get_workspace_content_permissions(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	const [read, write] = await Promise.all([
		has_workspace_content_permission(ctx, { ...args, permission: "content.read" }),
		has_workspace_content_permission(ctx, { ...args, permission: "content.write" }),
	]);
	return { read, write };
}

// Public API grants

export const create_grant = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.union(v.id("ai_chat_threads"), v.null()),
		principalKey: v.string(),
		tokenHash: v.string(),
		scopes: grant_scopes_validator,
		pathPrefix: v.union(v.string(), v.null()),
		now: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!membership) {
			throw convex_error({ message: "Unauthorized" });
		}
		if (args.scopes.length === 0) {
			throw convex_error({ message: "At least one scope is required" });
		}

		const expired = await ctx.db
			.query("public_api_grants")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", args.now))
			.take(20);
		await Promise.all(expired.map((grant) => ctx.db.delete("public_api_grants", grant._id)));

		await ctx.db.insert("public_api_grants", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			threadId: args.threadId,
			principalKey: args.principalKey,
			tokenHash: args.tokenHash,
			scopes: Array.from(new Set(args.scopes)),
			pathPrefix: args.pathPrefix == null ? null : server_path_normalize(args.pathPrefix),
			createdAt: args.now,
			expiresAt: args.now + PUBLIC_API_GRANT_TTL_MS,
		});

		return null;
	},
});

export const cleanup_expired_grants = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => cleanup_expired_grants_batch(ctx, args),
});

// Plugin service grants

/**
 * Mint one `psg_` grant for a service that acts for an installation. Only the hash is stored, so the
 * raw token is returned once and cannot be read back.
 *
 * The caller says which scopes it wants, but the installation's accepted capabilities decide what it
 * gets. Nothing about the tenant, the plugin, or the version comes from the caller: those are read
 * from the live installation.
 *
 * Unlike `create_grant`, this does not delete expired rows on the way through. Expiry belongs to the
 * cron, so a service that never calls again still has its grant cleaned up.
 */
export const create_plugin_service_grant = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		actorUserId: v.id("users"),
		requestedScopes: plugin_service_scopes_validator,
		// The seal mint passes true: a processing grant must carry every scope it was promised, so a
		// capability removed between the caller's pre-check and this mutation refuses the mint instead
		// of silently writing a narrower grant.
		requireAllRequestedScopes: v.optional(v.boolean()),
		destinationPathPrefix: v.union(v.string(), v.null()),
		phase: v.union(v.literal("interactive"), v.literal("processing")),
		now: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			grantId: v.id("plugin_service_grants"),
			principalKey: v.string(),
			scopes: plugin_service_scopes_validator,
			expiresAt: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const [installation, workspace] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", args.installationId),
			ctx.db.get("organizations_workspaces", args.workspaceId),
		]);
		if (
			!installation ||
			!workspace ||
			workspace.organizationId !== args.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined ||
			installation.status !== "enabled" ||
			installation.organizationId !== args.organizationId ||
			installation.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.actorUserId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		// This is the capability the install-consent dialog warns about, and the only one that is about
		// the exchange itself rather than about a scope. Without it the workspace never agreed to let
		// this plugin hand its access to a server outside the app, so there is nothing to hand over.
		if (!installation.acceptedCapabilities.includes("plugin.service.connect")) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const requested = new Set(args.requestedScopes);
		const scopes: Infer<typeof plugin_service_scopes_validator> = [];
		if (requested.has("plugin_data:read") && installation.acceptedCapabilities.includes("plugin.data.read")) {
			scopes.push("plugin_data:read");
		}
		if (requested.has("plugin_data:write") && installation.acceptedCapabilities.includes("plugin.data.write")) {
			scopes.push("plugin_data:write");
		}
		// The workspace consented to file writes through the capability, and the prefix says where they
		// may land. Check the capability first: without it the scope is narrowed away like the two
		// above, and asking where it would have written makes no sense.
		const destinationPathPrefix =
			args.destinationPathPrefix == null ? null : server_path_normalize(args.destinationPathPrefix);
		if (requested.has("files:write") && installation.acceptedCapabilities.includes("workspace.files.write")) {
			if (destinationPathPrefix == null) {
				return Result({ _nay: { message: "A file-write grant requires a destination path prefix" } });
			}
			scopes.push("files:write");
		}
		if (scopes.length === 0) {
			return Result({ _nay: { message: "At least one scope is required" } });
		}
		if (args.requireAllRequestedScopes && scopes.length !== requested.size) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const token = `${PLUGIN_SERVICE_GRANT_TOKEN_PREFIX}${crypto_random_hex(PLUGIN_SERVICE_GRANT_TOKEN_BYTES)}`;
		const tokenHash = await crypto_sha256_hex(token);
		// 32 random bytes do not repeat in practice, so this refuses rather than retries. The reason to
		// check at all is that `resolve_principal` reads this index with `.unique()`: two docs with one
		// hash would make it throw on every call with that token instead of answering.
		const duplicate = await ctx.db
			.query("plugin_service_grants")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.first();
		if (duplicate) {
			return Result({ _nay: { message: "Failed to mint a unique grant token" } });
		}

		// One producer identity per installation. It survives token rotation and re-exchange, so the
		// versioned documents and reservations this service owns stay owned by it.
		const principalKey = `plugin_service:${args.organizationId}:${args.workspaceId}:${args.installationId}`;
		// A processing grant is the fixed recovery window after a meeting closes; an interactive grant
		// lives one working day and renews.
		const expiresAt =
			args.now + (args.phase === "processing" ? PLUGIN_SERVICE_PROCESSING_GRANT_TTL_MS : PLUGIN_SERVICE_GRANT_TTL_MS);
		const grantId = await ctx.db.insert("plugin_service_grants", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			pluginVersionId: installation.pluginVersionId,
			pluginName: installation.pluginName,
			actorUserId: args.actorUserId,
			tokenHash,
			scopes,
			principalKey,
			phase: args.phase,
			destinationPathPrefix,
			expiresAt,
			updatedAt: args.now,
		});

		return Result({
			_yay: {
				token,
				grantId,
				principalKey,
				scopes,
				expiresAt,
			},
		});
	},
});

/**
 * Give a live grant a new raw token and another day, keeping the same doc. A processing grant only
 * gets the new token: its deadline is the sealed recovery window and never moves.
 *
 * The caller presents the raw token it holds, never the grant id: the id is not a secret, so taking
 * one here would let anyone who ever saw an id extend that grant. Looking the doc up by the hash of
 * the presented token is what proves the caller still holds it.
 *
 * The stored scopes are left alone. `resolve_principal` narrows them against the installation's
 * current capabilities on every single call, so this doc never has to be the record of what the
 * grant may still do.
 *
 * Two renewals at once cannot both win: they patch the same doc, so Convex retries the loser, and by
 * then the old hash is gone and it is told its token no longer works. The service that lost re-runs
 * the exchange with a fresh `plu_` token.
 */
export const rotate_plugin_service_grant = internalMutation({
	args: {
		presented: v.string(),
		now: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			grantId: v.id("plugin_service_grants"),
			principalKey: v.string(),
			scopes: plugin_service_scopes_validator,
			expiresAt: v.number(),
		}),
	}),
	handler: async (ctx, args) => {
		const presentedHash = await crypto_sha256_hex(args.presented);
		const grant = await ctx.db
			.query("plugin_service_grants")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", presentedHash))
			.unique();
		if (!grant || grant.revokedAt != null || grant.expiresAt <= args.now) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		// The same liveness the mint asks for, because a renewal is a fresh 24 hours of access. A dead
		// installation or a departed actor would be caught again at every use, but refusing here means
		// the service learns now instead of holding a token that answers 401 on its next real call.
		const [installation, workspace] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", grant.installationId),
			ctx.db.get("organizations_workspaces", grant.workspaceId),
		]);
		if (
			!installation ||
			!workspace ||
			workspace.organizationId !== grant.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined ||
			installation.status !== "enabled" ||
			installation.pluginVersionId !== grant.pluginVersionId ||
			installation.organizationId !== grant.organizationId ||
			installation.workspaceId !== grant.workspaceId ||
			!installation.acceptedCapabilities.includes("plugin.service.connect")
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

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

		const token = `${PLUGIN_SERVICE_GRANT_TOKEN_PREFIX}${crypto_random_hex(PLUGIN_SERVICE_GRANT_TOKEN_BYTES)}`;
		const tokenHash = await crypto_sha256_hex(token);
		// Same reason as the mint: `resolve_principal` reads this index with `.unique()`, so two docs
		// sharing one hash would make every call with that token throw instead of answering.
		const duplicate = await ctx.db
			.query("plugin_service_grants")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.first();
		if (duplicate) {
			return Result({ _nay: { message: "Failed to mint a unique grant token" } });
		}

		// A processing grant's deadline is the recovery window sealed at mint. Rotation may refresh the
		// raw token, but extending the deadline would let a service roll the window forever.
		const expiresAt = grant.phase === "processing" ? grant.expiresAt : args.now + PLUGIN_SERVICE_GRANT_TTL_MS;
		await ctx.db.patch("plugin_service_grants", grant._id, {
			tokenHash,
			expiresAt,
			updatedAt: args.now,
		});

		return Result({
			_yay: {
				token,
				grantId: grant._id,
				principalKey: grant.principalKey,
				scopes: grant.scopes,
				expiresAt,
			},
		});
	},
});

export const cleanup_expired_grants_until_done = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const result = await cleanup_expired_grants_batch(ctx, args);
		if (!result.done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.public_api.cleanup_expired_grants_until_done, {
				...(args.batchSize === undefined ? {} : { batchSize: args.batchSize }),
				...(args._test_now === undefined ? {} : { _test_now: args._test_now }),
			});
		}
		return result;
	},
});

async function cleanup_expired_grants_batch(
	ctx: MutationCtx,
	args: {
		_test_now?: number;
		batchSize?: number;
	},
) {
	const now = args._test_now ?? Date.now();
	const batchSize = Math.min(Math.max(args.batchSize ?? PUBLIC_API_GRANT_CLEANUP_BATCH_SIZE, 1), 1000);
	const expired = await ctx.db
		.query("public_api_grants")
		.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
		.take(batchSize);

	await Promise.all(expired.map((grant) => ctx.db.delete("public_api_grants", grant._id)));

	return {
		deletedCount: expired.length,
		done: expired.length < batchSize,
	};
}

// API credential management

export const api_credential_create = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		name: v.string(),
		scopes: user_credential_scopes_validator,
	},
	returns: v_result({
		_yay: v.object({
			credentialId: v.id("api_credentials"),
			keyId: v.string(),
			credential: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const credentialManagement = await authorize_credential_management(ctx, { membershipId: args.membershipId });
		if (credentialManagement._nay) return credentialManagement;

		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "api_credentials_write",
			key: credentialManagement._yay.user._id,
		});
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const name = args.name.trim();
		if (name.length === 0) {
			return Result({ _nay: { message: "API key name is required" } });
		}
		if (name.length > API_CREDENTIAL_NAME_MAX_CHARS) {
			return Result({ _nay: { message: "API key name must be 80 characters or fewer" } });
		}

		const scopes = Array.from(new Set(args.scopes));
		if (scopes.length === 0) {
			return Result({ _nay: { message: "At least one scope is required" } });
		}

		const quota = await quotas_db_get(ctx, {
			quotaName: "active_api_credentials",
			userId: credentialManagement._yay.user._id,
			organizationId: credentialManagement._yay.organization._id,
			workspaceId: credentialManagement._yay.workspace._id,
		});
		if (quota.usedCount >= quota.maxCount) {
			return Result({
				_nay: { message: `You can have up to ${quota.maxCount} active API keys in this workspace` },
			});
		}

		const now = Date.now();
		const secret = await create_credential_secret(ctx);
		const credentialId = await ctx.db.insert("api_credentials", {
			organizationId: credentialManagement._yay.organization._id,
			workspaceId: credentialManagement._yay.workspace._id,
			userId: credentialManagement._yay.user._id,
			name,
			keyId: secret.keyId,
			obfuscatedValue: secret.obfuscatedValue,
			secretHash: secret.secretHash,
			scopes,
			createdAt: now,
			revokedAt: null,
			lastUsedAt: null,
		});
		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount + 1,
			updatedAt: now,
		});

		return Result({
			_yay: {
				credentialId,
				keyId: secret.keyId,
				credential: secret.credential,
			},
		});
	},
});

export const api_credentials_list = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v_result({
		_yay: v.array(
			v.object({
				credentialId: v.id("api_credentials"),
				name: v.string(),
				keyId: v.string(),
				obfuscatedValue: v.string(),
				scopes: user_credential_scopes_validator,
				createdAt: v.number(),
				revokedAt: v.union(v.number(), v.null()),
				lastUsedAt: v.union(v.number(), v.null()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const credentialManagement = await authorize_credential_management(ctx, { membershipId: args.membershipId });
		if (credentialManagement._nay) return credentialManagement;

		const activeCredentials = await ctx.db
			.query("api_credentials")
			.withIndex("by_organization_workspace_user_revokedAt", (q) =>
				q
					.eq("organizationId", credentialManagement._yay.organization._id)
					.eq("workspaceId", credentialManagement._yay.workspace._id)
					.eq("userId", credentialManagement._yay.user._id)
					.eq("revokedAt", null),
			)
			.order("desc")
			.take(API_CREDENTIAL_LIST_MAX);
		const revokedCredentials =
			activeCredentials.length < API_CREDENTIAL_LIST_MAX
				? await ctx.db
						.query("api_credentials")
						.withIndex("by_organization_workspace_user_revokedAt", (q) =>
							q
								.eq("organizationId", credentialManagement._yay.organization._id)
								.eq("workspaceId", credentialManagement._yay.workspace._id)
								.eq("userId", credentialManagement._yay.user._id),
						)
						.order("desc")
						.filter((q) => q.neq(q.field("revokedAt"), null))
						.take(API_CREDENTIAL_LIST_MAX - activeCredentials.length)
				: [];
		const credentials = [...activeCredentials, ...revokedCredentials];

		return Result({
			_yay: credentials.map((credential) => ({
				credentialId: credential._id,
				name: credential.name,
				keyId: credential.keyId,
				obfuscatedValue: credential.obfuscatedValue,
				scopes: credential.scopes,
				createdAt: credential.createdAt,
				revokedAt: credential.revokedAt,
				lastUsedAt: credential.lastUsedAt,
			})),
		});
	},
});

export const api_credential_revoke = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		credentialId: v.id("api_credentials"),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const credentialManagement = await authorize_credential_management(ctx, { membershipId: args.membershipId });
		if (credentialManagement._nay) return credentialManagement;

		const credential = await ctx.db.get("api_credentials", args.credentialId);
		if (
			!credential ||
			credential.organizationId !== credentialManagement._yay.organization._id ||
			credential.workspaceId !== credentialManagement._yay.workspace._id ||
			credential.userId !== credentialManagement._yay.user._id
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (credential.revokedAt == null) {
			const rateLimit = await rate_limiter_limit_by_key(ctx, {
				name: "api_credentials_write",
				key: credentialManagement._yay.user._id,
			});
			if (rateLimit) {
				return Result({ _nay: { message: rateLimit.message } });
			}

			const quota = await quotas_db_get(ctx, {
				quotaName: "active_api_credentials",
				userId: credentialManagement._yay.user._id,
				organizationId: credentialManagement._yay.organization._id,
				workspaceId: credentialManagement._yay.workspace._id,
			});
			const now = Date.now();
			await Promise.all([
				ctx.db.patch("api_credentials", credential._id, { revokedAt: now }),
				ctx.db.patch("quotas", quota._id, {
					usedCount: quota.usedCount - 1,
					updatedAt: now,
				}),
			]);
		}

		return Result({ _yay: null });
	},
});

export const api_credential_rotate = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		credentialId: v.id("api_credentials"),
	},
	returns: v_result({
		_yay: v.object({
			credentialId: v.id("api_credentials"),
			keyId: v.string(),
			credential: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const credentialManagement = await authorize_credential_management(ctx, { membershipId: args.membershipId });
		if (credentialManagement._nay) return credentialManagement;

		const credential = await ctx.db.get("api_credentials", args.credentialId);
		if (
			!credential ||
			credential.organizationId !== credentialManagement._yay.organization._id ||
			credential.workspaceId !== credentialManagement._yay.workspace._id ||
			credential.userId !== credentialManagement._yay.user._id
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (credential.revokedAt != null) {
			return Result({ _nay: { message: "Not found" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "api_credentials_write",
			key: credentialManagement._yay.user._id,
		});
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const now = Date.now();
		const secret = await create_credential_secret(ctx);
		await ctx.db.patch("api_credentials", credential._id, { revokedAt: now });
		const credentialId = await ctx.db.insert("api_credentials", {
			organizationId: credentialManagement._yay.organization._id,
			workspaceId: credentialManagement._yay.workspace._id,
			userId: credentialManagement._yay.user._id,
			name: credential.name,
			keyId: secret.keyId,
			obfuscatedValue: secret.obfuscatedValue,
			secretHash: secret.secretHash,
			scopes: credential.scopes,
			createdAt: now,
			revokedAt: null,
			lastUsedAt: null,
		});

		return Result({
			_yay: {
				credentialId,
				keyId: secret.keyId,
				credential: secret.credential,
			},
		});
	},
});

// Principal resolution

/**
 * Facts only, keyed on the presented token alone so Convex can cache the result: identity,
 * tenancy, scopes, expiry timestamps, and content permissions. The two verdicts that depend on the
 * caller's clock and route — token expiry and the app permission mapped from its scope — are applied by
 * public_api_resolve_live_principal; never call this directly from a route. Liveness checks
 * (revocation, disable, uninstall, membership loss) are writes, so they invalidate the cache.
 */
export const resolve_principal = internalQuery({
	args: {
		presented: v.string(),
	},
	returns: v_result({
		_yay: v.union(
			v.object({
				kind: v.literal("public_api_grant"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				userId: v.id("users"),
				expiresAt: v.number(),
				contentPermissions: v.object({ read: v.boolean(), write: v.boolean() }),
				scopes: grant_scopes_validator,
				principalKey: v.string(),
				credentialId: v.null(),
				pathPrefix: v.union(v.string(), v.null()),
			}),
			v.object({
				kind: v.literal("user_api_key"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				userId: v.id("users"),
				contentPermissions: v.object({ read: v.boolean(), write: v.boolean() }),
				scopes: user_credential_scopes_validator,
				principalKey: v.string(),
				credentialId: v.id("api_credentials"),
				pathPrefix: v.null(),
			}),
			v.object({
				kind: v.literal("plugin_run"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				runId: v.id("plugins_event_runs"),
				installationId: v.id("plugins_workspace_installations"),
				pluginVersionId: v.id("plugins_versions"),
				/**
				 * The person whose upload started this run, or, on an invoke run, the invoking member,
				 * host-verified from the `plu_` session that called the invoke route. Used for file
				 * authorship, and as the eyes the run reads and writes files with: a run has no user of
				 * its own, so without that it would be a way around a restricted folder. See
				 * `public_api_visibility_user_id`.
				 */
				actorUserId: v.id("users"),
				/** The file the event fired for. All three are null for an event that fires on no file, including every invoke run. */
				sourceFileNodeId: v.union(v.id("files_nodes"), v.null()),
				sourceAssetId: v.union(v.id("files_r2_assets"), v.null()),
				/** Current path of the source node's parent; plugin writes must land exactly here. */
				outputParentPath: v.union(v.string(), v.null()),
				apiTokenExpiresAt: v.number(),
				scopes: plugin_run_scopes_validator,
				principalKey: v.string(),
				/**
				 * Always null: a plugin run has no destination seal. The read routes call
				 * `public_api_is_path_inside_prefix(path, principal.pathPrefix)`, which treats null as
				 * "anywhere" — right here, because the run's real boundary is its actor's eyes.
				 */
				pathPrefix: v.null(),
			}),
			v.object({
				kind: v.literal("plugin_ui"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				userId: v.id("users"),
				installationId: v.id("plugins_workspace_installations"),
				pluginVersionId: v.id("plugins_versions"),
				sessionId: v.id("plugins_ui_sessions"),
				sessionExpiresAt: v.number(),
				contentPermissions: v.object({ read: v.boolean(), write: v.boolean() }),
				scopes: plugin_ui_scopes_validator,
				principalKey: v.string(),
				credentialId: v.null(),
				pathPrefix: v.null(),
			}),
			v.object({
				kind: v.literal("plugin_service"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				grantId: v.id("plugin_service_grants"),
				installationId: v.id("plugins_workspace_installations"),
				pluginVersionId: v.id("plugins_versions"),
				/**
				 * The member whose plugin frame asked for this grant. The service has no user of its own,
				 * so this is the authorship it writes with and the eyes it reads with, the same way a
				 * plugin run uses the person whose upload started it.
				 */
				actorUserId: v.id("users"),
				/**
				 * Which phase the grant is in. `seal-processing` refuses a grant that is already
				 * `processing`, `verify-live` refuses a phase the service did not expect, and only a
				 * `processing` grant may upload files. Permissions are not one of those differences:
				 * both phases resolve with the actor's live membership and permissions below.
				 */
				phase: v.union(v.literal("interactive"), v.literal("processing")),
				expiresAt: v.number(),
				contentPermissions: v.object({ read: v.boolean(), write: v.boolean() }),
				scopes: plugin_service_scopes_validator,
				principalKey: v.string(),
				credentialId: v.null(),
				pathPrefix: v.union(v.string(), v.null()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		if (public_api_PLUGIN_RUN_TOKEN_REGEX.test(args.presented)) {
			const apiTokenHash = await crypto_sha256_hex(args.presented);
			const pluginRun = await ctx.db
				.query("plugins_event_runs")
				.withIndex("by_apiTokenHash", (q) => q.eq("apiTokenHash", apiTokenHash))
				.unique();
			if (!pluginRun || pluginRun.status !== "running" || !pluginRun.apiTokenExpiresAt) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			// A run's authority dies with its installation. Uninstalling deletes the installation doc,
			// upgrading writes a different pluginVersionId, and workspace purge disables the installation.
			// Keep all three checks in this live-token door.
			const [installation, workspace] = await Promise.all([
				ctx.db.get("plugins_workspace_installations", pluginRun.installationId),
				ctx.db.get("organizations_workspaces", pluginRun.workspaceId),
			]);
			if (
				!installation ||
				!workspace ||
				workspace.organizationId !== pluginRun.organizationId ||
				workspace.pluginDataPurgeStartedAt !== undefined ||
				installation.status !== "enabled" ||
				installation.pluginVersionId !== pluginRun.pluginVersionId ||
				installation.organizationId !== pluginRun.organizationId ||
				installation.workspaceId !== pluginRun.workspaceId
			) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			// Archived counts as missing: a run's authority dies with its triggering upload, and a
			// write authorized past this point would resurrect the archived parent folder as a new
			// active node (the download path already fails closed on archived sources in r2.ts).
			// A run that fired on no file has no source to lose, so it skips this check instead of
			// failing it.
			const sourceFileNode = pluginRun.fileNodeId ? await ctx.db.get("files_nodes", pluginRun.fileNodeId) : null;
			if (
				pluginRun.fileNodeId &&
				(!sourceFileNode ||
					sourceFileNode.archiveOperationId !== undefined ||
					sourceFileNode.organizationId !== pluginRun.organizationId ||
					sourceFileNode.workspaceId !== pluginRun.workspaceId)
			) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}
			const outputParentPath = sourceFileNode
				? sourceFileNode.parentId === files_ROOT_ID
					? "/"
					: server_path_parent_of(sourceFileNode.path)
				: null;

			// Platform baseline: download the exact triggering asset, write Markdown siblings, and
			// opt into the workspace activity feed (self-disclosure, so no extra consent).
			// A run that fired on no file gets neither file door: it has nothing to download, and no
			// place a sibling write could land.
			const scopes: Infer<typeof plugin_run_scopes_validator> = sourceFileNode
				? ["files:download", "files:write", "activities:write"]
				: ["activities:write"];
			if (pluginRun.acceptedCapabilities.includes("plugin.secrets.read")) {
				scopes.push("secrets:read");
			}
			if (pluginRun.acceptedCapabilities.includes("outbound.fetch")) {
				scopes.push("outbound:fetch");
			}
			// Plugin-data access is never part of the baseline. An installation that predates the store
			// consented to a plugin that could persist nothing, and it keeps that deal until an upgrade
			// makes the workspace accept the new capability.
			if (pluginRun.acceptedCapabilities.includes("plugin.data.read")) {
				scopes.push("plugin_data:read");
			}
			if (pluginRun.acceptedCapabilities.includes("plugin.data.write")) {
				scopes.push("plugin_data:write");
			}
			// Any run may read files under the same consent a frame reads with. The backend runs the
			// same publisher code either way, the run reads with its actor's eyes, and without this an
			// invoke endpoint could not read the files it maintains. `files:download` stays source-only.
			if (pluginRun.acceptedCapabilities.includes("workspace.files.read")) {
				scopes.push("files:read", "files:list");
			}
			// An invoke run has no source, so the sibling-write baseline above gave it no `files:write`.
			// Own-write is its one write consent, bounded to the plugin's stamped folders by the write
			// doors.
			if (
				pluginRun.event === "ui.invoke.requested" &&
				pluginRun.acceptedCapabilities.includes("workspace.files.own-write") &&
				!scopes.includes("files:write")
			) {
				scopes.push("files:write");
			}

			return Result({
				_yay: {
					kind: "plugin_run" as const,
					organizationId: pluginRun.organizationId,
					workspaceId: pluginRun.workspaceId,
					runId: pluginRun._id,
					installationId: pluginRun.installationId,
					pluginVersionId: pluginRun.pluginVersionId,
					actorUserId: pluginRun.actorUserId,
					// An invoke run stores no source fields at all, and the validator wants explicit null.
					sourceFileNodeId: pluginRun.fileNodeId ?? null,
					sourceAssetId: pluginRun.assetId ?? null,
					outputParentPath,
					apiTokenExpiresAt: pluginRun.apiTokenExpiresAt,
					scopes,
					principalKey: `plugin_run:${pluginRun._id}`,
					pathPrefix: null,
				},
			});
		}

		if (public_api_PLUGIN_UI_TOKEN_REGEX.test(args.presented)) {
			// A page and a file view both get their `plu_` token from the same table, and nothing on this
			// path can tell the two apart: the lookup below is by token hash alone, and the principal this
			// branch returns carries no frame kind at all. So read every rule here as a rule for both. The
			// file-view row keeps one extra field, `fileNodeId`, and the token-refresh route in
			// `plugins_ui.ts` is the only place in the backend that reads it.
			const tokenHash = await crypto_sha256_hex(args.presented);
			const session = await ctx.db
				.query("plugins_ui_sessions")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
				.unique();
			if (!session) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			// A UI session is only valid while its installation stays as it was. Uninstalling deletes the
			// installation doc, upgrading writes a different pluginVersionId, and workspace purge disables
			// the installation. Keep all three checks in this live-token door.
			const [installation, workspace] = await Promise.all([
				ctx.db.get("plugins_workspace_installations", session.installationId),
				ctx.db.get("organizations_workspaces", session.workspaceId),
			]);
			if (
				!installation ||
				!workspace ||
				workspace.organizationId !== session.organizationId ||
				workspace.pluginDataPurgeStartedAt !== undefined ||
				installation.status !== "enabled" ||
				installation.pluginVersionId !== session.pluginVersionId ||
				installation.organizationId !== session.organizationId ||
				installation.workspaceId !== session.workspaceId
			) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			// The frame acts on behalf of the minting user: it can never read what that user cannot.
			const user = await ctx.db.get("users", session.userId);
			if (!user || user.deletedAt != null) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", session.userId)
						.eq("organizationId", session.organizationId)
						.eq("workspaceId", session.workspaceId),
				)
				.first();
			if (!membership) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}
			const contentPermissions = await get_workspace_content_permissions(ctx, {
				organizationId: session.organizationId,
				workspaceId: session.workspaceId,
				userId: session.userId,
			});

			// Workspace file reads are consent-gated; UI sessions never get secrets or outbound scopes.
			const scopes: Infer<typeof plugin_ui_scopes_validator> = installation.acceptedCapabilities.includes(
				"workspace.files.read",
			)
				? ["files:list", "files:read", "files:download"]
				: [];
			// A frame may show what its plugin stored, but never write it. A UI session can belong to an
			// anonymous identity, and a frame is the surface an XSS reaches first, so a stored write from
			// here would become injected input that the plugin's backend later acts on with its secrets.
			if (installation.acceptedCapabilities.includes("plugin.data.read")) {
				scopes.push("plugin_data:read");
			}
			// The invoke route also maps this scope to content.write, so a workspace viewer's frame
			// carries the scope and is still refused there.
			if (installation.acceptedCapabilities.includes("plugin.backend.invoke")) {
				scopes.push("backend:invoke");
			}

			return Result({
				_yay: {
					kind: "plugin_ui" as const,
					organizationId: session.organizationId,
					workspaceId: session.workspaceId,
					userId: session.userId,
					installationId: session.installationId,
					pluginVersionId: session.pluginVersionId,
					sessionId: session._id,
					sessionExpiresAt: session.expiresAt,
					contentPermissions,
					scopes,
					// Keep one rate-limit identity across token rotation and fresh iframe sessions.
					principalKey: `plugin_ui:${session.organizationId}:${session.workspaceId}:${session.userId}:${session.installationId}`,
					credentialId: null,
					pathPrefix: null,
				},
			});
		}

		if (public_api_PLUGIN_SERVICE_TOKEN_REGEX.test(args.presented)) {
			const tokenHash = await crypto_sha256_hex(args.presented);
			const grant = await ctx.db
				.query("plugin_service_grants")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
				.unique();
			if (!grant || grant.revokedAt != null) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			// The grant belongs to the installation, so it dies with it. Uninstalling deletes the
			// installation doc, and upgrading to another version writes a different pluginVersionId. The
			// check below sees either change and refuses the grant on its next call.
			//
			// Workspace purge writes `disabled` before it drains grants and installations, so reject that
			// state here even while the grant doc still exists.
			//
			// The connect capability is rechecked for the same reason the scopes are below: taking it
			// away on upgrade must stop the outside server now, not when the grant expires.
			const [installation, workspace] = await Promise.all([
				ctx.db.get("plugins_workspace_installations", grant.installationId),
				ctx.db.get("organizations_workspaces", grant.workspaceId),
			]);
			if (
				!installation ||
				!workspace ||
				workspace.organizationId !== grant.organizationId ||
				workspace.pluginDataPurgeStartedAt !== undefined ||
				installation.status !== "enabled" ||
				installation.pluginVersionId !== grant.pluginVersionId ||
				installation.organizationId !== grant.organizationId ||
				installation.workspaceId !== grant.workspaceId ||
				!installation.acceptedCapabilities.includes("plugin.service.connect")
			) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

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
			// A grant acts for its actor, so the actor has to still be a member. Both phases need that,
			// including `processing`. Being sealed to one destination path prefix bounds where a grant
			// writes, not whether its member may still write, so it earns no exemption here.
			if (!membership) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}
			const contentPermissions = await get_workspace_content_permissions(ctx, {
				organizationId: grant.organizationId,
				workspaceId: grant.workspaceId,
				userId: grant.actorUserId,
			});

			// The grant is issued with the scopes the exchange asked for, but the installation's accepted
			// capabilities are still the ceiling. An upgrade never reaches this point. It replaces
			// `pluginVersionId`, and the version check above refuses the grant, so an upgrade revokes it
			// instead of narrowing it. Install acceptance is all-or-nothing today, and the only two writers
			// of `acceptedCapabilities` set it from the version they are installing, so a version change is
			// the only way a capability can disappear. Keep the rechecks below as defence in depth: they
			// are cheap, and they still hold the ceiling if someone later writes `acceptedCapabilities`
			// without moving the version.
			const scopes: Infer<typeof plugin_service_scopes_validator> = [];
			if (grant.scopes.includes("plugin_data:read") && installation.acceptedCapabilities.includes("plugin.data.read")) {
				scopes.push("plugin_data:read");
			}
			if (
				grant.scopes.includes("plugin_data:write") &&
				installation.acceptedCapabilities.includes("plugin.data.write")
			) {
				scopes.push("plugin_data:write");
			}
			// A file write must land somewhere the grant was told to write. A grant without a destination
			// prefix loses the scope, so the "no prefix means anywhere" reading of `pathPrefix` below can
			// never be reached from here. The capability recheck is the same defence in depth as above.
			if (
				grant.scopes.includes("files:write") &&
				installation.acceptedCapabilities.includes("workspace.files.write") &&
				grant.destinationPathPrefix != null
			) {
				scopes.push("files:write");
			}

			return Result({
				_yay: {
					kind: "plugin_service" as const,
					organizationId: grant.organizationId,
					workspaceId: grant.workspaceId,
					grantId: grant._id,
					installationId: grant.installationId,
					pluginVersionId: grant.pluginVersionId,
					actorUserId: grant.actorUserId,
					phase: grant.phase,
					expiresAt: grant.expiresAt,
					contentPermissions,
					scopes,
					principalKey: grant.principalKey,
					credentialId: null,
					pathPrefix: grant.destinationPathPrefix,
				},
			});
		}

		if (args.presented.startsWith(CREDENTIAL_KEY_PREFIX)) {
			const separatorIndex = args.presented.indexOf(".");
			if (separatorIndex <= 0 || separatorIndex === args.presented.length - 1) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			const keyId = args.presented.slice(0, separatorIndex);
			const secret = args.presented.slice(separatorIndex + 1);
			const credentials = await ctx.db
				.query("api_credentials")
				.withIndex("by_keyId", (q) => q.eq("keyId", keyId))
				.take(2);
			if (credentials.length !== 1) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			const credential = credentials[0];
			if (credential.revokedAt != null) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			const secretHash = await crypto_sha256_hex(secret);
			if (!crypto_timing_safe_equal(secretHash, credential.secretHash)) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			const user = await ctx.db.get("users", credential.userId);
			if (!user || user.deletedAt != null) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", credential.userId)
						.eq("organizationId", credential.organizationId)
						.eq("workspaceId", credential.workspaceId),
				)
				.first();
			if (!membership) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}
			const contentPermissions = await get_workspace_content_permissions(ctx, {
				organizationId: credential.organizationId,
				workspaceId: credential.workspaceId,
				userId: credential.userId,
			});

			return Result({
				_yay: {
					kind: "user_api_key" as const,
					organizationId: credential.organizationId,
					workspaceId: credential.workspaceId,
					userId: credential.userId,
					contentPermissions,
					scopes: credential.scopes,
					principalKey: credential.keyId,
					credentialId: credential._id,
					pathPrefix: null,
				},
			});
		}

		const tokenHash = await crypto_sha256_hex(args.presented);
		const grant = await ctx.db
			.query("public_api_grants")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
			.first();
		if (!grant) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", grant.userId)
					.eq("organizationId", grant.organizationId)
					.eq("workspaceId", grant.workspaceId),
			)
			.first();
		if (!membership) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const contentPermissions = await get_workspace_content_permissions(ctx, {
			organizationId: grant.organizationId,
			workspaceId: grant.workspaceId,
			userId: grant.userId,
		});

		return Result({
			_yay: {
				kind: "public_api_grant" as const,
				organizationId: grant.organizationId,
				workspaceId: grant.workspaceId,
				userId: grant.userId,
				expiresAt: grant.expiresAt,
				contentPermissions,
				scopes: grant.scopes,
				principalKey: grant.principalKey,
				credentialId: null,
				pathPrefix: grant.pathPrefix,
			},
		});
	},
});

export type public_api_resolve_principal_Result =
	typeof resolve_principal extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

// The service exchange routes in `plugins_service.ts` call these two through the generated `internal`
// object, which erases the return type. Each alias gives that call its type back.

export type public_api_create_plugin_service_grant_Result =
	typeof create_plugin_service_grant extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export type public_api_rotate_plugin_service_grant_Result =
	typeof rotate_plugin_service_grant extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type Principal = NonNullable<public_api_resolve_principal_Result["_yay"]>;

function has_same_download_authority(
	initial: Extract<Principal, { kind: "user_api_key" | "plugin_run" | "plugin_ui" }>,
	current: Principal,
) {
	const currentScopes: readonly public_api_Scope[] = current.scopes;
	if (
		initial.organizationId !== current.organizationId ||
		initial.workspaceId !== current.workspaceId ||
		!currentScopes.includes("files:download")
	) {
		return false;
	}

	switch (initial.kind) {
		case "user_api_key":
			return (
				current.kind === "user_api_key" &&
				current.credentialId === initial.credentialId &&
				current.userId === initial.userId
			);
		case "plugin_run":
			return (
				current.kind === "plugin_run" &&
				current.runId === initial.runId &&
				current.installationId === initial.installationId &&
				current.pluginVersionId === initial.pluginVersionId
			);
		case "plugin_ui":
			return (
				current.kind === "plugin_ui" &&
				current.sessionId === initial.sessionId &&
				current.userId === initial.userId &&
				current.installationId === initial.installationId &&
				current.pluginVersionId === initial.pluginVersionId
			);
	}
}

// Route authorization

export const mark_credential_used = internalMutation({
	args: {
		credentialId: v.id("api_credentials"),
		now: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const credential = await ctx.db.get("api_credentials", args.credentialId);
		if (credential) {
			await ctx.db.patch("api_credentials", credential._id, { lastUsedAt: args.now });
		}

		return null;
	},
});

// Staged file writes

const file_write_principal_ref_validator = v.union(
	v.object({
		kind: v.literal("user_api_key"),
		credentialId: v.id("api_credentials"),
	}),
	v.object({
		kind: v.literal("plugin_run"),
		runId: v.id("plugins_event_runs"),
		callId: v.id("plugins_event_run_calls"),
	}),
	v.object({
		kind: v.literal("plugin_service"),
		grantId: v.id("plugin_service_grants"),
	}),
);

/**
 * The live-run checks every plugin-run write door repeats inside its own transaction: the run is
 * still running with a live token in this tenant, and its installation is still enabled on the
 * same version in an unfenced workspace. `plugin-folders/ensure` calls this directly, because it
 * is the one run door whose target may not exist yet.
 */
export async function public_api_db_revalidate_live_plugin_run(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		runId: Id<"plugins_event_runs">;
		now: number;
	},
) {
	const pluginRun = await ctx.db.get("plugins_event_runs", args.runId);
	if (
		!pluginRun ||
		pluginRun.status !== "running" ||
		!pluginRun.apiTokenExpiresAt ||
		pluginRun.apiTokenExpiresAt <= args.now ||
		pluginRun.organizationId !== args.organizationId ||
		pluginRun.workspaceId !== args.workspaceId
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	const [installation, workspace] = await Promise.all([
		ctx.db.get("plugins_workspace_installations", pluginRun.installationId),
		ctx.db.get("organizations_workspaces", pluginRun.workspaceId),
	]);
	if (
		!installation ||
		!workspace ||
		workspace.organizationId !== pluginRun.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		installation.status !== "enabled" ||
		installation.pluginVersionId !== pluginRun.pluginVersionId
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	return Result({ _yay: { pluginRun, installation } });
}

/**
 * Shared revalidation for the prepare and publish mutations: the same live-principal and
 * plugin-constraint checks must hold in the transaction that creates the stage AND in the
 * transaction that publishes it, because the credential or run can die between the two.
 * Exported for the plugin file doors (`public_api_plugin_files.ts`), which need the same
 * transactional authority answer for their target paths.
 */
export async function public_api_db_revalidate_file_write_principal(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		principalRef: Infer<typeof file_write_principal_ref_validator>;
		path: string;
		now: number;
	},
) {
	if (args.principalRef.kind === "plugin_run") {
		const liveRun = await public_api_db_revalidate_live_plugin_run(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			runId: args.principalRef.runId,
			now: args.now,
		});
		if (liveRun._nay) {
			return liveRun;
		}
		const { pluginRun, installation } = liveRun._yay;

		// An invoke run has no source upload, so its write authority is the plugin's own stamped
		// area instead of the sibling rule. Branch on the event: upload runs keep the sibling rule
		// below exactly as it is.
		if (pluginRun.event === "ui.invoke.requested") {
			// Own-write is the consent for writing inside the plugin's stamped folders. The
			// resolver already gated the `files:write` scope on it; ask again here because the
			// consent can be taken back while a write is staged.
			if (!installation.acceptedCapabilities.includes("workspace.files.own-write")) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// The stamp rule: the active node at the target path, or the deepest existing
			// ancestor, must carry this plugin's stamp. Nothing existing at all means the plugin
			// never created its root through `plugin-folders/ensure`, so the write is refused.
			const ownedNode =
				(await db_get_active_node_at_path(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					path: args.path,
				})) ??
				(await db_get_deepest_existing_ancestor(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					path: args.path,
				}));
			if (!ownedNode || ownedNode.pluginOwnerName !== installation.pluginName) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// The run writes as the member who invoked it, so that member must still be one, and
			// must still be allowed to write where the output lands.
			const invokeActorMembership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", args.userId)
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId),
				)
				.first();
			if (!invokeActorMembership) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			if (
				!(await has_workspace_content_permission(ctx, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					permission: "content.write",
					fileNode: ownedNode,
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			return Result({ _yay: { pluginRun, installation, serviceGrant: null } });
		}

		// The sibling-write constraint is checked against the source node's CURRENT parent in this
		// transaction, so a concurrent source move cannot smuggle plugin output somewhere else.
		// Archived counts as missing: publishing beside an archived source would recreate the
		// user-deleted parent folder as a new active node. A run that fired on no file has no source
		// to write beside, so it falls into the refusal below.
		const sourceFileNode = pluginRun.fileNodeId ? await ctx.db.get("files_nodes", pluginRun.fileNodeId) : null;
		if (
			!sourceFileNode ||
			sourceFileNode.archiveOperationId !== undefined ||
			sourceFileNode.organizationId !== args.organizationId ||
			sourceFileNode.workspaceId !== args.workspaceId
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const sourceParentPath =
			sourceFileNode.parentId === files_ROOT_ID ? "/" : server_path_parent_of(sourceFileNode.path);
		if (server_path_parent_of(args.path) !== sourceParentPath) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// A plugin run writes as the person whose upload started it, so that person still has to be
		// allowed to write here. A run can outlive them: a member is removed, or their role is taken
		// away, while the run is still going. Asked against the source file rather than the workspace,
		// because the output lands beside it — a grant on a restricted folder is often the only reason
		// the actor could write there at all.
		const actorMembership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!actorMembership) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		if (
			!(await has_workspace_content_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				permission: "content.write",
				fileNode: sourceFileNode,
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		return Result({ _yay: { pluginRun, installation, serviceGrant: null } });
	}

	if (args.principalRef.kind === "plugin_service") {
		// The grant facts first: the same live checks the resolver ran, because a revocation, a
		// phase change, or an expiry can land between the route's token check and this transaction.
		const grant = await ctx.db.get("plugin_service_grants", args.principalRef.grantId);
		if (
			!grant ||
			grant.revokedAt != null ||
			grant.expiresAt <= args.now ||
			grant.organizationId !== args.organizationId ||
			grant.workspaceId !== args.workspaceId ||
			grant.actorUserId !== args.userId ||
			grant.phase !== "processing" ||
			grant.destinationPathPrefix == null ||
			!grant.scopes.includes("files:write")
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const [installation, workspace] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", grant.installationId),
			ctx.db.get("organizations_workspaces", grant.workspaceId),
		]);
		if (
			!installation ||
			!workspace ||
			workspace.organizationId !== grant.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined ||
			installation.status !== "enabled" ||
			installation.pluginVersionId !== grant.pluginVersionId ||
			!installation.acceptedCapabilities.includes("plugin.service.connect") ||
			!installation.acceptedCapabilities.includes("workspace.files.write")
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		// The seal is a location bound, checked again here so a stage prepared for one path can
		// never publish outside the destination the grant was sealed to.
		if (!public_api_is_path_inside_prefix(args.path, grant.destinationPathPrefix)) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// The grant acts for its member, so that member must still be one, and must still be
		// allowed to write where the file lands. Asked against the target or the deepest existing
		// ancestor, so a grant inside a restricted folder is judged by the grant that let the
		// actor in — both fill and create under a restricted folder are covered.
		const actorMembership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.userId)
					.eq("organizationId", args.organizationId)
					.eq("workspaceId", args.workspaceId),
			)
			.first();
		if (!actorMembership) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const aclNode =
			(await db_get_active_node_at_path(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				path: args.path,
			})) ??
			(await db_get_deepest_existing_ancestor(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				path: args.path,
			}));
		if (
			!(await has_workspace_content_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				permission: "content.write",
				...(aclNode ? { fileNode: aclNode } : {}),
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		return Result({ _yay: { pluginRun: null, installation, serviceGrant: grant } });
	}

	const credential = await ctx.db.get("api_credentials", args.principalRef.credentialId);
	if (
		!credential ||
		credential.revokedAt != null ||
		credential.userId !== args.userId ||
		credential.organizationId !== args.organizationId ||
		credential.workspaceId !== args.workspaceId
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", credential.userId)
				.eq("organizationId", credential.organizationId)
				.eq("workspaceId", credential.workspaceId),
		)
		.first();
	if (!membership) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	if (
		!(await has_workspace_content_permission(ctx, {
			organizationId: credential.organizationId,
			workspaceId: credential.workspaceId,
			userId: credential.userId,
			permission: "content.write",
		}))
	) {
		return Result({ _nay: { message: "Permission denied" } });
	}
	return Result({ _yay: { pluginRun: null, installation: null, serviceGrant: null } });
}

/**
 * The plugin facts `public_api_db_revalidate_file_write_principal` proved, handed to the checks below that
 * need the installation or the grant again.
 */
type FileWritePluginFacts = {
	pluginRun: Doc<"plugins_event_runs"> | null;
	installation: Doc<"plugins_workspace_installations"> | null;
	serviceGrant: Doc<"plugin_service_grants"> | null;
};

/**
 * Whether this node's direct lock is the lock of this installation's own live upload target,
 * judged by the same rule the service delete and archive doors use.
 */
async function db_service_lock_is_own_live_target(
	ctx: MutationCtx,
	args: { facts: FileWritePluginFacts; node: Doc<"files_nodes"> },
) {
	const installation = args.facts.installation;
	const serviceGrant = args.facts.serviceGrant;
	if (!installation || !serviceGrant || serviceGrant.destinationPathPrefix == null) {
		return false;
	}

	const destinationNode = await db_get_active_node_at_path(ctx, {
		organizationId: serviceGrant.organizationId,
		workspaceId: serviceGrant.workspaceId,
		path: serviceGrant.destinationPathPrefix,
	});
	if (!destinationNode) {
		return false;
	}
	return await public_api_service_uploads_db_can_clean_up_service_created_lock(ctx, {
		principal: {
			organizationId: serviceGrant.organizationId,
			workspaceId: serviceGrant.workspaceId,
			actorUserId: serviceGrant.actorUserId,
			pathPrefix: serviceGrant.destinationPathPrefix,
		},
		installation,
		destinationNodeId: destinationNode._id,
		node: args.node,
	});
}

/**
 * Whether a service principal may replace or fill this exact existing file. A path inside the
 * seal is only a location bound, not proof the service created the file — without this gate a
 * service could overwrite a member-created Markdown file inside its destination. Proof is the
 * write-door provenance stamp, or the installation's own live read-only upload target on the
 * node (a file created read-only through `create-target` carries no stamp but must stay
 * updatable by the service that created it).
 */
async function db_service_owns_existing_file(
	ctx: MutationCtx,
	args: { facts: FileWritePluginFacts; node: Doc<"files_nodes"> },
) {
	const installation = args.facts.installation;
	if (!installation || !args.facts.serviceGrant) {
		return false;
	}
	if (args.node.pluginServiceWritePluginName === installation.pluginName) {
		return true;
	}
	return await db_service_lock_is_own_live_target(ctx, args);
}

/**
 * Whether a plugin principal may write through a `files_node_require_writable` refusal. Every
 * other caller keeps today's 409.
 *
 * Run-owned area: pass when the lock's OWNING node is a direct lock this plugin's own doors
 * created. Resolve the scope node instead of requiring the lock to sit on this node, so files
 * inside a folder the plugin locked stay writable to the plugin's backend. Own-area and
 * own-write were already proved by revalidation for invoke runs; own-access is not asked here,
 * because own-access is the capability to CREATE a lock and own-write the capability to write
 * the file — a plugin that later loses own-access can still maintain the files it owns.
 *
 * Service seal: only the file's own direct locks can pass — the plugin-named lock the write door
 * created, or the lock of this installation's own live upload target.
 *
 * Exported for the plugin file doors, which judge archive and access locks with the same rule.
 */
export async function public_api_db_can_pass_read_only_for_plugin(
	ctx: MutationCtx,
	args: {
		facts: FileWritePluginFacts;
		/** The node whose lock refused the write: the target itself, or the ancestor a create sits under. */
		node: Doc<"files_nodes">;
	},
) {
	const installation = args.facts.installation;
	if (!installation || args.node.readOnlyScopeNodeId === undefined) {
		return false;
	}

	if (args.facts.pluginRun) {
		if (args.facts.pluginRun.event !== "ui.invoke.requested") {
			return false;
		}
		const scopeNode = await ctx.db.get("files_nodes", args.node.readOnlyScopeNodeId);
		return scopeNode?.readOnlyPluginName === installation.pluginName;
	}

	const serviceGrant = args.facts.serviceGrant;
	if (!serviceGrant || serviceGrant.destinationPathPrefix == null) {
		return false;
	}
	if (
		await public_api_service_uploads_db_can_release_plugin_named_lock(ctx, {
			installation,
			pathPrefix: serviceGrant.destinationPathPrefix,
			node: args.node,
		})
	) {
		return true;
	}
	return await db_service_lock_is_own_live_target(ctx, { facts: args.facts, node: args.node });
}

/**
 * Remember the target at prepare time. Publish uses this to avoid changing a different file.
 */
const file_write_target_anchor_validator = v.union(
	v.object({
		kind: v.literal("existing"),
		nodeId: v.id("files_nodes"),
	}),
	v.object({ kind: v.literal("create") }),
);

function file_write_stale_refusal() {
	return Result({
		_nay: { name: "stale_write", message: "The file changed during the write" },
	});
}

async function db_get_active_node_at_path(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		path: string;
	},
) {
	return await ctx.db
		.query("files_nodes")
		.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("path", args.path)
				.eq("archiveOperationId", undefined),
		)
		.first();
}

/**
 * Find the nearest existing node above `path`. Return null when only the workspace root exists.
 */
async function db_get_deepest_existing_ancestor(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		path: string;
	},
) {
	const segments = path_extract_segments_from(args.path);
	for (let depth = segments.length - 1; depth >= 1; depth--) {
		const ancestor = await db_get_active_node_at_path(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: `/${segments.slice(0, depth).join("/")}`,
		});
		if (ancestor) {
			return ancestor;
		}
	}
	return null;
}

/**
 * Check the target before creating temporary docs. Check access before the read-only lock so a
 * hidden node's lock stays private. Remember the target so publish cannot change a different file.
 */
async function db_preflight_file_write_target(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		path: string;
		pluginFacts: FileWritePluginFacts;
	},
) {
	const activeNode = await db_get_active_node_at_path(ctx, args);
	if (activeNode) {
		if (
			!(await has_workspace_content_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				permission: "content.write",
				fileNode: activeNode,
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Check the lock again at publish time. If the target is writable then, the write can finish.
		const writable = files_node_require_writable(activeNode);
		if (writable._nay && !(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts: args.pluginFacts, node: activeNode }))) {
			return writable;
		}

		return Result({
			_yay: {
				targetAnchor: { kind: "existing" as const, nodeId: activeNode._id },
			},
		});
	}

	const ancestor = await db_get_deepest_existing_ancestor(ctx, args);
	if (ancestor) {
		if (
			!(await access_control_db_can_act_on_file_node(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				fileNode: ancestor,
				permission: "content.write",
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Do not create temporary docs below a read-only node.
		const writable = files_node_require_writable(ancestor);
		if (writable._nay && !(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts: args.pluginFacts, node: ancestor }))) {
			return writable;
		}
	}

	return Result({ _yay: { targetAnchor: { kind: "create" as const } } });
}

/**
 * Stop a prepared write after a conflict. Mark its plugin call as failed. Create R2 deletion jobs
 * before deleting its temporary docs, so a later crash cannot lose the cleanup work.
 */
async function db_abandon_file_write_stage_conflict(
	ctx: MutationCtx,
	args: {
		stage: Doc<"public_api_file_write_stages">;
		/**
		 * Assets that the action already uploaded to R2. The fill path does not upload its Yjs
		 * snapshot.
		 */
		putAssetIds: Array<Id<"files_r2_assets">>;
		refusalMessage: string;
		deletionReason: "read_only_stage" | "failed_create";
	},
) {
	const now = Date.now();

	// Save the same conflict that the route returns. Do not save the refused file content.
	if (args.stage.callId) {
		const call = await ctx.db.get("plugins_event_run_calls", args.stage.callId);
		// Ignore a late or repeated finish. Only a started call can finish.
		if (call && call.status === "started") {
			await ctx.db.patch("plugins_event_run_calls", call._id, {
				status: "failed",
				errorCode: "conflict",
				errorMessage: args.refusalMessage,
				responseStatus: 409,
				finishedAt: now,
				elapsedMs: now - call.startedAt,
				updatedAt: now,
			});
		}
	}

	for (const assetId of [args.stage.yjsSnapshotAssetId, args.stage.contentSnapshotAssetId]) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset) {
			continue;
		}

		// These internal uploads finished before publish started. Nothing can upload to the key later.
		if (args.putAssetIds.includes(assetId)) {
			await r2_enqueue_object_deletion_job(ctx, {
				organizationId: args.stage.organizationId,
				workspaceId: args.stage.workspaceId,
				r2Key: r2_create_asset_key({
					organizationId: args.stage.organizationId,
					workspaceId: args.stage.workspaceId,
					assetId,
				}),
				reason: args.deletionReason,
			});
		}
		await ctx.db.delete("files_r2_assets", assetId);
	}

	await ctx.db.delete("public_api_file_write_stages", args.stage._id);
}

export const prepare_file_write = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/** Authoring user: the credential owner, or the plugin run's actorUserId. */
		userId: v.id("users"),
		principalRef: file_write_principal_ref_validator,
		path: v.string(),
		overwrite: v.union(v.literal("replace"), v.literal("fail")),
		contentSize: v.number(),
		yjsSnapshotSize: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			stageId: v.id("public_api_file_write_stages"),
			yjsSnapshotAssetId: v.id("files_r2_assets"),
			contentSnapshotAssetId: v.id("files_r2_assets"),
			targetAnchor: file_write_target_anchor_validator,
		}),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: args.principalRef,
			path: args.path,
			now,
		});
		if (revalidated._nay) {
			return revalidated;
		}

		// Check the current target before creating temporary docs. Publish checks it again before its
		// first write.
		const preflight = await db_preflight_file_write_target(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			path: args.path,
			pluginFacts: revalidated._yay,
		});
		if (preflight._nay) {
			return preflight;
		}

		// On publish, the staged content snapshot becomes the file's first version snapshot, and
		// the node points at it. Editable files have no separate content asset.
		const insert_stage_asset = (kind: "yjs_snapshot" | "content_snapshot", size: number) =>
			ctx.db.insert("files_r2_assets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind,
				r2Bucket: r2_get_bucket(),
				size,
				createdBy: args.userId,
				unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
				updatedAt: now,
			});
		const [yjsSnapshotAssetId, contentSnapshotAssetId] = await Promise.all([
			insert_stage_asset("yjs_snapshot", args.yjsSnapshotSize),
			insert_stage_asset("content_snapshot", args.contentSize),
		]);

		const stageId = await ctx.db.insert("public_api_file_write_stages", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			...(args.principalRef.kind === "plugin_run"
				? { runId: args.principalRef.runId, callId: args.principalRef.callId }
				: args.principalRef.kind === "plugin_service"
					? { grantId: args.principalRef.grantId }
					: { credentialId: args.principalRef.credentialId }),
			path: args.path,
			overwrite: args.overwrite,
			yjsSnapshotAssetId,
			contentSnapshotAssetId,
			expiresAt: now + FILE_WRITE_STAGE_TTL_MS,
			updatedAt: now,
		});

		return Result({
			_yay: { stageId, yjsSnapshotAssetId, contentSnapshotAssetId, targetAnchor: preflight._yay.targetAnchor },
		});
	},
});

type prepare_file_write_Result =
	typeof prepare_file_write extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const publish_file_write = internalMutation({
	args: {
		stageId: v.id("public_api_file_write_stages"),
		content: v.string(),
		/** The target state saved by `prepare_file_write`. Publish requires it to stay the same. */
		targetAnchor: file_write_target_anchor_validator,
		/**
		 * Create the file with committed content only and no Yjs document. The action then never
		 * PUT the staged Yjs snapshot object, so its asset doc is dropped below, the same way the
		 * fill path drops the one it does not use.
		 */
		nonCollaborative: v.optional(v.boolean()),
		/**
		 * Plugin principals only: create the file with a direct plugin-named lock. The needed
		 * consent is checked below before anything is written.
		 */
		requestReadOnly: v.optional(v.boolean()),
	},
	returns: v_result({
		_yay: v.object({ nodeId: v.id("files_nodes") }),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const stage = await ctx.db.get("public_api_file_write_stages", args.stageId);
		if (!stage) {
			// A cleanup already consumed the stage: the write can no longer be published.
			return Result({ _nay: { message: "Write was not published" } });
		}

		const principalRef: Infer<typeof file_write_principal_ref_validator> | null =
			stage.runId && stage.callId
				? { kind: "plugin_run", runId: stage.runId, callId: stage.callId }
				: stage.credentialId
					? { kind: "user_api_key", credentialId: stage.credentialId }
					: stage.grantId
						? { kind: "plugin_service", grantId: stage.grantId }
						: null;
		if (!principalRef) {
			// Unreachable: prepare_file_write always stores exactly one principal reference.
			throw should_never_happen("public_api_file_write_stages doc without a principal reference", {
				stageId: stage._id,
			});
		}

		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			userId: stage.userId,
			principalRef,
			path: stage.path,
			now,
		});
		if (revalidated._nay) {
			return revalidated;
		}

		const [yjsSnapshotAsset, contentSnapshotAsset] = await Promise.all([
			ctx.db.get("files_r2_assets", stage.yjsSnapshotAssetId),
			ctx.db.get("files_r2_assets", stage.contentSnapshotAssetId),
		]);
		if (!yjsSnapshotAsset || !contentSnapshotAsset) {
			// Unreachable while the stage exists: cleanup deletes the asset docs and the stage together.
			throw should_never_happen("public_api_file_write_stages doc with missing asset docs", {
				stageId: stage._id,
			});
		}

		// Set when a lock refused this write and the plugin's own-lock exception passed it. The
		// create below must then skip the recursive helper's own lock check, which would refuse
		// that same lock again.
		let createThroughOwnLock = false;

		const activeNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", stage.organizationId)
					.eq("workspaceId", stage.workspaceId)
					.eq("path", stage.path)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (activeNode) {
			// This lookup is raw on purpose: a path holds one active node, so a restricted file the caller
			// cannot see still has to block the create below, or two nodes would end up on one path. That
			// makes the node-level check the only thing standing between the caller and somebody else's
			// restricted file, which `replace` would archive.
			if (
				!(await has_workspace_content_permission(ctx, {
					organizationId: stage.organizationId,
					workspaceId: stage.workspaceId,
					userId: stage.userId,
					permission: "content.write",
					fileNode: activeNode,
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// The prepared write must still point to this node. Then check its current lock before the
			// first write.
			if (args.targetAnchor.kind !== "existing" || args.targetAnchor.nodeId !== activeNode._id) {
				const staleRefusal = file_write_stale_refusal();
				await db_abandon_file_write_stage_conflict(ctx, {
					stage,
					putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
					refusalMessage: staleRefusal._nay.message,
					deletionReason: "failed_create",
				});
				return staleRefusal;
			}

			const writable = files_node_require_writable(activeNode);
			if (writable._nay) {
				if (!(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts: revalidated._yay, node: activeNode }))) {
					await db_abandon_file_write_stage_conflict(ctx, {
						stage,
						putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
						refusalMessage: writable._nay.message,
						deletionReason: "read_only_stage",
					});
					return writable;
				}
				createThroughOwnLock = true;
			}

			if (activeNode.kind !== "file") {
				return Result({ _nay: { message: "A folder already exists at this path" } });
			}
			if (stage.overwrite === "fail") {
				return Result({ _nay: { message: "A file already exists at this path" } });
			}

			// Replacing an existing file is an update, so a service needs proof it created this
			// exact file, not only a path inside its seal.
			if (
				principalRef.kind === "plugin_service" &&
				!(await db_service_owns_existing_file(ctx, { facts: revalidated._yay, node: activeNode }))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// Recreation below walks this file's folders and asks `content.write` on each one, and a
			// refusal there would return normally — which commits the archive and leaves the caller with
			// no file at all. So the same question is asked here, while nothing has been written yet.
			// Nested scopes make this reachable: a grant on an inner restricted folder passes the check
			// on the file above without saying anything about the restricted folder holding it.
			let ancestorId = activeNode.parentId;
			while (ancestorId !== files_ROOT_ID) {
				const ancestor: Doc<"files_nodes"> | null = await ctx.db.get("files_nodes", ancestorId);
				if (!ancestor) {
					break;
				}
				if (
					!(await access_control_db_can_act_on_file_node(ctx, {
						organizationId: stage.organizationId,
						workspaceId: stage.workspaceId,
						userId: stage.userId,
						fileNode: ancestor,
						permission: "content.write",
					}))
				) {
					return Result({ _nay: { message: "Permission denied" } });
				}
				ancestorId = ancestor.parentId;
			}

			await files_nodes_db_archive_nodes(ctx, { nodeIds: [activeNode._id], updatedBy: stage.userId, now });
		}

		// A create still needs an empty target path. Check the current parent lock before the first
		// write.
		if (!activeNode) {
			if (args.targetAnchor.kind !== "create") {
				const staleRefusal = file_write_stale_refusal();
				await db_abandon_file_write_stage_conflict(ctx, {
					stage,
					putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
					refusalMessage: staleRefusal._nay.message,
					deletionReason: "failed_create",
				});
				return staleRefusal;
			}
			const ancestor = await db_get_deepest_existing_ancestor(ctx, {
				organizationId: stage.organizationId,
				workspaceId: stage.workspaceId,
				path: stage.path,
			});

			// Check access first. A hidden restricted folder must not reveal its read-only state.
			if (
				ancestor &&
				!(await has_workspace_content_permission(ctx, {
					organizationId: stage.organizationId,
					workspaceId: stage.workspaceId,
					userId: stage.userId,
					permission: "content.write",
					fileNode: ancestor,
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			if (ancestor) {
				const writable = files_node_require_writable(ancestor);
				if (writable._nay) {
					if (
						!(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts: revalidated._yay, node: ancestor }))
					) {
						await db_abandon_file_write_stage_conflict(ctx, {
							stage,
							putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
							refusalMessage: writable._nay.message,
							deletionReason: "read_only_stage",
						});
						return writable;
					}
					createThroughOwnLock = true;
				}
			}
		}

		// `access.readOnly` creates the file already locked. Decide the consent before anything is
		// written, so a refusal leaves no half-created state.
		if (args.requestReadOnly === true) {
			const installation = revalidated._yay.installation;
			// The route already refuses `access` for non-plugin callers; this is the transactional check.
			if (!installation) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			if (principalRef.kind === "plugin_run") {
				// Own-access is the consent that creates a lock. Own-write alone lets a plugin write
				// its files, not lock them.
				if (
					revalidated._yay.pluginRun?.event !== "ui.invoke.requested" ||
					!installation.acceptedCapabilities.includes("workspace.files.own-access")
				) {
					return Result({ _nay: { message: "Permission denied" } });
				}
			} else {
				// Mirror the `create-target` read-only rule: the create-read-only consent, plus the
				// actor still holding `content.permissions.manage` at the destination, because a lock
				// is an ACL decision the actor must be allowed to make.
				if (!installation.acceptedCapabilities.includes("workspace.files.create-read-only")) {
					return Result({ _nay: { message: "Permission denied" } });
				}
				const destinationAclNode = await db_get_deepest_existing_ancestor(ctx, {
					organizationId: stage.organizationId,
					workspaceId: stage.workspaceId,
					path: stage.path,
				});
				const [organization, workspace] = await Promise.all([
					ctx.db.get("organizations", stage.organizationId),
					ctx.db.get("organizations_workspaces", stage.workspaceId),
				]);
				let canManageDestination = false;
				if (organization && organization.defaultWorkspaceId && workspace) {
					// The full permission question, like the `create-target` door asks it: the actor's
					// workspace-wide manage permission, refined by the destination's restricted scope.
					canManageDestination = await access_control_db_has_permission(ctx, {
						organizationId: organization._id,
						workspaceId: workspace._id,
						defaultWorkspaceId: organization.defaultWorkspaceId,
						organizationOwnerUserId: organization.ownerUserId,
						resource: destinationAclNode
							? {
									kind: "file",
									id: String(destinationAclNode._id),
									restrictedScopeNodeId: destinationAclNode.restrictedScopeNodeId ?? null,
								}
							: { kind: "workspace", id: String(workspace._id) },
						permission: "content.permissions.manage",
						userId: stage.userId,
					});
				}
				if (!canManageDestination) {
					return Result({ _nay: { message: "Permission denied" } });
				}
			}
		}

		// Owned-area runs stamp every node this write creates — the file and each new intermediate
		// folder — so the stamp rule keeps answering for later writes below them. Driven by the
		// principal reference, never by a request field: public doors must stay unable to set the
		// stamp.
		const stampPluginName =
			principalRef.kind === "plugin_run" &&
			revalidated._yay.pluginRun?.event === "ui.invoke.requested" &&
			revalidated._yay.installation
				? revalidated._yay.installation.pluginName
				: undefined;

		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: stage.userId,
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			parentId: files_ROOT_ID,
			path: stage.path,
			kind: "file",
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			// The staged content snapshot holds the file's current bytes. Below it also becomes
			// the file's first version snapshot.
			assetId: stage.contentSnapshotAssetId,
			expectsTextContent: true,
			metadata: [{ key: "source", value: "api" }],
			...(stampPluginName ? { stampCreatedNodesPluginName: stampPluginName } : {}),
			// The refusing lock is the plugin's own, and the ACL questions were asked above. Skip
			// the helper's re-check of that same lock, and keep the new nodes under the locked
			// folder's pointer so they stay read-only for members.
			...(createThroughOwnLock ? { skipAccessControlAndLock: true, inheritParentReadOnlyScope: true } : {}),
			now,
		});
		if (created._nay) {
			// An intermediate segment is owned by a file, or an equivalent structural conflict.
			return Result({ _nay: { message: created._nay.message } });
		}

		// A service-created file records which plugin wrote it. Later service updates and the
		// per-file archive read this as ownership proof; member sharing and lock code ignore it.
		if (principalRef.kind === "plugin_service" && revalidated._yay.installation) {
			await ctx.db.patch("files_nodes", created._yay, {
				pluginServiceWritePluginName: revalidated._yay.installation.pluginName,
			});
		}
		// The requested lock was authorized above, before anything was written. The node is brand
		// new and has no descendants, so no cascade is needed.
		if (args.requestReadOnly === true && revalidated._yay.installation) {
			await ctx.db.patch("files_nodes", created._yay, {
				readOnlyScopeNodeId: created._yay,
				readOnlyPluginName: revalidated._yay.installation.pluginName,
			});
		}

		// Same mutation as the node insert, so a content failure still rolls back the whole create.
		await files_nodes_db_insert_file_content_docs(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			nodeId: created._yay,
			path: stage.path,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			// The public write route is Markdown-only.
			rootKind: "rich_text",
			textContent: args.content,
			readOnly: false,
			nonCollaborative: args.nonCollaborative === true,
			...(args.nonCollaborative === true ? {} : { yjsSnapshotAssetId: stage.yjsSnapshotAssetId }),
			userId: stage.userId,
			now,
		});

		// A non-collaborative file has no Yjs document, so the staged snapshot asset was never
		// uploaded and nothing will ever point at it.
		if (args.nonCollaborative === true) {
			await ctx.db.delete("files_r2_assets", yjsSnapshotAsset._id);
		}

		await files_nodes_db_finalize_editable_text_node_creation(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			nodeId: created._yay,
			userId: stage.userId,
			...(args.nonCollaborative === true
				? {}
				: { yjsSnapshot: { assetId: stage.yjsSnapshotAssetId, size: yjsSnapshotAsset.size } }),
			versionSnapshotAssetId: stage.contentSnapshotAssetId,
			versionSnapshotSize: contentSnapshotAsset.size,
		});

		// Atomic with the publish: the run's output count, the settled call, and the consumed
		// stage all commit with the new file node or not at all.
		const pluginRun = revalidated._yay.pluginRun;
		if (pluginRun) {
			await ctx.db.patch("plugins_event_runs", pluginRun._id, {
				outputWriteCount: pluginRun.outputWriteCount + 1,
				updatedAt: now,
			});
			await activities_db_add_target(ctx, {
				sourceId: pluginRun._id,
				target: { type: "file_node", id: created._yay, path: stage.path, message: "" },
				now,
			});
		}
		if (stage.callId) {
			const call = await ctx.db.get("plugins_event_run_calls", stage.callId);
			// A late or duplicate finish is a no-op: only a started call settles.
			if (call && call.status === "started") {
				await ctx.db.patch("plugins_event_run_calls", call._id, {
					status: "succeeded",
					errorMessage: null,
					responseStatus: 200,
					requestBytes: contentSnapshotAsset.size,
					finishedAt: now,
					elapsedMs: now - call.startedAt,
					updatedAt: now,
				});
			}
		}

		// Nothing is free: the committed write bills the workspace payer one cent, in the same
		// transaction, so a rolled-back publish emits nothing. The staged content snapshot becomes
		// the file's first version snapshot, so it is the unique-per-save version part.
		const organization = await ctx.db.get("organizations", stage.organizationId);
		if (!organization) {
			throw should_never_happen("stage.organizationId points to a missing organizations doc", {
				stageId: stage._id,
				organizationId: stage.organizationId,
			});
		}
		const billedUserId = billing_pick_billed_user_id({ userId: stage.userId, organization });
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			throw should_never_happen("billedUserId points to a missing users doc", {
				stageId: stage._id,
				userId: stage.userId,
				billedUserId,
			});
		}
		await billing_db_emit_file_save(ctx, {
			billedUser,
			actorUserId: stage.userId,
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			nodeId: created._yay,
			version: stage.contentSnapshotAssetId,
		});

		await ctx.db.delete("public_api_file_write_stages", stage._id);

		return Result({ _yay: { nodeId: created._yay } });
	},
});

type publish_file_write_Result =
	typeof publish_file_write extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Publish a write whose target is an existing editable text file: replace the file's content
 * in place so the nodeId stays stable for open editors and links. The route computed the fill
 * update (a Yjs diff against the doc state it reconstructed), staged it as a trusted
 * `public_fill` update, and PUT only the content snapshot object; the staged Yjs snapshot asset
 * is unused and dropped here.
 */
export const publish_file_fill = internalMutation({
	args: {
		stageId: v.id("public_api_file_write_stages"),
		content: v.string(),
		expectedNodeId: v.id("files_nodes"),
		fillUpdateStageId: v.optional(v.id("files_yjs_trusted_update_stages")),
		expectedYjsLastSequenceId: v.optional(v.id("files_yjs_docs_last_sequences")),
		/**
		 * The target's collaboration mode as the route saw it. A non-collaborative file has no
		 * document, so its fill is a plain content swap and carries no `fillUpdateStageId`.
		 */
		nonCollaborative: v.optional(v.boolean()),
	},
	returns: v_result({
		_yay: v.object({ nodeId: v.id("files_nodes") }),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const stage = await ctx.db.get("public_api_file_write_stages", args.stageId);
		if (!stage) {
			// A cleanup already consumed the stage: the write can no longer be published.
			return Result({ _nay: { message: "Write was not published" } });
		}

		const principalRef: Infer<typeof file_write_principal_ref_validator> | null =
			stage.runId && stage.callId
				? { kind: "plugin_run", runId: stage.runId, callId: stage.callId }
				: stage.credentialId
					? { kind: "user_api_key", credentialId: stage.credentialId }
					: stage.grantId
						? { kind: "plugin_service", grantId: stage.grantId }
						: null;
		if (!principalRef) {
			// Unreachable: prepare_file_write always stores exactly one principal reference.
			throw should_never_happen("public_api_file_write_stages doc without a principal reference", {
				stageId: stage._id,
			});
		}

		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			userId: stage.userId,
			principalRef,
			path: stage.path,
			now,
		});
		if (revalidated._nay) {
			return revalidated;
		}

		// Bind only the tenant and node before access checks. Path, archive, type, mode, and lineage
		// are details a caller without node access must not learn from the conflict response.
		const fileNode = await ctx.db.get("files_nodes", args.expectedNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== stage.organizationId ||
			fileNode.workspaceId !== stage.workspaceId
		) {
			return Result({ _nay: { message: "The file changed during the write" } });
		}

		// `public_api_db_revalidate_file_write_principal` above asks about the workspace, and a write can be staged
		// for a while. This is the commit, so the node itself is asked again here: a grant taken away
		// during staging has to stop the write, not arrive too late.
		if (
			!(await has_workspace_content_permission(ctx, {
				organizationId: stage.organizationId,
				workspaceId: stage.workspaceId,
				userId: stage.userId,
				permission: "content.write",
				fileNode,
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Filling is an update, so a service needs proof it created this exact file, not only a
		// path inside its seal.
		if (
			principalRef.kind === "plugin_service" &&
			!(await db_service_owns_existing_file(ctx, { facts: revalidated._yay, node: fileNode }))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		// Check ACL, then check the current lock before the first write. A refusal also cleans up the
		// stage in this transaction. The fill path uploaded only the content snapshot.
		const writable = files_node_require_writable(fileNode);
		if (writable._nay && !(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts: revalidated._yay, node: fileNode }))) {
			await db_abandon_file_write_stage_conflict(ctx, {
				stage,
				putAssetIds: [stage.contentSnapshotAssetId],
				refusalMessage: writable._nay.message,
				deletionReason: "read_only_stage",
			});
			return writable;
		}

		// After ACL and lock checks, require the exact active editable target and collaboration
		// lineage the route built its content projection from.
		if (
			fileNode.path !== stage.path ||
			fileNode.archiveOperationId !== undefined ||
			!files_node_has_editable_text_content(fileNode) ||
			(fileNode.nonCollaborative === true) !== (args.nonCollaborative === true) ||
			(fileNode.nonCollaborative !== true &&
				fileNode.yjsLastSequenceId !== args.expectedYjsLastSequenceId)
		) {
			return Result({ _nay: { message: "The file changed during the write" } });
		}

		const contentSnapshotAsset = await ctx.db.get("files_r2_assets", stage.contentSnapshotAssetId);
		if (!contentSnapshotAsset) {
			// Unreachable while the stage exists: cleanup deletes the asset docs and the stage together.
			throw should_never_happen("public_api_file_write_stages doc with missing asset docs", {
				stageId: stage._id,
			});
		}

		// The fill path never PUT a Yjs snapshot object, so only the staged asset doc exists.
		const yjsSnapshotAsset = await ctx.db.get("files_r2_assets", stage.yjsSnapshotAssetId);
		if (yjsSnapshotAsset) {
			await ctx.db.delete("files_r2_assets", yjsSnapshotAsset._id);
		}

		const filled = await files_nodes_db_fill_text_node_content(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			fileNode,
			userId: stage.userId,
			textContent: args.content,
			contentSnapshotAssetId: stage.contentSnapshotAssetId,
			contentSize: contentSnapshotAsset.size,
			fillUpdateStageId: args.fillUpdateStageId,
			expectedYjsLastSequenceId: args.expectedYjsLastSequenceId,
		});
		if (filled._nay) {
			// Throw so Convex rolls back the snapshot and node writes done above.
			throw convex_error({ message: "Failed to write file", cause: filled._nay });
		}

		// Atomic with the fill: the run's output count, the settled call, and the consumed
		// stage all commit with the replaced content or not at all.
		const pluginRun = revalidated._yay.pluginRun;
		if (pluginRun) {
			await ctx.db.patch("plugins_event_runs", pluginRun._id, {
				outputWriteCount: pluginRun.outputWriteCount + 1,
				updatedAt: now,
			});
			await activities_db_add_target(ctx, {
				sourceId: pluginRun._id,
				target: { type: "file_node", id: fileNode._id, path: stage.path, message: "" },
				now,
			});
		}
		if (stage.callId) {
			const call = await ctx.db.get("plugins_event_run_calls", stage.callId);
			// A late or duplicate finish is a no-op: only a started call settles.
			if (call && call.status === "started") {
				await ctx.db.patch("plugins_event_run_calls", call._id, {
					status: "succeeded",
					errorMessage: null,
					responseStatus: 200,
					requestBytes: contentSnapshotAsset.size,
					finishedAt: now,
					elapsedMs: now - call.startedAt,
					updatedAt: now,
				});
			}
		}

		// Nothing is free: the committed fill bills the workspace payer one cent, in the same
		// transaction, so a rolled-back publish emits nothing. The staged content snapshot becomes
		// the file's new version snapshot, so it is the unique-per-save version part.
		const organization = await ctx.db.get("organizations", stage.organizationId);
		if (!organization) {
			throw should_never_happen("stage.organizationId points to a missing organizations doc", {
				stageId: stage._id,
				organizationId: stage.organizationId,
			});
		}
		const billedUserId = billing_pick_billed_user_id({ userId: stage.userId, organization });
		const billedUser = await ctx.db.get("users", billedUserId);
		if (!billedUser) {
			throw should_never_happen("billedUserId points to a missing users doc", {
				stageId: stage._id,
				userId: stage.userId,
				billedUserId,
			});
		}
		await billing_db_emit_file_save(ctx, {
			billedUser,
			actorUserId: stage.userId,
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			nodeId: fileNode._id,
			version: stage.contentSnapshotAssetId,
		});

		await ctx.db.delete("public_api_file_write_stages", stage._id);

		return Result({ _yay: { nodeId: fileNode._id } });
	},
});

type publish_file_fill_Result =
	typeof publish_file_fill extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Publish a touch: create an empty editable Markdown file at the staged path, or succeed as a
 * no-op when an active file already owns the path. Touches are placeholder creation, not output
 * writes — run output counting and plugin call settling stay with the route (one call covers the
 * whole batch).
 */
export const publish_file_touch = internalMutation({
	args: {
		stageId: v.id("public_api_file_write_stages"),
		/** The target state saved by `prepare_file_write`. Publish requires it to stay the same. */
		targetAnchor: file_write_target_anchor_validator,
	},
	returns: v_result({
		_yay: v.object({ nodeId: v.id("files_nodes"), created: v.boolean() }),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const stage = await ctx.db.get("public_api_file_write_stages", args.stageId);
		if (!stage) {
			// A cleanup already consumed the stage: the touch can no longer be published.
			return Result({ _nay: { message: "Write was not published" } });
		}

		const principalRef: Infer<typeof file_write_principal_ref_validator> | null =
			stage.runId && stage.callId
				? { kind: "plugin_run", runId: stage.runId, callId: stage.callId }
				: stage.credentialId
					? { kind: "user_api_key", credentialId: stage.credentialId }
					: stage.grantId
						? { kind: "plugin_service", grantId: stage.grantId }
						: null;
		if (!principalRef) {
			// Unreachable: prepare_file_write always stores exactly one principal reference.
			throw should_never_happen("public_api_file_write_stages doc without a principal reference", {
				stageId: stage._id,
			});
		}

		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			userId: stage.userId,
			principalRef,
			path: stage.path,
			now,
		});
		if (revalidated._nay) {
			return revalidated;
		}

		const activeNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
				q
					.eq("organizationId", stage.organizationId)
					.eq("workspaceId", stage.workspaceId)
					.eq("path", stage.path)
					.eq("archiveOperationId", undefined),
			)
			.first();
		if (activeNode) {
			// This lookup is raw, because a path holds one active node and a restricted one still has to
			// stop the create below. So it can find a file the caller may not touch, and answering the
			// touch would hand back its stable node id.
			if (
				!(await has_workspace_content_permission(ctx, {
					organizationId: stage.organizationId,
					workspaceId: stage.workspaceId,
					userId: stage.userId,
					permission: "content.write",
					fileNode: activeNode,
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}

			// An existing target must still be the same node. A target that appeared after prepare can
			// satisfy touch when it is writable now.
			if (args.targetAnchor.kind === "existing") {
				if (args.targetAnchor.nodeId !== activeNode._id) {
					const staleRefusal = file_write_stale_refusal();
					await db_abandon_file_write_stage_conflict(ctx, {
						stage,
						putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
						refusalMessage: staleRefusal._nay.message,
						deletionReason: "failed_create",
					});
					return staleRefusal;
				}
			}

			const writable = files_node_require_writable(activeNode);
			if (writable._nay) {
				await db_abandon_file_write_stage_conflict(ctx, {
					stage,
					putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
					refusalMessage: writable._nay.message,
					deletionReason: "read_only_stage",
				});
				return writable;
			}

			if (activeNode.kind !== "file") {
				return Result({ _nay: { message: "A folder already exists at this path" } });
			}

			// Another writer created the file between the route's check and this publish: the touch
			// is satisfied. Drop the staged assets and their already-PUT objects, but do not settle
			// the plugin call here — the route settles it once for the whole batch.
			const stagedAssetIds = [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId];
			for (const assetId of stagedAssetIds) {
				await r2_enqueue_object_deletion_job(ctx, {
					organizationId: stage.organizationId,
					workspaceId: stage.workspaceId,
					r2Key: r2_create_asset_key({
						organizationId: stage.organizationId,
						workspaceId: stage.workspaceId,
						assetId,
					}),
					reason: "failed_create",
				});
			}
			for (const assetId of stagedAssetIds) {
				const asset = await ctx.db.get("files_r2_assets", assetId);
				if (asset) {
					await ctx.db.delete("files_r2_assets", assetId);
				}
			}
			// The pre-existing file is still where this run's output will land, so it is a target.
			const pluginRun = revalidated._yay.pluginRun;
			if (pluginRun) {
				await activities_db_add_target(ctx, {
					sourceId: pluginRun._id,
					target: { type: "file_node", id: activeNode._id, path: stage.path, message: "" },
					now,
				});
			}
			await ctx.db.delete("public_api_file_write_stages", stage._id);

			return Result({ _yay: { nodeId: activeNode._id, created: false } });
		}

		// The target is still missing. Touch must have prepared a create.
		if (args.targetAnchor.kind !== "create") {
			const staleRefusal = file_write_stale_refusal();
			await db_abandon_file_write_stage_conflict(ctx, {
				stage,
				putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
				refusalMessage: staleRefusal._nay.message,
				deletionReason: "failed_create",
			});
			return staleRefusal;
		}
		const ancestor = await db_get_deepest_existing_ancestor(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			path: stage.path,
		});

		// Check access first. A hidden restricted folder must not reveal its read-only state.
		if (
			ancestor &&
			!(await has_workspace_content_permission(ctx, {
				organizationId: stage.organizationId,
				workspaceId: stage.workspaceId,
				userId: stage.userId,
				permission: "content.write",
				fileNode: ancestor,
			}))
		) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		// A plugin that locked its own folder still creates inside it, the same way the write door
		// lets it. Without this pass a plugin could write a file into its locked folder but never
		// touch one there.
		let createThroughOwnLock = false;
		if (ancestor) {
			const writable = files_node_require_writable(ancestor);
			if (writable._nay) {
				if (!(await public_api_db_can_pass_read_only_for_plugin(ctx, { facts: revalidated._yay, node: ancestor }))) {
					await db_abandon_file_write_stage_conflict(ctx, {
						stage,
						putAssetIds: [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId],
						refusalMessage: writable._nay.message,
						deletionReason: "read_only_stage",
					});
					return writable;
				}
				createThroughOwnLock = true;
			}
		}

		const [yjsSnapshotAsset, contentSnapshotAsset] = await Promise.all([
			ctx.db.get("files_r2_assets", stage.yjsSnapshotAssetId),
			ctx.db.get("files_r2_assets", stage.contentSnapshotAssetId),
		]);
		if (!yjsSnapshotAsset || !contentSnapshotAsset) {
			// Unreachable while the stage exists: cleanup deletes the asset docs and the stage together.
			throw should_never_happen("public_api_file_write_stages doc with missing asset docs", {
				stageId: stage._id,
			});
		}

		// Stamp what the touch creates, the same way `publish_file_write` does. The stamp rule reads
		// the node at the target path before it falls back to the ancestor, so an unstamped file here
		// would refuse the plugin's own later write to fill it — and refuse the archive of the folder
		// holding it. Driven by the principal reference, never by a request field.
		const stampPluginName =
			principalRef.kind === "plugin_run" &&
			revalidated._yay.pluginRun?.event === "ui.invoke.requested" &&
			revalidated._yay.installation
				? revalidated._yay.installation.pluginName
				: undefined;

		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: stage.userId,
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			parentId: files_ROOT_ID,
			path: stage.path,
			kind: "file",
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			// The staged empty content snapshot holds the file's current (empty) bytes. Below it
			// also becomes the file's first version snapshot.
			assetId: stage.contentSnapshotAssetId,
			expectsTextContent: true,
			metadata: [{ key: "source", value: "api" }],
			...(stampPluginName ? { stampCreatedNodesPluginName: stampPluginName } : {}),
			// The refusing lock is the plugin's own, and the ACL questions were asked above. Skip
			// the helper's re-check of that same lock, and keep the new nodes under the locked
			// folder's pointer so they stay read-only for members.
			...(createThroughOwnLock ? { skipAccessControlAndLock: true, inheritParentReadOnlyScope: true } : {}),
			now,
		});
		if (created._nay) {
			// An intermediate segment is owned by a file, or an equivalent structural conflict.
			return Result({ _nay: { message: created._nay.message } });
		}

		// Same mutation as the node insert, so a content failure still rolls back the whole create.
		await files_nodes_db_insert_file_content_docs(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			nodeId: created._yay,
			path: stage.path,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			// The public touch route creates Markdown placeholders only.
			rootKind: "rich_text",
			textContent: "",
			readOnly: false,
			yjsSnapshotAssetId: stage.yjsSnapshotAssetId,
			userId: stage.userId,
			now,
		});

		await files_nodes_db_finalize_editable_text_node_creation(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			nodeId: created._yay,
			userId: stage.userId,
			yjsSnapshot: { assetId: stage.yjsSnapshotAssetId, size: yjsSnapshotAsset.size },
			versionSnapshotAssetId: stage.contentSnapshotAssetId,
			versionSnapshotSize: contentSnapshotAsset.size,
		});

		const pluginRun = revalidated._yay.pluginRun;
		if (pluginRun) {
			await activities_db_add_target(ctx, {
				sourceId: pluginRun._id,
				target: { type: "file_node", id: created._yay, path: stage.path, message: "" },
				now,
			});
		}

		await ctx.db.delete("public_api_file_write_stages", stage._id);

		return Result({ _yay: { nodeId: created._yay, created: true } });
	},
});

type publish_file_touch_Result =
	typeof publish_file_touch extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Check the same access and read-only rules as `publish_file_touch`. The touch route uses this when
 * the file already exists and it does not call the publish mutation. Check access first so a hidden
 * node returns `permission_denied` without revealing its lock.
 */
export const can_write_file_node = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		/**
		 * Set for an invoke run, whose authority is its plugin's stamped area. The touch route answers
		 * an already-existing file from this query and never reaches `publish_file_touch`, so the stamp
		 * rule revalidation applies on the create path has to be asked here too.
		 */
		requireStampedForInstallationId: v.optional(v.id("plugins_workspace_installations")),
	},
	returns: v.union(v.literal("ok"), v.literal("permission_denied"), v.literal("read_only")),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
			return "permission_denied";
		}
		// Without this an invoke run could touch any path in the workspace and read existence off the
		// status: 200 for a file its actor may write, 409 for a folder or a locked file, 403 for one
		// that is not there. The refusal is the same word the actor check below uses, so the two
		// cases stay indistinguishable.
		if (args.requireStampedForInstallationId) {
			const installation = await ctx.db.get("plugins_workspace_installations", args.requireStampedForInstallationId);
			if (!installation || fileNode.pluginOwnerName !== installation.pluginName) {
				return "permission_denied";
			}
		}
		if (
			!(await has_workspace_content_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				permission: "content.write",
				fileNode,
			}))
		) {
			return "permission_denied";
		}
		// A plugin's own lock does not pass here, unlike on the create path and on the write door.
		// `public_api_db_can_pass_read_only_for_plugin` takes a `MutationCtx`, and this is a query.
		// The plugin loses nothing real: the file it asked for already exists, which is all a touch
		// promises. Widen the helper's context if a plugin ever needs the 200 instead.
		if (files_node_require_writable(fileNode)._nay) {
			return "read_only";
		}
		return "ok";
	},
});

/**
 * Opt the calling plugin run into the workspace activity feed. Activities are strictly opt-in —
 * a plugin that wants to stay hidden simply never calls this — and one per run. Once created,
 * the host owns the lifecycle: touch/write publishes append targets, run terminalization closes
 * a still-running activity with the run outcome, and run retention deletes it.
 */
export const start_run_activity = internalMutation({
	args: {
		runId: v.id("plugins_event_runs"),
		/** "" = no custom title; the host composes one from the plugin and the triggering file. */
		title: v.string(),
		/** Caller-predicted duration; the route's validator caps it at ACTIVITIES_TIMEOUT_MAX_MS. */
		timeoutMs: v.number(),
	},
	returns: v_result({
		_yay: v.object({ activityId: v.id("activities") }),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const pluginRun = await ctx.db.get("plugins_event_runs", args.runId);
		// Same liveness bar as the staged-write mutations: only a live, unexpired run may act.
		if (
			!pluginRun ||
			pluginRun.status !== "running" ||
			!pluginRun.apiTokenExpiresAt ||
			pluginRun.apiTokenExpiresAt <= now
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const [installation, version, fileNode, actorMembership, workspace] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", pluginRun.installationId),
			ctx.db.get("plugins_versions", pluginRun.pluginVersionId),
			pluginRun.fileNodeId ? ctx.db.get("files_nodes", pluginRun.fileNodeId) : null,
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", pluginRun.actorUserId)
						.eq("organizationId", pluginRun.organizationId)
						.eq("workspaceId", pluginRun.workspaceId),
				)
				.first(),
			ctx.db.get("organizations_workspaces", pluginRun.workspaceId),
		]);
		// Recheck durable authority in this mutation. Removing the actor, changing the installation,
		// or archiving the source can happen after the route consumes its API call but before this write.
		if (
			!installation ||
			!workspace ||
			workspace.organizationId !== pluginRun.organizationId ||
			workspace.pluginDataPurgeStartedAt !== undefined ||
			installation.status !== "enabled" ||
			installation.pluginVersionId !== pluginRun.pluginVersionId ||
			installation.organizationId !== pluginRun.organizationId ||
			installation.workspaceId !== pluginRun.workspaceId ||
			!fileNode ||
			fileNode.archiveOperationId !== undefined ||
			fileNode.organizationId !== pluginRun.organizationId ||
			fileNode.workspaceId !== pluginRun.workspaceId
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		// Match the write sink's vocabulary (`public_api_db_revalidate_file_write_principal`): a dead plugin-run
		// bearer is "Unauthenticated", while a live run whose actor lost membership is "Permission
		// denied" and settles as 403 at the route.
		if (!actorMembership) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		if (!version) {
			// The enabled installation points to a `plugins_versions` doc, so a missing one breaks an invariant.
			const errorMessage = "pluginRun.pluginVersionId points to a missing plugins_versions doc";
			const errorData = { runId: pluginRun._id, pluginVersionId: pluginRun.pluginVersionId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		if (await activities_db_get_by_source_id(ctx, pluginRun._id)) {
			return Result({ _nay: { message: "An activity already exists for this run" } });
		}

		const activityId = await activities_db_start(ctx, {
			organizationId: pluginRun.organizationId,
			workspaceId: pluginRun.workspaceId,
			userId: pluginRun.actorUserId,
			source: {
				type: "plugin_run",
				id: pluginRun._id,
				installationId: pluginRun.installationId,
				pluginName: version.name,
			},
			title: args.title || `${version.displayName} plugin · ${fileNode.name}`,
			target: { type: "file_node", id: fileNode._id, path: fileNode.path, message: "" },
			timeoutAt: now + args.timeoutMs,
			now,
		});

		return Result({ _yay: { activityId } });
	},
});

type start_run_activity_Result =
	typeof start_run_activity extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Create upload nodes and presigned R2 PUT urls for a batch of binary files, on behalf of a
 * user API key. Lifted from the operator-only `data_import.create_upload_targets`, with the
 * node and ancestor ACL checks an API key needs (the operator flow authorizes as the
 * organization owner and skips them).
 *
 * With `skipProcessing`, created assets get `processingWorkId: null`, so the R2 event finalizer
 * records the object without starting Markdown conversion or plugin dispatch (it only starts
 * them while the field is still undefined).
 */
export const create_file_upload_targets = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/** The credential owner. */
		userId: v.id("users"),
		principalRef: file_write_principal_ref_validator,
		items: v.array(
			v.object({
				path: v.string(),
				contentType: v.string(),
				size: v.number(),
			}),
		),
		skipProcessing: v.boolean(),
		overwrite: v.union(v.literal("replace"), v.literal("fail")),
	},
	returns: v_result({
		_yay: v.array(
			v.object({
				path: v.string(),
				nodeId: v.id("files_nodes"),
				uploadUrl: v.string(),
				headers: v.record(v.string(), v.string()),
			}),
		),
		_nay: {
			data: v.object({ path: v.string() }),
		},
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		// One transactional re-check covers the whole batch. The user_api_key branch never reads
		// the path (path only matters for the plugin-run sibling constraint, and the route only
		// admits user keys), so any placeholder path works.
		const revalidated = await public_api_db_revalidate_file_write_principal(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: args.principalRef,
			path: "/",
			now,
		});
		if (revalidated._nay) {
			return revalidated;
		}

		// Keeping a file in the bucket costs real money every month, and the quota below can only
		// bill what R2 already stored, so the plan is the only door that can refuse an upload. Ask it
		// before the quota doc is seeded: a `_nay` return still commits what the mutation already
		// wrote, and a refused call must leave nothing behind. The key owner is the caller, but the
		// plan belongs to whoever pays for this workspace.
		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			const errorMessage = "principal organizationId points to a missing organizations doc";
			const errorData = { organizationId: args.organizationId, workspaceId: args.workspaceId };
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}
		const paidPlan = await billing_db_check_paid_plan(ctx, {
			userId: billing_pick_billed_user_id({ userId: args.userId, organization }),
		});
		if (!paidPlan.hasPaidPlan) {
			return Result({ _nay: { message: "This workspace's plan does not include file uploads" } });
		}

		// Validate the whole batch before any write. A `_nay` return does not roll back earlier
		// writes in the same mutation, so every fallible check runs first and the write pass below
		// only throws for impossible states (throwing does roll back).
		const leafPaths = new Set<string>();
		const validated: Array<{
			path: string;
			contentType: string;
			size: number;
			collidingNodeId: Id<"files_nodes"> | null;
		}> = [];
		for (const item of args.items) {
			// Require already-canonical paths, like the Markdown write route: accepting
			// near-canonical input here would create nodes the app's own creation flows reject.
			if (!item.path.startsWith("/") || item.path === "/" || server_path_normalize(item.path) !== item.path) {
				return Result({ _nay: { message: "Path must be absolute and normalized", data: { path: item.path } } });
			}

			// Upload names, not Markdown names: files_normalize_name("file", ...) only accepts .md,
			// while uploaded binaries keep their real extensions like the app's upload flow.
			const name = path_name_of(item.path);
			if (files_normalize_upload_file_name(name) !== name) {
				return Result({ _nay: { message: "Path ends in an invalid file name", data: { path: item.path } } });
			}
			for (const segment of path_extract_segments_from(item.path).slice(0, -1)) {
				const normalizedSegment = files_normalize_name("folder", segment);
				if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
					return Result({ _nay: { message: "Path contains an invalid folder name", data: { path: item.path } } });
				}
			}

			if (item.size > files_MAX_UPLOADS_BYTES) {
				return Result({ _nay: { message: "File too large", data: { path: item.path } } });
			}

			if (leafPaths.has(item.path)) {
				return Result({ _nay: { message: "Duplicate path in batch", data: { path: item.path } } });
			}
			leafPaths.add(item.path);

			const existingNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("path", item.path)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (existingNode) {
				// This lookup is raw on purpose, like publish_file_write: a path holds one active
				// node, so a restricted file the caller cannot see still has to block the create, or
				// two nodes would end up on one path. That makes this node-level check the only thing
				// standing between the caller and somebody else's restricted file, which `replace`
				// would archive.
				if (
					!(await has_workspace_content_permission(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.userId,
						permission: "content.write",
						fileNode: existingNode,
					}))
				) {
					return Result({ _nay: { message: "Permission denied", data: { path: item.path } } });
				}
				// Check access first so a hidden file still returns Permission denied. A read-only target
				// then stops the whole batch before any upload URL is created.
				const writable = files_node_require_writable(existingNode);
				if (writable._nay) {
					return Result({ _nay: { ...writable._nay, data: { path: item.path } } });
				}
				if (existingNode.kind !== "file") {
					return Result({ _nay: { message: "The path cannot point to a folder", data: { path: item.path } } });
				}
				if (args.overwrite === "fail") {
					return Result({ _nay: { message: "A file already exists at this path", data: { path: item.path } } });
				}
			}

			validated.push({
				path: item.path,
				// A recognized text extension stores the classifier's type and ignores the
				// caller's declared one; anything else keeps the client value (media uploads need
				// it for plugin routing).
				contentType: files_get_editable_text_content_type(name) ?? item.contentType,
				size: item.size,
				collidingNodeId: existingNode?._id ?? null,
			});
		}

		// Ancestor pass. Structural checks keep the recursive create from failing mid-write, and the
		// ACL check matters because an API key is not the organization owner: the create helper
		// itself refuses restricted folders, and by then earlier items are already written. Asking
		// here turns that case into a clean per-path refusal before anything is written.
		for (const item of validated) {
			const segments = path_extract_segments_from(item.path);
			for (let depth = 1; depth < segments.length; depth++) {
				const ancestorPath = `/${segments.slice(0, depth).join("/")}`;
				if (leafPaths.has(ancestorPath)) {
					return Result({
						_nay: { message: "Path conflicts with another item in the batch", data: { path: item.path } },
					});
				}

				const ancestor = await ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
						q
							.eq("organizationId", args.organizationId)
							.eq("workspaceId", args.workspaceId)
							.eq("path", ancestorPath)
							.eq("archiveOperationId", undefined),
					)
					.first();
				if (!ancestor) {
					continue;
				}
				// Check access before checking whether this node is a file or folder. This stops a hidden file
				// from revealing why the path failed.
				if (
					!(await access_control_db_can_act_on_file_node(ctx, {
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						userId: args.userId,
						fileNode: ancestor,
						permission: "content.write",
					}))
				) {
					return Result({ _nay: { message: "Permission denied", data: { path: item.path } } });
				}
				if (ancestor.kind !== "folder") {
					return Result({
						_nay: { message: "An intermediate segment is owned by a file", data: { path: item.path } },
					});
				}
				// A read-only parent folder stops the whole batch before quota is used or URLs are created.
				const ancestorWritable = files_node_require_writable(ancestor);
				if (ancestorWritable._nay) {
					return Result({ _nay: { ...ancestorWritable._nay, data: { path: item.path } } });
				}
			}
		}

		// Consume the declared bytes for the whole batch up front. The counter is monotonic on
		// purpose: deletes do not refund it, so it is a coarse per-workspace budget, not storage
		// accounting. Seeded lazily because existing workspaces have no doc for this quota.
		const totalDeclaredBytes = validated.reduce((sum, item) => sum + item.size, 0);
		const quotaId = await quotas_db_ensure(ctx, {
			quotaName: "public_api_upload_bytes",
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			now,
		});
		const quota = await ctx.db.get("quotas", quotaId);
		if (!quota) {
			// Unreachable: quotas_db_ensure returned this id in the same transaction.
			throw should_never_happen("quotas_db_ensure returned a missing quota doc", { quotaId });
		}
		if (quota.usedCount + totalDeclaredBytes > quota.maxCount) {
			return Result({ _nay: { message: "Upload quota exceeded" } });
		}
		await ctx.db.patch("quotas", quota._id, {
			usedCount: quota.usedCount + totalDeclaredBytes,
			updatedAt: now,
		});

		// Write pass. Items run in order so later items reuse folders created by earlier ones.
		const targets: Array<{
			path: string;
			nodeId: Id<"files_nodes">;
			uploadUrl: string;
			headers: Record<string, string>;
		}> = [];
		for (const item of validated) {
			// Uploading over a name archives whatever holds it, like create_upload_node, so re-runs
			// replace the previous upload instead of failing.
			if (item.collidingNodeId) {
				await files_nodes_db_archive_nodes(ctx, {
					nodeIds: [item.collidingNodeId],
					updatedBy: args.userId,
					now,
				});
			}

			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind: "upload",
				r2Bucket: r2_get_bucket(),
				size: item.size,
				...(args.skipProcessing ? { processingWorkId: null } : {}),
				createdBy: args.userId,
				unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
				updatedAt: now,
			});

			const nodeIdResult = await files_nodes_db_create_node_recursively_at_path(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				parentId: files_ROOT_ID,
				path: item.path,
				kind: "file",
				contentType: item.contentType,
				assetId,
				metadata: [{ key: "source", value: "api" }],
				now,
			});
			// The validation pass cleared every failure this helper can hit (collisions, ancestor
			// conflicts, restricted folders). Throw so a surprise failure rolls the whole batch back
			// instead of leaving earlier items half-created.
			if (nodeIdResult._nay) {
				const errorMessage = "create_node_recursively_at_path failed after batch validation";
				const errorData = { path: item.path, nay: nodeIdResult._nay };
				console.error(errorMessage, errorData);
				throw should_never_happen(errorMessage, errorData);
			}

			// Save the temporary key and URL expiry before returning the URL. This accepts the upload, so
			// a later read-only lock does not stop it from finishing.
			const uploadStagingR2Key = r2_create_upload_staging_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId,
			});
			await ctx.db.patch("files_r2_assets", assetId, {
				uploadStagingR2Key,
				uploadUrlExpiresAt: now + FILES_UPLOAD_URL_TTL_MS,
			});

			const signedUpload = await r2_generate_upload_url(uploadStagingR2Key);

			// The header map is the exact set the client must send with the PUT. Content-Type is a
			// convention, not signature-enforced: it keeps the stored object's metadata matching the
			// node's contentType.
			targets.push({
				path: item.path,
				nodeId: nodeIdResult._yay,
				uploadUrl: signedUpload.url,
				headers: { "Content-Type": item.contentType },
			});
		}

		return Result({ _yay: targets });
	},
});

type create_file_upload_targets_Result =
	typeof create_file_upload_targets extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Clean up a write that did not publish. Create R2 deletion jobs before deleting its temporary
 * docs. A published write has no stage doc, so this cleanup cannot delete published files.
 */
export async function public_api_db_cleanup_file_write_stage(
	ctx: MutationCtx,
	stage: Doc<"public_api_file_write_stages">,
	orphanedKeys: string[] = [],
) {
	const stagedAssetIds = [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId];
	const keys = new Set(orphanedKeys);
	for (const assetId of stagedAssetIds) {
		keys.add(
			r2_create_asset_key({
				organizationId: stage.organizationId,
				workspaceId: stage.workspaceId,
				assetId,
			}),
		);
	}

	for (const r2Key of keys) {
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			r2Key,
			reason: "failed_create",
			// The upload action may still be running. Keep the job until the stage expires. Then delete
			// the R2 file one last time.
			putMayArriveUntil: stage.expiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS,
		});
	}

	for (const assetId of stagedAssetIds) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset) {
			continue;
		}
		await ctx.db.delete("files_r2_assets", assetId);
	}

	if (stage.callId) {
		const call = await ctx.db.get("plugins_event_run_calls", stage.callId);
		// Ignore a late or repeated finish. Only a started call can finish.
		if (call && call.status === "started") {
			const now = Date.now();
			await ctx.db.patch("plugins_event_run_calls", call._id, {
				status: "failed",
				errorCode: "unpublished_write",
				errorMessage: "Write was not published",
				responseStatus: 500,
				finishedAt: now,
				elapsedMs: now - call.startedAt,
				updatedAt: now,
			});
		}
	}
	await ctx.db.delete("public_api_file_write_stages", stage._id);
}

export const cleanup_file_write_stage = internalMutation({
	args: {
		stageId: v.id("public_api_file_write_stages"),
		/**
		 * R2 keys already written by the action. A plugin run may remove the stage while those writes
		 * are still running. These keys let cleanup delete objects that arrive after the stage is gone.
		 */
		orphanedKeys: v.optional(v.array(v.string())),
		/** Organization and workspace used to clean up R2 keys after the stage doc is gone. */
		orphanedScope: v.optional(
			v.object({
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
			}),
		),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const stage = await ctx.db.get("public_api_file_write_stages", args.stageId);
		if (stage) {
			await public_api_db_cleanup_file_write_stage(ctx, stage, args.orphanedKeys);
		} else if (args.orphanedKeys?.length) {
			if (!args.orphanedScope) {
				throw should_never_happen("orphaned file write keys without their stage scope", {
					stageId: args.stageId,
				});
			}
			for (const r2Key of new Set(args.orphanedKeys)) {
				await r2_enqueue_object_deletion_job(ctx, {
					...args.orphanedScope,
					r2Key,
					reason: "failed_create",
				});
			}
		}

		return null;
	},
});

/**
 * Cron sweep for stages orphaned by an action crash between prepare and publish. Ordinary failures
 * clean their own stage inline; this only catches writes whose action never got to do so.
 */
export const cleanup_expired_file_write_stages = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const batchSize = Math.min(Math.max(args.batchSize ?? FILE_WRITE_STAGE_CLEANUP_BATCH_SIZE, 1), 100);
		const expired = await ctx.db
			.query("public_api_file_write_stages")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
			.take(batchSize);
		for (const stage of expired) {
			await public_api_db_cleanup_file_write_stage(ctx, stage);
		}

		const done = expired.length < batchSize;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.public_api.cleanup_expired_file_write_stages, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}

		return { deletedCount: expired.length, done };
	},
});

/**
 * Ask the same node-level write question `publish_file_fill` asks at commit time, for the
 * skip-if-unchanged path, which never reaches a publish mutation. Return false for a read-only file
 * so the normal write path returns 409 instead of confirming the file content with a 200 response.
 */
export const check_file_node_write_permission = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.archiveOperationId !== undefined
		) {
			return false;
		}

		if (
			!(await has_workspace_content_permission(ctx, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				permission: "content.write",
				fileNode,
			}))
		) {
			return false;
		}

		return !files_node_require_writable(fileNode)._nay;
	},
});

/**
 * Write one Markdown file: decide create-vs-fill, stage, PUT the staged objects, publish, and
 * clean the stage up on failure. Shared by the single write route and write-many. The helper
 * knows nothing about plugins: the single route maps `_nay` through its own `fail()` closure
 * (which settles the plugin call), and success-path plugin settlement lives inside the publish
 * mutations.
 */
async function write_one_markdown_file(
	ctx: ActionCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		/** Authoring user: the credential owner, or the plugin run's or service grant's actorUserId. */
		userId: Id<"users">;
		visibilityUserId: Id<"users">;
		principalRef: Infer<typeof file_write_principal_ref_validator>;
		path: string;
		content: string;
		contentBytes: number;
		overwrite: "replace" | "fail";
		skipIfUnchanged: boolean;
		/**
		 * Create the file without a collaborative document. Only used when this write creates the
		 * file: writing over a file that already exists keeps whatever mode that file has.
		 */
		nonCollaborative: boolean;
		/**
		 * Plugin principals only: create the file with a direct plugin-named lock. Only used when
		 * this write creates the file; filling an existing file keeps its lock state.
		 */
		requestReadOnly: boolean;
	},
) {
	// Decide create-vs-fill before staging. Writing over an existing editable Markdown
	// file replaces its content in place so the nodeId stays stable for open editors and
	// links; only non-editable targets (e.g. stored uploads) keep the archive-and-recreate
	// path in publish_file_write. The publish mutations re-check the node transactionally.
	const activeNode = (await ctx.runQuery(internal.files_nodes.get_by_path, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		visibilityUserId: args.visibilityUserId,
		path: args.path,
	})) as files_nodes_get_by_path_Result;
	if (activeNode?.kind === "folder") {
		return Result({
			_nay: {
				name: "nay",
				message: "A folder already exists at this path",
				data: { status: 409, errorCode: "conflict" },
			},
		});
	}
	if (activeNode && args.overwrite === "fail") {
		return Result({
			_nay: {
				name: "nay",
				message: "A file already exists at this path",
				data: { status: 409, errorCode: "conflict" },
			},
		});
	}
	// Fill-in-place branch for a non-collaborative file. There is no document to project the new
	// text into, so this is a plain content swap. Without this branch the write would fall to the
	// create path below and archive the file to recreate it, which changes the nodeId on every
	// re-import.
	if (activeNode?.nonCollaborative === true && files_node_has_editable_text_content(activeNode)) {
		// Re-running an import must not mint a new version for a file whose text did not change.
		// A service never takes this shortcut: its proof that it created the file lives in the
		// publish mutation, and a 200 here would let a service confirm the exact content of a
		// member file inside its destination.
		if (args.skipIfUnchanged && args.principalRef.kind !== "plugin_service") {
			const current = (await ctx.runQuery(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.visibilityUserId,
				path: args.path,
				mode: { kind: "full", maxBytes: files_MAX_TEXT_CONTENT_BYTES },
			})) as files_nodes_read_file_content_from_chunks_Result;
			// Skip only when the commit-time write check would also say yes. When it says no, fall
			// through so the caller gets the same refusal a plain write gets. A 200 here would let
			// a caller who cannot write the node confirm its exact content.
			if (current?.content === args.content) {
				const canWriteNode = (await ctx.runQuery(internal.public_api.check_file_node_write_permission, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					nodeId: activeNode._id,
				})) as boolean;
				if (canWriteNode) {
					return Result({ _yay: { nodeId: activeNode._id, wroteInPlace: true, unchanged: true } });
				}
			}
		}

		const prepared: prepare_file_write_Result = await ctx.runMutation(internal.public_api.prepare_file_write, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			principalRef: args.principalRef,
			path: args.path,
			overwrite: args.overwrite,
			contentSize: args.contentBytes,
			// This path never uploads a Yjs snapshot object; publish_file_fill drops the staged
			// asset doc.
			yjsSnapshotSize: 0,
		});
		if (prepared._nay) {
			if (prepared._nay.message === "Permission denied") {
				return Result({
					_nay: {
						name: "nay",
						message: prepared._nay.message,
						data: { status: 403, errorCode: "permission_denied" },
					},
				});
			}
			// A locked target is a conflict, not a permission error. A permission error would stop the
			// whole batch. A conflict stops only this item.
			if (prepared._nay.name === "read_only") {
				return Result({
					_nay: { name: "nay", message: prepared._nay.message, data: { status: 409, errorCode: "conflict" } },
				});
			}
			return Result({
				_nay: { name: "nay", message: prepared._nay.message, data: { status: 401, errorCode: "unauthenticated" } },
			});
		}

		if (prepared._yay.targetAnchor.kind !== "existing" || prepared._yay.targetAnchor.nodeId !== activeNode._id) {
			await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
				stageId: prepared._yay.stageId,
				orphanedKeys: [],
			});
			return Result({
				_nay: {
					name: "nay",
					message: "The file changed during the write",
					data: { status: 409, errorCode: "conflict" },
				},
			});
		}

		const contentSnapshotKey = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: prepared._yay.contentSnapshotAssetId,
		});
		try {
			await r2_put_object(ctx, {
				key: contentSnapshotKey,
				body: args.content,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			});
		} catch (error) {
			console.error("Failed to write staged file object", {
				error,
				stageId: prepared._yay.stageId,
				path: args.path,
			});
			await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
				stageId: prepared._yay.stageId,
				orphanedKeys: [contentSnapshotKey],
				orphanedScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
			});
			return Result({
				_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
			});
		}

		const published: publish_file_fill_Result = await ctx.runMutation(internal.public_api.publish_file_fill, {
			stageId: prepared._yay.stageId,
			content: args.content,
			expectedNodeId: activeNode._id,
			nonCollaborative: true,
		});
		if (published._nay) {
			// Conflict is the fallback: structural 409s pass their specific message through,
			// while the auth and storage failures use fixed literals.
			const failure =
				published._nay.message === "Unauthenticated"
					? { status: 401 as const, errorCode: "unauthenticated" as const }
					: published._nay.message === "Permission denied"
						? { status: 403 as const, errorCode: "permission_denied" as const }
						: published._nay.message === "Write was not published"
							? { status: 500 as const, errorCode: "storage_failure" as const }
							: { status: 409 as const, errorCode: "conflict" as const };
			// A read-only refusal already cleaned up the stage during publish. Running cleanup again
			// would change the plugin call to the wrong unpublished_write/500 error.
			if (published._nay.name !== "read_only" && published._nay.name !== "stale_write") {
				await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
					stageId: prepared._yay.stageId,
					orphanedKeys: [contentSnapshotKey],
					orphanedScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
				});
			}
			return Result({ _nay: { name: "nay", message: published._nay.message, data: failure } });
		}

		return Result({ _yay: { nodeId: published._yay.nodeId, wroteInPlace: true, unchanged: false } });
	}

	// Fill-in-place branch. A null materialization state means the node was archived or
	// replaced between the two queries; the create path below then handles the write.
	if (activeNode && files_node_has_editable_yjs_state(activeNode)) {
		const materializationState = (await ctx.runQuery(internal.files_nodes.get_file_content_materialization_state, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: activeNode._id,
		})) as get_file_content_materialization_state_Result;
		if (materializationState) {
			const currentContent = await files_nodes_reconstruct_latest_file_content_from_materialization_state({
				state: materializationState,
			});
			if (currentContent._nay) {
				console.error("Failed to reconstruct current file content for public file write", {
					nay: currentContent._nay,
					path: args.path,
				});
				return Result({
					_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
				});
			}

			// Mirror the snapshot-restore recipe: project the new text into the current
			// doc and diff against the pre-projection state vector, so open editor sessions
			// converge on the new content instead of being detached by a node swap.
			const yjsBeforeStateVector = encodeStateVector(currentContent._yay.yjsDoc);
			const projectedYjsDoc = files_yjs_doc_update_from_text({
				mut_yjsDoc: currentContent._yay.yjsDoc,
				text: args.content,
				// The node in hand owns the shape (the route's `.md` gate makes it rich text today,
				// but the shape must come from the node, never from the route).
				rootKind: activeNode.yjsRootKind,
			});
			if (projectedYjsDoc._nay) {
				console.error("Failed to project public file write content into the Yjs doc", {
					nay: projectedYjsDoc._nay,
					path: args.path,
				});
				return Result({
					_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
				});
			}
			const fillUpdate = files_yjs_compute_diff_update_from_state_vector({
				yjsDoc: projectedYjsDoc._yay,
				yjsBeforeStateVector,
			});

			// Re-running an import must not mint new versions for files whose content did not
			// change. A null diff means projecting the incoming Markdown was a semantic no-op,
			// so return before staging: no stage, no asset docs, no uploads, no version snapshot.
			// A service never takes this shortcut: its proof that it created the file lives in
			// the publish mutation, and a 200 here would let a service confirm the exact content
			// of a member file inside its destination.
			if (args.skipIfUnchanged && fillUpdate === null && args.principalRef.kind !== "plugin_service") {
				// Skip only when the commit-time write check would also say yes. When it says no,
				// fall through to the normal write path so the caller gets the same refusal a plain
				// write gets — a 200 here would let a caller who cannot write the node confirm its
				// exact content through the unchanged marker.
				const canWriteNode = (await ctx.runQuery(internal.public_api.check_file_node_write_permission, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					nodeId: activeNode._id,
				})) as boolean;
				if (canWriteNode) {
					return Result({ _yay: { nodeId: activeNode._id, wroteInPlace: true, unchanged: true } });
				}
			}

			const prepared: prepare_file_write_Result = await ctx.runMutation(internal.public_api.prepare_file_write, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				principalRef: args.principalRef,
				path: args.path,
				overwrite: args.overwrite,
				contentSize: args.contentBytes,
				// The fill path never uploads a Yjs snapshot object; publish_file_fill drops
				// the staged asset doc.
				yjsSnapshotSize: 0,
			});
			if (prepared._nay) {
				if (prepared._nay.message === "Permission denied") {
					return Result({
						_nay: {
							name: "nay",
							message: prepared._nay.message,
							data: { status: 403, errorCode: "permission_denied" },
						},
					});
				}
				// A locked target is a conflict, not a permission error. A permission error would stop the
				// whole batch. A conflict stops only this item.
				if (prepared._nay.name === "read_only") {
					return Result({
						_nay: { name: "nay", message: prepared._nay.message, data: { status: 409, errorCode: "conflict" } },
					});
				}
				return Result({
					_nay: { name: "nay", message: prepared._nay.message, data: { status: 401, errorCode: "unauthenticated" } },
				});
			}

			// The fill diff above belongs to this exact node. If prepare found a different target, the
			// old diff is not safe to use. Return the same conflict as publish_file_fill.
			if (prepared._yay.targetAnchor.kind !== "existing" || prepared._yay.targetAnchor.nodeId !== activeNode._id) {
				await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
					stageId: prepared._yay.stageId,
					orphanedKeys: [],
				});
				return Result({
					_nay: {
						name: "nay",
						message: "The file changed during the write",
						data: { status: 409, errorCode: "conflict" },
					},
				});
			}
			const contentSnapshotKey = r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: prepared._yay.contentSnapshotAssetId,
			});
			try {
				await r2_put_object(ctx, {
					key: contentSnapshotKey,
					body: args.content,
					contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
				});
			} catch (error) {
				console.error("Failed to write staged file object", {
					error,
					stageId: prepared._yay.stageId,
					path: args.path,
				});
				await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
					stageId: prepared._yay.stageId,
					orphanedKeys: [contentSnapshotKey],
					orphanedScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
				});
				return Result({
					_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
				});
			}

			// Move the server-built diff through a 30-minute trusted `public_fill` stage and hand
			// the publish mutation only its id, so the registered call carries one large value
			// (the content text). An abandoned stage falls to the TTL sweep.
			let fillUpdateStageId: Id<"files_yjs_trusted_update_stages"> | undefined;
			if (fillUpdate) {
				const staged = (await ctx.runMutation(internal.files_pending_updates.stage_trusted_yjs_update, {
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					userId: args.userId,
					nodeId: activeNode._id,
					kind: "public_fill",
					update: files_u8_to_array_buffer(fillUpdate),
				})) as stage_trusted_yjs_update_LocalResult;
				if (staged._nay) {
					console.error("Failed to stage the public file write fill update", {
						nay: staged._nay,
						path: args.path,
					});
					await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
						stageId: prepared._yay.stageId,
						orphanedKeys: [contentSnapshotKey],
						orphanedScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
					});
					return Result({
						_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
					});
				}
				fillUpdateStageId = staged._yay.stageId;
			}

			const published: publish_file_fill_Result = await ctx.runMutation(internal.public_api.publish_file_fill, {
				stageId: prepared._yay.stageId,
				content: args.content,
				expectedNodeId: activeNode._id,
				expectedYjsLastSequenceId: materializationState.yjsLastSequenceDoc._id,
				...(fillUpdateStageId ? { fillUpdateStageId } : {}),
			});
			if (published._nay) {
				// Conflict is the fallback: structural 409s pass their specific message through,
				// while the auth and storage failures use fixed literals.
				const failure =
					published._nay.message === "Unauthenticated"
						? { status: 401 as const, errorCode: "unauthenticated" as const }
						: published._nay.message === "Permission denied"
							? { status: 403 as const, errorCode: "permission_denied" as const }
							: published._nay.message === "Write was not published"
								? { status: 500 as const, errorCode: "storage_failure" as const }
								: { status: 409 as const, errorCode: "conflict" as const };
				// A read-only refusal already cleaned up the stage during publish. Running cleanup again
				// would change the plugin call to the wrong unpublished_write/500 error.
				if (published._nay.name !== "read_only" && published._nay.name !== "stale_write") {
					await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
						stageId: prepared._yay.stageId,
						orphanedKeys: [contentSnapshotKey],
						orphanedScope: { organizationId: args.organizationId, workspaceId: args.workspaceId },
					});
				}
				return Result({
					_nay: { name: "nay", message: published._nay.message, data: failure },
				});
			}

			return Result({ _yay: { nodeId: published._yay.nodeId, wroteInPlace: true, unchanged: false } });
		}
	}

	// A non-collaborative file is created with committed content only, so there is no document to
	// build and nothing to upload to the Yjs snapshot key.
	let snapshotUpdate: ArrayBuffer | null = null;
	if (!args.nonCollaborative) {
		const built = files_nodes_create_yjs_snapshot_update_from_text({
			text: args.content,
			// The public write route is `.md`-gated (non-goal 4), so the created document is rich
			// text by definition.
			rootKind: "rich_text",
		});
		if (built._nay) {
			console.error("Failed to build Yjs snapshot for public file write", {
				nay: built._nay,
				path: args.path,
			});
			return Result({
				_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
			});
		}
		snapshotUpdate = built._yay;
	}

	const prepared: prepare_file_write_Result = await ctx.runMutation(internal.public_api.prepare_file_write, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		principalRef: args.principalRef,
		path: args.path,
		overwrite: args.overwrite,
		contentSize: args.contentBytes,
		yjsSnapshotSize: snapshotUpdate?.byteLength ?? 0,
	});
	if (prepared._nay) {
		if (prepared._nay.message === "Permission denied") {
			return Result({
				_nay: { name: "nay", message: prepared._nay.message, data: { status: 403, errorCode: "permission_denied" } },
			});
		}
		// A locked target or parent is a conflict, not a permission error. A permission error would
		// stop the whole batch. A conflict stops only this item.
		if (prepared._nay.name === "read_only") {
			return Result({
				_nay: { name: "nay", message: prepared._nay.message, data: { status: 409, errorCode: "conflict" } },
			});
		}
		return Result({
			_nay: { name: "nay", message: prepared._nay.message, data: { status: 401, errorCode: "unauthenticated" } },
		});
	}

	const stageId = prepared._yay.stageId;
	const stageScope = { organizationId: args.organizationId, workspaceId: args.workspaceId };
	const yjsSnapshotKey = r2_create_asset_key({ ...stageScope, assetId: prepared._yay.yjsSnapshotAssetId });
	const contentSnapshotKey = r2_create_asset_key({
		...stageScope,
		assetId: prepared._yay.contentSnapshotAssetId,
	});
	// A plugin run may remove the stage before these R2 writes finish. Keep the exact keys so cleanup
	// can still remove objects that arrive after the stage is gone.
	const orphanedKeys = snapshotUpdate ? [yjsSnapshotKey, contentSnapshotKey] : [contentSnapshotKey];
	// Wait for both writes before cleanup. Otherwise one failed write could start cleanup while the
	// other write is still running, and the late object would have no remaining cleanup owner.
	const putResults = await Promise.allSettled([
		snapshotUpdate
			? r2_put_object(ctx, {
					key: yjsSnapshotKey,
					body: snapshotUpdate,
					contentType: "application/octet-stream" satisfies files_ContentType,
				})
			: Promise.resolve(null),
		r2_put_object(ctx, {
			key: contentSnapshotKey,
			body: args.content,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
		}),
	]);
	const putFailure = putResults.find((result) => result.status === "rejected");
	if (putFailure) {
		console.error("Failed to write staged file objects", {
			error: putFailure.reason,
			stageId,
			path: args.path,
		});
		await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
			stageId,
			orphanedKeys,
			orphanedScope: stageScope,
		});
		return Result({
			_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
		});
	}

	const published: publish_file_write_Result = await ctx.runMutation(internal.public_api.publish_file_write, {
		stageId,
		content: args.content,
		targetAnchor: prepared._yay.targetAnchor,
		nonCollaborative: args.nonCollaborative,
		...(args.requestReadOnly ? { requestReadOnly: true } : {}),
	});
	if (published._nay) {
		// Conflict is the fallback: structural 409s pass their specific message through,
		// while the auth and storage failures use fixed literals.
		const failure =
			published._nay.message === "Unauthenticated"
				? { status: 401 as const, errorCode: "unauthenticated" as const }
				: published._nay.message === "Permission denied"
					? { status: 403 as const, errorCode: "permission_denied" as const }
					: published._nay.message === "Write was not published"
						? { status: 500 as const, errorCode: "storage_failure" as const }
						: { status: 409 as const, errorCode: "conflict" as const };
		// A read-only refusal already cleaned up the stage during publish. Running cleanup again
		// would change the plugin call to the wrong unpublished_write/500 error.
		if (published._nay.name !== "read_only" && published._nay.name !== "stale_write") {
			await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
				stageId,
				orphanedKeys,
				orphanedScope: stageScope,
			});
		}
		return Result({
			_nay: { name: "nay", message: published._nay.message, data: failure },
		});
	}

	return Result({ _yay: { nodeId: published._yay.nodeId, wroteInPlace: false, unchanged: false } });
}

// HTTP routes

const read_file_body_validator = z.object({
	path: z.string(),
	maxBytes: z.number().int().min(1).optional(),
});

export type public_api_http_read_file_Body = z.infer<typeof read_file_body_validator>;

export async function public_api_http_read_file(ctx: ActionCtx, request: Request, path: "/api/v1/files/read") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:read" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "public_api_grant", "plugin_ui", "plugin_run"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	// Authorizing consumed a plugin run's call slot, and a run that ends with a call still open is
	// failed as "Plugin left API calls unfinished". So every branch below settles it, including the
	// successful one.
	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	const body = await server_request_json_parse_and_validate(request, read_file_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	const requestedPath = server_path_normalize(body._yay.path);
	if (requestedPath === "/") {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Path must point to a file.", errorCode: "invalid_input" }),
		} as const;
	}
	if (!public_api_is_path_inside_prefix(requestedPath, principal.pathPrefix)) {
		return {
			status: 403,
			body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
		} as const;
	}

	const content = await ctx.runAction(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		// A plugin run has no user of its own, so it reads with its actor's eyes.
		userId: public_api_visibility_user_id(principal),
		path: requestedPath,
		includePending: principal.kind === "public_api_grant",
		maxBytes: Math.min(body._yay.maxBytes ?? FILES_READ_MAX_BYTES, FILES_READ_MAX_BYTES),
	});
	if (!content) {
		return {
			status: 404,
			body: await fail({
				status: 404,
				message: "File not found or exceeds the read limit.",
				errorCode: "not_found",
			}),
		} as const;
	}

	const bytes = TEXT_ENCODER.encode(content.content).length;
	console.info("Public API file read", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		bytes,
	});

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
		responseBytes: bytes,
	});

	return {
		status: 200,
		body: {
			path: requestedPath,
			nodeId: content.displayNodeId,
			content: content.content,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const read_many_body_validator = z.object({
	paths: z.array(z.string()).min(1),
	maxBytes: z.number().int().min(1).optional(),
});

export type public_api_http_read_many_Body = z.infer<typeof read_many_body_validator>;

export async function public_api_http_read_many(ctx: ActionCtx, request: Request, path: "/api/v1/files/read-many") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:read" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "public_api_grant"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, read_many_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const requestedPaths = body._yay.paths
		.slice(0, FILES_READ_MANY_MAX_ITEMS)
		.map((filePath) => server_path_normalize(filePath));
	if (requestedPaths.some((filePath) => filePath === "/")) {
		return { status: 400, body: { message: "Paths must point to files." } } as const;
	}
	if (requestedPaths.some((filePath) => !public_api_is_path_inside_prefix(filePath, principal.pathPrefix))) {
		return { status: 403, body: { message: "Permission denied" } } as const;
	}

	const maxBytes = Math.min(body._yay.maxBytes ?? FILES_READ_MAX_BYTES, FILES_READ_MAX_BYTES);
	const contents = await Promise.all(
		requestedPaths.map(async (filePath) => ({
			path: filePath,
			content: await ctx.runAction(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				userId: principal.userId,
				path: filePath,
				includePending: principal.kind === "public_api_grant",
				maxBytes,
			}),
		})),
	);

	let contentBytes = 0;
	const pathsTruncated = body._yay.paths.length > requestedPaths.length;
	let contentTruncated = false;
	const files: Array<{
		path: string;
		nodeId: string;
		content: string;
	}> = [];
	const errors: Array<{ path: string; message: string }> = [];

	for (const item of contents) {
		if (!item.content) {
			errors.push({
				path: item.path,
				message: "File not found or exceeds the read limit.",
			});
			continue;
		}

		const nextContentBytes = TEXT_ENCODER.encode(item.content.content).length;
		if (contentBytes + nextContentBytes > FILES_READ_MANY_MAX_CONTENT_BYTES) {
			contentTruncated = true;
			break;
		}

		contentBytes += nextContentBytes;
		files.push({
			path: item.path,
			nodeId: item.content.displayNodeId,
			content: item.content.content,
		});
	}

	console.info("Public API files read", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		count: files.length,
		errorCount: errors.length,
		truncated: pathsTruncated || contentTruncated,
		bytes: contentBytes,
	});

	return {
		status: 200,
		body: {
			files,
			errors,
			truncated: pathsTruncated || contentTruncated,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const write_file_body_validator = z.object({
	path: z.string(),
	content: z.string(),
	overwrite: z.enum(["replace", "fail"]).optional(),
	skipIfUnchanged: z.boolean().optional(),
	/**
	 * Create the file with no collaborative document: its text lives only in the committed
	 * content, and a later write replaces the whole text. Absent or `false` creates the normal
	 * collaborative file. Only read when this write creates the file; writing over a file that
	 * already exists keeps whatever mode that file has.
	 */
	nonCollaborative: z.boolean().optional(),
	/**
	 * Plugin principals only. `readOnly: true` creates the file with a direct plugin-named lock;
	 * it does nothing when the write fills an existing file. The consent behind it is checked
	 * transactionally at publish time.
	 */
	access: z.object({ readOnly: z.boolean().optional() }).optional(),
});

export type public_api_http_write_file_Body = z.infer<typeof write_file_body_validator>;

export async function public_api_http_write_file(ctx: ActionCtx, request: Request, path: "/api/v1/files/write") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_service"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	// Settles the consumed plugin call and builds the error body in one step; the
	// caller supplies the matching literal status so the response union stays narrow.
	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	const body = await server_request_json_parse_and_validate(request, write_file_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	if (!body._yay.path.startsWith("/")) {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Path must be absolute.", errorCode: "invalid_input" }),
		} as const;
	}
	const requestedPath = server_path_normalize(body._yay.path);
	if (requestedPath === "/") {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Path must point to a file.", errorCode: "invalid_input" }),
		} as const;
	}
	// Segment-aware: a raw lastIndexOf("/") would split inside an escaped-slash segment and
	// validate a different name than the segment the node is created with.
	const name = path_name_of(requestedPath);
	const normalizedName = files_normalize_name("file", name);
	if (!name.toLowerCase().endsWith(".md") || normalizedName._nay || normalizedName._yay !== name) {
		return {
			status: 400,
			body: await fail({
				status: 400,
				message: "Path must end in a valid Markdown (.md) file name.",
				errorCode: "invalid_input",
			}),
		} as const;
	}
	// Intermediate folders are created verbatim on publish; require already-canonical
	// names so a user-key write cannot materialize folders (e.g. "..") that the app's
	// own creation flows would reject.
	for (const segment of path_extract_segments_from(requestedPath).slice(0, -1)) {
		const normalizedSegment = files_normalize_name("folder", segment);
		if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
			return {
				status: 400,
				body: await fail({
					status: 400,
					message: "Path contains an invalid folder name.",
					errorCode: "invalid_input",
				}),
			} as const;
		}
	}
	// Normalize at the request boundary, above the byte count and the fan-out:
	// the document, the R2 content snapshot, the committed chunks, and the stored size
	// must all see the same LF-normalized, BOM-stripped string.
	const content = files_normalize_text_document_input(body._yay.content);
	if (content.length === 0) {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Content must not be empty.", errorCode: "invalid_input" }),
		} as const;
	}
	const contentBytes = files_get_utf8_byte_size(content);
	if (contentBytes > files_MAX_TEXT_CONTENT_BYTES) {
		return {
			status: 400,
			body: await fail({
				status: 400,
				message: `Content exceeds the ${files_MAX_TEXT_CONTENT_BYTES}-byte limit.`,
				errorCode: "invalid_input",
			}),
		} as const;
	}
	// Upload-triggered plugins may only create Markdown siblings of their triggering file; the
	// same constraint is revalidated transactionally at prepare and publish time. An invoke run
	// has no source file (`outputParentPath` is null); its authority is the plugin's stamped area,
	// which only the transactional checks can prove, so it passes here. A non-invoke run with no
	// source never carries the `files:write` scope, so it never reaches this line.
	if (
		principal.kind === "plugin_run" &&
		principal.outputParentPath !== null &&
		server_path_parent_of(requestedPath) !== principal.outputParentPath
	) {
		return {
			status: 403,
			body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
		} as const;
	}
	// A service writes only inside the destination its grant was sealed to, and only in the
	// processing phase — the same fence as the service upload routes. Revalidated transactionally
	// at prepare and publish time.
	if (
		principal.kind === "plugin_service" &&
		(principal.phase !== "processing" || !public_api_is_path_inside_prefix(requestedPath, principal.pathPrefix))
	) {
		return {
			status: 403,
			body: await fail({
				status: 403,
				message: "Path is outside this grant's destination",
				errorCode: "permission_denied",
			}),
		} as const;
	}
	// The `access` option is a plugin feature: a user key holder locks files through the app.
	if (body._yay.access?.readOnly === true && principal.kind === "user_api_key") {
		return {
			status: 403,
			body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
		} as const;
	}
	const overwrite = body._yay.overwrite ?? "replace";

	// Nothing is free: a public-API write costs the same one cent a member's save costs.
	// The gate sits at the route, not inside `prepare_file_write`, because `touch` shares that
	// mutation and touch stays free (the app's sidebar create of an empty file is free too).
	const credits = await ctx.runQuery(internal.billing.check_credits, {
		userId: public_api_visibility_user_id(principal),
		organizationId: principal.organizationId,
		minimumRequiredCents: 1,
	});
	if (!credits.hasCredits) {
		return {
			status: 402,
			body: await fail({ status: 402, message: "Insufficient funds", errorCode: "insufficient_funds" }),
		} as const;
	}

	let principalRef: Infer<typeof file_write_principal_ref_validator>;
	if (principal.kind === "plugin_run") {
		if (!pluginCallId) {
			// Unreachable: public API authorization creates the call for plugin principals.
			throw should_never_happen("plugin_run write without a consumed call", {
				runId: principal.runId,
			});
		}
		principalRef = { kind: "plugin_run", runId: principal.runId, callId: pluginCallId };
	} else if (principal.kind === "plugin_service") {
		principalRef = { kind: "plugin_service", grantId: principal.grantId };
	} else {
		principalRef = { kind: "user_api_key", credentialId: principal.credentialId };
	}

	const written = await write_one_markdown_file(ctx, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: public_api_visibility_user_id(principal),
		visibilityUserId: public_api_visibility_user_id(principal),
		principalRef,
		path: requestedPath,
		content,
		contentBytes,
		overwrite,
		skipIfUnchanged: body._yay.skipIfUnchanged ?? false,
		nonCollaborative: body._yay.nonCollaborative ?? false,
		requestReadOnly: body._yay.access?.readOnly === true,
	});
	if (written._nay) {
		const failBody = await fail({
			status: written._nay.data.status,
			message: written._nay.message,
			errorCode: written._nay.data.errorCode,
		});
		// Branch per literal so the response union keeps exact status literals.
		if (written._nay.data.status === 409) {
			return { status: 409, body: failBody } as const;
		}
		if (written._nay.data.status === 403) {
			return { status: 403, body: failBody } as const;
		}
		if (written._nay.data.status === 401) {
			return { status: 401, body: failBody } as const;
		}
		return { status: 500, body: failBody } as const;
	}

	// A skipped write is a success for the caller and for a plugin call, but no
	// publish mutation ran, so settle the plugin call here.
	if (written._yay.unchanged) {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "succeeded",
			responseStatus: 200,
		});
		console.info("Public API file write skipped as unchanged", {
			principalKind: principal.kind,
			principalKey: principal.principalKey,
			bytes: contentBytes,
		});
		return {
			status: 200,
			body: {
				path: requestedPath,
				nodeId: written._yay.nodeId,
				contentType: "text/markdown;charset=utf-8" as const,
				unchanged: true as const,
			},
			headers: { "Cache-Control": "no-store" },
		} as const;
	}

	if (written._yay.wroteInPlace) {
		console.info("Public API file written in place", {
			principalKind: principal.kind,
			principalKey: principal.principalKey,
			bytes: contentBytes,
		});
	} else {
		console.info("Public API file written", {
			principalKind: principal.kind,
			principalKey: principal.principalKey,
			bytes: contentBytes,
		});
	}

	return {
		status: 200,
		body: {
			path: requestedPath,
			nodeId: written._yay.nodeId,
			contentType: "text/markdown;charset=utf-8" as const,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const write_many_body_validator = z.object({
	files: z
		.array(
			z.object({
				path: z.string(),
				content: z.string(),
				overwrite: z.enum(["replace", "fail"]).optional(),
				/** Same meaning as on the single write route. */
				nonCollaborative: z.boolean().optional(),
			}),
		)
		.min(1)
		.max(FILES_WRITE_MANY_MAX_ITEMS),
	skipIfUnchanged: z.boolean().optional(),
});

export type public_api_http_write_many_Body = z.infer<typeof write_many_body_validator>;

export async function public_api_http_write_many(ctx: ActionCtx, request: Request, path: "/api/v1/files/write-many") {
	// Authenticate before buffering: the request cap is large (many files), so only
	// a valid write credential gets to make the server read that much body.
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const declaredBytes = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > FILES_WRITE_MANY_MAX_REQUEST_BYTES) {
		return { status: 400, body: { message: "Request body is too large" } } as const;
	}
	const bodyText = await read_request_text_bounded(request, FILES_WRITE_MANY_MAX_REQUEST_BYTES);
	if (bodyText === null) {
		return { status: 400, body: { message: "Request body is too large" } } as const;
	}
	let bodyJson: unknown;
	try {
		bodyJson = JSON.parse(bodyText);
	} catch {
		return { status: 400, body: { message: "Failed to parse request body as JSON" } } as const;
	}
	const body = write_many_body_validator.safeParse(bodyJson);
	if (!body.success) {
		return { status: 400, body: { message: "Request body validation failed" } } as const;
	}

	// Validate every item with the single-route rules before writing anything, so a
	// bad batch fails whole instead of stopping half-written. Later per-item failures
	// (permission, conflict, storage) still report per item because they depend on
	// workspace state, not on the request shape.
	const validatedFiles: Array<{
		path: string;
		content: string;
		contentBytes: number;
		overwrite: "replace" | "fail";
		nonCollaborative: boolean;
	}> = [];
	const seenPaths = new Set<string>();
	for (const file of body.data.files) {
		if (!file.path.startsWith("/")) {
			return { status: 400, body: { message: "Path must be absolute.", path: file.path } } as const;
		}
		const requestedPath = server_path_normalize(file.path);
		if (requestedPath === "/") {
			return { status: 400, body: { message: "Path must point to a file.", path: file.path } } as const;
		}
		const name = path_name_of(requestedPath);
		const normalizedName = files_normalize_name("file", name);
		if (!name.toLowerCase().endsWith(".md") || normalizedName._nay || normalizedName._yay !== name) {
			return {
				status: 400,
				body: { message: "Path must end in a valid Markdown (.md) file name.", path: file.path },
			} as const;
		}
		// Intermediate folders are created verbatim on publish; require already-canonical
		// names so a write cannot materialize folders the app's own flows would reject.
		for (const segment of path_extract_segments_from(requestedPath).slice(0, -1)) {
			const normalizedSegment = files_normalize_name("folder", segment);
			if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
				return {
					status: 400,
					body: { message: "Path contains an invalid folder name.", path: file.path },
				} as const;
			}
		}
		// Normalize at the request boundary, above the byte count and the fan-out.
		// the same rule as the single-file write route.
		const content = files_normalize_text_document_input(file.content);
		if (content.length === 0) {
			return { status: 400, body: { message: "Content must not be empty.", path: file.path } } as const;
		}
		const contentBytes = files_get_utf8_byte_size(content);
		if (contentBytes > files_MAX_TEXT_CONTENT_BYTES) {
			return {
				status: 400,
				body: {
					message: `Content exceeds the ${files_MAX_TEXT_CONTENT_BYTES}-byte limit.`,
					path: file.path,
				},
			} as const;
		}
		// Compare normalized paths so two spellings of one path cannot race each other
		// inside the same batch.
		if (seenPaths.has(requestedPath)) {
			return { status: 400, body: { message: "Duplicate path in batch", path: file.path } } as const;
		}
		seenPaths.add(requestedPath);
		validatedFiles.push({
			path: requestedPath,
			content,
			contentBytes,
			overwrite: file.overwrite ?? "replace",
			nonCollaborative: file.nonCollaborative ?? false,
		});
	}

	// One up-front charge on the bulk bucket, one token per file, before any write:
	// an over-budget batch gets a whole-request 429 with zero files staged.
	const batchRateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_files_write_bulk",
		key: `${principal.kind}:${principal.principalKey}`,
		count: validatedFiles.length,
	});
	if (batchRateLimit) {
		return {
			status: 429,
			body: { message: batchRateLimit.message, retryAfterMs: batchRateLimit.retryAfterMs },
		} as const;
	}

	// Nothing is free: one credit gate for the whole batch, before any file is staged. There is
	// no per-item re-check — the payer is signed in (user-key route), and the synced balance
	// cannot move during the batch from the batch's own events.
	const credits = await ctx.runQuery(internal.billing.check_credits, {
		userId: public_api_visibility_user_id(principal),
		organizationId: principal.organizationId,
		minimumRequiredCents: 1,
	});
	if (!credits.hasCredits) {
		return { status: 402, body: { message: "Insufficient funds" } } as const;
	}

	const principalRef: Infer<typeof file_write_principal_ref_validator> = {
		kind: "user_api_key",
		credentialId: principal.credentialId,
	};

	// Sequential on purpose: writes into one workspace share ancestor folders, and
	// concurrent publishes would conflict on creating them.
	const written: Array<{
		path: string;
		nodeId: Id<"files_nodes">;
		contentType: "text/markdown;charset=utf-8";
		unchanged?: true;
	}> = [];
	const errors: Array<{
		path: string;
		message: string;
		errorCode: "permission_denied" | "conflict" | "storage_failure";
	}> = [];
	for (const file of validatedFiles) {
		const result = await write_one_markdown_file(ctx, {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId: principal.userId,
			visibilityUserId: public_api_visibility_user_id(principal),
			principalRef,
			path: file.path,
			content: file.content,
			contentBytes: file.contentBytes,
			overwrite: file.overwrite,
			skipIfUnchanged: body.data.skipIfUnchanged ?? false,
			nonCollaborative: file.nonCollaborative ?? false,
			// Write-many stays a user-key route, and the lock option is a plugin feature.
			requestReadOnly: false,
		});
		if (result._nay) {
			// The credential died mid-batch (expired or revoked); every remaining item
			// would fail the same way, so abort the whole request.
			if (result._nay.data.errorCode === "unauthenticated") {
				return { status: 401, body: { message: result._nay.message } } as const;
			}
			errors.push({
				path: file.path,
				message: result._nay.message,
				errorCode: result._nay.data.errorCode,
			});
			continue;
		}
		written.push({
			path: file.path,
			nodeId: result._yay.nodeId,
			contentType: "text/markdown;charset=utf-8" as const,
			...(result._yay.unchanged ? { unchanged: true as const } : {}),
		});
	}

	console.info("Public API files written in batch", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		writtenCount: written.length,
		errorCount: errors.length,
	});

	return {
		status: 200,
		body: { written, errors },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const touch_files_body_validator = z.object({
	paths: z.array(z.string()).min(1).max(FILES_TOUCH_MAX_PATHS),
});

export type public_api_http_touch_files_Body = z.infer<typeof touch_files_body_validator>;

export async function public_api_http_touch_files(ctx: ActionCtx, request: Request, path: "/api/v1/files/touch") {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	// Settles the consumed plugin call and builds the error body in one step; the
	// caller supplies the matching literal status so the response union stays narrow.
	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	const body = await server_request_json_parse_and_validate(request, touch_files_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	// Validate every path with the same rules as /api/v1/files/write before touching
	// anything, so a bad batch creates no files at all.
	const requestedPaths: string[] = [];
	for (const rawPath of body._yay.paths) {
		if (!rawPath.startsWith("/")) {
			return {
				status: 400,
				body: await fail({ status: 400, message: "Path must be absolute.", errorCode: "invalid_input" }),
			} as const;
		}
		const requestedPath = server_path_normalize(rawPath);
		if (requestedPath === "/") {
			return {
				status: 400,
				body: await fail({
					status: 400,
					message: "Path must point to a file.",
					errorCode: "invalid_input",
				}),
			} as const;
		}
		// Segment-aware: a raw lastIndexOf("/") would split inside an escaped-slash segment and
		// validate a different name than the segment the node is created with.
		const name = path_name_of(requestedPath);
		const normalizedName = files_normalize_name("file", name);
		if (!name.toLowerCase().endsWith(".md") || normalizedName._nay || normalizedName._yay !== name) {
			return {
				status: 400,
				body: await fail({
					status: 400,
					message: "Path must end in a valid Markdown (.md) file name.",
					errorCode: "invalid_input",
				}),
			} as const;
		}
		// Intermediate folders are created verbatim on publish; require already-canonical
		// names so a user-key touch cannot materialize folders (e.g. "..") that the app's
		// own creation flows would reject.
		for (const segment of path_extract_segments_from(requestedPath).slice(0, -1)) {
			const normalizedSegment = files_normalize_name("folder", segment);
			if (normalizedSegment._nay || normalizedSegment._yay !== segment) {
				return {
					status: 400,
					body: await fail({
						status: 400,
						message: "Path contains an invalid folder name.",
						errorCode: "invalid_input",
					}),
				} as const;
			}
		}
		// Upload-triggered plugins may only create Markdown siblings of their triggering file; the
		// same constraint is revalidated transactionally at publish time. An invoke run has no source
		// file (`outputParentPath` is null); its authority is the plugin's stamped area, which only
		// the transactional check in `publish_file_touch` can prove, so it passes here. A non-invoke
		// run with no source never carries the `files:write` scope, so it never reaches this line.
		if (
			principal.kind === "plugin_run" &&
			principal.outputParentPath !== null &&
			server_path_parent_of(requestedPath) !== principal.outputParentPath
		) {
			return {
				status: 403,
				body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
			} as const;
		}
		requestedPaths.push(requestedPath);
	}
	// Compare after normalization: distinct raw paths can collapse to the same file.
	if (new Set(requestedPaths).size !== requestedPaths.length) {
		return {
			status: 400,
			body: await fail({ status: 400, message: "Paths must be unique.", errorCode: "invalid_input" }),
		} as const;
	}

	// Every touched file starts as the same empty doc; build its Yjs snapshot once.
	// The touch route is `.md`-gated (non-goal 4), so rich text by definition.
	const emptySnapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
		text: "",
		rootKind: "rich_text",
	});
	if (emptySnapshotUpdate._nay) {
		console.error("Failed to build the empty Yjs snapshot for public file touch", {
			nay: emptySnapshotUpdate._nay,
		});
		return {
			status: 500,
			body: await fail({ status: 500, message: "Failed to touch files", errorCode: "storage_failure" }),
		} as const;
	}

	let principalRef: Infer<typeof file_write_principal_ref_validator>;
	if (principal.kind === "plugin_run") {
		if (!pluginCallId) {
			// Unreachable: public API authorization creates the call for plugin principals.
			throw should_never_happen("plugin_run touch without a consumed call", {
				runId: principal.runId,
			});
		}
		principalRef = { kind: "plugin_run", runId: principal.runId, callId: pluginCallId };
	} else {
		principalRef = { kind: "user_api_key", credentialId: principal.credentialId };
	}

	const files: Array<{ path: string; nodeId: Id<"files_nodes">; created: boolean }> = [];
	// Run touches in order because sibling paths may create the same missing folders. One read-only
	// path ends the request with 409. Earlier touches stay saved, and retrying them is safe.
	for (const requestedPath of requestedPaths) {
		// An active file already satisfies the touch; skip staging entirely. The publish
		// mutation re-checks the path transactionally, so this pre-check is only an
		// optimization for the common already-exists case.
		const activeNode = (await ctx.runQuery(internal.files_nodes.get_by_path, {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			visibilityUserId: public_api_visibility_user_id(principal),
			path: requestedPath,
		})) as files_nodes_get_by_path_Result;
		if (activeNode) {
			// This branch answers the touch by itself, so the node question `publish_file_touch`
			// asks has to be asked here too. `get_by_path` above only filters by what the caller
			// may read, and a read-only sharee would otherwise be told the file is theirs to
			// write. Asked before the folder conflict, in the same order as the mutation.
			const canWriteNode = (await ctx.runQuery(internal.public_api.can_write_file_node, {
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				userId: principal.kind === "plugin_run" ? principal.actorUserId : principal.userId,
				nodeId: activeNode._id,
				// An invoke run is the one principal the pre-check above lets through with no path
				// bound of its own, so its stamped area has to be proved here. An upload run is
				// already held to its triggering file's folder, and a key holder has no plugin area.
				...(principal.kind === "plugin_run" && principal.outputParentPath === null
					? { requireStampedForInstallationId: principal.installationId }
					: {}),
			})) as "ok" | "permission_denied" | "read_only";
			if (canWriteNode === "permission_denied") {
				return {
					status: 403,
					body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
				} as const;
			}
			// A locked target refuses touch. Return the same conflict as a locked write.
			if (canWriteNode === "read_only") {
				return {
					status: 409,
					body: await fail({ status: 409, message: "This item is read-only.", errorCode: "conflict" }),
				} as const;
			}
			if (activeNode.kind === "folder") {
				return {
					status: 409,
					body: await fail({
						status: 409,
						message: "A folder already exists at this path",
						errorCode: "conflict",
					}),
				} as const;
			}
			files.push({ path: requestedPath, nodeId: activeNode._id, created: false });
			continue;
		}

		const prepared: prepare_file_write_Result = await ctx.runMutation(internal.public_api.prepare_file_write, {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			userId: principal.kind === "plugin_run" ? principal.actorUserId : principal.userId,
			principalRef,
			path: requestedPath,
			overwrite: "fail",
			contentSize: 0,
			yjsSnapshotSize: emptySnapshotUpdate._yay.byteLength,
		});
		if (prepared._nay) {
			if (prepared._nay.message === "Permission denied") {
				return {
					status: 403,
					body: await fail({ status: 403, message: prepared._nay.message, errorCode: "permission_denied" }),
				} as const;
			}
			// A locked parent is a conflict, not a permission error.
			if (prepared._nay.name === "read_only") {
				return {
					status: 409,
					body: await fail({ status: 409, message: prepared._nay.message, errorCode: "conflict" }),
				} as const;
			}
			return {
				status: 401,
				body: await fail({ status: 401, message: prepared._nay.message, errorCode: "unauthenticated" }),
			} as const;
		}

		const stageId = prepared._yay.stageId;
		const stageScope = { organizationId: principal.organizationId, workspaceId: principal.workspaceId };
		const yjsSnapshotKey = r2_create_asset_key({
			...stageScope,
			assetId: prepared._yay.yjsSnapshotAssetId,
		});
		const contentSnapshotKey = r2_create_asset_key({
			...stageScope,
			assetId: prepared._yay.contentSnapshotAssetId,
		});
		// A plugin run may remove the stage before these R2 writes finish. Keep the exact keys so cleanup
		// can still remove objects that arrive after the stage is gone.
		const orphanedKeys = [yjsSnapshotKey, contentSnapshotKey];
		// Wait for both writes before cleanup. Otherwise one failed write could start cleanup while the
		// other write is still running, and the late object would have no remaining cleanup owner.
		const putResults = await Promise.allSettled([
			r2_put_object(ctx, {
				key: yjsSnapshotKey,
				body: emptySnapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: contentSnapshotKey,
				body: "",
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);
		const putFailure = putResults.find((result) => result.status === "rejected");
		if (putFailure) {
			console.error("Failed to write staged touch objects", {
				error: putFailure.reason,
				stageId,
				path: requestedPath,
			});
			const failBody = await fail({
				status: 500,
				message: "Failed to touch files",
				errorCode: "storage_failure",
			});
			await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
				stageId,
				orphanedKeys,
				orphanedScope: stageScope,
			});
			return { status: 500, body: failBody } as const;
		}

		const published: publish_file_touch_Result = await ctx.runMutation(internal.public_api.publish_file_touch, {
			stageId,
			targetAnchor: prepared._yay.targetAnchor,
		});
		if (published._nay) {
			// Conflict is the fallback: structural 409s pass their specific message through,
			// while the auth and storage failures use fixed literals.
			const failedStatus =
				published._nay.message === "Unauthenticated"
					? 401
					: published._nay.message === "Permission denied"
						? 403
						: published._nay.message === "Write was not published"
							? 500
							: 409;
			const failBody = await fail({
				status: failedStatus,
				message: published._nay.message,
				errorCode:
					failedStatus === 409
						? "conflict"
						: failedStatus === 403
							? "permission_denied"
							: failedStatus === 401
								? "unauthenticated"
								: "storage_failure",
			});
			// A read-only refusal already cleaned up the stage during publish.
			if (published._nay.name !== "read_only" && published._nay.name !== "stale_write") {
				await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
					stageId,
					orphanedKeys,
					orphanedScope: stageScope,
				});
			}
			if (failedStatus === 409) {
				return { status: 409, body: failBody } as const;
			}
			if (failedStatus === 403) {
				return { status: 403, body: failBody } as const;
			}
			if (failedStatus === 401) {
				return { status: 401, body: failBody } as const;
			}
			return { status: 500, body: failBody } as const;
		}

		files.push({ path: requestedPath, nodeId: published._yay.nodeId, created: published._yay.created });
	}

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});

	console.info("Public API files touched", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		count: files.length,
	});

	return {
		status: 200,
		body: { files },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const download_urls_body_validator = z.object({
	fileNodeIds: z.array(z.string().min(1)).min(1).max(FILES_DOWNLOAD_URLS_MAX_REQUEST_ITEMS),
	expiresInSeconds: z.number().int().min(1).max(FILES_DOWNLOAD_URL_MAX_TTL_SECONDS).optional(),
});

export type public_api_http_download_urls_Body = z.infer<typeof download_urls_body_validator>;

export async function public_api_http_download_urls(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/files/download-urls",
) {
	const declaredBytes = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > FILES_DOWNLOAD_URLS_MAX_REQUEST_BYTES) {
		return { status: 400, body: { message: "Request body is too large" } } as const;
	}
	const bodyText = await read_request_text_bounded(request, FILES_DOWNLOAD_URLS_MAX_REQUEST_BYTES);
	if (bodyText === null) {
		return { status: 400, body: { message: "Request body is too large" } } as const;
	}
	let bodyJson: unknown;
	try {
		bodyJson = JSON.parse(bodyText);
	} catch {
		return { status: 400, body: { message: "Failed to parse request body as JSON" } } as const;
	}
	const body = download_urls_body_validator.safeParse(bodyJson);
	if (!body.success) {
		return { status: 400, body: { message: "Request body validation failed" } } as const;
	}
	// Duplicate ids never consume principal capacity or start file work.
	if (new Set(body.data.fileNodeIds).size !== body.data.fileNodeIds.length) {
		return { status: 400, body: { message: "fileNodeIds must be unique" } } as const;
	}

	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:download" satisfies public_api_Scope,
		allowedKinds: ["user_api_key", "plugin_run", "plugin_ui"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;
	const presentedToken = auth._yay.presentedToken;

	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	// A backend plugin can request only its triggering upload, but it uses the same
	// array request and response as every other plugin.
	if (
		principal.kind === "plugin_run" &&
		(principal.sourceFileNodeId === null ||
			body.data.fileNodeIds.length !== 1 ||
			body.data.fileNodeIds[0] !== String(principal.sourceFileNodeId))
	) {
		return {
			status: 404,
			body: await fail({ status: 404, message: "Not found", errorCode: "not_found" }),
		} as const;
	}

	const fileNodeIds = body.data.fileNodeIds.slice(0, FILES_DOWNLOAD_URLS_MAX_ITEMS);
	const truncated = body.data.fileNodeIds.length > fileNodeIds.length;

	// Authorization charged one slot for the request; the rest of the batch
	// charges here so N URLs cost the same principal budget as N single calls.
	if (fileNodeIds.length > 1) {
		const batchRateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_principal",
			key: `${principal.kind}:${principal.principalKey}:${path}`,
			count: fileNodeIds.length - 1,
		});
		if (batchRateLimit) {
			return {
				status: 429,
				body: { message: batchRateLimit.message, retryAfterMs: batchRateLimit.retryAfterMs },
			} as const;
		}
	}

	// Per-node queries keep each file in its own Convex cache entry, so one changed
	// file invalidates only its own result.
	const datas: r2_get_data_for_public_download_url_Result[] = await Promise.all(
		fileNodeIds.map((fileNodeId) =>
			ctx.runQuery(internal.r2.get_data_for_public_download_url, {
				organizationId: principal.organizationId,
				workspaceId: principal.workspaceId,
				fileNodeId,
				visibilityUserId: public_api_visibility_user_id(principal),
			}),
		),
	);

	if (
		principal.kind === "plugin_run" &&
		(principal.sourceAssetId === null ||
			!datas[0] ||
			datas[0].asset._id !== principal.sourceAssetId ||
			!datas[0].asset.r2Key)
	) {
		return {
			status: 404,
			body: await fail({ status: 404, message: "Not found", errorCode: "not_found" }),
		} as const;
	}

	// For every file, the download signs the asset that node.assetId points at.
	// For editable files that is the newest version snapshot. Materialize first
	// when the Yjs log is newer than the snapshot, or when the asset has no r2Key
	// (old data). Each materialization stores a fresh snapshot and points the
	// node at it. ReadOnly files (uploads, plugin sources) sign their write-once
	// content asset.
	const signKeys: Array<string | null> = await Promise.all(
		datas.map(async (data) => {
			if (!data) {
				return null;
			}
			const materializationState = data.materializationState;
			if (principal.kind === "plugin_run" || !materializationState) {
				return data.asset.r2Key ?? null;
			}
			if (
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence ||
				!data.asset.r2Key
			) {
				// Try to store a fresh version snapshot, but still allow downloading the
				// older one if this fails.
				const materialized = await ctx.runAction(internal.files_nodes_content.materialize_file_content, {
					organizationId: principal.organizationId,
					workspaceId: principal.workspaceId,
					nodeId: data.fileNode._id,
					userId: principal.userId,
					targetSequence: materializationState.yjsLastSequenceDoc.lastSequence,
				});
				if (materialized._nay) {
					console.warn("Failed to materialize Markdown before public download", {
						fileNodeId: data.fileNode._id,
						nay: materialized._nay,
					});
				}
				const refreshed: r2_get_data_for_public_download_url_Result = await ctx.runQuery(
					internal.r2.get_data_for_public_download_url,
					{
						organizationId: principal.organizationId,
						workspaceId: principal.workspaceId,
						fileNodeId: data.fileNode._id,
						visibilityUserId: public_api_visibility_user_id(principal),
					},
				);
				return refreshed?.asset.r2Key ?? null;
			}
			return data.asset.r2Key ?? null;
		}),
	);

	// Materialization can be slow. Resolve the exact bearer again so every URL uses
	// the authority that remains when this all-or-nothing batch starts signing.
	const signingAuthority = await public_api_resolve_live_principal(ctx, {
		presented: presentedToken,
		now: Date.now(),
		requiredScope: "files:download" satisfies public_api_Scope,
	});
	if (signingAuthority._nay) {
		const status = signingAuthority._nay.message === "Permission denied" ? 403 : 401;
		return {
			status,
			body: await fail({
				status,
				message: signingAuthority._nay.message,
				errorCode: status === 403 ? "permission_denied" : "unauthenticated",
			}),
		} as const;
	}
	if (!has_same_download_authority(principal, signingAuthority._yay)) {
		return {
			status: 401,
			body: await fail({ status: 401, message: "Unauthenticated", errorCode: "unauthenticated" }),
		} as const;
	}

	const preSignAt = Date.now();
	let expiresIn = Math.min(
		body.data.expiresInSeconds ?? FILES_DOWNLOAD_URL_MAX_TTL_SECONDS,
		FILES_DOWNLOAD_URL_MAX_TTL_SECONDS,
	);
	const principalAuthorityExpiresAt =
		signingAuthority._yay.kind === "plugin_run"
			? signingAuthority._yay.apiTokenExpiresAt
			: signingAuthority._yay.kind === "plugin_ui"
				? signingAuthority._yay.sessionExpiresAt
				: null;
	if (principalAuthorityExpiresAt != null) {
		const remainingSeconds =
			Math.floor((principalAuthorityExpiresAt - preSignAt) / 1000) - FILES_DOWNLOAD_URL_SIGNING_MARGIN_SECONDS;
		if (remainingSeconds < 1) {
			return {
				status: 401,
				body: await fail({
					status: 401,
					message: "Unauthenticated",
					errorCode: "unauthenticated",
				}),
			} as const;
		}
		expiresIn = Math.min(expiresIn, remainingSeconds);
	}

	const signed = await Promise.all(
		datas.map(async (data, index) => {
			const fileNodeId = fileNodeIds[index];
			const signKey = signKeys[index];
			if (!data || !signKey) {
				return { fileNodeId, url: null };
			}
			// Upload content types are client-supplied, and a presigned R2 GET carries no
			// nosniff/CSP — the pinned type plus the disposition below is the whole defense.
			// Both derive from the node NAME: only the literal media map serves inline, and
			// everything else (text included) downloads as an attachment, so spoofed bytes
			// can never run as text/html or image/svg+xml on the shared R2 origin.
			const serving = files_get_signed_download_serving(data.fileNode.name);
			return {
				fileNodeId,
				url: await r2_get_download_url({
					key: signKey,
					options: {
						expiresIn,
						responseContentType: serving.responseContentType,
						responseContentDisposition: serving.responseContentDisposition,
					},
				}),
			};
		}),
	);
	const expiresAt = Math.min(preSignAt + expiresIn * 1000, principalAuthorityExpiresAt ?? Number.POSITIVE_INFINITY);
	const items: Array<{ fileNodeId: string; url: string; expiresAt: number }> = [];
	const errors: Array<{ fileNodeId: string; message: string }> = [];
	for (const entry of signed) {
		if (entry.url) {
			items.push({ fileNodeId: entry.fileNodeId, url: entry.url, expiresAt });
		} else {
			errors.push({ fileNodeId: entry.fileNodeId, message: "Not found" });
		}
	}

	// All URLs share one request authority. Recheck it after signing so an ACL,
	// tenant, installation, or session change suppresses the whole batch.
	const revalidated = await public_api_resolve_live_principal(ctx, {
		presented: presentedToken,
		now: Date.now(),
		requiredScope: "files:download" satisfies public_api_Scope,
	});
	if (revalidated._nay) {
		const status = revalidated._nay.message === "Permission denied" ? 403 : 401;
		return {
			status,
			body: await fail({
				status,
				message: revalidated._nay.message,
				errorCode: status === 403 ? "permission_denied" : "unauthenticated",
			}),
		} as const;
	}
	if (!has_same_download_authority(principal, revalidated._yay)) {
		return {
			status: 401,
			body: await fail({ status: 401, message: "Unauthenticated", errorCode: "unauthenticated" }),
		} as const;
	}

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});

	console.info("Public API download URLs issued", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		count: items.length,
		errorCount: errors.length,
		truncated,
	});

	return {
		status: 200,
		body: { items, errors, truncated },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const upload_urls_body_validator = z.object({
	files: z
		.array(
			z.object({
				path: z.string(),
				contentType: z.string().min(1).max(200),
				size: z.number().int().min(1),
			}),
		)
		.min(1)
		.max(FILES_UPLOAD_URLS_MAX_ITEMS),
	skipProcessing: z.boolean().optional(),
	overwrite: z.enum(["replace", "fail"]).optional(),
});

export type public_api_http_upload_urls_Body = z.infer<typeof upload_urls_body_validator>;

export async function public_api_http_upload_urls(ctx: ActionCtx, request: Request, path: "/api/v1/files/upload-urls") {
	// User keys only: plugin runs have their own sibling-write constraints and call
	// accounting, and grants and UI sessions are read-only by design.
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "files:write" satisfies public_api_Scope,
		allowedKinds: ["user_api_key"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, upload_urls_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	// Authorization charged one slot for the request; the rest of the batch
	// charges here so N upload URLs cost the same principal budget as N single calls.
	if (body._yay.files.length > 1) {
		const batchRateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "public_api_principal",
			key: `${principal.kind}:${principal.principalKey}:${path}`,
			count: body._yay.files.length - 1,
		});
		if (batchRateLimit) {
			return {
				status: 429,
				body: { message: batchRateLimit.message, retryAfterMs: batchRateLimit.retryAfterMs },
			} as const;
		}
	}

	const created = (await ctx.runMutation(internal.public_api.create_file_upload_targets, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: principal.userId,
		principalRef: { kind: "user_api_key", credentialId: principal.credentialId },
		items: body._yay.files,
		skipProcessing: body._yay.skipProcessing ?? false,
		overwrite: body._yay.overwrite ?? "replace",
	})) as create_file_upload_targets_Result;
	if (created._nay) {
		// Mint failures are all-or-nothing: the mutation validates the whole batch
		// before writing, so no partial targets exist when it returns `_nay`.
		const failedPath = created._nay.data?.path;
		const failedStatus =
			created._nay.message === "Unauthenticated"
				? 401
				: created._nay.message === "Permission denied" ||
					  created._nay.message === "Upload quota exceeded" ||
					  created._nay.message === "This workspace's plan does not include file uploads"
					? 403
					: created._nay.name === "read_only" ||
						  created._nay.message === "A file already exists at this path" ||
						  created._nay.message === "The path cannot point to a folder" ||
						  created._nay.message === "An intermediate segment is owned by a file"
						? 409
						: 400;
		if (failedStatus === 401) {
			return { status: 401, body: { message: created._nay.message } } as const;
		}
		if (failedStatus === 403) {
			return { status: 403, body: { message: created._nay.message, path: failedPath } } as const;
		}
		if (failedStatus === 409) {
			return { status: 409, body: { message: created._nay.message, path: failedPath } } as const;
		}
		return { status: 400, body: { message: created._nay.message, path: failedPath } } as const;
	}

	console.info("Public API upload urls minted", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		count: created._yay.length,
	});

	return {
		status: 200,
		body: { files: created._yay },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

const start_activity_body_validator = z.object({
	// "" (after trimming) = no custom title; the host composes one from the plugin's
	// display name and the triggering file's name.
	title: z.string().trim().max(ACTIVITIES_TITLE_MAX_CHARS),
	// The caller must predict how long its work takes; the timeout cron closes the
	// activity as "timeout" once this much time passes without a finish.
	timeoutMs: z.number().int().min(1).max(ACTIVITIES_TIMEOUT_MAX_MS),
});

export type public_api_http_start_activity_Body = z.infer<typeof start_activity_body_validator>;

export async function public_api_http_start_activity(
	ctx: ActionCtx,
	request: Request,
	path: "/api/v1/activities/start",
) {
	const auth = await public_api_authorize_request(ctx, request, {
		requiredScope: "activities:write" satisfies public_api_Scope,
		allowedKinds: ["plugin_run"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;
	const pluginCallId = auth._yay.pluginCallId;

	// Settles the consumed plugin call and builds the error body in one step; the
	// caller supplies the matching literal status so the response union stays narrow.
	const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
		await public_api_settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: failArgs.status,
			errorCode: failArgs.errorCode,
			errorMessage: failArgs.message,
		});
		return { message: failArgs.message };
	};

	const body = await server_request_json_parse_and_validate(request, start_activity_body_validator);
	if (body._nay) {
		return {
			status: 400,
			body: await fail({ status: 400, message: body._nay.message, errorCode: "invalid_input" }),
		} as const;
	}

	const started: start_run_activity_Result = await ctx.runMutation(internal.public_api.start_run_activity, {
		runId: principal.runId,
		title: body._yay.title,
		timeoutMs: body._yay.timeoutMs,
	});
	if (started._nay) {
		if (started._nay.message === "An activity already exists for this run") {
			return {
				status: 409,
				body: await fail({ status: 409, message: started._nay.message, errorCode: "conflict" }),
			} as const;
		}
		if (started._nay.message === "Permission denied") {
			return {
				status: 403,
				body: await fail({ status: 403, message: started._nay.message, errorCode: "permission_denied" }),
			} as const;
		}
		return {
			status: 401,
			body: await fail({ status: 401, message: started._nay.message, errorCode: "unauthenticated" }),
		} as const;
	}

	await public_api_settle_plugin_call_best_effort(ctx, {
		callId: pluginCallId,
		status: "succeeded",
		responseStatus: 200,
	});

	console.info("Public API run activity started", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
	});

	return {
		status: 200,
		body: { activityId: started._yay.activityId },
		headers: { "Cache-Control": "no-store" },
	} as const;
}

/**
 * Answer what a user API key can still do, for the workspace API-keys screen's "Test key" button.
 *
 * Every other route needs one scope, so testing a key through one of them only proves the key has
 * that scope. A key minted for plugin documents alone would look broken. This route asks for no
 * scope and reports the ones the key still has.
 */
export async function public_api_http_verify_key(ctx: ActionCtx, request: Request, path: "/api/v1/auth/verify") {
	const auth = await public_api_authorize_key_inspection(ctx, request, { route: path });
	if (auth._nay) {
		return auth._nay;
	}

	const principal = auth._yay.principal;
	return {
		status: 200,
		body: {
			organizationId: principal.organizationId,
			workspaceId: principal.workspaceId,
			scopes: auth._yay.allowedScopes,
		},
		headers: { "Cache-Control": "no-store" },
	} as const;
}
