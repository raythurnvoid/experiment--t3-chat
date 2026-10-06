import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { ai_chat_files_db_get_invocation_membership } from "./ai_chat_files.ts";
import { ai_chat_workspaces_db_resolve, ai_chat_workspaces_SELECTORS } from "./ai_chat_workspaces.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_integration_policy_db_allows_mcp_server } from "./organizations_integration_policy.ts";
import { plugins_access_db_authorize_management } from "./plugins_access.ts";
import app_convex_schema, { ai_chat_workspaces_source_validator, plugins_mcp_target_validator } from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_decrypt_secret_value, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import type { plugins_McpServer } from "../shared/plugins.ts";

const DELETION_BATCH_SIZE = 100;

/**
 * Revocation docs only wait for one revoke attempt, so a day is plenty.
 */
const REVOCATION_RETENTION_MS = 24 * 60 * 60 * 1000;

const CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * At most this many MCP servers load in one chat turn.
 */
const TURN_SERVERS_MAX = 20;

/**
 * After this many turns in a row with a failed tool list, turn setup skips the server for a while.
 */
const UNHEALTHY_AFTER_FAILURES = 3;
const UNHEALTHY_PAUSE_MS = 5 * 60 * 1000;

export const plugins_mcp_CANNOT_USE_MESSAGE = "You cannot use MCP servers in this workspace.";
export const plugins_mcp_POLICY_MESSAGE = "Your organization's MCP policy blocks this server.";

/**
 * SHA-256 of where a plugin MCP server sends data: its URL, its whole `auth` object, and its header
 * names, never header values. The organization allowlist matches on it. The object is built with a
 * fixed key order, so the same server always gives the same value, however it was read back.
 */
export async function plugins_mcp_destination_fingerprint(server: plugins_McpServer) {
	const auth =
		server.auth.kind === "oauth"
			? {
					kind: server.auth.kind,
					issuer: server.auth.issuer,
					resource: server.auth.resource,
					scopes: server.auth.scopes,
				}
			: { kind: server.auth.kind };
	return `sha256:${await crypto_sha256_hex(
		JSON.stringify({ url: server.url, auth, headers: server.headers.map((header) => header.name) }),
	)}`;
}

/**
 * The additional data that binds a member's header secret to its server, member, and name. A secret
 * doc copied to another server, member, or name fails to decrypt.
 */
export function plugins_mcp_custom_secret_additional_data(args: {
	customServerId: Id<"mcp_custom_servers">;
	userId: Id<"users">;
	name: string;
}) {
	return `custom_secret:${args.customServerId}:${args.userId}:${args.name}`;
}

/**
 * Decrypt the header secrets of a member's own server into a name-to-value map.
 */
export async function plugins_mcp_decrypt_custom_secrets(args: {
	customServerId: Id<"mcp_custom_servers">;
	userId: Id<"users">;
	secrets: ReadonlyArray<Doc<"mcp_custom_server_secrets">>;
}) {
	const values = new Map<string, string>();
	for (const secret of args.secrets) {
		values.set(
			secret.name,
			await crypto_decrypt_secret_value({
				secret: secret.value,
				additionalData: plugins_mcp_custom_secret_additional_data({ ...args, name: secret.name }),
				keyName: "MCP_SECRETS_ENCRYPTION_KEY",
			}),
		);
	}
	return values;
}

/**
 * The header values of a member's own server: each header joins its parts with the secret values.
 */
export function plugins_mcp_custom_header_values(
	headers: Doc<"mcp_custom_servers">["headers"],
	secretValues: ReadonlyMap<string, string>,
) {
	return headers.map((header) => ({
		name: header.name,
		value: header.parts.map((part) => (part.kind === "text" ? part.text : secretValues.get(part.secretName)!)).join(""),
	}));
}

/**
 * The additional data that binds a grant's encrypted tokens to its target, member, and sign-in server.
 */
export function plugins_mcp_grant_additional_data(
	grant: Pick<Doc<"plugins_mcp_oauth_grants">, "target" | "userId" | "issuer" | "resource">,
) {
	const target =
		grant.target.kind === "plugin"
			? `plugin:${grant.target.installationId}:${grant.target.serverId}`
			: `custom:${grant.target.customServerId}`;
	return `grant:${target}:${grant.userId}:${grant.issuer}:${grant.resource}`;
}

/**
 * Delete one grant and keep what a later revoke needs.
 *
 * The tokens are deleted first, in this transaction. Deletion paths are mutations and cannot fetch,
 * so the encrypted token is copied into a revocation doc for a later best-effort revoke. A grant with
 * no revocation endpoint or no token has nothing to revoke.
 */
export async function plugins_mcp_db_revoke_grant(ctx: MutationCtx, grant: Doc<"plugins_mcp_oauth_grants">) {
	await ctx.db.delete("plugins_mcp_oauth_grants", grant._id);
	await plugins_mcp_db_schedule_revocation(ctx, grant);
}

/**
 * Copy a grant's encrypted token into a revocation doc and schedule one revoke attempt. The caller
 * deletes or clears the tokens on the grant itself.
 */
