import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { plugins_db_get_live_service_account } from "./plugins_service_accounts.ts";
import {
	crypto_decrypt_secret_value,
	crypto_encrypt_secret_value,
	crypto_sha256_hex,
	crypto_timing_safe_equal,
} from "../server/crypto-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { public_api_PLUGIN_UI_TOKEN_REGEX } from "../shared/public-api.ts";

async function live_installation(
	ctx: QueryCtx,
	args: {
		installationId: Id<"plugins_workspace_installations">;
		pluginVersionId: Id<"plugins_versions">;
		serviceAccountId: Id<"access_control_service_accounts">;
		actorUserId: Id<"users">;
		serviceSecretHash: string;
	},
) {
	const installation = await ctx.db.get("plugins_workspace_installations", args.installationId);
	if (
		!installation ||
		installation.status !== "enabled" ||
		installation.pluginVersionId !== args.pluginVersionId ||
		!installation.acceptedCapabilities.includes("plugin.service.connect") ||
		!(await plugins_db_get_live_service_account(ctx, { installation, serviceAccountId: args.serviceAccountId }))
	) {
		return null;
	}
	const [workspace, actor, registration, membership] = await Promise.all([
		ctx.db.get("organizations_workspaces", installation.workspaceId),
		ctx.db.get("users", args.actorUserId),
		ctx.db
			.query("plugins_service_registrations")
			.withIndex("by_pluginName", (q) => q.eq("pluginName", installation.pluginName))
			.first(),
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q
					.eq("active", true)
					.eq("userId", args.actorUserId)
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId),
			)
			.first(),
	]);
	if (
		!workspace ||
		workspace.organizationId !== installation.organizationId ||
		workspace.pluginDataPurgeStartedAt !== undefined ||
		!actor ||
		actor.deletedAt != null ||
		!membership ||
		!registration ||
		!crypto_timing_safe_equal(registration.exchangeSecretHash, args.serviceSecretHash)
	)
		return null;
	const capability = {
		"files:write": "workspace.files.write",
		"plugin_data:read": "plugin.data.read",
		"plugin_data:write": "plugin.data.write",
	} as const;
	if (registration.scopes.some((scope) => !installation.acceptedCapabilities.includes(capability[scope]))) return null;
	return { installation, registeredScopes: registration.scopes };
}

export async function plugins_service_grant_requests_db_source(
	ctx: QueryCtx,
	args: {
		presented: string;
		operation: "exchange" | "renew" | "seal";
		serviceSecretHash: string;
	},
) {
	const hash = await crypto_sha256_hex(args.presented);
	if (args.operation === "exchange") {
		if (!public_api_PLUGIN_UI_TOKEN_REGEX.test(args.presented)) return null;
		const session = await ctx.db
			.query("plugins_ui_sessions")
			.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
			.first();
		if (!session || session.expiresAt <= Date.now()) return null;
		const live = await live_installation(ctx, {
			...session,
			actorUserId: session.userId,
			serviceSecretHash: args.serviceSecretHash,
		});
		return live ? { ...live, actorUserId: session.userId } : null;
	}
	const grant = await ctx.db
		.query("plugin_service_grants")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
		.first();
	if (
		!grant ||
		grant.revokedAt != null ||
		grant.expiresAt <= Date.now() ||
		(args.operation === "seal" && grant.phase !== "interactive")
	)
		return null;
	const live = await live_installation(ctx, { ...grant, serviceSecretHash: args.serviceSecretHash });
	return live && grant.scopes.every((scope) => live.registeredScopes.includes(scope))
		? { ...live, actorUserId: grant.actorUserId }
		: null;
}

