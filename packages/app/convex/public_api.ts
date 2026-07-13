import { v, type Infer } from "convex/values";
import {
	httpAction,
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
import type { RegisteredMutation, RegisteredQuery, RouteSpec } from "convex/server";
import { z } from "zod";
import type { RouterForConvexModules } from "./http.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import { rate_limiter_limit_by_key, rate_limiter_http_client_key } from "./rate_limiter.ts";
import { type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import { type api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_random_hex, crypto_sha256_hex, crypto_timing_safe_equal } from "../server/crypto-utils.ts";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_path_normalize,
	server_path_parent_of,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { path_extract_segments_from, path_name_of, should_never_happen } from "../shared/shared-utils.ts";
import { files_normalize_name } from "../shared/files.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_ROOT_ID,
	files_get_utf8_byte_size,
	type files_ContentType,
} from "../server/files.ts";
import {
	files_nodes_create_yjs_snapshot_update_from_markdown,
	files_nodes_db_archive_nodes,
	files_nodes_db_create_node_recursively_at_path,
	files_nodes_db_finalize_file_node_creation,
} from "./files_nodes.ts";
import {
	r2_create_asset_key,
	r2_delete_object,
	r2_get_bucket,
	r2_get_download_url,
	r2_put_object,
	type r2_get_data_for_public_download_url_Result,
} from "./r2.ts";
import { type plugins_runtime_consume_run_api_call_Result } from "./plugins_runtime.ts";

export const public_api_SCOPE_FILES_LIST = "files:list";
export const public_api_SCOPE_FILES_READ = "files:read";
export const public_api_SCOPE_FILES_WRITE = "files:write";
export const public_api_SCOPE_FILES_DOWNLOAD = "files:download";
export const public_api_SCOPE_SECRETS_READ = "secrets:read";
export const public_api_SCOPE_OUTBOUND_FETCH = "outbound:fetch";

const FILES_LIST_MAX_ITEMS = 100;
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

const TEXT_ENCODER = new TextEncoder();
const CREDENTIAL_KEY_PREFIX = "pk_";
const CREDENTIAL_KEY_ID_BYTES = 16;
const CREDENTIAL_SECRET_BYTES = 32;
const API_CREDENTIAL_TOKEN_RE = /^pk_[0-9a-f]{32}\.[0-9a-f]{64}$/u;
const PUBLIC_API_GRANT_TOKEN_RE = /^[0-9a-f]{64}$/u;
const PLUGIN_RUN_TOKEN_RE = /^plr_[0-9a-f]{64}$/u;
const PLUGIN_UI_TOKEN_RE = /^plu_[0-9a-f]{64}$/u;
const PUBLIC_API_GRANT_TTL_MS = 10 * 60 * 1000;
const PUBLIC_API_GRANT_CLEANUP_BATCH_SIZE = 100;
// Stages only need to outlive one write action; anything older is a crashed write.
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

type Scope =
	| typeof public_api_SCOPE_FILES_LIST
	| typeof public_api_SCOPE_FILES_READ
	| typeof public_api_SCOPE_FILES_WRITE
	| typeof public_api_SCOPE_FILES_DOWNLOAD
	| typeof public_api_SCOPE_SECRETS_READ
	| typeof public_api_SCOPE_OUTBOUND_FETCH;
type PrincipalKind = "public_api_grant" | "user_api_key" | "plugin_run" | "plugin_ui";

const grant_scopes_validator = v.array(
	v.union(v.literal(public_api_SCOPE_FILES_LIST), v.literal(public_api_SCOPE_FILES_READ)),
);
const user_credential_scopes_validator = v.array(
	v.union(
		v.literal(public_api_SCOPE_FILES_LIST),
		v.literal(public_api_SCOPE_FILES_READ),
		v.literal(public_api_SCOPE_FILES_WRITE),
		v.literal(public_api_SCOPE_FILES_DOWNLOAD),
	),
);
const plugin_run_scopes_validator = v.array(
	v.union(
		v.literal(public_api_SCOPE_FILES_WRITE),
		v.literal(public_api_SCOPE_FILES_DOWNLOAD),
		v.literal(public_api_SCOPE_SECRETS_READ),
		v.literal(public_api_SCOPE_OUTBOUND_FETCH),
	),
);
// Read-only by design: UI sessions never get write, secrets, or outbound scopes.
const plugin_ui_scopes_validator = v.array(
	v.union(
		v.literal(public_api_SCOPE_FILES_LIST),
		v.literal(public_api_SCOPE_FILES_READ),
		v.literal(public_api_SCOPE_FILES_DOWNLOAD),
	),
);

function normalize_extension(extension: string | undefined) {
	const normalized = extension?.trim().replace(/^\./u, "").toLowerCase();
	return normalized ? normalized : undefined;
}

function is_path_inside_prefix(filePath: string, pathPrefix: string | null) {
	if (pathPrefix == null) return true;
	const normalizedPrefix = server_path_normalize(pathPrefix);
	return normalizedPrefix === "/" || filePath === normalizedPrefix || filePath.startsWith(`${normalizedPrefix}/`);
}

function get_bearer_token(request: Request) {
	const authorization = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!authorization?.startsWith(prefix)) return null;
	const token = authorization.slice(prefix.length).trim();
	return token.length > 0 ? token : null;
}