export async function plugins_mcp_db_schedule_revocation(
	ctx: MutationCtx,
	grant: Pick<
		Doc<"plugins_mcp_oauth_grants">,
		| "target"
		| "userId"
		| "issuer"
		| "resource"
		| "revocationEndpoint"
		| "clientId"
		| "clientKind"
		| "tokenEndpointAuthMethod"
		| "accessToken"
		| "refreshToken"
	>,
) {
	// Revoking the refresh token also ends the access tokens it made at most servers.
	const token = grant.refreshToken
		? { value: grant.refreshToken, hint: "refresh_token" as const }
		: grant.accessToken
			? { value: grant.accessToken, hint: "access_token" as const }
			: null;
	if (!grant.revocationEndpoint || !token) {
		return;
	}

	const revocationId = await ctx.db.insert("plugins_mcp_oauth_revocations", {
		token: token.value,
		additionalData: plugins_mcp_grant_additional_data(grant),
		tokenTypeHint: token.hint,
		revocationEndpoint: grant.revocationEndpoint,
		issuer: grant.issuer,
		clientId: grant.clientId,
		clientKind: grant.clientKind,
		tokenEndpointAuthMethod: grant.tokenEndpointAuthMethod,
	});
	// Only the doc id goes into the scheduler args. Convex keeps those args where the dashboard shows
	// them, so a token must never be one.
	await ctx.scheduler.runAfter(0, internal.plugins_mcp_oauth.revoke_one, { revocationId });
}

/**
 * The first free tool prefix for a plugin server in one workspace: the server id itself, else
 * `<id>-2`, `<id>-3`, ... The id is cut to 17 characters before the suffix, so the prefix stays at
 * most 20 characters.
 */
async function db_free_tool_prefix(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		serverId: string;
		taken: ReadonlySet<string>;
	},
) {
	const isFree = async (prefix: string) =>
		!args.taken.has(prefix) &&
		!(await ctx.db
			.query("plugins_mcp_servers")
			.withIndex("by_organization_workspace_toolPrefix", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("toolPrefix", prefix),
			)
			.first());

	if (await isFree(args.serverId)) {
		return args.serverId;
	}

	const base = args.serverId.slice(0, 17);
	for (let suffix = 2; ; suffix++) {
		const prefix = `${base}-${suffix}`;
		if (await isFree(prefix)) {
			return prefix;
		}
	}
}

/**
 * Where a grant was issued: a grant is only good for the same URL and the same sign-in server.
 */
function grant_destination(server: plugins_McpServer) {
	return server.auth.kind === "oauth" ? JSON.stringify([server.url, server.auth.issuer, server.auth.resource]) : null;
}

/**
 * Make an installation's server docs match its new version. Install and upgrade call it in the
 * install transaction, so two installs cannot take the same tool prefix.
 *
 * A doc is updated in place by server id, so its tool prefix and health count survive an upgrade and
 * old chat history keeps its tool names. When a server's URL or sign-in server changed, or the server
 * is gone, its grants are deleted and revoked in the background: one server can have a grant per
 * member, more than one transaction may write.
 */
export async function plugins_mcp_db_sync_installation_servers(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		previousServers: plugins_McpServer[];
		servers: plugins_McpServer[];
		now: number;
	},
) {
	const serverDocs = await ctx.db
		.query("plugins_mcp_servers")
		.withIndex("by_organization_workspace_installation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("installationId", args.installationId),
		)
		.collect();
	const serverDocsByServerId = new Map(serverDocs.map((serverDoc) => [serverDoc.serverId, serverDoc]));
	const previousServersById = new Map(args.previousServers.map((server) => [server.id, server]));
	const serverIds = new Set(args.servers.map((server) => server.id));
	const staleGrantServerIds: string[] = [];

	// Prefixes taken earlier in this loop are not visible to the index read yet.
	const takenPrefixes = new Set<string>();
	for (const server of args.servers) {
		const destinationFingerprint = await plugins_mcp_destination_fingerprint(server);
		const serverDoc = serverDocsByServerId.get(server.id);
		if (serverDoc) {
			await ctx.db.patch("plugins_mcp_servers", serverDoc._id, { destinationFingerprint });
			const previousServer = previousServersById.get(server.id);
			if (previousServer && grant_destination(previousServer) !== grant_destination(server)) {
				staleGrantServerIds.push(server.id);
			}
			continue;
		}

		const toolPrefix = await db_free_tool_prefix(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			serverId: server.id,
			taken: takenPrefixes,
		});
		takenPrefixes.add(toolPrefix);
		await ctx.db.insert("plugins_mcp_servers", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			serverId: server.id,
			toolPrefix,
			destinationFingerprint,
			failures: 0,
			unhealthyUntil: null,
		});
	}

	for (const serverDoc of serverDocs) {
		if (!serverIds.has(serverDoc.serverId)) {
			await ctx.db.delete("plugins_mcp_servers", serverDoc._id);
			staleGrantServerIds.push(serverDoc.serverId);
		}
	}

	for (const serverId of staleGrantServerIds) {
		// Only grants from before this change. A member may connect again before the drain runs, and
		// that new grant is for the new destination.
		await ctx.scheduler.runAfter(0, internal.plugins_mcp.drain_server_grants, {
			installationId: args.installationId,
			serverId,
			connectedBefore: args.now,
		});
	}
}

