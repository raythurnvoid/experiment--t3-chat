import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { v, type Infer } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	action,
	type ActionCtx,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	type MutationCtx,
	query,
	type QueryCtx,
} from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import {
	mcp_custom_servers_SIGN_IN_CHANGED_MESSAGE,
	type mcp_custom_servers_record_test_Result,
} from "./mcp_custom_servers.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_integration_policy_db_allows_mcp_server } from "./organizations_integration_policy.ts";
import {
	plugins_mcp_CANNOT_USE_MESSAGE,
	plugins_mcp_db_revoke_grant,
	plugins_mcp_db_schedule_revocation,
	plugins_mcp_grant_additional_data,
	plugins_mcp_POLICY_MESSAGE,
} from "./plugins_mcp.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema, { plugins_mcp_target_validator } from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import {
	crypto_decrypt_secret_value,
	crypto_encrypt_secret_value,
	crypto_random_hex,
	crypto_sha256_hex,
} from "../server/crypto-utils.ts";
import { mcp_client_auth_challenge, mcp_client_list_tools } from "../server/mcp-client.ts";
import {
	mcp_oauth_check_client_document,
	mcp_oauth_discover,
	mcp_oauth_callback_iss_matches,
	mcp_oauth_exchange,
	mcp_oauth_refresh,
	mcp_oauth_revoke,
	mcp_oauth_same_resource,
	mcp_oauth_start,
	type mcp_oauth_Client,
} from "../server/mcp-oauth.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";

/**
 * A started sign-in must finish within this time.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;

const PROBE_TIMEOUT_MS = 5000;

const DELETION_BATCH_SIZE = 100;

/**
 * How long one caller may hold a grant's refresh lease.
 */
const REFRESH_LEASE_MS = 30 * 1000;

/**
 * Refresh a token this long before it expires, so a call never starts with a token about to end.
 */
const REFRESH_BEFORE_MS = 60 * 1000;

const REFRESH_POLL_MS = 500;

const NOT_AVAILABLE_MESSAGE = "This MCP server is no longer available.";
const SERVER_CHANGED_MESSAGE = "The server changed. Connect again.";
const EXPIRED_MESSAGE = "This sign-in expired. Connect again.";

const pending_validator = doc(app_convex_schema, "plugins_mcp_oauth_pending");

type Target = Infer<typeof plugins_mcp_target_validator>;

/**
 * The callback URL and the client metadata document URL. Both live next to the app, at `APP_BASE_URL`
 * (the app origin plus its base path). The app build writes the same two values into `client.json`.
 */
function app_oauth_urls() {
	const base = process.env.APP_BASE_URL?.trim().replace(/\/$/u, "");
	if (!base || !URL.canParse(base)) {
		return null;
	}
	return { redirectUri: `${base}/oauth/mcp/callback`, clientIdMetadataUrl: `${base}/oauth/mcp/client.json` };
}

/**
 * The additional data that binds a DCR client secret to its issuer and client id.
 */
function client_additional_data(issuer: string, clientId: string) {
	return `client:${issuer}:${clientId}`;
}

/**
 * Read a DCR client's secret. A secret that cannot be read (a changed key) gives `null`, so the caller
 * registers a new client instead.
 */
async function decrypt_client(clientDoc: Doc<"plugins_mcp_oauth_clients">) {
	const clientSecret =
		clientDoc.clientSecret === null
			? null
			: await crypto_decrypt_secret_value(
					clientDoc.clientSecret,
					client_additional_data(clientDoc.issuer, clientDoc.clientId),
					"MCP_SECRETS_ENCRYPTION_KEY",
				).catch(() => undefined);
	if (clientSecret === undefined) {
		return null;
	}

	return {
		kind: "dcr",
		clientId: clientDoc.clientId,
		clientSecret,
		clientSecretExpiresAt: clientDoc.clientSecretExpiresAt,
		authMethod: clientDoc.tokenEndpointAuthMethod,
	} satisfies mcp_oauth_Client;
}

/**
 * The client a token or revoke request uses. A CIMD client is only its client document URL. A DCR
 * client needs its stored doc. `null` when that doc is gone or its secret cannot be read.
 */
async function load_client(
	args: Pick<Doc<"plugins_mcp_oauth_grants">, "clientKind" | "clientId">,
	clientDoc: Doc<"plugins_mcp_oauth_clients"> | null,
): Promise<mcp_oauth_Client | null> {
	if (args.clientKind === "cimd") {
		return {
			kind: "cimd",
			clientId: args.clientId,
			clientSecret: null,
			clientSecretExpiresAt: null,
			authMethod: "none",
		};
	}
	return clientDoc ? await decrypt_client(clientDoc) : null;
}

/**
 * Encrypt a grant's tokens, bound to the grant's target, member, and sign-in server.
 */
async function encrypt_grant_tokens(
	grant: Parameters<typeof plugins_mcp_grant_additional_data>[0],
	tokens: { accessToken: string; refreshToken: string | null },
) {
	const additionalData = plugins_mcp_grant_additional_data(grant);
	const encrypt = async (value: string) => ({
		...(await crypto_encrypt_secret_value(value, additionalData, "MCP_SECRETS_ENCRYPTION_KEY")),
		keyId: "v1" as const,
	});
	return {
		accessToken: await encrypt(tokens.accessToken),
		refreshToken: tokens.refreshToken === null ? null : await encrypt(tokens.refreshToken),
	};
}

async function db_find_client(ctx: QueryCtx | MutationCtx, args: { issuer: string; clientId: string }) {
	return await ctx.db
		.query("plugins_mcp_oauth_clients")
		.withIndex("by_issuer", (q) => q.eq("issuer", args.issuer))
		.filter((q) => q.eq(q.field("clientId"), args.clientId))
		.first();
}

/**
 * Where one target sends a sign-in, read from the stored version or the member's own server doc.
 * `null` when the target is gone, turned off, or has no sign-in.
 */
