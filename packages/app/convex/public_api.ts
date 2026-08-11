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
	files_node_has_editable_yjs_state,
	files_normalize_text_document_input,
	files_u8_to_array_buffer,
	type files_ContentType,
} from "../server/files.ts";
import { files_yjs_compute_diff_update_from_state_vector } from "../shared/files-yjs.ts";
import { files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { encodeStateVector } from "yjs";
import {
	files_nodes_db_archive_nodes,
	files_nodes_db_create_node_recursively_at_path,
	type files_nodes_get_by_path_Result,
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
	r2_delete_object,
	r2_generate_upload_url,
	r2_get_bucket,
	r2_get_download_url,
	r2_put_object,
	r2_UNFINALIZED_ASSET_TTL_MS,
} from "./r2_client.ts";
import {
	public_api_PLUGIN_RUN_TOKEN_REGEX,
	public_api_PLUGIN_UI_TOKEN_REGEX,
	type public_api_Scope,
} from "../shared/public-api.ts";
import {
	public_api_authorize_request,
	public_api_is_path_inside_prefix,
	public_api_resolve_live_principal,
	public_api_settle_plugin_call_best_effort,
	public_api_visibility_user_id,
} from "./public_api_http_auth.ts";

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
	),
);
const plugin_run_scopes_validator = v.array(
	v.union(
		v.literal("files:write" satisfies public_api_Scope),
		v.literal("files:download" satisfies public_api_Scope),
		v.literal("secrets:read" satisfies public_api_Scope),
		v.literal("outbound:fetch" satisfies public_api_Scope),
		v.literal("activities:write" satisfies public_api_Scope),
	),
);
// Read-only by design: UI sessions never get write, secrets, or outbound scopes.
const plugin_ui_scopes_validator = v.array(
	v.union(
		v.literal("files:list" satisfies public_api_Scope),
		v.literal("files:read" satisfies public_api_Scope),
		v.literal("files:download" satisfies public_api_Scope),
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
				 * The person whose upload started this run. Used for file authorship, and as the eyes the
				 * run reads and writes files with: a run has no user of its own, so without that it would
				 * be a way around a restricted folder. See `public_api_visibility_user_id`.
				 */
				actorUserId: v.id("users"),
				sourceFileNodeId: v.id("files_nodes"),
				sourceAssetId: v.id("files_r2_assets"),
				/** Current path of the source node's parent; plugin writes must land exactly here. */
				outputParentPath: v.string(),
				apiTokenExpiresAt: v.number(),
				scopes: plugin_run_scopes_validator,
				principalKey: v.string(),
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

			// A run's authority dies with its installation: disabling, uninstalling, or upgrading the
			// installation (which changes its pluginVersionId) revokes every live run token.
			const installation = await ctx.db.get("plugins_workspace_installations", pluginRun.installationId);
			if (
				!installation ||
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
			const sourceFileNode = await ctx.db.get("files_nodes", pluginRun.fileNodeId);
			if (
				!sourceFileNode ||
				sourceFileNode.archiveOperationId !== undefined ||
				sourceFileNode.organizationId !== pluginRun.organizationId ||
				sourceFileNode.workspaceId !== pluginRun.workspaceId
			) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}
			const outputParentPath =
				sourceFileNode.parentId === files_ROOT_ID ? "/" : server_path_parent_of(sourceFileNode.path);

			// Platform baseline: download the exact triggering asset, write Markdown siblings, and
			// opt into the workspace activity feed (self-disclosure, so no extra consent).
			const scopes: Infer<typeof plugin_run_scopes_validator> = ["files:download", "files:write", "activities:write"];
			if (pluginRun.acceptedCapabilities.includes("plugin.secrets.read")) {
				scopes.push("secrets:read");
			}
			if (pluginRun.acceptedCapabilities.includes("outbound.fetch")) {
				scopes.push("outbound:fetch");
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
					sourceFileNodeId: pluginRun.fileNodeId,
					sourceAssetId: pluginRun.assetId,
					outputParentPath,
					apiTokenExpiresAt: pluginRun.apiTokenExpiresAt,
					scopes,
					principalKey: `plugin_run:${pluginRun._id}`,
				},
			});
		}

		if (public_api_PLUGIN_UI_TOKEN_REGEX.test(args.presented)) {
			const tokenHash = await crypto_sha256_hex(args.presented);
			const session = await ctx.db
				.query("plugins_ui_sessions")
				.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
				.unique();
			if (!session) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			// A UI session is only valid while its installation stays as it was: disabling,
			// uninstalling, or upgrading it (an upgrade changes pluginVersionId) revokes every
			// outstanding page token.
			const installation = await ctx.db.get("plugins_workspace_installations", session.installationId);
			if (
				!installation ||
				installation.status !== "enabled" ||
				installation.pluginVersionId !== session.pluginVersionId ||
				installation.organizationId !== session.organizationId ||
				installation.workspaceId !== session.workspaceId
			) {
				return Result({ _nay: { message: "Unauthenticated" } });
			}

			// The page acts on behalf of the minting user: it can never read what that user cannot.
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
);