/**
 * Delete the grants one plugin server had before its URL or sign-in server changed, in batches.
 */
export const drain_server_grants = internalMutation({
	args: {
		installationId: v.id("plugins_workspace_installations"),
		serverId: v.string(),
		connectedBefore: v.number(),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const grants = await ctx.db
			.query("plugins_mcp_oauth_grants")
			.withIndex("by_targetInstallation_targetServerId_user", (q) =>
				q.eq("target.installationId", args.installationId).eq("target.serverId", args.serverId),
			)
			.filter((q) => q.lte(q.field("connectedAt"), args.connectedBefore))
			.take(DELETION_BATCH_SIZE);
		for (const grant of grants) {
			await plugins_mcp_db_revoke_grant(ctx, grant);
		}

		if (grants.length === DELETION_BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_mcp.drain_server_grants, {
				installationId: args.installationId,
				serverId: args.serverId,
				connectedBefore: args.connectedBefore,
			});
		}
		return null;
	},
});

/**
 * Delete one batch of an installation's MCP docs: server docs, grants (each revoked), pending
 * sign-ins, and the call ledger. Uninstall and the registry hard delete both use it.
 */
export async function plugins_mcp_db_drain_installation_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		installationId: Id<"plugins_workspace_installations">;
		batchSize: number;
	},
) {
	const servers = await ctx.db
		.query("plugins_mcp_servers")
		.withIndex("by_organization_workspace_installation", (q) =>
			q
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId)
				.eq("installationId", args.installationId),
		)
		.take(args.batchSize);
	if (servers.length > 0) {
		await Promise.all(servers.map((server) => ctx.db.delete("plugins_mcp_servers", server._id)));
		return { done: false, deletedCount: servers.length };
	}

	const grants = await ctx.db
		.query("plugins_mcp_oauth_grants")
		.withIndex("by_targetInstallation_targetServerId_user", (q) => q.eq("target.installationId", args.installationId))
		.take(args.batchSize);
	if (grants.length > 0) {
		for (const grant of grants) {
			await plugins_mcp_db_revoke_grant(ctx, grant);
		}
		return { done: false, deletedCount: grants.length };
	}

	for (const tableName of ["plugins_mcp_oauth_pending", "plugins_mcp_calls"] as const) {
		const docs = await ctx.db
			.query(tableName)
			.withIndex("by_targetInstallation", (q) => q.eq("target.installationId", args.installationId))
			.take(args.batchSize);
		if (docs.length > 0) {
			await Promise.all(docs.map((doc) => ctx.db.delete(tableName, doc._id)));
			return { done: false, deletedCount: docs.length };
		}
	}

	return { done: true, deletedCount: 0 };
}

/**
 * Finish deleting an uninstalled plugin's MCP docs.
 *
 * Uninstall removes the installation doc in its own transaction, so this drain cannot look the scope
 * up afterwards. The uninstall passes the tenant and installation id it already holds. Tools already
 * stopped loading, because the installation is gone.
 */
export const drain_uninstalled_installation = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({ done: v.boolean(), deletedCount: v.number() }),
	handler: async (ctx, args) => {
		const drained = await plugins_mcp_db_drain_installation_batch(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			installationId: args.installationId,
			batchSize: DELETION_BATCH_SIZE,
		});
		if (!drained.done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_mcp.drain_uninstalled_installation, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				installationId: args.installationId,
			});
		}

		return drained;
	},
});

/**
 * Delete one batch of a removed member's MCP docs in one organization. It shares one budget across
 * the organization's workspaces, like the other member removal drains. A member's own servers go
 * first, so their tools stop loading before anything else.
 */
export async function plugins_mcp_db_drain_member_batch(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		userId: Id<"users">;
		workspaceIds: readonly Id<"organizations_workspaces">[];
	},
) {
	let remaining = DELETION_BATCH_SIZE;

	// An organization has at most six workspaces. Walk those small ranges while keeping one total batch.
	for (const workspaceId of args.workspaceIds) {
		for (const tableName of [
			"mcp_custom_servers",
			"mcp_custom_server_secrets",
			"plugins_mcp_oauth_pending",
			"plugins_mcp_calls",
		] as const) {
			if (remaining === 0) {
				break;
			}

			const docs = await ctx.db
				.query(tableName)
				.withIndex("by_organization_workspace_user", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", workspaceId).eq("userId", args.userId),
				)
				.take(remaining);
			await Promise.all(docs.map((doc) => ctx.db.delete(tableName, doc._id)));
			remaining -= docs.length;
		}
		if (remaining === 0) {
			break;
		}

		const grants = await ctx.db
			.query("plugins_mcp_oauth_grants")
			.withIndex("by_organization_workspace_user", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", workspaceId).eq("userId", args.userId),
			)
			.take(remaining);
		for (const grant of grants) {
			await plugins_mcp_db_revoke_grant(ctx, grant);
		}
		remaining -= grants.length;
	}

	return { drainedAny: remaining < DELETION_BATCH_SIZE };
}

