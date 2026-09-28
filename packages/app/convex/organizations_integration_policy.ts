import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { access_control_db_has_permission } from "./access_control.ts";
import { access_control_changes_db_record } from "./access_control_changes.ts";
import { plugins_mcp_destination_fingerprint } from "./plugins_mcp.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_convex_get_user_fallback_to_anonymous, should_never_happen } from "../server/server-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

/**
 * Keep the policy doc far below the 1 MiB document limit.
 */
const ALLOWLIST_MAX_ENTRIES = 50;

const DISABLE_BATCH_SIZE = 100;

const policy_validator = doc(app_convex_schema, "organizations_integration_policies");
const policy_mode_validator = policy_validator.fields.plugins.fields.mode;

type IntegrationPolicy = Doc<"organizations_integration_policies">;

async function db_get_policy(ctx: QueryCtx, organizationId: Id<"organizations">) {
	return await ctx.db
		.query("organizations_integration_policies")
		.withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
		.first();
}

/**
 * Where one plugin server sends data, as the key the plugin entry stores.
 */
function server_key(serverId: string, destinationFingerprint: string) {
	return JSON.stringify([serverId, destinationFingerprint]);
}

/**
 * The plugin entry for a version. An entry names one plugin by name, publisher, and source
 * repository, because a name can be taken by another publisher after a registry delete.
 */
function find_plugin_entry(policy: IntegrationPolicy, version: Doc<"plugins_versions">) {
	return policy.plugins.allowlist.find(
		(entry) =>
			entry.pluginName === version.name &&
			entry.publisherUserId === version.createdBy &&
			entry.sourceRepositoryUrl === version.sourceRepositoryUrl,
	);
}

/**
 * Whether a plugin version fits a custom organization's policy.
 *
 * The plugin entry's ceiling is everything the owner approved. A version that asks for anything
 * outside it (a capability, an origin, an MCP server or a new destination for one) waits for the
 * owner. No doc means nothing is allowed.
 */
async function plugin_version_status(policy: IntegrationPolicy | null, version: Doc<"plugins_versions">) {
	if (policy?.plugins.mode === "allow_all") {
		return "allowed" as const;
	}

	const entry = policy ? find_plugin_entry(policy, version) : undefined;
	if (!entry) {
		return "blocked" as const;
	}

	const capabilities = new Set(entry.capabilities);
	const outboundOrigins = new Set(entry.outboundOrigins);
	const uiOutboundOrigins = new Set(entry.uiOutboundOrigins);
	const servers = new Set(entry.mcpServers.map((server) => server_key(server.serverId, server.destinationFingerprint)));
	const versionServerKeys = await Promise.all(
		version.mcpServers.map(async (server) => server_key(server.id, await plugins_mcp_destination_fingerprint(server))),
	);
	const fits =
		version.capabilities.every((capability) => capabilities.has(capability)) &&
		version.outboundOrigins.every((origin) => outboundOrigins.has(origin)) &&
		version.uiOutboundOrigins.every((origin) => uiOutboundOrigins.has(origin)) &&
		versionServerKeys.every((key) => servers.has(key));
	return fits ? ("allowed" as const) : ("needs_approval" as const);
}

/**
 * Whether an organization lets a plugin version be installed. The personal organization allows
 * every plugin. `install_version` is the only writer of `status: "enabled"`, so this install-time
 * check plus the disable pass below keep every enabled installation inside the policy.
 */
export async function organizations_integration_policy_db_plugin_version_status(
	ctx: QueryCtx,
	args: { organization: Doc<"organizations">; version: Doc<"plugins_versions"> },
) {
	if (args.organization.default) {
		return "allowed" as const;
	}

	return await plugin_version_status(await db_get_policy(ctx, args.organization._id), args.version);
}

/**
 * Whether one organization lets agent chats use one MCP server. The caller asks once for every
 * organization a chat thread can reach.
 */