async function db_get_target(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; membership: Doc<"organizations_workspaces_users">; target: Target },
) {
	const { target, membership } = args;
	if (target.kind === "custom") {
		const customServer = await ctx.db.get("mcp_custom_servers", target.customServerId);
		// A server with headers never starts a sign-in.
		if (
			!customServer ||
			!customServer.enabled ||
			customServer.auth.kind === "headers" ||
			customServer.userId !== args.userId ||
			customServer.organizationId !== membership.organizationId ||
			customServer.workspaceId !== membership.workspaceId
		) {
			return null;
		}

		return {
			url: customServer.url,
			destinationFingerprint: customServer.destinationFingerprint,
			/**
			 * `null` for a server saved with no sign-in. `start` pins it first (late pin).
			 */
			pinnedIssuer: customServer.auth.kind === "oauth" ? customServer.auth.issuer : null,
			pinnedResource: null,
			/**
			 * A member's own server keeps the exact resource it was pinned with.
			 */
			expectedResource: customServer.auth.kind === "oauth" ? customServer.auth.resource : null,
			scopes: [] as string[],
		};
	}

	const installation = await ctx.db.get("plugins_workspace_installations", target.installationId);
	if (
		!installation ||
		installation.status !== "enabled" ||
		!installation.acceptedCapabilities.includes("agent.mcp.connect") ||
		installation.organizationId !== membership.organizationId ||
		installation.workspaceId !== membership.workspaceId
	) {
		return null;
	}

	const version = (await ctx.db.get("plugins_versions", installation.pluginVersionId))!;
	const server = version.mcpServers.find((candidate) => candidate.id === target.serverId);
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
	if (!server || !serverDoc || server.auth.kind !== "oauth") {
		return null;
	}

	return {
		url: server.url,
		destinationFingerprint: serverDoc.destinationFingerprint,
		pinnedIssuer: server.auth.issuer as string | null,
		pinnedResource: server.auth.resource,
		expectedResource: null as string | null,
		scopes: server.auth.scopes,
	};
}

/**
 * Check that a member may sign in to a target now: a live membership with `workspace.mcp.use`, the
 * target still live and pointing where it did, and the organization policy allows it.
 *
 * `start` and `finish` wait on the network between checks and writes, and a member removal can
 * finish meanwhile. So every write that follows the network checks again in its own transaction.
 */
async function db_check_sign_in(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		membership: Doc<"organizations_workspaces_users"> | null;
		target: Target;
		/**
		 * The fingerprint read before the network call. `null` when nothing was read yet.
		 */
		expectedDestinationFingerprint: string | null;
	},
) {
	const { membership } = args;
	if (!membership) {
		return Result({ _nay: { message: plugins_mcp_CANNOT_USE_MESSAGE } });
	}

	const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
	const mayUse = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.userId },
		membership,
		permission: "workspace.mcp.use",
	});
	if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined || mayUse._nay) {
		return Result({ _nay: { message: plugins_mcp_CANNOT_USE_MESSAGE } });
	}

	const server = await db_get_target(ctx, { userId: args.userId, membership, target: args.target });
	if (!server) {
		return Result({ _nay: { message: NOT_AVAILABLE_MESSAGE } });
	}
	if (
		args.expectedDestinationFingerprint !== null &&
		server.destinationFingerprint !== args.expectedDestinationFingerprint
	) {
		return Result({ _nay: { message: SERVER_CHANGED_MESSAGE } });
	}

	const allowed = await organizations_integration_policy_db_allows_mcp_server(ctx, {
		organizationId: membership.organizationId,
		target: args.target,
	});
	if (!allowed) {
		return Result({ _nay: { message: plugins_mcp_POLICY_MESSAGE } });
	}

	return Result({ _yay: server });
}

/**
 * The member's live membership in the workspace a pending sign-in was started in.
 */
async function db_find_membership(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
	},
) {
	return await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", args.userId)
				.eq("organizationId", args.organizationId)
				.eq("workspaceId", args.workspaceId),
		)
		.first();
}

async function db_get_grant(ctx: QueryCtx | MutationCtx, args: { userId: Id<"users">; target: Target }) {
	const { target } = args;
	return target.kind === "plugin"
		? await ctx.db
				.query("plugins_mcp_oauth_grants")
				.withIndex("by_targetInstallation_targetServerId_user", (q) =>
					q
						.eq("target.installationId", target.installationId)
						.eq("target.serverId", target.serverId)
						.eq("userId", args.userId),
				)
				.first()
		: await ctx.db
				.query("plugins_mcp_oauth_grants")
				.withIndex("by_targetCustomServer_user", (q) =>
					q.eq("target.customServerId", target.customServerId).eq("userId", args.userId),
				)
				.first();
}

async function db_mark_grant_needs_reconnect(ctx: MutationCtx, grant: Doc<"plugins_mcp_oauth_grants">) {
	await ctx.db.patch("plugins_mcp_oauth_grants", grant._id, {
		status: "needs_reconnect",
		accessToken: null,
		refreshToken: null,
		expiresAt: null,
		version: grant.version + 1,
		leaseId: null,
		leaseUntil: null,
	});
	await plugins_mcp_db_schedule_revocation(ctx, grant);
}

/**
 * A return path inside the app, such as `/w/org/home/chat`. Never a full URL: the callback page goes
 * there after sign-in, so another origin here would be an open redirect.
 */
function is_app_path(path: string) {
	return path.length <= 1024 && /^\/(?![/\\])[^\s\\]*$/u.test(path);
}

/**
 * Delete the caller's own grant and pending sign-ins for one MCP server in this workspace.
 *
 * Removing access needs no permission, so a member who lost `workspace.mcp.use` can still
 * disconnect. An admin cannot disconnect another member's sign-in here.
 */