/**
 * Delete one batch of a user's MCP docs in every organization. A member's own servers go first, so
 * their tools stop loading before anything else.
 */
export async function plugins_mcp_db_delete_user_batch(
	ctx: MutationCtx,
	args: { userId: Id<"users">; batchSize: number },
) {
	for (const tableName of [
		"mcp_custom_servers",
		"mcp_custom_server_secrets",
		"plugins_mcp_oauth_pending",
		"plugins_mcp_calls",
	] as const) {
		const docs = await ctx.db
			.query(tableName)
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.take(args.batchSize);
		if (docs.length > 0) {
			await Promise.all(docs.map((doc) => ctx.db.delete(tableName, doc._id)));
			return { done: false, deletedCount: docs.length };
		}
	}

	const grants = await ctx.db
		.query("plugins_mcp_oauth_grants")
		.withIndex("by_user", (q) => q.eq("userId", args.userId))
		.take(args.batchSize);
	for (const grant of grants) {
		await plugins_mcp_db_revoke_grant(ctx, grant);
	}

	return { done: grants.length === 0, deletedCount: grants.length };
}

/**
 * Account deletion, at the request: delete the user's MCP servers, secrets, grants, and ledger in
 * every organization, including ones the user does not own. Recovering the account does not bring
 * them back.
 */
export const drain_user_mcp_docs = internalMutation({
	args: {
		userId: v.id("users"),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const drained = await plugins_mcp_db_delete_user_batch(ctx, {
			userId: args.userId,
			batchSize: DELETION_BATCH_SIZE,
		});
		if (!drained.done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_mcp.drain_user_mcp_docs, { userId: args.userId });
		}
		return null;
	},
});

/**
 * Delete revocation docs older than a day. `revoke_one` deletes a doc after its one attempt, so a
 * doc left here is one whose attempt never ran.
 */
export const cleanup_old_revocations = internalMutation({
	args: {
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const revocations = await ctx.db
			.query("plugins_mcp_oauth_revocations")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - REVOCATION_RETENTION_MS))
			.take(DELETION_BATCH_SIZE);
		await Promise.all(revocations.map((revocation) => ctx.db.delete("plugins_mcp_oauth_revocations", revocation._id)));

		if (revocations.length === DELETION_BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_mcp.cleanup_old_revocations, {});
		}
		return null;
	},
});

/**
 * Delete MCP call ledger docs older than 30 days.
 */
export const cleanup_old_calls = internalMutation({
	args: {
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const calls = await ctx.db
			.query("plugins_mcp_calls")
			.withIndex("by_startedAt", (q) => q.lt("startedAt", Date.now() - CALL_RETENTION_MS))
			.take(DELETION_BATCH_SIZE);
		await Promise.all(calls.map((call) => ctx.db.delete("plugins_mcp_calls", call._id)));

		if (calls.length === DELETION_BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_mcp.cleanup_old_calls, {});
		}
		return null;
	},
});

/**
 * Per server of one installation: health, whether the organization policy allows it, and the
 * caller's own sign-in. Never a token or a secret. The page takes each server's title and auth kind
 * from the installed version.
 */
export const get_installation_mcp_status = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		installationId: v.id("plugins_workspace_installations"),
	},
	returns: v.array(
		v.object({
			serverId: v.string(),
			/**
			 * Turn setup pauses a server after failed tool lists in a row. This is the last state it wrote.
			 */
			health: v.union(v.literal("healthy"), v.literal("paused")),
			policy: v.union(v.literal("allowed"), v.literal("blocked")),
			connection: v.union(
				v.object({
					status: doc(app_convex_schema, "plugins_mcp_oauth_grants").fields.status,
					scopes: v.array(v.string()),
					authorizationHost: v.string(),
					connectedAt: v.number(),
				}),
				v.null(),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		// The Access screen is for plugin managers, so this reads with the same permission.
		const allowed = await plugins_access_db_authorize_management(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			installationId: args.installationId,
		});
		if (allowed._nay?.message === "Unauthenticated") throw convex_error(allowed._nay);
		if (allowed._nay) {
			return [];
		}
		const membership = allowed._yay.membership;

		const servers = await ctx.db
			.query("plugins_mcp_servers")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("installationId", args.installationId),
			)
			.collect();

		return await Promise.all(
			servers.map(async (server) => {
				const target = { kind: "plugin" as const, installationId: args.installationId, serverId: server.serverId };
				const [policyAllows, grant] = await Promise.all([
					organizations_integration_policy_db_allows_mcp_server(ctx, {
						organizationId: membership.organizationId,
						target,
					}),
					ctx.db
						.query("plugins_mcp_oauth_grants")
						.withIndex("by_targetInstallation_targetServerId_user", (q) =>
							q
								.eq("target.installationId", args.installationId)
								.eq("target.serverId", server.serverId)
								.eq("userId", userAuth.id),
						)
						.first(),
				]);
				return {
					serverId: server.serverId,
					health: server.unhealthyUntil === null ? ("healthy" as const) : ("paused" as const),
					policy: policyAllows ? ("allowed" as const) : ("blocked" as const),
					connection: grant
						? {
								status: grant.status,
								scopes: grant.scope.split(" ").filter(Boolean),
								authorizationHost: new URL(grant.issuer).host,
								connectedAt: grant.connectedAt,
							}
						: null,
				};
			}),
		);
	},
});

