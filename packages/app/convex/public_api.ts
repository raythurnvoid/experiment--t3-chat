import { v } from "convex/values";
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
import type { Id } from "./_generated/dataModel";
import type { RegisteredQuery, RouteSpec } from "convex/server";
import { z } from "zod";
import type { RouterForConvexModules } from "./http.ts";
import { access_control_db_has_permission } from "./access_control.ts";
import { rate_limiter_limit_by_key, rate_limiter_http_client_key } from "./rate_limiter.ts";
import { type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import { type api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_path_normalize,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

export const public_api_SCOPE_FILES_LIST = "files:list";
export const public_api_SCOPE_FILES_READ = "files:read";

const FILES_LIST_MAX_ITEMS = 100;
const FILES_READ_MAX_BYTES = 128_000;
const FILES_READ_MANY_MAX_ITEMS = 50;
const FILES_READ_MANY_MAX_CONTENT_BYTES = 384_000;

const TEXT_ENCODER = new TextEncoder();
const CREDENTIAL_KEY_PREFIX = "pk_";
const CREDENTIAL_KEY_ID_BYTES = 16;
const CREDENTIAL_SECRET_BYTES = 32;
const API_CREDENTIAL_TOKEN_RE = /^pk_[0-9a-f]{32}\.[0-9a-f]{64}$/u;
const PUBLIC_API_GRANT_TOKEN_RE = /^[0-9a-f]{64}$/u;
const PUBLIC_API_GRANT_TTL_MS = 10 * 60 * 1000;
const PUBLIC_API_GRANT_CLEANUP_BATCH_SIZE = 100;

type Scope = typeof public_api_SCOPE_FILES_LIST | typeof public_api_SCOPE_FILES_READ;
type PrincipalKind = "public_api_grant" | "user_api_key";

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

function timing_safe_equal(left: string, right: string) {
	const leftBytes = TEXT_ENCODER.encode(left);
	const rightBytes = TEXT_ENCODER.encode(right);
	let difference = leftBytes.length ^ rightBytes.length;
	const maxLength = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < maxLength; index += 1) {
		difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return difference === 0;
}

function is_plausible_bearer_token(token: string) {
	// Reject malformed bearer tokens before credential/grant lookup; well-formed tokens still require DB verification.
	return API_CREDENTIAL_TOKEN_RE.test(token) || PUBLIC_API_GRANT_TOKEN_RE.test(token);
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

async function has_file_read_access(
	ctx: QueryCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		userId: Id<"users">;
	},
) {
	const [organization, workspace] = await Promise.all([
		ctx.db.get("organizations", args.organizationId),
		ctx.db.get("organizations_workspaces", args.workspaceId),
	]);
	if (!organization || !workspace || !organization.defaultWorkspaceId || workspace.organizationId !== organization._id) {
		return false;
	}

	return await access_control_db_has_permission(ctx, {
		organizationId: organization._id,
		workspaceId: workspace._id,
		defaultWorkspaceId: organization.defaultWorkspaceId,
		organizationOwnerUserId: organization.ownerUserId,
		resourceKind: "workspace",
		resourceId: String(workspace._id),
		permission: "asset.read",
		userId: args.userId,
	});
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
		scopes: v.array(v.union(v.literal(public_api_SCOPE_FILES_LIST), v.literal(public_api_SCOPE_FILES_READ))),
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
		scopes: v.array(v.union(v.literal(public_api_SCOPE_FILES_LIST), v.literal(public_api_SCOPE_FILES_READ))),
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
				scopes: v.array(v.union(v.literal(public_api_SCOPE_FILES_LIST), v.literal(public_api_SCOPE_FILES_READ))),
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

export const resolve_principal = internalQuery({
	args: {
		presented: v.string(),
		now: v.number(),
	},
	returns: v_result({
		_yay: v.object({
			kind: v.union(v.literal("public_api_grant"), v.literal("user_api_key")),
			organizationId: v.id("organizations"),
			workspaceId: v.id("organizations_workspaces"),
			userId: v.id("users"),
			scopes: v.array(v.union(v.literal(public_api_SCOPE_FILES_LIST), v.literal(public_api_SCOPE_FILES_READ))),
			principalKey: v.string(),
			credentialId: v.union(v.id("api_credentials"), v.null()),
			pathPrefix: v.union(v.string(), v.null()),
		}),
		_nay: {
			data: v.object({
				status: v.number(),
				reason: v.string(),
			}),
		},
	}),
	handler: async (ctx, args) => {
		if (args.presented.startsWith(CREDENTIAL_KEY_PREFIX)) {
			const separatorIndex = args.presented.indexOf(".");
			if (separatorIndex <= 0 || separatorIndex === args.presented.length - 1) {
				return Result({
					_nay: {
						message: "Unauthenticated",
						data: { status: 401, reason: "malformed_credential" },
					},
				});
			}

			const keyId = args.presented.slice(0, separatorIndex);
			const secret = args.presented.slice(separatorIndex + 1);
			const credentials = await ctx.db
				.query("api_credentials")
				.withIndex("by_keyId", (q) => q.eq("keyId", keyId))
				.take(2);
			if (credentials.length !== 1) {
				return Result({
					_nay: {
						message: "Unauthenticated",
						data: {
							status: 401,
							reason: credentials.length > 1 ? "duplicate_key_id" : "unknown_credential",
						},
					},
				});
			}

			const credential = credentials[0];
			if (credential.revokedAt != null) {
				return Result({
					_nay: {
						message: "Unauthenticated",
						data: { status: 401, reason: "revoked" },
					},
				});
			}

			const secretHash = await crypto_sha256_hex(secret);
			if (!timing_safe_equal(secretHash, credential.secretHash)) {
				return Result({
					_nay: {
						message: "Unauthenticated",
						data: { status: 401, reason: "bad_secret" },
					},
				});
			}

			const user = await ctx.db.get("users", credential.userId);
			if (!user || user.deletedAt != null) {
				return Result({
					_nay: {
						message: "Unauthenticated",
						data: { status: 401, reason: "missing_user" },
					},
				});
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
				return Result({
					_nay: {
						message: "Unauthenticated",
						data: { status: 401, reason: "inactive_membership" },
					},
				});
			}
			if (
				!(await has_file_read_access(ctx, {
					organizationId: credential.organizationId,
					workspaceId: credential.workspaceId,
					userId: credential.userId,
				}))
			) {
				return Result({
					_nay: {
						message: "Permission denied",
						data: { status: 403, reason: "missing_asset_read" },
					},
				});
			}

			return Result({
				_yay: {
					kind: "user_api_key" as const,
					organizationId: credential.organizationId,
					workspaceId: credential.workspaceId,
					userId: credential.userId,
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
		if (!grant || grant.expiresAt <= args.now) {
			return Result({
				_nay: {
					message: "Unauthenticated",
					data: { status: 401, reason: "unknown_or_expired_grant" },
				},
			});
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
			return Result({
				_nay: {
					message: "Unauthenticated",
					data: { status: 401, reason: "inactive_membership" },
				},
			});
		}
		if (
			!(await has_file_read_access(ctx, {
				organizationId: grant.organizationId,
				workspaceId: grant.workspaceId,
				userId: grant.userId,
			}))
		) {
			return Result({
				_nay: {
					message: "Permission denied",
					data: { status: 403, reason: "missing_asset_read" },
				},
			});
		}

		return Result({
			_yay: {
				kind: "public_api_grant" as const,
				organizationId: grant.organizationId,
				workspaceId: grant.workspaceId,
				userId: grant.userId,
				scopes: grant.scopes,
				principalKey: grant.principalKey,
				credentialId: null,
				pathPrefix: grant.pathPrefix,
			},
		});
	},
});

type resolve_principal_Result =
	typeof resolve_principal extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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

async function authorize_request(
	ctx: ActionCtx,
	request: Request,
	args: {
		requiredScope: Scope;
		allowedKinds: PrincipalKind[];
		route: string;
	},
) {
	const token = get_bearer_token(request);
	if (!token) {
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
	if (!is_plausible_bearer_token(token)) {
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

	const resolved: resolve_principal_Result = await ctx.runQuery(
		internal.public_api.resolve_principal,
		{
			presented: token,
			now: Date.now(),
		},
	);
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

		return { _nay: { status: resolved._nay.data.status, body: { message: resolved._nay.message } } } as const;
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

	if (!args.allowedKinds.includes(principal.kind)) {
		console.warn("Public API principal kind rejected", {
			route: args.route,
			requiredKinds: args.allowedKinds,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	if (!principal.scopes.includes(args.requiredScope)) {
		console.warn("Public API principal scope rejected", {
			route: args.route,
			requiredScope: args.requiredScope,
			principalKind: principal.kind,
			principalKey: principal.principalKey,
		});
		return { _nay: { status: 403, body: { message: "Permission denied" } } } as const;
	}

	await mark_credential_used_best_effort(ctx, {
		credentialId: principal.credentialId,
		now,
	});
	return { _yay: principal } as const;
}

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
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await authorize_request(ctx, request, {
								requiredScope: public_api_SCOPE_FILES_LIST,
								allowedKinds: ["user_api_key", "public_api_grant"],
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay;

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: body._nay } as const;
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

							console.info("Public API files listed", {
								principalKind: principal.kind,
								principalKey: principal.principalKey,
								count: result.page.length,
								isDone: result.isDone,
							});

							return {
								status: 200,
								body: {
									items: result.page.map((item) => ({
										path: item.path,
										name: item.name,
										kind: item.kind,
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
								allowedKinds: ["user_api_key", "public_api_grant"],
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay;

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: body._nay } as const;
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
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay;

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: body._nay } as const;
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
	};
}