function is_plausible_bearer_token(token: string) {
	// Reject malformed bearer tokens before credential/grant/run lookup; well-formed tokens still require DB verification.
	return (
		API_CREDENTIAL_TOKEN_RE.test(token) ||
		PUBLIC_API_GRANT_TOKEN_RE.test(token) ||
		PLUGIN_RUN_TOKEN_RE.test(token) ||
		PLUGIN_UI_TOKEN_RE.test(token)
	);
}

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

	const hasPermission = await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: workspace._id,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resourceKind: "workspace",
		resourceId: String(workspace._id),
		permission: "api.credentials.manage",
		userId: user._id,
	});
	if (!hasPermission) {
		return Result({ _nay: { message: "Permission denied" } });
	}

	return Result({ _yay: { user, membership, organization, workspace } });
}

async function has_workspace_asset_permission(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
		permission: "asset.read" | "asset.write";
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
		resourceKind: "workspace",
		resourceId: String(workspace._id),
		permission: args.permission,
		userId: args.userId,
	});
}

/**
 * Both asset ACL facts at once: resolve_principal returns these instead of judging the route's
 * requiredUserPermission itself, so its result stays cacheable per token (verdicts live in
 * public_api_resolve_live_principal). Revoking a role invalidates the cached facts immediately.
 */