export const disconnect = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: plugins_mcp_target_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "mcp_member_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Not found" } });
		}

		const grant = await db_get_grant(ctx, { userId: userAuth.id, target: args.target });
		if (grant && (grant.organizationId !== membership.organizationId || grant.workspaceId !== membership.workspaceId)) {
			return Result({ _nay: { message: "Not found" } });
		}

		const { target } = args;
		const pending = await ctx.db
			.query("plugins_mcp_oauth_pending")
			.withIndex("by_organization_workspace_user", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("userId", userAuth.id),
			)
			.filter((q) =>
				target.kind === "plugin"
					? q.and(
							q.eq(q.field("target.installationId"), target.installationId),
							q.eq(q.field("target.serverId"), target.serverId),
						)
					: q.eq(q.field("target.customServerId"), target.customServerId),
			)
			.collect();
		if (!grant && pending.length === 0) {
			return Result({ _nay: { message: "Not found" } });
		}

		for (const pendingDoc of pending) {
			await ctx.db.delete("plugins_mcp_oauth_pending", pendingDoc._id);
		}
		if (grant) {
			await plugins_mcp_db_revoke_grant(ctx, grant);
		}
		return Result({ _yay: null });
	},
});

/**
 * Whether the caller could start a sign-in for a target now. Connect cards and sign-in notices stay in
 * the chat history, so a card whose server is gone says so instead of offering a Connect button.
 */
export const can_connect = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		/**
		 * Ids as the chat history stores them: plain strings.
		 */
		target: v.union(
			v.object({ kind: v.literal("plugin"), installationId: v.string(), serverId: v.string() }),
			v.object({ kind: v.literal("custom"), customServerId: v.string() }),
		),
	},
	returns: v.boolean(),
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
			return false;
		}

		const { target } = args;
		let normalized: Target | null = null;
		if (target.kind === "plugin") {
			const installationId = ctx.db.normalizeId("plugins_workspace_installations", target.installationId);
			normalized = installationId ? { kind: "plugin", installationId, serverId: target.serverId } : null;
		} else {
			const customServerId = ctx.db.normalizeId("mcp_custom_servers", target.customServerId);
			normalized = customServerId ? { kind: "custom", customServerId } : null;
		}
		if (!normalized) {
			return false;
		}

		return (await db_get_target(ctx, { userId: userAuth.id, membership, target: normalized })) !== null;
	},
});

/**
 * What `start` needs before it fetches: the target's sign-in settings, a DCR client this issuer
 * registered before, and the scopes of the member's earlier sign-in.
 */