/**
 * Whether the sidebar shows "MCP servers". A member who lost `workspace.mcp.use` but still has a
 * server or a sign-in here still gets the page, so they can delete them.
 */
export const mcp_available = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.object({ canUse: v.boolean(), hasSavedData: v.boolean() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return { canUse: false, hasSavedData: false };
		}

		const [mayUse, customServer, grant] = await Promise.all([
			access_control_db_authorize_membership(ctx, { userAuth, membership, permission: "workspace.mcp.use" }),
			ctx.db
				.query("mcp_custom_servers")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("userId", userAuth.id),
				)
				.first(),
			ctx.db
				.query("plugins_mcp_oauth_grants")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("userId", userAuth.id),
				)
				.first(),
		]);
		return { canUse: !mayUse._nay, hasSavedData: customServer !== null || grant !== null };
	},
});

/**
 * The caller's own sign-ins to the plugin MCP servers of this workspace: one entry per sign-in
 * server of an enabled installation, plus each server the caller still has a sign-in for after its
 * installation was turned off, so they can disconnect it. Never a token, a secret, a publisher, or a
 * source repository.
 */
export const list_member_plugin_connections = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.object({
		canUse: v.boolean(),
		servers: v.array(
			v.object({
				target: plugins_mcp_target_validator.members[0],
				pluginName: v.string(),
				serverTitle: v.string(),
				serverHost: v.string(),
				authorizationHost: v.string(),
				installationEnabled: v.boolean(),
				health: v.union(v.literal("healthy"), v.literal("paused")),
				policy: v.union(v.literal("allowed"), v.literal("blocked")),
				connection: v.union(
					v.object({
						status: doc(app_convex_schema, "plugins_mcp_oauth_grants").fields.status,
						scopes: v.array(v.string()),
						connectedAt: v.number(),
					}),
					v.null(),
				),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return { canUse: false, servers: [] };
		}
		const mayUse = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "workspace.mcp.use",
		});

		const [installations, grants] = await Promise.all([
			ctx.db
				.query("plugins_workspace_installations")
				.withIndex("by_organization_workspace_status_pluginName", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("status", "enabled"),
				)
				.collect(),
			ctx.db
				.query("plugins_mcp_oauth_grants")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("userId", userAuth.id),
				)
				.collect(),
		]);
		const grantByTarget = new Map(
			grants.flatMap((grant) =>
				grant.target.kind === "plugin" ? [[`${grant.target.installationId}:${grant.target.serverId}`, grant]] : [],
			),
		);

		// Installations turned off since the member signed in, so they can still disconnect.
		const enabledIds = new Set(installations.map((installation) => installation._id));
		const disabled = await Promise.all(
			[
				...new Set(
					grants.flatMap((grant) =>
						grant.target.kind === "plugin" && !enabledIds.has(grant.target.installationId)
							? [grant.target.installationId]
							: [],
					),
				),
			].map((installationId) => ctx.db.get("plugins_workspace_installations", installationId)),
		);

		const servers = [];
		for (const installation of [
			...installations.filter((installation) => installation.acceptedCapabilities.includes("agent.mcp.connect")),
			...disabled.filter((installation) => installation !== null),
		]) {
			const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
			const serverDocs = await ctx.db
				.query("plugins_mcp_servers")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("installationId", installation._id),
				)
				.collect();
			const installationEnabled = enabledIds.has(installation._id);

			for (const server of version.mcpServers) {
				const grant = grantByTarget.get(`${installation._id}:${server.id}`);
				if (server.auth.kind !== "oauth" || (!installationEnabled && !grant) || (mayUse._nay && !grant)) {
					continue;
				}

				const target = { kind: "plugin" as const, installationId: installation._id, serverId: server.id };
				const serverDoc = serverDocs.find((candidate) => candidate.serverId === server.id);
				servers.push({
					target,
					pluginName: installation.pluginName,
					serverTitle: server.title,
					serverHost: new URL(server.url).host,
					authorizationHost: new URL(server.auth.issuer).host,
					installationEnabled,
					health: serverDoc?.unhealthyUntil ? ("paused" as const) : ("healthy" as const),
					policy: (await organizations_integration_policy_db_allows_mcp_server(ctx, {
						organizationId: membership.organizationId,
						target,
					}))
						? ("allowed" as const)
						: ("blocked" as const),
					connection: grant
						? {
								status: grant.status,
								scopes: grant.scope.split(" ").filter(Boolean),
								connectedAt: grant.connectedAt,
							}
						: null,
				});
			}
		}

		return { canUse: !mayUse._nay, servers };
	},
});

