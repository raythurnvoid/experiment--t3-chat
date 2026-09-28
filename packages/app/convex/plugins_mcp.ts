import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { ai_chat_files_db_get_invocation_membership } from "./ai_chat_files.ts";
import { ai_chat_workspaces_db_resolve, ai_chat_workspaces_SELECTORS } from "./ai_chat_workspaces.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_integration_policy_db_allows_mcp_server } from "./organizations_integration_policy.ts";
import app_convex_schema, { ai_chat_workspaces_source_validator, plugins_mcp_target_validator } from "./schema.ts";
import { v_result } from "../server/convex-utils.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
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

/**
 * A chat turn only knows plugin servers for now. Members cannot add their own servers yet.
 */
const plugin_target_validator = plugins_mcp_target_validator.members[0];

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
 * The additional data that binds a grant's encrypted tokens to its target, member, and sign-in server.
 */
function grant_additional_data(grant: Doc<"plugins_mcp_oauth_grants">) {
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

	// Revoking the refresh token also ends the access tokens it made at most servers.
	const token = grant.refreshToken
		? { value: grant.refreshToken, hint: "refresh_token" as const }
		: grant.accessToken
			? { value: grant.accessToken, hint: "access_token" as const }
			: null;
	if (!grant.revocationEndpoint || !token) {
		return;
	}

	await ctx.db.insert("plugins_mcp_oauth_revocations", {
		token: token.value,
		additionalData: grant_additional_data(grant),
		tokenTypeHint: token.hint,
		revocationEndpoint: grant.revocationEndpoint,
		clientId: grant.clientId,
		clientKind: grant.clientKind,
		tokenEndpointAuthMethod: grant.tokenEndpointAuthMethod,
	});
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
			return [];
		}

		// The Access screen is for plugin managers, so this reads with the same permission.
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}
		const allowed = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "workspace.plugins.manage",
		});
		if (allowed._nay) {
			return [];
		}

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
 */
export const list_turn_servers = internalQuery({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		reachOrganizationIds: v.array(v.id("organizations")),
	},
	returns: v.object({
		servers: v.array(
			v.object({
				target: plugin_target_validator,
				toolPrefix: v.string(),
				source: v.object({ kind: v.literal("plugin"), pluginName: v.string(), serverTitle: v.string() }),
				url: v.string(),
				/**
				 * The manifest's tool allowlist. Null means every tool the server lists.
				 */
				toolAllowlist: v.union(v.array(v.string()), v.null()),
				pluginVersionId: v.id("plugins_versions"),
				/**
				 * Each header value is the value of the named plugin secret.
				 */
				headerSpec: v.array(v.object({ name: v.string(), secretName: v.string() })),
				failures: v.number(),
			}),
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

		const servers = [];
		const notes: string[] = [];
		for (const { installation, server, serverDoc } of candidates) {
			const label = `${installation.pluginName} · ${server.title}`;
			const target = { kind: "plugin" as const, installationId: installation._id, serverId: server.id };

			if (serverDoc.unhealthyUntil !== null && serverDoc.unhealthyUntil > now) {
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

			servers.push({
				target,
				toolPrefix: serverDoc.toolPrefix,
				source: { kind: "plugin" as const, pluginName: installation.pluginName, serverTitle: server.title },
				url: server.url,
				toolAllowlist: server.tools,
				pluginVersionId: installation.pluginVersionId,
				headerSpec: server.headers.map((header) => ({ name: header.name, secretName: header.secret })),
				failures: serverDoc.failures,
			});
		}

		return { servers, notes };
	},
});

/**
 * Record how one server's tool list went at turn setup. Only turn setup calls this, once per server
 * per turn. Tool calls never count: their input comes from the model and the member, so one member
 * could otherwise pause a shared plugin server for everyone. The caller counts only server-level
 * failures, never sign-in errors, for the same reason.
 */
export const record_server_outcome = internalMutation({
	args: {
		target: plugin_target_validator,
		ok: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Write nothing when the server is gone: an uninstall may have finished while the list ran.
		const installation = await ctx.db.get("plugins_workspace_installations", args.target.installationId);
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
			.filter((q) => q.eq(q.field("serverId"), args.target.serverId))
			.first();
		if (!serverDoc) {
			return null;
		}

		if (args.ok) {
			await ctx.db.patch("plugins_mcp_servers", serverDoc._id, { failures: 0, unhealthyUntil: null });
			return null;
		}

		// Keep counting after the pause ends, so one more failed turn pauses the server again at once.
		const failures = serverDoc.failures + 1;
		await ctx.db.patch("plugins_mcp_servers", serverDoc._id, {
			failures,
			unhealthyUntil: failures >= UNHEALTHY_AFTER_FAILURES ? Date.now() + UNHEALTHY_PAUSE_MS : serverDoc.unhealthyUntil,
		});
		return null;
	},
});

/**
 * Check one MCP tool call again right before Press sends it. The tool set was frozen at turn setup,
 * and the member, the policy, or the installation may have changed since. It returns no secret.
 */
export const recheck_call = internalQuery({
	args: {
		source: ai_chat_workspaces_source_validator,
		target: plugin_target_validator,
		expectedPluginVersionId: v.id("plugins_versions"),
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
			return Result({ _nay: { message: "You cannot use MCP servers in this workspace." } });
		}

		if (!(await db_thread_allows_target(ctx, { source: args.source, target: args.target }))) {
			return Result({ _nay: { message: "Your organization's MCP policy blocks this server." } });
		}

		const installation = await ctx.db.get("plugins_workspace_installations", args.target.installationId);
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
			.filter((q) => q.eq(q.field("serverId"), args.target.serverId))
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
		target: plugin_target_validator,
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
		// deleted, so write nothing when the member or the installation is gone.
		const [membership, installation] = await Promise.all([
			ai_chat_files_db_get_invocation_membership(ctx, args.source),
			ctx.db.get("plugins_workspace_installations", args.target.installationId),
		]);
		if (!membership || !installation) {
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