export async function organizations_integration_policy_db_allows_mcp_server(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; target: Doc<"plugins_mcp_oauth_grants">["target"] },
) {
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization) {
		return false;
	}
	if (organization.default) {
		return true;
	}

	const policy = await db_get_policy(ctx, organization._id);
	if (!policy) {
		return false;
	}

	if (args.target.kind === "custom") {
		const customServer = await ctx.db.get("mcp_custom_servers", args.target.customServerId);
		if (!customServer) {
			return false;
		}

		return (
			policy.mcpServers.mode === "allow_all" ||
			policy.mcpServers.allowlist.some((entry) => entry.destinationFingerprint === customServer.destinationFingerprint)
		);
	}

	// A plugin and its MCP servers are allowed together, so a plugin server is checked against its
	// plugin's entry, pinned by where the server sends data.
	if (policy.plugins.mode === "allow_all") {
		return true;
	}
	const target = args.target;
	const installation = await ctx.db.get("plugins_workspace_installations", target.installationId);
	if (!installation) {
		return false;
	}
	const [version, server] = await Promise.all([
		ctx.db.get("plugins_versions", installation.pluginVersionId),
		ctx.db
			.query("plugins_mcp_servers")
			.withIndex("by_organization_workspace_installation", (q) =>
				q
					.eq("organizationId", installation.organizationId)
					.eq("workspaceId", installation.workspaceId)
					.eq("installationId", installation._id),
			)
			.filter((q) => q.eq(q.field("serverId"), target.serverId))
			.first(),
	]);
	if (!version || !server) {
		return false;
	}

	const entry = find_plugin_entry(policy, version);
	return (
		entry?.mcpServers.some(
			(entryServer) =>
				entryServer.serverId === server.serverId &&
				entryServer.destinationFingerprint === server.destinationFingerprint,
		) ?? false
	);
}

/**
 * Turn off the enabled installations a stricter policy no longer allows, in batches. Data,
 * configuration, secrets, and the service account stay, so an admin can turn the plugin on again
 * after the owner allows it. Each batch reads the live policy, so running it again is safe.
 */
async function db_disable_blocked_installations(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		cursor: { workspaceId: Id<"organizations_workspaces">; pluginName: string } | null;
		batchSize: number;
	},
) {
	const organization = await ctx.db.get("organizations", args.organizationId);
	if (!organization || organization.default) {
		return;
	}

	const policy = await db_get_policy(ctx, organization._id);
	const workspaces = await ctx.db
		.query("organizations_workspaces")
		.withIndex("by_organization_default", (q) => q.eq("organizationId", organization._id))
		.collect();
	const now = Date.now();

	// A workspace deleted since the last batch is not in the list any more, so start over from the
	// first workspace, with no plugin name filter. Every pass is safe to repeat.
	const cursorIndex = args.cursor
		? workspaces.findIndex((workspace) => workspace._id === args.cursor?.workspaceId)
		: -1;
	let remaining = args.batchSize;
	for (let index = Math.max(0, cursorIndex); index < workspaces.length; index++) {
		const workspace = workspaces[index]!;
		const afterPluginName = index === cursorIndex ? (args.cursor?.pluginName ?? null) : null;
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) => {
				const enabled = q
					.eq("organizationId", organization._id)
					.eq("workspaceId", workspace._id)
					.eq("status", "enabled");
				return afterPluginName === null ? enabled : enabled.gt("pluginName", afterPluginName);
			})
			.take(remaining);

		for (const installation of installations) {
			const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
			// The install writes the installation from a stored version, and the registry delete
			// disables installations before it deletes their versions.
			if (!version) {
				throw should_never_happen("plugins_versions doc missing for an enabled installation", {
					installationId: installation._id,
				});
			}
			if ((await plugin_version_status(policy, version)) === "allowed") {
				continue;
			}

			await ctx.db.patch("plugins_workspace_installations", installation._id, {
				status: "disabled",
				updatedAt: now,
			});
			await access_control_changes_db_record(ctx, [
				{
					scope: { kind: "installation", installationId: installation._id },
					event: { kind: "refresh", reason: "installation" },
				},
			]);
		}

		remaining -= installations.length;
		if (remaining === 0) {
			await ctx.scheduler.runAfter(0, internal.organizations_integration_policy.disable_blocked_installations, {
				organizationId: organization._id,
				cursor: { workspaceId: workspace._id, pluginName: installations.at(-1)!.pluginName },
			});
			return;
		}
	}
}

export const disable_blocked_installations = internalMutation({
	args: {
		organizationId: v.id("organizations"),
		cursor: v.union(v.object({ workspaceId: v.id("organizations_workspaces"), pluginName: v.string() }), v.null()),
		_test_batchSize: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await db_disable_blocked_installations(ctx, {
			organizationId: args.organizationId,
			cursor: args.cursor,
			batchSize: args._test_batchSize ?? DISABLE_BATCH_SIZE,
		});
		return null;
	},
});

/**
 * Check that the caller may manage the policy of a custom organization. Copied from
 * `set_organization_billing_mode`.
 */