/**
 * Whether every organization a chat thread can reach allows one MCP server. A thread reaches the
 * workspaces of `ai_chat_workspaces_SELECTORS`: today its own and the member's home. So a member
 * cannot get around a block by chatting in their home and reading the organization's files there.
 */
async function db_thread_allows_target(
	ctx: QueryCtx,
	args: {
		source: Infer<typeof ai_chat_workspaces_source_validator>;
		target: Infer<typeof plugins_mcp_target_validator>;
	},
) {
	for (const workspace of ai_chat_workspaces_SELECTORS) {
		const resolved = await ai_chat_workspaces_db_resolve(ctx, { source: args.source, workspace });
		if (resolved._nay) {
			return false;
		}
		const allowed = await organizations_integration_policy_db_allows_mcp_server(ctx, {
			organizationId: resolved._yay.organizationId,
			target: args.target,
		});
		if (!allowed) {
			return false;
		}
	}
	return true;
}

/**
 * The MCP servers one chat turn may load, in load order, and a note for each server left out.
 *
 * The thread may not exist yet, so the caller passes the organizations of the workspaces the turn
 * captured. Every one of them must allow a server. The `execute` recheck checks the same rule live.
 *
 * Plugin servers come first, then the member's own servers of this workspace. So when a turn has
 * more than 20, the member's own servers are left out first.
 */
export const list_turn_servers = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		reachOrganizationIds: v.array(v.id("organizations")),
	},
	returns: v.object({
		servers: v.array(
			v.union(
				v.object({
					kind: v.literal("plugin"),
					target: plugins_mcp_target_validator.members[0],
					toolPrefix: v.string(),
					/**
					 * How the server signs in. `oauth` servers get the member's token.
					 */
					auth: v.union(v.literal("none"), v.literal("headers"), v.literal("oauth")),
					source: v.object({ kind: v.literal("plugin"), pluginName: v.string(), serverTitle: v.string() }),
					/**
					 * Press text that names the server in the notes the model reads.
					 */
					label: v.string(),
					url: v.string(),
					destinationFingerprint: v.string(),
					/**
					 * The manifest's tool allowlist. Null means every tool the server lists.
					 */
					toolAllowlist: v.union(v.array(v.string()), v.null()),
					/**
					 * The call recheck compares it, so a turn never calls a URL the admin moved away from.
					 */
					pluginVersionId: v.id("plugins_versions"),
					/**
					 * Each header value is the value of the named plugin secret.
					 */
					headerSpec: v.array(v.object({ name: v.string(), secretName: v.string() })),
					failures: v.number(),
				}),
				v.object({
					kind: v.literal("custom"),
					target: plugins_mcp_target_validator.members[1],
					toolPrefix: v.string(),
					auth: v.union(v.literal("none"), v.literal("headers"), v.literal("oauth")),
					source: v.object({ kind: v.literal("custom"), serverName: v.string() }),
					label: v.string(),
					url: v.string(),
					/**
					 * The call recheck compares it, so an edit never sends the old headers to a new URL.
					 */
					destinationFingerprint: v.string(),
					/**
					 * Each header joins its parts. The chat action decrypts the secrets once per turn.
					 */
					headerSpec: doc(app_convex_schema, "mcp_custom_servers").fields.headers,
					secrets: v.array(doc(app_convex_schema, "mcp_custom_server_secrets")),
					failures: v.number(),
				}),
			),
		),
		notes: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("status", "enabled"),
			)
			.collect();

		const candidates = [];
		for (const installation of installations) {
			if (!installation.acceptedCapabilities.includes("agent.mcp.connect")) {
				continue;
			}

			const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
			const serverDocs = await ctx.db
				.query("plugins_mcp_servers")
				.withIndex("by_organization_workspace_installation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
						.eq("installationId", installation._id),
				)
				.collect();
			for (const serverDoc of serverDocs) {
				// Install and upgrade write the server docs from the installed version in one transaction,
				// so every doc has its server in the version.
				const server = version.mcpServers.find((candidate) => candidate.id === serverDoc.serverId)!;
				candidates.push({ installation, server, serverDoc });
			}
		}
		candidates.sort((a, b) => a.serverDoc.toolPrefix.localeCompare(b.serverDoc.toolPrefix));

		const customServers = (
			await ctx.db
				.query("mcp_custom_servers")
				.withIndex("by_organization_workspace_user", (q) =>
					q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("userId", args.userId),
				)
				.collect()
		)
			.filter((customServer) => customServer.enabled)
			.toSorted((a, b) => a.toolPrefix.localeCompare(b.toolPrefix));

		const entries = [
			...candidates.map(({ installation, server, serverDoc }) => ({
				unhealthyUntil: serverDoc.unhealthyUntil,
				turnServer: {
					kind: "plugin" as const,
					target: { kind: "plugin" as const, installationId: installation._id, serverId: server.id },
					toolPrefix: serverDoc.toolPrefix,
					auth: server.auth.kind === "secret_headers" ? ("headers" as const) : server.auth.kind,
					source: { kind: "plugin" as const, pluginName: installation.pluginName, serverTitle: server.title },
					label: `${installation.pluginName} · ${server.title}`,
					url: server.url,
					destinationFingerprint: serverDoc.destinationFingerprint,
					toolAllowlist: server.tools,
					pluginVersionId: installation.pluginVersionId,
					headerSpec: server.headers.map((header) => ({ name: header.name, secretName: header.secret })),
					failures: serverDoc.failures,
				},
			})),
			...(await Promise.all(
				customServers.map(async (customServer) => ({
					unhealthyUntil: customServer.unhealthyUntil,
					turnServer: {
						kind: "custom" as const,
						target: { kind: "custom" as const, customServerId: customServer._id },
						toolPrefix: customServer.toolPrefix,
						auth: customServer.auth.kind,
						source: { kind: "custom" as const, serverName: customServer.name },
						label: `Your server "${customServer.name}"`,
						url: customServer.url,
						destinationFingerprint: customServer.destinationFingerprint,
						headerSpec: customServer.headers,
						secrets: await ctx.db
							.query("mcp_custom_server_secrets")
							.withIndex("by_customServer_name", (q) => q.eq("customServerId", customServer._id))
							.collect(),
						failures: customServer.failures,
					},
				})),
			)),
		];

		const servers = [];
		const notes: string[] = [];
		for (const { unhealthyUntil, turnServer } of entries) {
			const { label, target } = turnServer;

			if (unhealthyUntil !== null && unhealthyUntil > now) {
				notes.push(`${label}: left out, because its tool list failed several turns in a row.`);
				continue;
			}

			let allowed = true;
			for (const organizationId of args.reachOrganizationIds) {
				if (!(await organizations_integration_policy_db_allows_mcp_server(ctx, { organizationId, target }))) {
					allowed = false;
					break;
				}
			}
			if (!allowed) {
				notes.push(`${label}: blocked by your organization's MCP policy.`);
				continue;
			}

			if (servers.length >= TURN_SERVERS_MAX) {
				notes.push(`${label}: left out, because a chat can use at most ${TURN_SERVERS_MAX} MCP servers.`);
				continue;
			}

			servers.push(turnServer);
		}

		return { servers, notes };
	},
});