export async function plugins_service_grant_requests_db_recover(
	ctx: QueryCtx,
	args: {
		presented: string;
		operation: "exchange" | "renew" | "seal";
		requestId: string;
		fingerprint: string;
		serviceSecretHash: string;
	},
) {
	const credentialHash = await crypto_sha256_hex(args.presented);
	const receipt = await ctx.db
		.query("plugin_service_grant_requests")
		.withIndex("by_credentialHash_operation_requestId", (q) =>
			q.eq("credentialHash", credentialHash).eq("operation", args.operation).eq("requestId", args.requestId),
		)
		.first();
	if (!receipt) {
		return (await plugins_service_grant_requests_db_source(ctx, args))
			? Result({ _yay: null })
			: Result({ _nay: { message: "Unauthenticated" } });
	}
	const grant = await ctx.db.get("plugin_service_grants", receipt.grantId);
	if (
		!grant ||
		grant.revokedAt != null ||
		grant.expiresAt <= Date.now() ||
		grant.tokenHash !== receipt.responseTokenHash
	) {
		return Result({ _nay: { message: "Unauthenticated" } });
	}
	const live = await live_installation(ctx, { ...grant, serviceSecretHash: args.serviceSecretHash });
	if (!live || grant.scopes.some((scope) => !live.registeredScopes.includes(scope)))
		return Result({ _nay: { message: "Unauthenticated" } });
	if (receipt.fingerprint !== args.fingerprint)
		return Result({ _nay: { message: "This request ID was already used" } });
	if (receipt.expiresAt <= Date.now() || receipt.ciphertext === null || receipt.nonce === null) {
		return Result({ _nay: { message: "Reconnect Files sync" } });
	}
	const token = await crypto_decrypt_secret_value(
		{ ciphertext: receipt.ciphertext, nonce: receipt.nonce },
		JSON.stringify([credentialHash, args.operation, args.requestId, args.fingerprint]),
	);
	return Result({
		_yay: {
			token,
			grantId: grant._id,
			principalKey: grant.principalKey,
			scopes: grant.scopes,
			expiresAt: grant.expiresAt,
			actorUserId: grant.actorUserId,
			organizationId: grant.organizationId,
			workspaceId: grant.workspaceId,
			installationId: grant.installationId,
			destinationPathPrefix: grant.destinationPathPrefix,
		},
	});
}

export async function plugins_service_grant_requests_db_save(
	ctx: MutationCtx,
	args: {
		presented: string;
		operation: "exchange" | "renew" | "seal";
		requestId: string;
		fingerprint: string;
		grant: Doc<"plugin_service_grants">;
		token: string;
	},
) {
	const credentialHash = await crypto_sha256_hex(args.presented);
	const encrypted = await crypto_encrypt_secret_value(
		args.token,
		JSON.stringify([credentialHash, args.operation, args.requestId, args.fingerprint]),
	);
	const expiresAt = Math.min(Date.now() + 24 * 60 * 60 * 1000, args.grant.expiresAt);
	await ctx.db.insert("plugin_service_grant_requests", {
		organizationId: args.grant.organizationId,
		workspaceId: args.grant.workspaceId,
		installationId: args.grant.installationId,
		credentialHash,
		operation: args.operation,
		requestId: args.requestId,
		fingerprint: args.fingerprint,
		grantId: args.grant._id,
		responseTokenHash: args.grant.tokenHash,
		...encrypted,
		responseAvailable: true,
		expiresAt,
		createdAt: Date.now(),
	});
	await ctx.scheduler.runAt(expiresAt, internal.plugins_service_grant_requests.cleanup, {});
}

export const recover = internalMutation({
	args: {
		presented: v.string(),
		operation: v.union(v.literal("exchange"), v.literal("renew"), v.literal("seal")),
		requestId: v.string(),
		fingerprint: v.string(),
		serviceSecretHash: v.string(),
	},
	returns: v_result({
		_yay: v.union(
			v.object({
				token: v.string(),
				grantId: v.id("plugin_service_grants"),
				principalKey: v.string(),
				scopes: v.array(
					v.union(v.literal("files:write"), v.literal("plugin_data:read"), v.literal("plugin_data:write")),
				),
				expiresAt: v.number(),
				actorUserId: v.id("users"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				installationId: v.id("plugins_workspace_installations"),
				destinationPathPrefix: v.union(v.string(), v.null()),
			}),
			v.null(),
		),
	}),
	handler: async (ctx, args) => await plugins_service_grant_requests_db_recover(ctx, args),
});

export const cleanup = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const expired = await ctx.db
			.query("plugin_service_grant_requests")
			.withIndex("by_responseAvailable_expiresAt", (q) => q.eq("responseAvailable", true).lte("expiresAt", Date.now()))
			.take(100);
		for (const receipt of expired)
			await ctx.db.patch("plugin_service_grant_requests", receipt._id, {
				ciphertext: null,
				nonce: null,
				responseAvailable: false,
			});
		if (expired.length === 100) await ctx.scheduler.runAfter(0, internal.plugins_service_grant_requests.cleanup, {});
		return null;
	},
});