async function db_authorize_policy_manager(
	ctx: QueryCtx,
	args: { userId: Id<"users">; organization: Doc<"organizations"> },
) {
	const defaultWorkspaceId = args.organization.defaultWorkspaceId;
	if (!defaultWorkspaceId) {
		const errorMessage = "organization.defaultWorkspaceId is not set";
		const errorData = { organizationId: args.organization._id };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}

	// The permission check does not verify membership, so we do it here. Otherwise a user whose
	// memberships were turned off for account deletion could still change the policy.
	const homeMembership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", args.userId)
				.eq("organizationId", args.organization._id)
				.eq("workspaceId", defaultWorkspaceId),
		)
		.first();
	if (!homeMembership) {
		return false;
	}

	return await access_control_db_has_permission(ctx, {
		organizationId: args.organization._id,
		workspaceId: defaultWorkspaceId,
		defaultWorkspaceId,
		organizationOwnerUserId: args.organization.ownerUserId,
		resource: { kind: "organization", id: String(args.organization._id) },
		permission: "organization.integrations_policy.manage",
		userId: args.userId,
	});
}

export const update_policy = mutation({
	args: {
		organizationId: v.id("organizations"),
		change: v.union(
			v.object({ kind: v.literal("set_plugins_mode"), mode: policy_mode_validator }),
			v.object({ kind: v.literal("allow_plugin"), pluginVersionId: v.id("plugins_versions") }),
			v.object({ kind: v.literal("remove_plugin"), pluginName: v.string() }),
			v.object({ kind: v.literal("set_mcp_servers_mode"), mode: policy_mode_validator }),
			v.object({ kind: v.literal("allow_mcp_server"), destinationFingerprint: v.string() }),
			v.object({ kind: v.literal("remove_mcp_server"), destinationFingerprint: v.string() }),
		),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (organization.default) {
			return Result({ _nay: { message: "The personal organization allows every plugin and MCP server" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "organizations_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		if (!(await db_authorize_policy_manager(ctx, { userId: userAuth.id, organization }))) {
			return Result({ _nay: { message: "Permission denied" } });
		}

		const now = Date.now();
		const policy = await db_get_policy(ctx, organization._id);
		let plugins = policy?.plugins ?? { mode: "allowlist" as const, allowlist: [] };
		let mcpServers = policy?.mcpServers ?? { mode: "allowlist" as const, allowlist: [] };
		const change = args.change;

		if (change.kind === "set_plugins_mode") {
			plugins = { ...plugins, mode: change.mode };
		} else if (change.kind === "allow_plugin") {
			const version = await ctx.db.get("plugins_versions", change.pluginVersionId);
			if (!version) {
				return Result({ _nay: { message: "Not found" } });
			}
			if (version.sourceStatus !== "ready" || version.reviewStatus !== "passed") {
				return Result({ _nay: { message: "Only a published plugin version can be allowed" } });
			}

			// The server copies the plugin and its reach from the version, so a client cannot send its
			// own ceiling. Allowing a newer version widens the ceiling to cover both, so older versions
			// installed in other workspaces stay inside it.
			const existing = plugins.allowlist.find((entry) => entry.pluginName === version.name);
			const sameSource =
				existing?.publisherUserId === version.createdBy && existing.sourceRepositoryUrl === version.sourceRepositoryUrl;
			if (!existing && plugins.allowlist.length >= ALLOWLIST_MAX_ENTRIES) {
				return Result({
					_nay: { message: `This list is full (${ALLOWLIST_MAX_ENTRIES}). Remove an entry or use Allow all.` },
				});
			}

			const previous = sameSource ? existing : null;
			const servers = new Map(
				(previous?.mcpServers ?? []).map((server) => [
					server_key(server.serverId, server.destinationFingerprint),
					server,
				]),
			);
			for (const server of version.mcpServers) {
				const destinationFingerprint = await plugins_mcp_destination_fingerprint(server);
				servers.set(server_key(server.id, destinationFingerprint), {
					serverId: server.id,
					destinationFingerprint,
					url: server.url,
				});
			}
			const entry = {
				pluginName: version.name,
				publisherUserId: version.createdBy,
				sourceRepositoryUrl: version.sourceRepositoryUrl,
				capabilities: [...new Set([...(previous?.capabilities ?? []), ...version.capabilities])],
				outboundOrigins: [...new Set([...(previous?.outboundOrigins ?? []), ...version.outboundOrigins])],
				uiOutboundOrigins: [...new Set([...(previous?.uiOutboundOrigins ?? []), ...version.uiOutboundOrigins])],
				mcpServers: [...servers.values()],
				addedBy: previous?.addedBy ?? userAuth.id,
				addedAt: previous?.addedAt ?? now,
				updatedAt: now,
			};
			// An entry for the same name from another source is replaced. Its installations stop
			// matching, and the disable pass below turns them off.
			plugins = {
				...plugins,
				allowlist: [...plugins.allowlist.filter((entry) => entry.pluginName !== version.name), entry],
			};
		} else if (change.kind === "remove_plugin") {
			plugins = {
				...plugins,
				allowlist: plugins.allowlist.filter((entry) => entry.pluginName !== change.pluginName),
			};
		} else if (change.kind === "set_mcp_servers_mode") {
			mcpServers = { ...mcpServers, mode: change.mode };
		} else if (change.kind === "allow_mcp_server") {
			if (!mcpServers.allowlist.some((entry) => entry.destinationFingerprint === change.destinationFingerprint)) {
				if (mcpServers.allowlist.length >= ALLOWLIST_MAX_ENTRIES) {
					return Result({
						_nay: { message: `This list is full (${ALLOWLIST_MAX_ENTRIES}). Remove an entry or use Allow all.` },
					});
				}

				// The owner picks from servers members of this organization added. Copy the details from
				// one of them, so the entry says where the data goes.
				const customServer = await ctx.db
					.query("mcp_custom_servers")
					.withIndex("by_organization_destinationFingerprint", (q) =>
						q.eq("organizationId", organization._id).eq("destinationFingerprint", change.destinationFingerprint),
					)
					.first();
				if (!customServer) {
					return Result({ _nay: { message: "Not found" } });
				}

				mcpServers = {
					...mcpServers,
					allowlist: [
						...mcpServers.allowlist,
						{
							destinationFingerprint: customServer.destinationFingerprint,
							url: customServer.url,
							authKind: customServer.auth.kind,
							oauthIssuer: customServer.auth.kind === "oauth" ? customServer.auth.issuer : null,
							addedBy: userAuth.id,
							addedAt: now,
						},
					],
				};
			}
		} else {
			mcpServers = {
				...mcpServers,
				allowlist: mcpServers.allowlist.filter(
					(entry) => entry.destinationFingerprint !== change.destinationFingerprint,
				),
			};
		}

		if (policy) {
			await ctx.db.patch("organizations_integration_policies", policy._id, {
				plugins,
				mcpServers,
				updatedBy: userAuth.id,
				updatedAt: now,
			});
		} else {
			await ctx.db.insert("organizations_integration_policies", {
				organizationId: organization._id,
				plugins,
				mcpServers,
				updatedBy: userAuth.id,
				updatedAt: now,
			});
		}

		// MCP servers are checked at every chat turn and tool call, so an MCP change needs no pass.
		// Plugins are checked only at install, so a plugin change turns off what no longer fits.
		if (change.kind === "set_plugins_mode" || change.kind === "allow_plugin" || change.kind === "remove_plugin") {
			await db_disable_blocked_installations(ctx, {
				organizationId: organization._id,
				cursor: null,
				batchSize: DISABLE_BATCH_SIZE,
			});
		}

		return Result({ _yay: null });
	},
});

export const get_policy = query({
	args: {
		organizationId: v.id("organizations"),
	},
	returns: v.union(
		v.object({ view: v.literal("manager"), policy: v.union(policy_validator, v.null()) }),
		v.object({
			view: v.literal("member"),
			plugins: v.object({ mode: policy_mode_validator, allowlist: v.array(v.object({ pluginName: v.string() })) }),
			mcpServers: v.object({ mode: policy_mode_validator }),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (!organization) {
			return null;
		}

		const membership = await ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_active_user_organization_workspace", (q) =>
				q.eq("active", true).eq("userId", userAuth.id).eq("organizationId", organization._id),
			)
			.first();
		if (!membership) {
			return null;
		}

		if (organization.default) {
			return {
				view: "member" as const,
				plugins: { mode: "allow_all" as const, allowlist: [] },
				mcpServers: { mode: "allow_all" as const },
			};
		}

		const policy = await db_get_policy(ctx, organization._id);
		if (await db_authorize_policy_manager(ctx, { userId: userAuth.id, organization })) {
			return { view: "manager" as const, policy };
		}

		// Members see only what explains a block. `list_installations` hides the publisher and the
		// source repository from installers for the same reason.
		return {
			view: "member" as const,
			plugins: {
				mode: policy?.plugins.mode ?? "allowlist",
				allowlist: (policy?.plugins.allowlist ?? []).map((entry) => ({ pluginName: entry.pluginName })),
			},
			mcpServers: { mode: policy?.mcpServers.mode ?? "allowlist" },
		};
	},
});

export const list_plugin_candidates = query({
	args: {
		organizationId: v.id("organizations"),
	},
	returns: v.array(
		v.object({
			pluginVersionId: v.id("plugins_versions"),
			name: doc(app_convex_schema, "plugins_versions").fields.name,
			displayName: doc(app_convex_schema, "plugins_versions").fields.displayName,
			version: doc(app_convex_schema, "plugins_versions").fields.version,
			publisherDisplayName: v.union(v.string(), v.null()),
			capabilities: doc(app_convex_schema, "plugins_versions").fields.capabilities,
			outboundOrigins: doc(app_convex_schema, "plugins_versions").fields.outboundOrigins,
			uiOutboundOrigins: doc(app_convex_schema, "plugins_versions").fields.uiOutboundOrigins,
			mcpServers: doc(app_convex_schema, "plugins_versions").fields.mcpServers,
			organizationPolicy: v.union(v.literal("allowed"), v.literal("blocked"), v.literal("needs_approval")),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const organization = await ctx.db.get("organizations", args.organizationId);
		if (
			!organization ||
			organization.default ||
			!(await db_authorize_policy_manager(ctx, { userId: userAuth.id, organization }))
		) {
			return [];
		}

		const policy = await db_get_policy(ctx, organization._id);
		// One doc per plugin, already in name order. See `list_published_plugins`.
		const versions = await ctx.db
			.query("plugins_versions")
			.withIndex("by_isLatest_name", (q) => q.eq("isLatest", true))
			.collect();

		return await Promise.all(
			versions
				.filter((version) => version.reviewStatus === "passed")
				.map(async (version) => {
					const creator = await ctx.db.get("users", version.createdBy);
					const anagraphic = creator?.anagraphic ? await ctx.db.get("users_anagraphics", creator.anagraphic) : null;
					return {
						pluginVersionId: version._id,
						name: version.name,
						displayName: version.displayName,
						version: version.version,
						publisherDisplayName: anagraphic?.displayName ?? null,
						capabilities: version.capabilities,
						outboundOrigins: version.outboundOrigins,
						uiOutboundOrigins: version.uiOutboundOrigins,
						mcpServers: version.mcpServers,
						organizationPolicy: await plugin_version_status(policy, version),
					};
				}),
		);
	},
});

export const list_custom_server_candidates = query({
	args: {
		organizationId: v.id("organizations"),
		paginationOpts: paginationOptsValidator,
	},
	returns: paginationResultValidator(
		v.object({
			destinationFingerprint: v.string(),
			url: v.string(),
			authKind: policy_validator.fields.mcpServers.fields.allowlist.element.fields.authKind,
			oauthIssuer: policy_validator.fields.mcpServers.fields.allowlist.element.fields.oauthIssuer,
			memberCount: v.number(),
			allowed: v.boolean(),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const empty = { page: [], continueCursor: "", isDone: true };
		const organization = await ctx.db.get("organizations", args.organizationId);
		if (
			!organization ||
			organization.default ||
			!(await db_authorize_policy_manager(ctx, { userId: userAuth.id, organization }))
		) {
			return empty;
		}

		const policy = await db_get_policy(ctx, organization._id);
		const allowed = new Set(policy?.mcpServers.allowlist.map((entry) => entry.destinationFingerprint));
		// Docs come sorted by fingerprint, so one server's docs sit together. A server can still span
		// two pages; the screen merges groups by fingerprint.
		const result = await ctx.db
			.query("mcp_custom_servers")
			.withIndex("by_organization_destinationFingerprint", (q) => q.eq("organizationId", organization._id))
			.paginate({ ...args.paginationOpts, numItems: Math.min(100, args.paginationOpts.numItems) });

		const groups = new Map<
			string,
			{
				destinationFingerprint: string;
				url: string;
				authKind: Doc<"mcp_custom_servers">["auth"]["kind"];
				oauthIssuer: string | null;
				memberIds: Set<Id<"users">>;
			}
		>();
		for (const customServer of result.page) {
			const group = groups.get(customServer.destinationFingerprint) ?? {
				destinationFingerprint: customServer.destinationFingerprint,
				url: customServer.url,
				authKind: customServer.auth.kind,
				oauthIssuer: customServer.auth.kind === "oauth" ? customServer.auth.issuer : null,
				memberIds: new Set(),
			};
			group.memberIds.add(customServer.userId);
			groups.set(customServer.destinationFingerprint, group);
		}

		return {
			...result,
			page: [...groups.values()].map((group) => ({
				destinationFingerprint: group.destinationFingerprint,
				url: group.url,
				authKind: group.authKind,
				oauthIssuer: group.oauthIssuer,
				memberCount: group.memberIds.size,
				allowed: allowed.has(group.destinationFingerprint),
			})),
		};
	},
});