/**
 * The health fields after one tool list at turn setup.
 */
function next_health(server: { failures: number; unhealthyUntil: number | null }, ok: boolean) {
	if (ok) {
		return { failures: 0, unhealthyUntil: null };
	}

	// Keep counting after the pause ends, so one more failed turn pauses the server again at once.
	const failures = server.failures + 1;
	return {
		failures,
		unhealthyUntil: failures >= UNHEALTHY_AFTER_FAILURES ? Date.now() + UNHEALTHY_PAUSE_MS : server.unhealthyUntil,
	};
}

/**
 * Record how one server's tool list went at turn setup. Only turn setup calls this, once per server
 * per turn. Tool calls never count: their input comes from the model and the member, so one member
 * could otherwise pause a shared plugin server for everyone. The caller counts only server-level
 * failures, never sign-in errors, for the same reason.
 */
export const record_server_outcome = internalMutation({
	args: {
		target: plugins_mcp_target_validator,
		expectedDestinationFingerprint: v.string(),
		ok: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Ignore a list result if the server was deleted or moved while the request was running.
		const healthDoc = await get_health_doc(ctx, args.target);
		if (!healthDoc || healthDoc.doc.destinationFingerprint !== args.expectedDestinationFingerprint) {
			return null;
		}

		const health = next_health(healthDoc.doc, args.ok);
		await healthDoc.patch(health);
		// Turn setup already uses a server again once its pause ends. Clear the pause at that time too,
		// so the MCP servers page and the plugin Access screen stop showing "Paused".
		if (health.unhealthyUntil !== null && health.unhealthyUntil !== healthDoc.doc.unhealthyUntil) {
			await ctx.scheduler.runAt(health.unhealthyUntil, internal.plugins_mcp.end_pause, {
				target: args.target,
				unhealthyUntil: health.unhealthyUntil,
			});
		}
		return null;
	},
});

/**
 * Clear a server's pause when it ends. Keep `failures`, so one more failed turn pauses it again at once.
 */
export const end_pause = internalMutation({
	args: {
		target: plugins_mcp_target_validator,
		unhealthyUntil: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const healthDoc = await get_health_doc(ctx, args.target);
		// A newer pause has its own job.
		if (healthDoc?.doc.unhealthyUntil === args.unhealthyUntil) {
			await healthDoc.patch({ unhealthyUntil: null });
		}
		return null;
	},
});

/**
 * The doc that holds one server's health, or `null` when the server is gone.
 */