/**
 * Shared revalidation for the prepare and publish mutations: the same live-principal and
 * plugin-constraint checks must hold in the transaction that creates the stage AND in the
 * transaction that publishes it, because the credential or run can die between the two.
 */
async function db_revalidate_file_write_principal(
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
		const pluginRun = await ctx.db.get("plugins_event_runs", args.principalRef.runId);
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
		const installation = await ctx.db.get("plugins_workspace_installations", pluginRun.installationId);
		if (
			!installation ||
			installation.status !== "enabled" ||
			installation.pluginVersionId !== pluginRun.pluginVersionId
		) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		// The sibling-write constraint is checked against the source node's CURRENT parent in this
		// transaction, so a concurrent source move cannot smuggle plugin output somewhere else.
		// Archived counts as missing: publishing beside an archived source would recreate the
		// user-deleted parent folder as a new active node.
		const sourceFileNode = await ctx.db.get("files_nodes", pluginRun.fileNodeId);
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

		return Result({ _yay: { pluginRun } });
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
	return Result({ _yay: { pluginRun: null } });
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
		}),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const revalidated = await db_revalidate_file_write_principal(ctx, {
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
				: { credentialId: args.principalRef.credentialId }),
			path: args.path,
			overwrite: args.overwrite,
			yjsSnapshotAssetId,
			contentSnapshotAssetId,
			expiresAt: now + FILE_WRITE_STAGE_TTL_MS,
			updatedAt: now,
		});

		return Result({ _yay: { stageId, yjsSnapshotAssetId, contentSnapshotAssetId } });
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
					: null;
		if (!principalRef) {
			// Unreachable: prepare_file_write always stores exactly one principal reference.
			throw should_never_happen("public_api_file_write_stages doc without a principal reference", {
				stageId: stage._id,
			});
		}

		const revalidated = await db_revalidate_file_write_principal(ctx, {
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
			if (activeNode.kind !== "file") {
				return Result({ _nay: { message: "A folder already exists at this path" } });
			}
			if (stage.overwrite === "fail") {
				return Result({ _nay: { message: "A file already exists at this path" } });
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
			// The public write route is Markdown-only.
			rootKind: "rich_text",
			textContent: args.content,
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
			yjsSnapshotAssetId: stage.yjsSnapshotAssetId,
			yjsSnapshotSize: yjsSnapshotAsset.size,
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
					: null;
		if (!principalRef) {
			// Unreachable: prepare_file_write always stores exactly one principal reference.
			throw should_never_happen("public_api_file_write_stages doc without a principal reference", {
				stageId: stage._id,
			});
		}

		const revalidated = await db_revalidate_file_write_principal(ctx, {
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

		// The target must still be the exact active editable file the route diffed against.
		// Anything else (archived, replaced, converted) is a conflict the caller reports as 409.
		const fileNode = await ctx.db.get("files_nodes", args.expectedNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== stage.organizationId ||
			fileNode.workspaceId !== stage.workspaceId ||
			fileNode.path !== stage.path ||
			fileNode.archiveOperationId !== undefined ||
			!files_node_has_editable_yjs_state(fileNode)
		) {
			return Result({ _nay: { message: "The file changed during the write" } });
		}

		// `db_revalidate_file_write_principal` above asks about the workspace, and a write can be staged
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
					: null;
		if (!principalRef) {
			// Unreachable: prepare_file_write always stores exactly one principal reference.
			throw should_never_happen("public_api_file_write_stages doc without a principal reference", {
				stageId: stage._id,
			});
		}

		const revalidated = await db_revalidate_file_write_principal(ctx, {
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

			if (activeNode.kind !== "file") {
				return Result({ _nay: { message: "A folder already exists at this path" } });
			}

			// Another writer created the file between the route's check and this publish: the touch
			// is satisfied. Drop the staged assets and their already-PUT objects, but do not settle
			// the plugin call here — the route settles it once for the whole batch.
			for (const assetId of [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId]) {
				const asset = await ctx.db.get("files_r2_assets", assetId);
				if (asset) {
					await r2_delete_object(
						ctx,
						r2_create_asset_key({ organizationId: stage.organizationId, workspaceId: stage.workspaceId, assetId }),
					);
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
			yjsSnapshotAssetId: stage.yjsSnapshotAssetId,
			yjsSnapshotSize: yjsSnapshotAsset.size,
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
 * The node question `publish_file_touch` asks, for the touch route's already-exists shortcut — the
 * one branch that answers without ever reaching that mutation. Without it touch reports success on a
 * file the caller may read but not write, while `/api/v1/files/write` on the same path answers 403.
 */
export const can_write_file_node = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const fileNode = await ctx.db.get("files_nodes", args.nodeId);
		if (!fileNode || fileNode.organizationId !== args.organizationId || fileNode.workspaceId !== args.workspaceId) {
			return false;
		}
		return await has_workspace_content_permission(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			permission: "content.write",
			fileNode,
		});
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
		const [installation, version, fileNode, actorMembership] = await Promise.all([
			ctx.db.get("plugins_workspace_installations", pluginRun.installationId),
			ctx.db.get("plugins_versions", pluginRun.pluginVersionId),
			ctx.db.get("files_nodes", pluginRun.fileNodeId),
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
		]);
		// Recheck durable authority in this mutation. Removing the actor, changing the installation,
		// or archiving the source can happen after the route consumes its API call but before this write.
		if (
			!installation ||
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
		// Match the write sink's vocabulary (`db_revalidate_file_write_principal`): a dead plugin-run
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
		const revalidated = await db_revalidate_file_write_principal(ctx, {
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
				if (ancestor.kind !== "folder") {
					return Result({
						_nay: { message: "An intermediate segment is owned by a file", data: { path: item.path } },
					});
				}
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

			const signedUpload = await r2_generate_upload_url(
				r2_create_asset_key({
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
					assetId,
				}),
			);

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
 * Idempotent unpublished-write cleanup: R2 objects first, then the asset docs, then the stage doc,
 * so a crash mid-cleanup leaves the stage behind for a retry. Publication deletes the stage in its
 * own transaction first, so cleanup can never delete a published output.
 */
export async function public_api_db_cleanup_file_write_stage(
	ctx: MutationCtx,
	stage: Doc<"public_api_file_write_stages">,
) {
	for (const assetId of [stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId]) {
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset) {
			continue;
		}
		// Staged asset docs have no r2Key until publication; the object key is deterministic.
		await r2_delete_object(
			ctx,
			r2_create_asset_key({ organizationId: stage.organizationId, workspaceId: stage.workspaceId, assetId }),
		);
		await ctx.db.delete("files_r2_assets", assetId);
	}
	if (stage.callId) {
		const call = await ctx.db.get("plugins_event_run_calls", stage.callId);
		// A late or duplicate finish is a no-op: only a started call settles.
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
		 * Object keys the calling action already PUT. When run terminalization cleaned the stage
		 * while those PUTs were in flight, the stage-derived cleanup saw no objects to delete;
		 * this fallback removes them so nothing is orphaned in the bucket.
		 */
		orphanedKeys: v.optional(v.array(v.string())),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const stage = await ctx.db.get("public_api_file_write_stages", args.stageId);
		if (stage) {
			await public_api_db_cleanup_file_write_stage(ctx, stage);
		} else if (args.orphanedKeys) {
			for (const key of args.orphanedKeys) {
				await r2_delete_object(ctx, key);
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
 * skip-if-unchanged path, which never reaches a publish mutation.
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

		return await has_workspace_content_permission(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			permission: "content.write",
			fileNode,
		});
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
		/** Authoring user: the credential owner, or the plugin run's actorUserId. */
		userId: Id<"users">;
		visibilityUserId: Id<"users">;
		principalRef: Infer<typeof file_write_principal_ref_validator>;
		path: string;
		content: string;
		contentBytes: number;
		overwrite: "replace" | "fail";
		skipIfUnchanged: boolean;
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
			if (args.skipIfUnchanged && fillUpdate === null) {
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
				return Result({
					_nay: { name: "nay", message: prepared._nay.message, data: { status: 401, errorCode: "unauthenticated" } },
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
				await ctx.runMutation(internal.public_api.cleanup_file_write_stage, {
					stageId: prepared._yay.stageId,
					orphanedKeys: [contentSnapshotKey],
				});
				return Result({
					_nay: { name: "nay", message: published._nay.message, data: failure },
				});
			}

			return Result({ _yay: { nodeId: published._yay.nodeId, wroteInPlace: true, unchanged: false } });
		}
	}

	const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
		text: args.content,
		// The public write route is `.md`-gated (non-goal 4), so the created document is rich
		// text by definition.
		rootKind: "rich_text",
	});
	if (snapshotUpdate._nay) {
		console.error("Failed to build Yjs snapshot for public file write", {
			nay: snapshotUpdate._nay,
			path: args.path,
		});
		return Result({
			_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
		});
	}

	const prepared: prepare_file_write_Result = await ctx.runMutation(internal.public_api.prepare_file_write, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		principalRef: args.principalRef,
		path: args.path,
		overwrite: args.overwrite,
		contentSize: args.contentBytes,
		yjsSnapshotSize: snapshotUpdate._yay.byteLength,
	});
	if (prepared._nay) {
		if (prepared._nay.message === "Permission denied") {
			return Result({
				_nay: { name: "nay", message: prepared._nay.message, data: { status: 403, errorCode: "permission_denied" } },
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
	// Passed to cleanup so objects PUT after run terminalization already swept the
	// stage (deleting the docs the keys derive from) still get removed from the bucket.
	const orphanedKeys = [yjsSnapshotKey, contentSnapshotKey];
	// Every PUT must settle before any cleanup: a fast-failing sibling would otherwise
	// trigger the key sweep while another PUT is still in flight, and that PUT would
	// re-create its object after the sweep — an untracked blob no reaper can find.
	const putResults = await Promise.allSettled([
		r2_put_object(ctx, {
			key: yjsSnapshotKey,
			body: snapshotUpdate._yay,
			contentType: "application/octet-stream" satisfies files_ContentType,
		}),
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
		await ctx.runMutation(internal.public_api.cleanup_file_write_stage, { stageId, orphanedKeys });
		return Result({
			_nay: { name: "nay", message: "Failed to write file", data: { status: 500, errorCode: "storage_failure" } },
		});
	}

	const published: publish_file_write_Result = await ctx.runMutation(internal.public_api.publish_file_write, {
		stageId,
		content: args.content,
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
		await ctx.runMutation(internal.public_api.cleanup_file_write_stage, { stageId, orphanedKeys });
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
		allowedKinds: ["user_api_key", "public_api_grant", "plugin_ui"],
		route: path,
	});
	if (auth._nay) {
		return auth._nay;
	}
	const principal = auth._yay.principal;

	const body = await server_request_json_parse_and_validate(request, read_file_body_validator);
	if (body._nay) {
		return { status: 400, body: { message: body._nay.message } } as const;
	}

	const requestedPath = server_path_normalize(body._yay.path);
	if (requestedPath === "/") {
		return { status: 400, body: { message: "Path must point to a file." } } as const;
	}
	if (!public_api_is_path_inside_prefix(requestedPath, principal.pathPrefix)) {
		return { status: 403, body: { message: "Permission denied" } } as const;
	}

	const content = await ctx.runAction(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: principal.userId,
		path: requestedPath,
		includePending: principal.kind === "public_api_grant",
		maxBytes: Math.min(body._yay.maxBytes ?? FILES_READ_MAX_BYTES, FILES_READ_MAX_BYTES),
	});
	if (!content) {
		return {
			status: 404,
			body: {
				message: "File not found or exceeds the read limit.",
			},
		} as const;
	}

	console.info("Public API file read", {
		principalKind: principal.kind,
		principalKey: principal.principalKey,
		bytes: TEXT_ENCODER.encode(content.content).length,
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
});

export type public_api_http_write_file_Body = z.infer<typeof write_file_body_validator>;

export async function public_api_http_write_file(ctx: ActionCtx, request: Request, path: "/api/v1/files/write") {
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
	// Plugins may only create Markdown siblings of their triggering file; the same
	// constraint is revalidated transactionally at prepare and publish time.
	if (principal.kind === "plugin_run" && server_path_parent_of(requestedPath) !== principal.outputParentPath) {
		return {
			status: 403,
			body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
		} as const;
	}
	const overwrite = body._yay.overwrite ?? "replace";

	let principalRef: Infer<typeof file_write_principal_ref_validator>;
	if (principal.kind === "plugin_run") {
		if (!pluginCallId) {
			// Unreachable: public API authorization creates the call for plugin principals.
			throw should_never_happen("plugin_run write without a consumed call", {
				runId: principal.runId,
			});
		}
		principalRef = { kind: "plugin_run", runId: principal.runId, callId: pluginCallId };
	} else {
		principalRef = { kind: "user_api_key", credentialId: principal.credentialId };
	}

	const written = await write_one_markdown_file(ctx, {
		organizationId: principal.organizationId,
		workspaceId: principal.workspaceId,
		userId: principal.kind === "plugin_run" ? principal.actorUserId : principal.userId,
		visibilityUserId: public_api_visibility_user_id(principal),
		principalRef,
		path: requestedPath,
		content,
		contentBytes,
		overwrite,
		skipIfUnchanged: body._yay.skipIfUnchanged ?? false,
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
		// Plugins may only create Markdown siblings of their triggering file; the same
		// constraint is revalidated transactionally at prepare and publish time.
		if (principal.kind === "plugin_run" && server_path_parent_of(requestedPath) !== principal.outputParentPath) {
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
	// Sequential on purpose: sibling paths usually share missing parent folders, and
	// concurrent publishes would race on the shared folder creation.
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
			if (
				!(await ctx.runQuery(internal.public_api.can_write_file_node, {
					organizationId: principal.organizationId,
					workspaceId: principal.workspaceId,
					userId: principal.kind === "plugin_run" ? principal.actorUserId : principal.userId,
					nodeId: activeNode._id,
				}))
			) {
				return {
					status: 403,
					body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
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
		// Passed to cleanup so objects PUT after run terminalization already swept the
		// stage (deleting the docs the keys derive from) still get removed from the bucket.
		const orphanedKeys = [yjsSnapshotKey, contentSnapshotKey];
		// Every PUT must settle before any cleanup: a fast-failing sibling would otherwise
		// trigger the key sweep while another PUT is still in flight, and that PUT would
		// re-create its object after the sweep — an untracked blob no reaper can find.
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
			await ctx.runMutation(internal.public_api.cleanup_file_write_stage, { stageId, orphanedKeys });
			return { status: 500, body: failBody } as const;
		}

		const published: publish_file_touch_Result = await ctx.runMutation(internal.public_api.publish_file_touch, {
			stageId,
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
			await ctx.runMutation(internal.public_api.cleanup_file_write_stage, { stageId, orphanedKeys });
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
		(body.data.fileNodeIds.length !== 1 || body.data.fileNodeIds[0] !== String(principal.sourceFileNodeId))
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
		(!datas[0] || datas[0].asset._id !== principal.sourceAssetId || !datas[0].asset.r2Key)
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
				: created._nay.message === "Permission denied" || created._nay.message === "Upload quota exceeded"
					? 403
					: created._nay.message === "A file already exists at this path" ||
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