async function get_workspace_asset_permissions(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	const [read, write] = await Promise.all([
		has_workspace_asset_permission(ctx, { ...args, permission: "asset.read" }),
		has_workspace_asset_permission(ctx, { ...args, permission: "asset.write" }),
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

		const scopes = Array.from(new Set(args.scopes));
		if (scopes.length === 0) {
			return Result({ _nay: { message: "At least one scope is required" } });
		}

		const now = Date.now();
		const secret = await create_credential_secret(ctx);
		const credentialId = await ctx.db.insert("api_credentials", {
			organizationId: credentialManagement._yay.organization._id,
			workspaceId: credentialManagement._yay.workspace._id,
			userId: credentialManagement._yay.user._id,
			name: args.name.trim() || "API key",
			keyId: secret.keyId,
			obfuscatedValue: secret.obfuscatedValue,
			secretHash: secret.secretHash,
			scopes,
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
			.take(100);
		const revokedCredentials =
			activeCredentials.length < 100
				? await ctx.db
						.query("api_credentials")
						.withIndex("by_organization_workspace_user", (q) =>
							q
								.eq("organizationId", credentialManagement._yay.organization._id)
								.eq("workspaceId", credentialManagement._yay.workspace._id)
								.eq("userId", credentialManagement._yay.user._id),
						)
						.filter((q) => q.neq(q.field("revokedAt"), null))
						.take(100 - activeCredentials.length)
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

			await ctx.db.patch("api_credentials", credential._id, { revokedAt: Date.now() });
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
 * tenancy, scopes, expiry timestamps, and asset ACL facts. The two verdicts that depend on the
 * caller's clock and route — token expiry and requiredUserPermission — are applied by
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
				assetPermissions: v.object({ read: v.boolean(), write: v.boolean() }),
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
				assetPermissions: v.object({ read: v.boolean(), write: v.boolean() }),
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
				/** Used only for file authorship/audit, never for permission checks. */
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
				assetPermissions: v.object({ read: v.boolean(), write: v.boolean() }),
				scopes: plugin_ui_scopes_validator,
				principalKey: v.string(),
				credentialId: v.null(),
				pathPrefix: v.null(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		if (PLUGIN_RUN_TOKEN_RE.test(args.presented)) {
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

			// Platform baseline: download the exact triggering asset, write Markdown siblings.
			const scopes: Infer<typeof plugin_run_scopes_validator> = [
				public_api_SCOPE_FILES_DOWNLOAD,
				public_api_SCOPE_FILES_WRITE,
			];
			if (pluginRun.acceptedCapabilities.includes("plugin.secrets.read")) {
				scopes.push(public_api_SCOPE_SECRETS_READ);
			}
			if (pluginRun.acceptedCapabilities.includes("outbound.fetch")) {
				scopes.push(public_api_SCOPE_OUTBOUND_FETCH);
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

		if (PLUGIN_UI_TOKEN_RE.test(args.presented)) {
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
			const assetPermissions = await get_workspace_asset_permissions(ctx, {
				organizationId: session.organizationId,
				workspaceId: session.workspaceId,
				userId: session.userId,
			});

			// Workspace file reads are consent-gated; UI sessions never get secrets or outbound scopes.
			const scopes: Infer<typeof plugin_ui_scopes_validator> = installation.acceptedCapabilities.includes(
				"workspace.files.read",
			)
				? [public_api_SCOPE_FILES_LIST, public_api_SCOPE_FILES_READ, public_api_SCOPE_FILES_DOWNLOAD]
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
					assetPermissions,
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
			const assetPermissions = await get_workspace_asset_permissions(ctx, {
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
					assetPermissions,
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
		const assetPermissions = await get_workspace_asset_permissions(ctx, {
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
				assetPermissions,
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

/**
 * The verdict half of principal resolution: resolve_principal returns cacheable facts, this
 * applies the checks that vary per call — token expiry against the caller's clock and the
 * route's required user ACL (plugin runs never use user ACLs). Every route authorization goes
 * through here, except plugins_runtime's runner-host route, which applies the plugin_run
 * expiry inline because a value import from this module would be a runtime cycle.
 */
export async function public_api_resolve_live_principal(
	ctx: ActionCtx,
	args: {
		presented: string;
		now: number;
		requiredUserPermission?: "asset.read" | "asset.write";
	},
) {
	const resolved: public_api_resolve_principal_Result = await ctx.runQuery(internal.public_api.resolve_principal, {
		presented: args.presented,
	});
	if (resolved._nay) {
		return resolved;
	}

	const principal = resolved._yay;
	const expiresAt =
		principal.kind === "plugin_run"
			? principal.apiTokenExpiresAt
			: principal.kind === "plugin_ui"
				? principal.sessionExpiresAt
				: principal.kind === "public_api_grant"
					? principal.expiresAt
					: null;
	if (expiresAt != null && expiresAt <= args.now) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}

	if (args.requiredUserPermission && principal.kind !== "plugin_run") {
		const allowed =
			args.requiredUserPermission === "asset.read" ? principal.assetPermissions.read : principal.assetPermissions.write;
		if (!allowed) {
			return Result({ _nay: { message: "Permission denied" } });
		}
	}

	return resolved;
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

async function mark_credential_used_best_effort(
	ctx: ActionCtx,
	args: {
		credentialId: Id<"api_credentials"> | null;
		now: number;
	},
) {
	const credentialId = args.credentialId;
	if (!credentialId) return;

	try {
		await ctx.runMutation(internal.public_api.mark_credential_used, {
			credentialId,
			now: args.now,
		});
	} catch (error) {
		console.warn("Failed to mark API credential used", {
			error,
			credentialId,
		});
	}
}

async function limit_bad_auth(ctx: ActionCtx, request: Request, route: string) {
	return await rate_limiter_limit_by_key(ctx, {
		name: "public_api_auth",
		key: `${rate_limiter_http_client_key(request)}:${route}`,
	});
}

/**
 * Settle a plugin call created by `authorize_request`. Best-effort: telemetry settlement must
 * never turn an already-decided HTTP response into a failure. Idempotent on the mutation side, so
 * a handler may settle a call the publish mutation already settled transactionally.
 */
async function settle_plugin_call_best_effort(
	ctx: ActionCtx,
	args: {
		callId: Id<"plugins_event_run_calls"> | null;
		status: "succeeded" | "failed";
		responseStatus: number;
		errorCode?: string;
		errorMessage?: string;
		responseBytes?: number;
	},
) {
	const callId = args.callId;
	if (!callId) return;

	try {
		await ctx.runMutation(internal.plugins_runtime.finish_run_call, {
			callId,
			status: args.status,
			responseStatus: args.responseStatus,
			errorCode: args.errorCode,
			errorMessage: args.errorMessage ?? null,
			responseBytes: args.responseBytes,
		});
	} catch (error) {
		console.warn("Failed to settle plugin run call", { error, callId });
	}
}

function is_principal_kind_allowed<K extends PrincipalKind>(
	principal: Principal,
	allowedKinds: readonly K[],
): principal is Extract<Principal, { kind: K }> {
	// Widening assignment: every K is a PrincipalKind.
	const kinds: readonly PrincipalKind[] = allowedKinds;
	return kinds.includes(principal.kind);
}

function has_same_download_authority(
	initial: Extract<Principal, { kind: "user_api_key" | "plugin_run" | "plugin_ui" }>,
	current: Principal,
) {
	const currentScopes: readonly Scope[] = current.scopes;
	if (
		initial.organizationId !== current.organizationId ||
		initial.workspaceId !== current.workspaceId ||
		!currentScopes.includes(public_api_SCOPE_FILES_DOWNLOAD)
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

async function authorize_request<K extends PrincipalKind>(
	ctx: ActionCtx,
	request: Request,
	args: {
		requiredScope: Scope;
		allowedKinds: readonly K[];
		/** ACL required from user principals (grants and API keys); plugin runs use scopes only. */
		requiredUserPermission?: "asset.read" | "asset.write";
		route: string;
	},
) {
	const token = get_bearer_token(request);
	if (!token || !is_plausible_bearer_token(token)) {
		const rateLimit = await limit_bad_auth(ctx, request, args.route);
		if (rateLimit) {
			return {
				_nay: {
					status: 429,
					body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs },
				},
			} as const;
		}

		return { _nay: { status: 401, body: { message: "Unauthenticated" } } } as const;
	}

	const resolved = await public_api_resolve_live_principal(ctx, {
		presented: token,
		now: Date.now(),
		requiredUserPermission: args.requiredUserPermission,
	});
	if (resolved._nay) {
		const rateLimit = await limit_bad_auth(ctx, request, args.route);
		if (rateLimit) {
			return {
				_nay: {
					status: 429,
					body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs },
				},
			} as const;
		}

		return {
			_nay: {
				status: resolved._nay.message === "Permission denied" ? 403 : 401,
				body: { message: resolved._nay.message },
			},
		} as const;
	}

	const principal = resolved._yay;
	const now = Date.now();
	const postAuthRateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "public_api_principal",
		key: `${principal.kind}:${principal.principalKey}:${args.route}`,
	});
	if (postAuthRateLimit) {
		console.warn("Public API principal route rate-limited", {
			route: args.route,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		return {
			_nay: {
				status: 429,
				body: { message: postAuthRateLimit.message, retryAfterMs: postAuthRateLimit.retryAfterMs },
			},
		} as const;
	}

	// Consume the quota slot before the kind/scope checks: a valid plugin token burning itself on a
	// disallowed route is a failed constraint and must still cost a slot and leave a failed call.
	let pluginCallId: Id<"plugins_event_run_calls"> | null = null;
	if (principal.kind === "plugin_run") {
		const consumed: plugins_runtime_consume_run_api_call_Result = await ctx.runMutation(
			internal.plugins_runtime.consume_run_api_call,
			{
				runId: principal.runId,
				kind: "api_request",
				route: args.route,
			},
		);
		if (consumed._nay) {
			return {
				_nay: {
					status: consumed._nay.message === "Plugin API call limit exceeded" ? 429 : 401,
					body: { message: consumed._nay.message },
				},
			} as const;
		}
		pluginCallId = consumed._yay.callId;
	}

	// Captured before the generic kind narrowing below: on the narrowed Extract<Principal, ...>
	// type these property accesses stay deferred and fail to type-check, while on the full union
	// each arm's scope array widens to Scope[] and the credentialId ternary narrows normally.
	const principalScopes: readonly Scope[] = principal.scopes;
	const credentialId = principal.kind === "plugin_run" ? null : principal.credentialId;

	if (!is_principal_kind_allowed(principal, args.allowedKinds)) {
		console.warn("Public API principal kind rejected", {
			route: args.route,
			requiredKinds: args.allowedKinds,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		await settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: 403,
			errorCode: "permission_denied",
			errorMessage: "Permission denied",
		});
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	if (!principalScopes.includes(args.requiredScope)) {
		console.warn("Public API principal scope rejected", {
			route: args.route,
			requiredScope: args.requiredScope,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		await settle_plugin_call_best_effort(ctx, {
			callId: pluginCallId,
			status: "failed",
			responseStatus: 403,
			errorCode: "permission_denied",
			errorMessage: "Permission denied",
		});
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	await mark_credential_used_best_effort(ctx, {
		credentialId,
		now,
	});
	return { _yay: { principal, pluginCallId, presentedToken: token } } as const;
}

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
		!(await has_workspace_asset_permission(ctx, {
			organizationId: credential.organizationId,
			workspaceId: credential.workspaceId,
			userId: credential.userId,
			permission: "asset.write",
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
			contentAssetId: v.id("files_r2_assets"),
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

		const insert_stage_asset = (kind: "content" | "yjs_snapshot" | "content_snapshot", size: number) =>
			ctx.db.insert("files_r2_assets", {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				kind,
				r2Bucket: r2_get_bucket(),
				size,
				createdBy: args.userId,
				updatedAt: now,
			});
		const [contentAssetId, yjsSnapshotAssetId, contentSnapshotAssetId] = await Promise.all([
			insert_stage_asset("content", args.contentSize),
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
			contentAssetId,
			yjsSnapshotAssetId,
			contentSnapshotAssetId,
			expiresAt: now + FILE_WRITE_STAGE_TTL_MS,
			updatedAt: now,
		});

		return Result({ _yay: { stageId, contentAssetId, yjsSnapshotAssetId, contentSnapshotAssetId } });
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

		const [contentAsset, yjsSnapshotAsset, contentSnapshotAsset] = await Promise.all([
			ctx.db.get("files_r2_assets", stage.contentAssetId),
			ctx.db.get("files_r2_assets", stage.yjsSnapshotAssetId),
			ctx.db.get("files_r2_assets", stage.contentSnapshotAssetId),
		]);
		if (!contentAsset || !yjsSnapshotAsset || !contentSnapshotAsset) {
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
			if (activeNode.kind !== "file") {
				return Result({ _nay: { message: "A folder already exists at this path" } });
			}
			if (stage.overwrite === "fail") {
				return Result({ _nay: { message: "A file already exists at this path" } });
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
			assetId: stage.contentAssetId,
			yjsSnapshotAssetId: stage.yjsSnapshotAssetId,
			textContent: args.content,
			readOnly: false,
			now,
		});
		if (created._nay) {
			// An intermediate segment is owned by a file, or an equivalent structural conflict.
			return Result({ _nay: { message: created._nay.message } });
		}

		await files_nodes_db_finalize_file_node_creation(ctx, {
			organizationId: stage.organizationId,
			workspaceId: stage.workspaceId,
			nodeId: created._yay,
			userId: stage.userId,
			contentAssetId: stage.contentAssetId,
			contentSize: contentAsset.size,
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
		}
		if (stage.callId) {
			const call = await ctx.db.get("plugins_event_run_calls", stage.callId);
			// A late or duplicate finish is a no-op: only a started call settles.
			if (call && call.status === "started") {
				await ctx.db.patch("plugins_event_run_calls", call._id, {
					status: "succeeded",
					errorMessage: null,
					responseStatus: 200,
					requestBytes: contentAsset.size,
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
 * Idempotent unpublished-write cleanup: R2 objects first, then the asset docs, then the stage doc,
 * so a crash mid-cleanup leaves the stage behind for a retry. Publication deletes the stage in its
 * own transaction first, so cleanup can never delete a published output.
 */
export async function public_api_db_cleanup_file_write_stage(
	ctx: MutationCtx,
	stage: Doc<"public_api_file_write_stages">,
) {
	for (const assetId of [stage.contentAssetId, stage.yjsSnapshotAssetId, stage.contentSnapshotAssetId]) {
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

// HTTP routes

export function public_api_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/v1/files/list" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							path: z.string().optional(),
							cursor: z.string().nullable().optional(),
							limit: z.number().int().min(1).optional(),
							recursive: z.boolean().optional(),
							kind: z.enum(["file", "folder"]).optional(),
							extension: z.string().optional(),
							contentTypePrefixes: z.array(z.string().min(1)).max(8).optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_request(ctx, request, {
								requiredScope: public_api_SCOPE_FILES_LIST,
								allowedKinds: ["user_api_key", "public_api_grant", "plugin_ui"],
								requiredUserPermission: "asset.read",
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay.principal;

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}

							const requestedPath = server_path_normalize(body._yay.path ?? "/");
							if (!is_path_inside_prefix(requestedPath, principal.pathPrefix)) {
								return { status: 403, body: { message: "Permission denied" } } as const;
							}

							const lowercaseExtension = normalize_extension(body._yay.extension);
							const numItems = Math.min(body._yay.limit ?? FILES_LIST_MAX_ITEMS, FILES_LIST_MAX_ITEMS);
							const result = await ctx.runQuery(internal.files_nodes.list_subtree, {
								organizationId: principal.organizationId,
								workspaceId: principal.workspaceId,
								folderPath: requestedPath,
								numItems,
								cursor: body._yay.cursor ?? null,
								kind: body._yay.kind,
								lowercaseExtension,
								minDepth: 1,
								maxDepth: body._yay.recursive ? undefined : 1,
							});

							// Filtering happens after pagination: cursor and isDone come from the unfiltered
							// page, so a filtered page can be short or even empty while isDone is still
							// false. Clients just keep fetching until isDone.
							const contentTypePrefixes = body._yay.contentTypePrefixes;
							const pageItems = contentTypePrefixes
								? result.page.filter((item) => {
										const contentType = item.contentType;
										return contentType != null && contentTypePrefixes.some((prefix) => contentType.startsWith(prefix));
									})
								: result.page;

							console.info("Public API files listed", {
								principalKind: principal.kind,
								principalKey: principal.principalKey,
								count: pageItems.length,
								isDone: result.isDone,
							});

							return {
								status: 200,
								body: {
									items: pageItems.map((item) => ({
										path: item.path,
										name: item.name,
										kind: item.kind,
										nodeId: item._id,
										contentType: item.contentType ?? null,
										updatedAt: item.updatedAt,
									})),
									cursor: result.continueCursor,
									isDone: result.isDone,
								},
								headers: { "Cache-Control": "no-store" },
							} as const;
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),

		...((/* iife */ path = "/api/v1/files/read" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							path: z.string(),
							maxBytes: z.number().int().min(1).optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_request(ctx, request, {
								requiredScope: public_api_SCOPE_FILES_READ,
								allowedKinds: ["user_api_key", "public_api_grant", "plugin_ui"],
								requiredUserPermission: "asset.read",
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay.principal;

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}

							const requestedPath = server_path_normalize(body._yay.path);
							if (requestedPath === "/") {
								return { status: 400, body: { message: "Path must point to a file." } } as const;
							}
							if (!is_path_inside_prefix(requestedPath, principal.pathPrefix)) {
								return { status: 403, body: { message: "Permission denied" } } as const;
							}

							const content = await ctx.runAction(
								internal.files_nodes.get_file_last_available_markdown_content_by_path,
								{
									organizationId: principal.organizationId,
									workspaceId: principal.workspaceId,
									userId: principal.userId,
									path: requestedPath,
									includePending: principal.kind === "public_api_grant",
									maxBytes: Math.min(body._yay.maxBytes ?? FILES_READ_MAX_BYTES, FILES_READ_MAX_BYTES),
								},
							);
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
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),

		...((/* iife */ path = "/api/v1/files/read-many" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							paths: z.array(z.string()).min(1),
							maxBytes: z.number().int().min(1).optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_request(ctx, request, {
								requiredScope: public_api_SCOPE_FILES_READ,
								allowedKinds: ["user_api_key", "public_api_grant"],
								requiredUserPermission: "asset.read",
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay.principal;

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}

							const requestedPaths = body._yay.paths
								.slice(0, FILES_READ_MANY_MAX_ITEMS)
								.map((filePath) => server_path_normalize(filePath));
							if (requestedPaths.some((filePath) => filePath === "/")) {
								return { status: 400, body: { message: "Paths must point to files." } } as const;
							}
							if (requestedPaths.some((filePath) => !is_path_inside_prefix(filePath, principal.pathPrefix))) {
								return { status: 403, body: { message: "Permission denied" } } as const;
							}

							const maxBytes = Math.min(body._yay.maxBytes ?? FILES_READ_MAX_BYTES, FILES_READ_MAX_BYTES);
							const contents = await Promise.all(
								requestedPaths.map(async (filePath) => ({
									path: filePath,
									content: await ctx.runAction(internal.files_nodes.get_file_last_available_markdown_content_by_path, {
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
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),

		...((/* iife */ path = "/api/v1/files/write" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							path: z.string(),
							content: z.string(),
							overwrite: z.enum(["replace", "fail"]).optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_request(ctx, request, {
								requiredScope: public_api_SCOPE_FILES_WRITE,
								allowedKinds: ["user_api_key", "plugin_run"],
								requiredUserPermission: "asset.write",
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
								await settle_plugin_call_best_effort(ctx, {
									callId: pluginCallId,
									status: "failed",
									responseStatus: failArgs.status,
									errorCode: failArgs.errorCode,
									errorMessage: failArgs.message,
								});
								return { message: failArgs.message };
							};

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
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
							if (body._yay.content.length === 0) {
								return {
									status: 400,
									body: await fail({ status: 400, message: "Content must not be empty.", errorCode: "invalid_input" }),
								} as const;
							}
							const contentBytes = files_get_utf8_byte_size(body._yay.content);
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
							if (
								principal.kind === "plugin_run" &&
								server_path_parent_of(requestedPath) !== principal.outputParentPath
							) {
								return {
									status: 403,
									body: await fail({ status: 403, message: "Permission denied", errorCode: "permission_denied" }),
								} as const;
							}
							const overwrite = body._yay.overwrite ?? "replace";

							const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(body._yay.content);
							if (snapshotUpdate._nay) {
								console.error("Failed to build Yjs snapshot for public file write", {
									nay: snapshotUpdate._nay,
									path: requestedPath,
								});
								return {
									status: 500,
									body: await fail({ status: 500, message: "Failed to write file", errorCode: "storage_failure" }),
								} as const;
							}

							let principalRef: Infer<typeof file_write_principal_ref_validator>;
							if (principal.kind === "plugin_run") {
								if (!pluginCallId) {
									// Unreachable: authorize_request creates the call for plugin principals.
									throw should_never_happen("plugin_run write without a consumed call", {
										runId: principal.runId,
									});
								}
								principalRef = { kind: "plugin_run", runId: principal.runId, callId: pluginCallId };
							} else {
								principalRef = { kind: "user_api_key", credentialId: principal.credentialId };
							}

							const prepared: prepare_file_write_Result = await ctx.runMutation(
								internal.public_api.prepare_file_write,
								{
									organizationId: principal.organizationId,
									workspaceId: principal.workspaceId,
									userId: principal.kind === "plugin_run" ? principal.actorUserId : principal.userId,
									principalRef,
									path: requestedPath,
									overwrite,
									contentSize: contentBytes,
									yjsSnapshotSize: snapshotUpdate._yay.byteLength,
								},
							);
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
							const contentKey = r2_create_asset_key({ ...stageScope, assetId: prepared._yay.contentAssetId });
							const yjsSnapshotKey = r2_create_asset_key({ ...stageScope, assetId: prepared._yay.yjsSnapshotAssetId });
							const contentSnapshotKey = r2_create_asset_key({
								...stageScope,
								assetId: prepared._yay.contentSnapshotAssetId,
							});
							// Passed to cleanup so objects PUT after run terminalization already swept the
							// stage (deleting the docs the keys derive from) still get removed from the bucket.
							const orphanedKeys = [contentKey, yjsSnapshotKey, contentSnapshotKey];
							// Every PUT must settle before any cleanup: a fast-failing sibling would otherwise
							// trigger the key sweep while another PUT is still in flight, and that PUT would
							// re-create its object after the sweep — an untracked blob no reaper can find.
							const putResults = await Promise.allSettled([
								r2_put_object(ctx, {
									key: contentKey,
									body: body._yay.content,
									contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
								}),
								r2_put_object(ctx, {
									key: yjsSnapshotKey,
									body: snapshotUpdate._yay,
									contentType: "application/octet-stream" satisfies files_ContentType,
								}),
								r2_put_object(ctx, {
									key: contentSnapshotKey,
									body: body._yay.content,
									contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
								}),
							]);
							const putFailure = putResults.find((result) => result.status === "rejected");
							if (putFailure) {
								console.error("Failed to write staged file objects", {
									error: putFailure.reason,
									stageId,
									path: requestedPath,
								});
								const failBody = await fail({
									status: 500,
									message: "Failed to write file",
									errorCode: "storage_failure",
								});
								await ctx.runMutation(internal.public_api.cleanup_file_write_stage, { stageId, orphanedKeys });
								return { status: 500, body: failBody } as const;
							}

							const published: publish_file_write_Result = await ctx.runMutation(
								internal.public_api.publish_file_write,
								{
									stageId,
									content: body._yay.content,
								},
							);
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

							console.info("Public API file written", {
								principalKind: principal.kind,
								principalKey: principal.principalKey,
								bytes: contentBytes,
							});

							return {
								status: 200,
								body: {
									path: requestedPath,
									nodeId: published._yay.nodeId,
									contentType: "text/markdown;charset=utf-8" as const,
								},
								headers: { "Cache-Control": "no-store" },
							} as const;
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),

		...((/* iife */ path = "/api/v1/files/download-urls" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							fileNodeIds: z.array(z.string().min(1)).min(1).max(FILES_DOWNLOAD_URLS_MAX_REQUEST_ITEMS),
							expiresInSeconds: z.number().int().min(1).max(FILES_DOWNLOAD_URL_MAX_TTL_SECONDS).optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
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
							const body = bodyValidator.safeParse(bodyJson);
							if (!body.success) {
								return { status: 400, body: { message: "Request body validation failed" } } as const;
							}
							// Duplicate ids never consume principal capacity or start file work.
							if (new Set(body.data.fileNodeIds).size !== body.data.fileNodeIds.length) {
								return { status: 400, body: { message: "fileNodeIds must be unique" } } as const;
							}

							const auth = await authorize_request(ctx, request, {
								requiredScope: public_api_SCOPE_FILES_DOWNLOAD,
								allowedKinds: ["user_api_key", "plugin_run", "plugin_ui"],
								requiredUserPermission: "asset.read",
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay.principal;
							const pluginCallId = auth._yay.pluginCallId;
							const presentedToken = auth._yay.presentedToken;

							const fail = async (failArgs: { status: number; message: string; errorCode: string }) => {
								await settle_plugin_call_best_effort(ctx, {
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

							// authorize_request charged one slot for the request; the rest of the batch
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

							await Promise.all(
								datas.map(async (data) => {
									if (
										principal.kind === "plugin_run" ||
										!data ||
										!data.materializationState ||
										data.materializationState.yjsLastSequenceDoc.lastSequence <=
											data.materializationState.yjsSnapshotDoc.sequence
									) {
										return;
									}
									// Try to update the committed Markdown asset, but still allow downloading
									// the current R2 asset if this fails.
									const materialized = await ctx.runAction(internal.files_nodes.materialize_file_content, {
										organizationId: principal.organizationId,
										workspaceId: principal.workspaceId,
										nodeId: data.fileNode._id,
										userId: principal.userId,
										targetSequence: data.materializationState.yjsLastSequenceDoc.lastSequence,
									});
									if (materialized._nay) {
										console.warn("Failed to materialize Markdown before public download", {
											fileNodeId: data.fileNode._id,
											nay: materialized._nay,
										});
									}
								}),
							);

							// Materialization can be slow. Resolve the exact bearer again so every URL uses
							// the authority that remains when this all-or-nothing batch starts signing.
							const signingAuthority = await public_api_resolve_live_principal(ctx, {
								presented: presentedToken,
								now: Date.now(),
								requiredUserPermission: "asset.read",
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
									Math.floor((principalAuthorityExpiresAt - preSignAt) / 1000) -
									FILES_DOWNLOAD_URL_SIGNING_MARGIN_SECONDS;
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
									if (!data || !data.asset.r2Key) {
										return { fileNodeId, url: null };
									}
									return {
										fileNodeId,
										url: await r2_get_download_url({ key: data.asset.r2Key, options: { expiresIn } }),
									};
								}),
							);
							const expiresAt = Math.min(
								preSignAt + expiresIn * 1000,
								principalAuthorityExpiresAt ?? Number.POSITIVE_INFINITY,
							);
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
								requiredUserPermission: "asset.read",
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

							await settle_plugin_call_best_effort(ctx, {
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
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