async function get_health_doc(ctx: MutationCtx, target: Infer<typeof plugins_mcp_target_validator>) {
	type HealthFields = { failures?: number; unhealthyUntil: number | null };

	if (target.kind === "custom") {
		const customServer = await ctx.db.get("mcp_custom_servers", target.customServerId);
		return customServer
			? {
					doc: customServer,
					patch: (fields: HealthFields) => ctx.db.patch("mcp_custom_servers", customServer._id, fields),
				}
			: null;
	}

	const installation = await ctx.db.get("plugins_workspace_installations", target.installationId);
	if (!installation) {
		return null;
	}
	const serverDoc = await ctx.db
		.query("plugins_mcp_servers")
		.withIndex("by_organization_workspace_installation", (q) =>
			q
				.eq("organizationId", installation.organizationId)
				.eq("workspaceId", installation.workspaceId)
				.eq("installationId", installation._id),
		)
		.filter((q) => q.eq(q.field("serverId"), target.serverId))
		.first();
	return serverDoc
		? { doc: serverDoc, patch: (fields: HealthFields) => ctx.db.patch("plugins_mcp_servers", serverDoc._id, fields) }
		: null;
}

/**
 * Check one MCP tool call again right before Press sends it. The tool set was frozen at turn setup,
 * and the member, the policy, or the installation may have changed since. It returns no secret.
 */
export const recheck_call = internalQuery({
	args: {
		source: ai_chat_workspaces_source_validator,
		target: plugins_mcp_target_validator,
		/**
		 * The plugin version at turn setup. Null for a member's own server.
		 */
		expectedPluginVersionId: v.union(v.id("plugins_versions"), v.null()),
		/**
		 * The fingerprint of a member's own server at turn setup. Null for a plugin server.
		 */
		expectedDestinationFingerprint: v.union(v.string(), v.null()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		// Membership lifetime, thread, `content.read`, and the purge fence.
		const current = await ai_chat_workspaces_db_resolve(ctx, { source: args.source, workspace: "current" });
		if (current._nay) {
			return Result({ _nay: { message: current._nay.message } });
		}

		const membership = (await ctx.db.get("organizations_workspaces_users", args.source.membershipId))!;
		const mayUse = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.source.userId },
			membership,
			permission: "workspace.mcp.use",
		});
		if (mayUse._nay) {
			return Result({ _nay: { message: plugins_mcp_CANNOT_USE_MESSAGE } });
		}

		if (!(await db_thread_allows_target(ctx, { source: args.source, target: args.target }))) {
			return Result({ _nay: { message: plugins_mcp_POLICY_MESSAGE } });
		}

		const target = args.target;
		if (target.kind === "custom") {
			const customServer = await ctx.db.get("mcp_custom_servers", target.customServerId);
			if (
				!customServer ||
				!customServer.enabled ||
				customServer.userId !== args.source.userId ||
				customServer.organizationId !== args.source.organizationId ||
				customServer.workspaceId !== args.source.workspaceId
			) {
				return Result({ _nay: { message: "This MCP server is no longer available." } });
			}
			// An edit can point the server at another URL. Never send the old headers there.
			if (customServer.destinationFingerprint !== args.expectedDestinationFingerprint) {
				return Result({ _nay: { message: "The server changed; try again." } });
			}
			return Result({ _yay: null });
		}

		const installation = await ctx.db.get("plugins_workspace_installations", target.installationId);
		if (
			!installation ||
			installation.status !== "enabled" ||
			!installation.acceptedCapabilities.includes("agent.mcp.connect") ||
			installation.organizationId !== args.source.organizationId ||
			installation.workspaceId !== args.source.workspaceId
		) {
			return Result({ _nay: { message: "This MCP server is no longer available." } });
		}
		// A new version can point the server at another URL. Never keep calling the old one.
		if (installation.pluginVersionId !== args.expectedPluginVersionId) {
			return Result({ _nay: { message: "The plugin changed; try again." } });
		}
		const serverDoc = await ctx.db
			.query("plugins_mcp_servers")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId)
					.eq("installationId", installation._id),
			)
			.filter((q) => q.eq(q.field("serverId"), target.serverId))
			.first();
		if (!serverDoc) {
			return Result({ _nay: { message: "This MCP server is no longer available." } });
		}

		return Result({ _yay: null });
	},
});

/**
 * Write one MCP call to the ledger. No arguments and no output.
 */
export const record_call = internalMutation({
	args: {
		source: ai_chat_workspaces_source_validator,
		target: plugins_mcp_target_validator,
		toolName: v.string(),
		startedAt: v.number(),
		durationMs: v.number(),
		bytesIn: v.number(),
		bytesOut: v.number(),
		outcome: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// A delete drain may have finished while the call ran. A doc written now would never be
		// deleted, so write nothing when the member or the server is gone.
		const [membership, targetDoc] = await Promise.all([
			ai_chat_files_db_get_invocation_membership(ctx, args.source),
			args.target.kind === "plugin"
				? ctx.db.get("plugins_workspace_installations", args.target.installationId)
				: ctx.db.get("mcp_custom_servers", args.target.customServerId),
		]);
		if (!membership || !targetDoc) {
			return null;
		}

		await ctx.db.insert("plugins_mcp_calls", {
			organizationId: args.source.organizationId,
			workspaceId: args.source.workspaceId,
			userId: args.source.userId,
			threadId: args.source.threadId,
			target: args.target,
			toolName: args.toolName,
			startedAt: args.startedAt,
			durationMs: args.durationMs,
			bytesIn: args.bytesIn,
			bytesOut: args.bytesOut,
			outcome: args.outcome,
		});
		return null;
	},
});