export const authorize_start = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		target: plugins_mcp_target_validator,
	},
	returns: v_result({
		_yay: v.object({
			server: v.object({
				url: v.string(),
				destinationFingerprint: v.string(),
				pinnedIssuer: v.union(v.string(), v.null()),
				pinnedResource: v.union(v.string(), v.null()),
				expectedResource: v.union(v.string(), v.null()),
				scopes: v.array(v.string()),
			}),
			clientDoc: v.union(doc(app_convex_schema, "plugins_mcp_oauth_clients"), v.null()),
			grant: v.union(v.object({ grantId: v.id("plugins_mcp_oauth_grants"), version: v.number() }), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, args);
		const checked = await db_check_sign_in(ctx, {
			userId: args.userId,
			membership,
			target: args.target,
			expectedDestinationFingerprint: null,
		});
		if (checked._nay) {
			return checked;
		}

		const server = checked._yay;
		// A reconnect asks again for what the member had, plus the scope a tool asked for.
		const grant = await db_get_grant(ctx, { userId: args.userId, target: args.target });
		const scopes = [...server.scopes, ...(grant?.requestedScopes ?? [])];
		if (grant?.stepUpScope) {
			scopes.push(...grant.stepUpScope.split(" "));
		}

		// The newest client first: a client whose secret expired is registered again.
		const clientDoc =
			server.pinnedIssuer === null
				? null
				: await ctx.db
						.query("plugins_mcp_oauth_clients")
						.withIndex("by_issuer", (q) => q.eq("issuer", server.pinnedIssuer!))
						.order("desc")
						.first();

		return Result({
			_yay: {
				server: { ...server, scopes: [...new Set(scopes)] },
				clientDoc,
				grant: grant ? { grantId: grant._id, version: grant.version } : null,
			},
		});
	},
});

type authorize_start_Result =
	typeof authorize_start extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Start one OAuth sign-in. Returns the URL the browser opens, and the sign-in host to show first.
 */
export const start = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		target: plugins_mcp_target_validator,
		/**
		 * The app page to open after sign-in.
		 */
		returnPath: v.string(),
	},
	returns: v_result({ _yay: v.object({ authorizationUrl: v.string(), authorizationHost: v.string() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		if (!is_app_path(args.returnPath)) {
			return Result({ _nay: { message: "Invalid return path" } });
		}
		const urls = app_oauth_urls();
		if (!urls) {
			return Result({ _nay: { message: "Press is not set up for MCP sign-in." } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_mcp_oauth_start", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorizeArgs = { userId: userAuth.id, membershipId: args.membershipId, target: args.target };
		let authorized = (await ctx.runQuery(
			internal.plugins_mcp_oauth.authorize_start,
			authorizeArgs,
		)) as authorize_start_Result;
		if (authorized._nay) {
			return authorized;
		}

		// Always ask once with no token. A server that names its PRM only in the 401 challenge cannot
		// connect without it.
		const probed = await mcp_client_list_tools({
			server: { url: authorized._yay.server.url, headers: [] },
			accessToken: null,
			timeoutMs: PROBE_TIMEOUT_MS,
			signal: new AbortController().signal,
		});
		const challenge = mcp_client_auth_challenge(probed._nay);

		// Late pin: a member's own server saved with no sign-in asked for one on a tool call.
		// Pin its sign-in server with the first-save rules, then start again from the pinned doc.
		if (args.target.kind === "custom" && authorized._yay.server.pinnedIssuer === null) {
			const discovered = await mcp_oauth_discover({
				serverUrl: authorized._yay.server.url,
				challenge,
				pinnedIssuer: null,
				pinnedResource: null,
			});
			if (discovered._nay) {
				return Result({ _nay: { message: discovered._nay.message } });
			}

			const pinned = (await ctx.runMutation(internal.mcp_custom_servers.record_test, {
				userId: userAuth.id,
				membershipId: args.membershipId,
				customServerId: args.target.customServerId,
				expectedDestinationFingerprint: authorized._yay.server.destinationFingerprint,
				// Record the no-token probe as it answered. Its tool list usually works, so the page does
				// not show a failed test for a server that asks for sign-in only on a tool call.
				lastTest: {
					at: Date.now(),
					outcome: probed._nay ? probed._nay.name : "ok",
					toolCount: probed._nay ? null : probed._yay.tools.length,
				},
				oauthPin: {
					issuer: discovered._yay.issuer,
					resource: discovered._yay.resource,
					authorizationHost: discovered._yay.authorizationHost,
				},
			})) as mcp_custom_servers_record_test_Result;
			if (pinned._nay) {
				return pinned;
			}

			// The pin changed the fingerprint, so an organization entry for the old one no longer matches.
			authorized = (await ctx.runQuery(
				internal.plugins_mcp_oauth.authorize_start,
				authorizeArgs,
			)) as authorize_start_Result;
			if (authorized._nay) {
				return authorized;
			}
		}

		const { server, clientDoc, grant } = authorized._yay;
		const knownClient = clientDoc ? await decrypt_client(clientDoc) : null;
		const state = crypto_random_hex(32);
		const started = await mcp_oauth_start({
			serverUrl: server.url,
			challenge,
			pinnedIssuer: server.pinnedIssuer,
			pinnedResource: server.pinnedResource,
			extraScopes: server.scopes,
			redirectUri: urls.redirectUri,
			clientIdMetadataUrl: urls.clientIdMetadataUrl,
			knownClient,
			state,
		});
		if (started._nay) {
			// Never follow a new sign-in server without a new reviewed version or a new server doc.
			if (started._nay.name === "oauth_issuer_changed") {
				if (grant) {
					await ctx.runMutation(internal.plugins_mcp_oauth.mark_refused, grant);
				}
				return Result({
					_nay: {
						message:
							args.target.kind === "plugin"
								? "The server changed its sign-in server. Ask the plugin publisher."
								: "This server changed its sign-in server. Delete it and add it again.",
					},
				});
			}
			return Result({ _nay: { message: started._nay.message } });
		}
		if (server.expectedResource !== null && started._yay.resource !== server.expectedResource) {
			return Result({ _nay: { message: mcp_custom_servers_SIGN_IN_CHANGED_MESSAGE } });
		}

		// The app build writes `client.json`. If it drifted from what Convex builds, every sign-in server
		// would refuse the client, so stop here with a clear reason.
		if (started._yay.client.kind === "cimd") {
			const checked = await mcp_oauth_check_client_document(urls);
			if (checked._nay) {
				return Result({ _nay: { message: checked._nay.message } });
			}
		}

		const { client } = started._yay;
		const inserted = (await ctx.runMutation(internal.plugins_mcp_oauth.insert_pending, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			target: args.target,
			expectedDestinationFingerprint: server.destinationFingerprint,
			stateHash: await crypto_sha256_hex(state),
			serverUrl: server.url,
			resource: started._yay.resource,
			issuer: started._yay.issuer,
			authorizationEndpoint: started._yay.endpoints.authorization,
			tokenEndpoint: started._yay.endpoints.token,
			revocationEndpoint: started._yay.endpoints.revocation,
			issParameterSupported: started._yay.issParameterSupported,
			clientId: client.clientId,
			clientKind: client.kind,
			tokenEndpointAuthMethod: client.authMethod,
			// Only a client registered in this call is new. A known client is already stored.
			newClient:
				client.kind === "dcr" && client.clientId !== knownClient?.clientId
					? { clientSecret: client.clientSecret, clientSecretExpiresAt: client.clientSecretExpiresAt }
					: null,
			scopes: started._yay.scopes,
			codeVerifier: started._yay.codeVerifier,
			returnPath: args.returnPath,
		})) as insert_pending_Result;
		if (inserted._nay) {
			return inserted;
		}

		return Result({
			_yay: { authorizationUrl: started._yay.authorizationUrl, authorizationHost: started._yay.authorizationHost },
		});
	},
});

/**
 * Store a started sign-in, and a DCR client registered for it. Checks the member and the target
 * again, because discovery waited on the network.
 */
export const insert_pending = internalMutation({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		target: plugins_mcp_target_validator,
		expectedDestinationFingerprint: v.string(),
		stateHash: v.string(),
		serverUrl: v.string(),
		resource: v.string(),
		issuer: v.string(),
		authorizationEndpoint: v.string(),
		tokenEndpoint: v.string(),
		revocationEndpoint: v.union(v.string(), v.null()),
		issParameterSupported: v.boolean(),
		clientId: v.string(),
		clientKind: pending_validator.fields.clientKind,
		tokenEndpointAuthMethod: pending_validator.fields.tokenEndpointAuthMethod,
		newClient: v.union(
			v.object({
				clientSecret: v.union(v.string(), v.null()),
				clientSecretExpiresAt: v.union(v.number(), v.null()),
			}),
			v.null(),
		),
		scopes: v.array(v.string()),
		codeVerifier: v.string(),
		returnPath: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, args);
		const checked = await db_check_sign_in(ctx, {
			userId: args.userId,
			membership,
			target: args.target,
			expectedDestinationFingerprint: args.expectedDestinationFingerprint,
		});
		if (checked._nay) {
			return checked;
		}

		if (args.newClient) {
			await ctx.db.insert("plugins_mcp_oauth_clients", {
				issuer: args.issuer,
				clientId: args.clientId,
				clientSecret:
					args.newClient.clientSecret === null
						? null
						: {
								...(await crypto_encrypt_secret_value(
									args.newClient.clientSecret,
									client_additional_data(args.issuer, args.clientId),
									"MCP_SECRETS_ENCRYPTION_KEY",
								)),
								keyId: "v1",
							},
				clientSecretExpiresAt: args.newClient.clientSecretExpiresAt,
				tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
			});
		}

		const codeVerifier = await crypto_encrypt_secret_value(
			args.codeVerifier,
			`pending:${args.stateHash}`,
			"MCP_SECRETS_ENCRYPTION_KEY",
		);
		await ctx.db.insert("plugins_mcp_oauth_pending", {
			stateHash: args.stateHash,
			organizationId: membership!.organizationId,
			workspaceId: membership!.workspaceId,
			userId: args.userId,
			target: args.target,
			destinationFingerprint: args.expectedDestinationFingerprint,
			serverUrl: args.serverUrl,
			resource: args.resource,
			issuer: args.issuer,
			authorizationEndpoint: args.authorizationEndpoint,
			tokenEndpoint: args.tokenEndpoint,
			revocationEndpoint: args.revocationEndpoint,
			issParameterSupported: args.issParameterSupported,
			clientId: args.clientId,
			clientKind: args.clientKind,
			tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
			scopes: args.scopes,
			codeVerifier: { ciphertext: codeVerifier.ciphertext, nonce: codeVerifier.nonce, keyId: "v1" },
			returnPath: args.returnPath,
			expiresAt: Date.now() + PENDING_TTL_MS,
		});
		return Result({ _yay: null });
	},
});

type insert_pending_Result =
	typeof insert_pending extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Finish a sign-in from the callback page. Returns the app page to open next.
 */
export const finish = action({
	args: {
		state: v.string(),
		code: v.union(v.string(), v.null()),
		iss: v.union(v.string(), v.null()),
		error: v.union(v.string(), v.null()),
	},
	returns: v_result({ _yay: v.object({ returnPath: v.string() }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const urls = app_oauth_urls();
		if (!urls) {
			return Result({ _nay: { message: "Press is not set up for MCP sign-in." } });
		}

		const claimed = (await ctx.runMutation(internal.plugins_mcp_oauth.claim_pending, {
			userId: userAuth.id,
			stateHash: await crypto_sha256_hex(args.state),
		})) as claim_pending_Result;
		if (claimed._nay) {
			return claimed;
		}
		const { pending, clientDoc } = claimed._yay;

		try {
			// Check `iss` before reading `error`: after a mismatch, the answer may come from another AS, so
			// none of its text is shown or followed.
			if (
				!mcp_oauth_callback_iss_matches({
					iss: args.iss,
					issuer: pending.issuer,
					issParameterSupported: pending.issParameterSupported,
				})
			) {
				return Result({ _nay: { message: "The sign-in answer came from an unexpected server. Connect again." } });
			}
			if (args.error !== null) {
				return Result({
					_nay: {
						message:
							args.error === "access_denied" ? "The sign-in was canceled." : "The sign-in server refused the sign-in.",
					},
				});
			}
			if (args.code === null) {
				return Result({ _nay: { message: "The sign-in server sent no code. Connect again." } });
			}

			const codeVerifier = await crypto_decrypt_secret_value(
				pending.codeVerifier,
				`pending:${pending.stateHash}`,
				"MCP_SECRETS_ENCRYPTION_KEY",
			).catch(() => null);
			const client = await load_client(pending, clientDoc);
			if (codeVerifier === null || client === null) {
				return Result({ _nay: { message: EXPIRED_MESSAGE } });
			}

			const exchanged = await mcp_oauth_exchange({
				tokenEndpoint: pending.tokenEndpoint,
				client,
				code: args.code,
				codeVerifier,
				redirectUri: urls.redirectUri,
				resource: pending.resource,
			});
			if (exchanged._nay) {
				return Result({ _nay: { message: exchanged._nay.message } });
			}

			const stored = (await ctx.runMutation(internal.plugins_mcp_oauth.store_grant, {
				pendingId: pending._id,
				pending: {
					organizationId: pending.organizationId,
					workspaceId: pending.workspaceId,
					userId: pending.userId,
					target: pending.target,
					destinationFingerprint: pending.destinationFingerprint,
					resource: pending.resource,
					issuer: pending.issuer,
					tokenEndpoint: pending.tokenEndpoint,
					revocationEndpoint: pending.revocationEndpoint,
					clientId: pending.clientId,
					clientKind: pending.clientKind,
					tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod,
					scopes: pending.scopes,
				},
				tokens: exchanged._yay,
			})) as store_grant_Result;
			if (stored._nay) {
				return stored;
			}

			return Result({ _yay: { returnPath: pending.returnPath } });
		} finally {
			await ctx.runMutation(internal.plugins_mcp_oauth.delete_pending, { pendingId: pending._id });
		}
	},
});

/**
 * Claim one pending sign-in for the caller. Replace its state hash so the callback works once,
 * but keep the doc so Disconnect and deletion can cancel the exchange.
 *
 * A failed check never deletes it. Every workspace shares one callback, so an attacker could send
 * their sign-in link to a victim. The victim's code must not land in the attacker's sign-in,
 * and a wrong user must not use the link up either.
 */
export const claim_pending = internalMutation({
	args: {
		userId: v.id("users"),
		stateHash: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			pending: doc(app_convex_schema, "plugins_mcp_oauth_pending"),
			clientDoc: v.union(doc(app_convex_schema, "plugins_mcp_oauth_clients"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const pending = await ctx.db
			.query("plugins_mcp_oauth_pending")
			.withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
			.first();
		if (!pending || pending.expiresAt < Date.now() || pending.userId !== args.userId) {
			return Result({ _nay: { message: EXPIRED_MESSAGE } });
		}

		const checked = await db_check_sign_in(ctx, {
			userId: args.userId,
			membership: await db_find_membership(ctx, pending),
			target: pending.target,
			expectedDestinationFingerprint: pending.destinationFingerprint,
		});
		if (checked._nay) {
			return checked;
		}

		// Return the original hash: the verifier was encrypted with it. The stored hash is no longer
		// shared with the browser, so a replay cannot claim the doc while the first exchange waits.
		await ctx.db.patch("plugins_mcp_oauth_pending", pending._id, { stateHash: crypto_random_hex(32) });
		return Result({
			_yay: {
				pending,
				clientDoc:
					pending.clientKind === "dcr"
						? await db_find_client(ctx, { issuer: pending.issuer, clientId: pending.clientId })
						: null,
			},
		});
	},
});

type claim_pending_Result =
	typeof claim_pending extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const delete_pending = internalMutation({
	args: { pendingId: v.id("plugins_mcp_oauth_pending") },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (await ctx.db.get("plugins_mcp_oauth_pending", args.pendingId)) {
			await ctx.db.delete("plugins_mcp_oauth_pending", args.pendingId);
		}
		return null;
	},
});

/**
 * Store the tokens of a finished sign-in. Checks the member and the target again, because the code
 * exchange waited on the network. When the check fails, the new token is revoked at once.
 */
export const store_grant = internalMutation({
	args: {
		pendingId: v.id("plugins_mcp_oauth_pending"),
		pending: v.object({
			organizationId: pending_validator.fields.organizationId,
			workspaceId: pending_validator.fields.workspaceId,
			userId: pending_validator.fields.userId,
			target: pending_validator.fields.target,
			destinationFingerprint: pending_validator.fields.destinationFingerprint,
			resource: pending_validator.fields.resource,
			issuer: pending_validator.fields.issuer,
			tokenEndpoint: pending_validator.fields.tokenEndpoint,
			revocationEndpoint: pending_validator.fields.revocationEndpoint,
			clientId: pending_validator.fields.clientId,
			clientKind: pending_validator.fields.clientKind,
			tokenEndpointAuthMethod: pending_validator.fields.tokenEndpointAuthMethod,
			scopes: pending_validator.fields.scopes,
		}),
		tokens: v.object({
			accessToken: v.string(),
			refreshToken: v.union(v.string(), v.null()),
			expiresAt: v.union(v.number(), v.null()),
			scope: v.union(v.string(), v.null()),
		}),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const { pending, tokens } = args;
		const pendingDoc = await ctx.db.get("plugins_mcp_oauth_pending", args.pendingId);
		if (pendingDoc) {
			await ctx.db.delete("plugins_mcp_oauth_pending", pendingDoc._id);
		}
		const encrypted = await encrypt_grant_tokens(pending, tokens);
		if (!pendingDoc) {
			await plugins_mcp_db_schedule_revocation(ctx, { ...pending, ...encrypted });
			return Result({ _nay: { message: EXPIRED_MESSAGE } });
		}

		const checked = await db_check_sign_in(ctx, {
			userId: pending.userId,
			membership: await db_find_membership(ctx, pending),
			target: pending.target,
			expectedDestinationFingerprint: pending.destinationFingerprint,
		});
		if (checked._nay) {
			await plugins_mcp_db_schedule_revocation(ctx, { ...pending, ...encrypted });
			return checked;
		}

		const fields = {
			issuer: pending.issuer,
			resource: pending.resource,
			tokenEndpoint: pending.tokenEndpoint,
			revocationEndpoint: pending.revocationEndpoint,
			clientId: pending.clientId,
			clientKind: pending.clientKind,
			tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod,
			...encrypted,
			expiresAt: tokens.expiresAt,
			// No `scope` in the answer means the AS granted what was asked (RFC 6749 §5.1).
			scope: tokens.scope ?? pending.scopes.join(" "),
			requestedScopes: pending.scopes,
			stepUpScope: null,
			connectedAt: Date.now(),
			status: "connected" as const,
			leaseId: null,
			leaseUntil: null,
		};

		// A reconnect replaces the tokens in place. The old refresh token is not revoked: some sign-in
		// servers end every token of the member and the client on a revoke, and that would end the new
		// sign-in too.
		const grant = await db_get_grant(ctx, { userId: pending.userId, target: pending.target });
		if (grant) {
			await ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { ...fields, version: grant.version + 1 });
		} else {
			await ctx.db.insert("plugins_mcp_oauth_grants", {
				organizationId: pending.organizationId,
				workspaceId: pending.workspaceId,
				userId: pending.userId,
				target: pending.target,
				...fields,
				version: 0,
			});
		}
		return Result({ _yay: null });
	},
});

type store_grant_Result =
	typeof store_grant extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * The member's grant for a target, when Press may send its token there. The issuer and the
 * resource come from the stored version or server doc, never from a new discovery. `null` when there
 * is no grant or it does not match them.
 */
export const get_grant_for_use = internalQuery({
	args: {
		userId: v.id("users"),
		target: plugins_mcp_target_validator,
	},
	returns: v.union(
		v.object({
			grantId: v.id("plugins_mcp_oauth_grants"),
			status: v.union(v.literal("connected"), v.literal("needs_reconnect")),
			version: v.number(),
			accessToken: doc(app_convex_schema, "plugins_mcp_oauth_grants").fields.accessToken,
			additionalData: v.string(),
			expiresAt: v.union(v.number(), v.null()),
			leaseUntil: v.union(v.number(), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const { target } = args;
		const grant = await db_get_grant(ctx, args);
		if (!grant) {
			return null;
		}

		let matches = false;
		if (target.kind === "custom") {
			const customServer = await ctx.db.get("mcp_custom_servers", target.customServerId);
			matches =
				customServer?.auth.kind === "oauth" &&
				grant.issuer === customServer.auth.issuer &&
				grant.resource === customServer.auth.resource;
		} else {
			const installation = await ctx.db.get("plugins_workspace_installations", target.installationId);
			const version = installation ? await ctx.db.get("plugins_versions", installation.pluginVersionId) : null;
			const server = version?.mcpServers.find((candidate) => candidate.id === target.serverId);
			// The same resources discovery accepts: the server URL, its origin, or the pin.
			matches =
				server?.auth.kind === "oauth" &&
				grant.issuer === server.auth.issuer &&
				(mcp_oauth_same_resource(grant.resource, server.url) ||
					mcp_oauth_same_resource(grant.resource, new URL(server.url).origin) ||
					(server.auth.resource !== null && mcp_oauth_same_resource(grant.resource, server.auth.resource)));
		}
		if (!matches) {
			return null;
		}

		return {
			grantId: grant._id,
			status: grant.status,
			version: grant.version,
			accessToken: grant.accessToken,
			additionalData: plugins_mcp_grant_additional_data(grant),
			expiresAt: grant.expiresAt,
			leaseUntil: grant.leaseUntil,
		};
	},
});

type get_grant_for_use_Result =
	typeof get_grant_for_use extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Take the refresh lease of a grant, so only one caller refreshes it. `null` when the grant
 * changed since the caller read it, or another caller holds a live lease.
 */
export const take_refresh_lease = internalMutation({
	args: {
		grantId: v.id("plugins_mcp_oauth_grants"),
		version: v.number(),
	},
	returns: v.union(
		v.object({
			leaseId: v.string(),
			grant: doc(app_convex_schema, "plugins_mcp_oauth_grants"),
			clientDoc: v.union(doc(app_convex_schema, "plugins_mcp_oauth_clients"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const grant = await ctx.db.get("plugins_mcp_oauth_grants", args.grantId);
		const now = Date.now();
		if (
			!grant ||
			grant.version !== args.version ||
			grant.status !== "connected" ||
			(grant.leaseUntil !== null && grant.leaseUntil > now)
		) {
			return null;
		}

		const leaseId = crypto_random_hex(16);
		await ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { leaseId, leaseUntil: now + REFRESH_LEASE_MS });
		return {
			leaseId,
			grant,
			clientDoc: grant.clientKind === "dcr" ? await db_find_client(ctx, grant) : null,
		};
	},
});

type take_refresh_lease_Result =
	typeof take_refresh_lease extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * End a refresh lease. New tokens replace the old ones only while the caller still holds the lease.
 * `invalid_grant` ends the grant: the member must connect again.
 * Return true when this lease's outcome was handled, or false when the grant or lease changed.
 */
export const finish_refresh = internalMutation({
	args: {
		grantId: v.id("plugins_mcp_oauth_grants"),
		leaseId: v.string(),
		outcome: v.union(
			v.object({
				kind: v.literal("refreshed"),
				leasedGrant: doc(app_convex_schema, "plugins_mcp_oauth_grants"),
				tokens: v.object({
					accessToken: v.string(),
					refreshToken: v.union(v.string(), v.null()),
					expiresAt: v.union(v.number(), v.null()),
				}),
			}),
			v.object({ kind: v.literal("invalid_grant") }),
			v.object({ kind: v.literal("failed") }),
		),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const { outcome } = args;
		const grant = await ctx.db.get("plugins_mcp_oauth_grants", args.grantId);
		// A disconnect or a deletion removed the grant during the refresh, but the server already made
		// new tokens. Revoke them, so they do not stay alive with no grant that points to them.
		if (!grant && outcome.kind === "refreshed") {
			await plugins_mcp_db_schedule_revocation(ctx, {
				...outcome.leasedGrant,
				...(await encrypt_grant_tokens(outcome.leasedGrant, outcome.tokens)),
			});
			return false;
		}
		// Another caller holds the lease now and may have stored newer tokens from the same sign-in.
		// Do not revoke here: some servers end every token of a sign-in on one revoke.
		if (!grant || grant.leaseId !== args.leaseId) {
			return false;
		}

		if (outcome.kind === "failed") {
			await ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { leaseId: null, leaseUntil: null });
			return true;
		}
		if (outcome.kind === "invalid_grant") {
			await db_mark_grant_needs_reconnect(ctx, grant);
			return true;
		}

		await ctx.db.patch("plugins_mcp_oauth_grants", grant._id, {
			...(await encrypt_grant_tokens(grant, outcome.tokens)),
			expiresAt: outcome.tokens.expiresAt,
			version: grant.version + 1,
			leaseId: null,
			leaseUntil: null,
		});
		return true;
	},
});

/**
 * The server refused a token or changed its sign-in server, so end the grant.
 * Only for the version the caller used, so a sign-in that finished meanwhile stays.
 */
export const mark_refused = internalMutation({
	args: {
		grantId: v.id("plugins_mcp_oauth_grants"),
		version: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const grant = await ctx.db.get("plugins_mcp_oauth_grants", args.grantId);
		if (grant && grant.version === args.version && grant.status === "connected") {
			await db_mark_grant_needs_reconnect(ctx, grant);
		}
		return null;
	},
});

/**
 * Keep the scope a server asked for in a 403 `insufficient_scope` answer. A tool call cannot open a
 * browser, so the member's next Connect asks for it.
 */
export const record_step_up = internalMutation({
	args: {
		userId: v.id("users"),
		target: plugins_mcp_target_validator,
		scope: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// The scope is server text. Keep it only when it is a valid scope list (RFC 6749 §3.3).
		const valid =
			args.scope.length <= 1024 && /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/u.test(args.scope);
		const grant = valid ? await db_get_grant(ctx, args) : null;
		if (grant) {
			await ctx.db.patch("plugins_mcp_oauth_grants", grant._id, { stepUpScope: args.scope });
		}
		return null;
	},
});

/**
 * The member's access token for a sign-in server, refreshed when needed.
 *
 * `refusedGrant` is the grant id and version whose token the server just refused. That token is
 * refreshed even when it has not expired yet. When another caller holds the refresh lease, turn setup
 * does not wait (`waitForLease: false`) and a tool call polls until the lease ends.
 */
export async function plugins_mcp_oauth_get_access_token(
	ctx: ActionCtx,
	args: {
		userId: Id<"users">;
		target: Target;
		refusedGrant: { grantId: Id<"plugins_mcp_oauth_grants">; version: number } | null;
		waitForLease: boolean;
		signal: AbortSignal;
	},
) {
	const deadline = Date.now() + REFRESH_LEASE_MS;
	for (;;) {
		const grant = (await ctx.runQuery(internal.plugins_mcp_oauth.get_grant_for_use, {
			userId: args.userId,
			target: args.target,
		})) as get_grant_for_use_Result;
		if (!grant) {
			return { status: "none" as const };
		}
		if (grant.status === "needs_reconnect" || grant.accessToken === null) {
			return { status: "needs_reconnect" as const };
		}

		const now = Date.now();
		const wasRefused =
			args.refusedGrant !== null &&
			grant.grantId === args.refusedGrant.grantId &&
			grant.version === args.refusedGrant.version;
		const refreshed = args.refusedGrant !== null && !wasRefused;
		const needsRefresh = wasRefused || (grant.expiresAt !== null && grant.expiresAt - now < REFRESH_BEFORE_MS);
		if (!needsRefresh) {
			const accessToken = await crypto_decrypt_secret_value(
				grant.accessToken,
				grant.additionalData,
				"MCP_SECRETS_ENCRYPTION_KEY",
			).catch(() => null);
			// A token Press cannot read (a changed key) is as good as gone.
			if (accessToken === null) {
				await ctx.runMutation(internal.plugins_mcp_oauth.mark_refused, {
					grantId: grant.grantId,
					version: grant.version,
				});
				return { status: "needs_reconnect" as const };
			}
			return {
				status: "connected" as const,
				grantId: grant.grantId,
				accessToken,
				version: grant.version,
				refreshed,
			};
		}

		const lease =
			grant.leaseUntil !== null && grant.leaseUntil > now
				? null
				: ((await ctx.runMutation(internal.plugins_mcp_oauth.take_refresh_lease, {
						grantId: grant.grantId,
						version: grant.version,
					})) as take_refresh_lease_Result);
		// Another caller is refreshing. Read the grant again when its lease ends or its new token lands.
		if (!lease) {
			if (!args.waitForLease || args.signal.aborted || Date.now() >= deadline) {
				return { status: "busy" as const };
			}
			await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
			continue;
		}

		const refreshToken =
			lease.grant.refreshToken === null
				? null
				: await crypto_decrypt_secret_value(
						lease.grant.refreshToken,
						grant.additionalData,
						"MCP_SECRETS_ENCRYPTION_KEY",
					).catch(() => null);
		const client = await load_client(lease.grant, lease.clientDoc);
		// Never assume a refresh token exists. Without one, or without the client, the member
		// must connect again.
		if (refreshToken === null || client === null) {
			const handled = await ctx.runMutation(internal.plugins_mcp_oauth.finish_refresh, {
				grantId: grant.grantId,
				leaseId: lease.leaseId,
				outcome: { kind: "invalid_grant" },
			});
			if (!handled) continue;
			return { status: "needs_reconnect" as const };
		}

		// Only the values stored on the grant. Refresh never runs discovery again.
		const refreshedTokens = await mcp_oauth_refresh({
			tokenEndpoint: lease.grant.tokenEndpoint,
			client,
			refreshToken,
			resource: lease.grant.resource,
			scope: lease.grant.scope || null,
		});
		if (refreshedTokens._nay) {
			const invalidGrant = refreshedTokens._nay.name === "oauth_invalid_grant";
			const handled = await ctx.runMutation(internal.plugins_mcp_oauth.finish_refresh, {
				grantId: grant.grantId,
				leaseId: lease.leaseId,
				outcome: { kind: invalidGrant ? "invalid_grant" : "failed" },
			});
			// A new Connect or refresh won the lease. Use its grant instead of this old failure.
			if (!handled) continue;
			return invalidGrant
				? { status: "needs_reconnect" as const }
				: { status: "failed" as const, message: refreshedTokens._nay.message };
		}

		const stored = await ctx.runMutation(internal.plugins_mcp_oauth.finish_refresh, {
			grantId: grant.grantId,
			leaseId: lease.leaseId,
			outcome: {
				kind: "refreshed",
				leasedGrant: lease.grant,
				tokens: {
					accessToken: refreshedTokens._yay.accessToken,
					refreshToken: refreshedTokens._yay.refreshToken,
					expiresAt: refreshedTokens._yay.expiresAt,
				},
			},
		});
		// The lease ran out during the refresh, and another caller may have refreshed too. Read the
		// grant again instead of using a token that was not stored.
		if (!stored) {
			continue;
		}
		return {
			status: "connected" as const,
			grantId: grant.grantId,
			accessToken: refreshedTokens._yay.accessToken,
			version: grant.version + 1,
			refreshed: true,
		};
	}
}

export const get_revocation = internalQuery({
	args: {
		revocationId: v.id("plugins_mcp_oauth_revocations"),
	},
	returns: v.union(
		v.object({
			revocation: doc(app_convex_schema, "plugins_mcp_oauth_revocations"),
			clientDoc: v.union(doc(app_convex_schema, "plugins_mcp_oauth_clients"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const revocation = await ctx.db.get("plugins_mcp_oauth_revocations", args.revocationId);
		if (!revocation) {
			return null;
		}
		return {
			revocation,
			clientDoc:
				revocation.clientKind === "dcr"
					? await db_find_client(ctx, { issuer: revocation.issuer, clientId: revocation.clientId })
					: null,
		};
	},
});

export const delete_revocation = internalMutation({
	args: {
		revocationId: v.id("plugins_mcp_oauth_revocations"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		if (await ctx.db.get("plugins_mcp_oauth_revocations", args.revocationId)) {
			await ctx.db.delete("plugins_mcp_oauth_revocations", args.revocationId);
		}
		return null;
	},
});

/**
 * Revoke one token at its sign-in server, once, best effort. The token was already deleted from
 * its grant. The doc is deleted whatever the answer, so a broken server never keeps a token here.
 */
export const revoke_one = internalAction({
	args: {
		revocationId: v.id("plugins_mcp_oauth_revocations"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const found = await ctx.runQuery(internal.plugins_mcp_oauth.get_revocation, args);
		if (!found) {
			return null;
		}

		const { revocation, clientDoc } = found;
		const token = await crypto_decrypt_secret_value(
			revocation.token,
			revocation.additionalData,
			"MCP_SECRETS_ENCRYPTION_KEY",
		).catch(() => null);
		const client = await load_client(revocation, clientDoc);
		// `mcp_oauth_revoke` logs its own failures, without the token.
		if (token !== null && client !== null) {
			await mcp_oauth_revoke({
				revocationEndpoint: revocation.revocationEndpoint,
				client,
				token,
				tokenTypeHint: revocation.tokenTypeHint,
			});
		}

		await ctx.runMutation(internal.plugins_mcp_oauth.delete_revocation, args);
		return null;
	},
});

/**
 * Delete pending sign-ins that expired without a callback.
 */
export const cleanup_expired_pending = internalMutation({
	args: {
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const expired = await ctx.db
			.query("plugins_mcp_oauth_pending")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
			.take(DELETION_BATCH_SIZE);
		await Promise.all(expired.map((pending) => ctx.db.delete("plugins_mcp_oauth_pending", pending._id)));

		if (expired.length === DELETION_BATCH_SIZE && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_mcp_oauth.cleanup_expired_pending, {});
		}
		return null;
	},
});
