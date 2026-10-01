import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { Result } from "common/errors-as-values-utils.ts";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { organizations_integration_policy_db_allows_mcp_server } from "./organizations_integration_policy.ts";
import {
	plugins_mcp_CANNOT_USE_MESSAGE,
	plugins_mcp_custom_header_values,
	plugins_mcp_custom_secret_additional_data,
	plugins_mcp_db_revoke_grant,
	plugins_mcp_decrypt_custom_secrets,
} from "./plugins_mcp.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import app_convex_schema from "./schema.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { crypto_encrypt_secret_value, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { mcp_client_auth_challenge, mcp_client_list_tools } from "../server/mcp-client.ts";
import { mcp_oauth_discover } from "../server/mcp-oauth.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { mcp_custom_config_build, mcp_custom_config_parse } from "../shared/mcp-custom-config.ts";

/**
 * A member can add at most this many servers in one workspace.
 */
const SERVERS_PER_MEMBER_MAX = 10;

const PROBE_TIMEOUT_MS = 5000;

/**
 * `test_connection` returns at most this many tool names.
 */
const TEST_TOOL_NAMES_MAX = 50;

const DRAIN_BATCH_SIZE = 100;

const SERVER_CHANGED_MESSAGE = "The server changed; try again.";
// A missing or changed `MCP_SECRETS_ENCRYPTION_KEY`, or a damaged doc, makes a decrypt fail.
const CANNOT_READ_SECRETS_MESSAGE = "Press could not read the saved secrets. Type them again.";
export const mcp_custom_servers_SIGN_IN_CHANGED_MESSAGE =
	"This server changed its sign-in settings. Delete it and add it again.";

const custom_server_validator = doc(app_convex_schema, "mcp_custom_servers");

const last_test_validator = custom_server_validator.fields.lastTest;

/**
 * The sign-in server discovery chose for a server with no headers, or `null`.
 */
const oauth_pin_validator = v.union(
	v.object({ issuer: v.string(), resource: v.string(), authorizationHost: v.string() }),
	v.null(),
);

/**
 * SHA-256 of where a member's server sends data: its URL, its auth kind, and its OAuth issuer. The
 * organization allowlist matches on it, so a new URL or a new sign-in server needs a new approval.
 */
async function destination_fingerprint(url: string, auth: Doc<"mcp_custom_servers">["auth"]) {
	return `sha256:${await crypto_sha256_hex(
		JSON.stringify({ url, authKind: auth.kind, oauthIssuer: auth.kind === "oauth" ? auth.issuer : null }),
	)}`;
}

/**
 * The caller's live membership, and whether it holds `workspace.mcp.use`.
 *
 * Removing access never needs the permission: a member who lost it can still turn off and delete
 * their own servers, like the saved browser data doors.
 */
async function db_get_member(
	ctx: QueryCtx | MutationCtx,
	args: { userId: Id<"users">; membershipId: Id<"organizations_workspaces_users"> },
) {
	const membership = await organizations_db_get_membership(ctx, args);
	if (!membership) {
		return null;
	}

	const workspace = await ctx.db.get("organizations_workspaces", membership.workspaceId);
	if (!workspace || workspace.pluginDataPurgeStartedAt !== undefined) {
		return null;
	}

	const mayUse = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: args.userId },
		membership,
		permission: "workspace.mcp.use",
	});
	return { membership, canUse: !mayUse._nay };
}

/**
 * The caller's own server in the membership's workspace, or null. Another member's server answers
 * like a missing one, so ids leak nothing.
 */
async function db_get_owned_server(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId: Id<"users">;
		membership: Doc<"organizations_workspaces_users">;
		customServerId: Id<"mcp_custom_servers">;
	},
) {
	const customServer = await ctx.db.get("mcp_custom_servers", args.customServerId);
	if (
		!customServer ||
		customServer.userId !== args.userId ||
		customServer.organizationId !== args.membership.organizationId ||
		customServer.workspaceId !== args.membership.workspaceId
	) {
		return null;
	}
	return customServer;
}

async function db_list_secrets(ctx: QueryCtx | MutationCtx, customServerId: Id<"mcp_custom_servers">) {
	return await ctx.db
		.query("mcp_custom_server_secrets")
		.withIndex("by_customServer_name", (q) => q.eq("customServerId", customServerId))
		.collect();
}

/**
 * `my-<slug>` of the server name. A clash with another server of the same member in the same
 * workspace gets `-2` ... `-10`. The cap is 10 servers, so a free number always exists.
 */
async function db_free_tool_prefix(
	ctx: MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; userId: Id<"users">; name: string },
) {
	const slug =
		args.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 17)
			.replace(/-+$/u, "") || "server";

	const taken = new Set(
		(
			await ctx.db
				.query("mcp_custom_servers")
				.withIndex("by_organization_workspace_user", (q) =>
					q
						.eq("organizationId", args.membership.organizationId)
						.eq("workspaceId", args.membership.workspaceId)
						.eq("userId", args.userId),
				)
				.collect()
		).map((customServer) => customServer.toolPrefix),
	);
	if (!taken.has(`my-${slug}`)) {
		return `my-${slug}`;
	}

	// Cut to 14 characters, so `my-` plus the slug plus `-10` still fits 20 characters.
	const base = slug.slice(0, 14).replace(/-+$/u, "");
	for (let suffix = 2; suffix <= SERVERS_PER_MEMBER_MAX; suffix++) {
		if (!taken.has(`my-${base}-${suffix}`)) {
			return `my-${base}-${suffix}`;
		}
	}
	return null;
}

/**
 * The server moved to another URL or sign-in server. Delete the member's sign-in for it, so a token
 * never goes to the new place, and delete sign-ins that were still running.
 */
async function db_forget_destination(
	ctx: MutationCtx,
	args: { customServerId: Id<"mcp_custom_servers">; userId: Id<"users"> },
) {
	const grant = await ctx.db
		.query("plugins_mcp_oauth_grants")
		.withIndex("by_targetCustomServer_user", (q) =>
			q.eq("target.customServerId", args.customServerId).eq("userId", args.userId),
		)
		.first();
	if (grant) {
		await plugins_mcp_db_revoke_grant(ctx, grant);
	}

	// One member starts at most a few sign-ins, and each lives 10 minutes.
	const pending = await ctx.db
		.query("plugins_mcp_oauth_pending")
		.withIndex("by_targetCustomServer", (q) => q.eq("target.customServerId", args.customServerId))
		.collect();
	for (const pendingDoc of pending) {
		await ctx.db.delete("plugins_mcp_oauth_pending", pendingDoc._id);
	}
}

/**
 * Probe a server once with its final headers: the same tool list a chat turn would run.
 */
async function probe(server: { url: string; headers: Array<{ name: string; value: string }> }) {
	const listed = await mcp_client_list_tools({
		server,
		accessToken: null,
		timeoutMs: PROBE_TIMEOUT_MS,
		signal: new AbortController().signal,
	});
	if (listed._nay) {
		return {
			outcome: listed._nay.name,
			message: listed._nay.message,
			toolNames: [],
			challenge: mcp_client_auth_challenge(listed._nay),
		};
	}
	return { outcome: "ok", message: null, toolNames: listed._yay.tools.map((tool) => tool.name), challenge: null };
}

/**
 * Pin the sign-in server of a server with no headers that asked for sign-in. PRM must name
 * exactly one sign-in server, unless the server already has a pin: then it must still name that one.
 */
async function discover_pin(args: {
	url: string;
	challenge: { resourceMetadataUrl: string | null; scope: string | null } | null;
	storedPin: { issuer: string; resource: string } | null;
}) {
	const discovered = await mcp_oauth_discover({
		serverUrl: args.url,
		challenge: args.challenge,
		pinnedIssuer: args.storedPin?.issuer ?? null,
		pinnedResource: null,
	});
	if (discovered._nay) {
		return Result({ _nay: { message: discovered._nay.message } });
	}
	if (args.storedPin && discovered._yay.resource !== args.storedPin.resource) {
		return Result({ _nay: { message: mcp_custom_servers_SIGN_IN_CHANGED_MESSAGE } });
	}

	return Result({
		_yay: {
			issuer: discovered._yay.issuer,
			resource: discovered._yay.resource,
			authorizationHost: discovered._yay.authorizationHost,
		},
	});
}

/**
 * The caller's own MCP servers in this workspace. Never a secret value: a secret part says only
 * whether its value is set.
 */
export const list = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.object({
		canUse: v.boolean(),
		servers: v.array(
			v.object({
				customServerId: v.id("mcp_custom_servers"),
				name: v.string(),
				toolPrefix: v.string(),
				url: v.string(),
				host: v.string(),
				enabled: v.boolean(),
				auth: v.union(
					v.object({ kind: v.literal("none") }),
					v.object({ kind: v.literal("headers") }),
					v.object({ kind: v.literal("oauth"), authorizationHost: v.string() }),
				),
				headers: v.array(
					v.object({
						name: v.string(),
						parts: v.array(
							v.union(
								v.object({ kind: v.literal("text"), text: v.string() }),
								v.object({
									kind: v.literal("secret"),
									secretName: v.string(),
									set: v.boolean(),
									updatedAt: v.union(v.number(), v.null()),
								}),
							),
						),
					}),
				),
				connection: v.union(
					v.object({
						status: doc(app_convex_schema, "plugins_mcp_oauth_grants").fields.status,
						scopes: v.array(v.string()),
						connectedAt: v.number(),
					}),
					v.null(),
				),
				policy: v.union(v.literal("allowed"), v.literal("blocked")),
				health: v.union(v.literal("healthy"), v.literal("paused")),
				lastTest: last_test_validator,
			}),
		),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}

		const member = await db_get_member(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		if (!member) {
			return { canUse: false, servers: [] };
		}

		const customServers = await ctx.db
			.query("mcp_custom_servers")
			.withIndex("by_organization_workspace_user", (q) =>
				q
					.eq("organizationId", member.membership.organizationId)
					.eq("workspaceId", member.membership.workspaceId)
					.eq("userId", userAuth.id),
			)
			.collect();

		const servers = await Promise.all(
			customServers
				.toSorted((a, b) => a.toolPrefix.localeCompare(b.toolPrefix))
				.map(async (customServer) => {
					const target = { kind: "custom" as const, customServerId: customServer._id };
					const [secrets, grant, policyAllows] = await Promise.all([
						db_list_secrets(ctx, customServer._id),
						ctx.db
							.query("plugins_mcp_oauth_grants")
							.withIndex("by_targetCustomServer_user", (q) =>
								q.eq("target.customServerId", customServer._id).eq("userId", userAuth.id),
							)
							.first(),
						organizations_integration_policy_db_allows_mcp_server(ctx, {
							organizationId: customServer.organizationId,
							target,
						}),
					]);
					const secretUpdatedAt = new Map(secrets.map((secret) => [secret.name, secret.updatedAt]));

					return {
						customServerId: customServer._id,
						name: customServer.name,
						toolPrefix: customServer.toolPrefix,
						url: customServer.url,
						host: new URL(customServer.url).host,
						enabled: customServer.enabled,
						auth:
							customServer.auth.kind === "oauth"
								? { kind: "oauth" as const, authorizationHost: customServer.auth.authorizationHost }
								: { kind: customServer.auth.kind },
						headers: customServer.headers.map((header) => ({
							name: header.name,
							parts: header.parts.map((part) =>
								part.kind === "text"
									? part
									: {
											kind: "secret" as const,
											secretName: part.secretName,
											set: secretUpdatedAt.has(part.secretName),
											updatedAt: secretUpdatedAt.get(part.secretName) ?? null,
										},
							),
						})),
						connection: grant
							? {
									status: grant.status,
									scopes: grant.scope.split(" ").filter(Boolean),
									connectedAt: grant.connectedAt,
								}
							: null,
						policy: policyAllows ? ("allowed" as const) : ("blocked" as const),
						health: customServer.unhealthyUntil === null ? ("healthy" as const) : ("paused" as const),
						lastTest: customServer.lastTest,
					};
				}),
		);

		return { canUse: member.canUse, servers };
	},
});

/**
 * What `save` and `test_connection` need before they fetch: the caller's permission, and the owned
 * server with its encrypted secrets when there is one. Decrypting happens in the action.
 */
export const authorize_server = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		customServerId: v.union(v.id("mcp_custom_servers"), v.null()),
	},
	returns: v_result({
		_yay: v.object({
			customServer: v.union(custom_server_validator, v.null()),
			secrets: v.array(doc(app_convex_schema, "mcp_custom_server_secrets")),
		}),
	}),
	handler: async (ctx, args) => {
		const member = await db_get_member(ctx, args);
		if (!member?.canUse) {
			return Result({ _nay: { message: plugins_mcp_CANNOT_USE_MESSAGE } });
		}

		if (args.customServerId === null) {
			return Result({ _yay: { customServer: null, secrets: [] } });
		}

		const customServer = await db_get_owned_server(ctx, {
			userId: args.userId,
			membership: member.membership,
			customServerId: args.customServerId,
		});
		if (!customServer) {
			return Result({ _nay: { message: "Not found" } });
		}
		return Result({ _yay: { customServer, secrets: await db_list_secrets(ctx, customServer._id) } });
	},
});

type authorize_server_Result =
	typeof authorize_server extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Add or edit one server from the pasted text. Press parses the text again here, probes the server
 * once, and stores a clean record. It never stores the pasted text.
 */
export const save = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		customServerId: v.union(v.id("mcp_custom_servers"), v.null()),
		text: v.string(),
		draftKey: v.string(),
		fill: v.object({
			name: v.string(),
			urlFields: v.array(v.object({ name: v.string(), value: v.string() })),
			notSecretHeaders: v.array(v.string()),
			secretValues: v.array(v.object({ name: v.string(), value: v.string() })),
			keptSecretNames: v.array(v.string()),
		}),
	},
	returns: v_result({
		_yay: v.object({
			customServerId: v.id("mcp_custom_servers"),
			outcome: v.string(),
			message: v.union(v.string(), v.null()),
			toolCount: v.union(v.number(), v.null()),
			/**
			 * The host the member signs in at, when the server is pinned for sign-in. The probe sends no
			 * token, so such a server may answer `auth_required` without being broken.
			 */
			authorizationHost: v.union(v.string(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "mcp_custom_servers_probe", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = (await ctx.runQuery(internal.mcp_custom_servers.authorize_server, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			customServerId: args.customServerId,
		})) as authorize_server_Result;
		if (authorized._nay) {
			return authorized;
		}

		const draft = mcp_custom_config_parse(args.text).drafts.find((candidate) => candidate.key === args.draftKey);
		if (!draft) {
			return Result({ _nay: { message: "The pasted text has no server with this name." } });
		}

		const { customServer, secrets } = authorized._yay;
		// A secret the member left empty keeps its stored value. Only an edit has stored values.
		const storedNames = new Set(secrets.map((secret) => secret.name));
		const built = mcp_custom_config_build(draft, {
			...args.fill,
			keptSecretNames: args.fill.keptSecretNames.filter((name) => storedNames.has(name)),
		});
		if (built._nay) {
			return Result({ _nay: { message: built._nay.message } });
		}

		const { server, secretValues } = built._yay;
		const typedNames = new Set(secretValues.map((secret) => secret.name));
		const keptSecretNames = server.headers.flatMap((header) =>
			header.parts.flatMap((part) =>
				part.kind === "secret" && !typedNames.has(part.secretName) ? [part.secretName] : [],
			),
		);

		// Saved secrets never go to a new host. Pasted text could move the server to someone else's
		// address and reuse the member's key there, so a new origin needs every secret typed again.
		if (
			customServer !== null &&
			keptSecretNames.length > 0 &&
			new URL(server.url).origin !== new URL(customServer.url).origin
		) {
			return Result({ _nay: { message: "The server address changed. Type the secret values again." } });
		}

		// Decrypt only the kept secrets. If the stored values cannot be read, typing every value again still works.
		const values =
			customServer === null
				? new Map<string, string>()
				: await plugins_mcp_decrypt_custom_secrets({
						customServerId: customServer._id,
						userId: userAuth.id,
						secrets: secrets.filter((secret) => keptSecretNames.includes(secret.name)),
					}).catch(() => null);
		if (values === null) {
			return Result({ _nay: { message: CANNOT_READ_SECRETS_MESSAGE } });
		}
		for (const secret of secretValues) {
			values.set(secret.name, secret.value);
		}

		// A failed probe still saves: the outcome goes into `lastTest`, and the member can test again.
		const probed = await probe({ url: server.url, headers: plugins_mcp_custom_header_values(server.headers, values) });
		const lastTest = {
			at: Date.now(),
			outcome: probed.outcome,
			toolCount: probed.outcome === "ok" ? probed.toolNames.length : null,
		};

		// A server with no headers that asks for sign-in saves only with a pinned sign-in server. When
		// discovery refuses it, nothing is saved. An edit of the same URL keeps its stored pin, also when
		// this probe did not ask for sign-in: the tool list may work without a token, or the server may be
		// down. Losing the pin would delete the member's sign-in.
		const storedPin =
			server.headers.length === 0 && customServer?.auth.kind === "oauth" && customServer.url === server.url
				? {
						issuer: customServer.auth.issuer,
						resource: customServer.auth.resource,
						authorizationHost: customServer.auth.authorizationHost,
					}
				: null;
		let oauthPin = storedPin;
		if (probed.outcome === "auth_required" && server.headers.length === 0) {
			const pinned = await discover_pin({ url: server.url, challenge: probed.challenge, storedPin });
			if (pinned._nay) {
				return pinned;
			}
			oauthPin = pinned._yay;
		}

		const written = (await ctx.runMutation(internal.mcp_custom_servers.write_server, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			customServerId: customServer?._id ?? null,
			expectedDestinationFingerprint: customServer?.destinationFingerprint ?? null,
			server,
			secretValues,
			keptSecretNames,
			lastTest,
			oauthPin,
		})) as write_server_Result;
		if (written._nay) {
			return written;
		}

		return Result({
			_yay: {
				customServerId: written._yay.customServerId,
				outcome: lastTest.outcome,
				message: probed.message,
				toolCount: lastTest.toolCount,
				authorizationHost: oauthPin?.authorizationHost ?? null,
			},
		});
	},
});

/**
 * Write one server and its new secret values. It checks the member again, because the probe ran
 * between `authorize_server` and this write, and a member removal may have finished meanwhile.
 */
export const write_server = internalMutation({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		customServerId: v.union(v.id("mcp_custom_servers"), v.null()),
		/**
		 * The fingerprint `save` read. A different one means another save moved the server meanwhile.
		 */
		expectedDestinationFingerprint: v.union(v.string(), v.null()),
		server: v.object({
			name: custom_server_validator.fields.name,
			url: custom_server_validator.fields.url,
			headers: custom_server_validator.fields.headers,
		}),
		secretValues: v.array(v.object({ name: v.string(), value: v.string() })),
		/**
		 * Secret names that keep their stored value.
		 */
		keptSecretNames: v.array(v.string()),
		lastTest: last_test_validator,
		oauthPin: oauth_pin_validator,
	},
	returns: v_result({ _yay: v.object({ customServerId: v.id("mcp_custom_servers") }) }),
	handler: async (ctx, args) => {
		const member = await db_get_member(ctx, args);
		if (!member?.canUse) {
			return Result({ _nay: { message: plugins_mcp_CANNOT_USE_MESSAGE } });
		}

		const now = Date.now();
		// A server with headers never starts OAuth.
		const auth: Doc<"mcp_custom_servers">["auth"] =
			args.server.headers.length > 0
				? { kind: "headers" }
				: args.oauthPin
					? { kind: "oauth", ...args.oauthPin }
					: { kind: "none" };
		const destinationFingerprint = await destination_fingerprint(args.server.url, auth);

		// Kept secrets must still have their stored doc. Another save may have deleted one meanwhile.
		const stored = args.customServerId === null ? [] : await db_list_secrets(ctx, args.customServerId);
		const storedNames = new Set(stored.map((secret) => secret.name));
		if (args.keptSecretNames.some((name) => !storedNames.has(name))) {
			return Result({ _nay: { message: SERVER_CHANGED_MESSAGE } });
		}

		let customServerId: Id<"mcp_custom_servers">;
		if (args.customServerId === null) {
			const count = (
				await ctx.db
					.query("mcp_custom_servers")
					.withIndex("by_organization_workspace_user", (q) =>
						q
							.eq("organizationId", member.membership.organizationId)
							.eq("workspaceId", member.membership.workspaceId)
							.eq("userId", args.userId),
					)
					.take(SERVERS_PER_MEMBER_MAX)
			).length;
			const toolPrefix =
				count < SERVERS_PER_MEMBER_MAX
					? await db_free_tool_prefix(ctx, {
							membership: member.membership,
							userId: args.userId,
							name: args.server.name,
						})
					: null;
			if (toolPrefix === null) {
				return Result({
					_nay: { message: `You can add at most ${SERVERS_PER_MEMBER_MAX} MCP servers in a workspace.` },
				});
			}

			customServerId = await ctx.db.insert("mcp_custom_servers", {
				organizationId: member.membership.organizationId,
				workspaceId: member.membership.workspaceId,
				userId: args.userId,
				name: args.server.name,
				toolPrefix,
				url: args.server.url,
				headers: args.server.headers,
				auth,
				destinationFingerprint,
				enabled: true,
				lastTest: args.lastTest,
				failures: 0,
				unhealthyUntil: null,
				updatedAt: now,
			});
		} else {
			const customServer = await db_get_owned_server(ctx, {
				userId: args.userId,
				membership: member.membership,
				customServerId: args.customServerId,
			});
			if (!customServer || customServer.destinationFingerprint !== args.expectedDestinationFingerprint) {
				return Result({ _nay: { message: SERVER_CHANGED_MESSAGE } });
			}

			customServerId = customServer._id;
			if (customServer.destinationFingerprint !== destinationFingerprint) {
				await db_forget_destination(ctx, { customServerId, userId: args.userId });
			}
			// The tool prefix never changes on an edit, so old chat history keeps its tool names.
			await ctx.db.patch("mcp_custom_servers", customServerId, {
				name: args.server.name,
				url: args.server.url,
				headers: args.server.headers,
				auth,
				destinationFingerprint,
				lastTest: args.lastTest,
				failures: 0,
				unhealthyUntil: null,
				updatedAt: now,
			});
		}

		// Keep the stored rows of kept names, replace the typed ones, and delete the rest.
		const neededNames = new Set(
			args.server.headers.flatMap((header) =>
				header.parts.flatMap((part) => (part.kind === "secret" ? [part.secretName] : [])),
			),
		);
		const typedNames = new Set(args.secretValues.map((secret) => secret.name));
		for (const secret of stored) {
			if (!neededNames.has(secret.name) || typedNames.has(secret.name)) {
				await ctx.db.delete("mcp_custom_server_secrets", secret._id);
			}
		}

		for (const secret of args.secretValues) {
			if (!neededNames.has(secret.name)) {
				continue;
			}

			const encrypted = await crypto_encrypt_secret_value({
				value: secret.value,
				additionalData: plugins_mcp_custom_secret_additional_data({ customServerId, userId: args.userId, name: secret.name }),
				keyName: "MCP_SECRETS_ENCRYPTION_KEY",
			});
			await ctx.db.insert("mcp_custom_server_secrets", {
				organizationId: member.membership.organizationId,
				workspaceId: member.membership.workspaceId,
				userId: args.userId,
				customServerId,
				name: secret.name,
				value: { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, keyId: "v1" },
				updatedAt: now,
			});
		}

		return Result({ _yay: { customServerId } });
	},
});

type write_server_Result =
	typeof write_server extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Probe one saved server with its stored values and record the outcome.
 */
export const test_connection = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		customServerId: v.id("mcp_custom_servers"),
	},
	returns: v_result({
		_yay: v.object({
			outcome: v.string(),
			message: v.union(v.string(), v.null()),
			toolCount: v.union(v.number(), v.null()),
			/**
			 * The host the member signs in at, when the server is pinned for sign-in. The probe sends no
			 * token, so such a server may answer `auth_required` without being broken.
			 */
			authorizationHost: v.union(v.string(), v.null()),
			/**
			 * The first tool names the server lists. They are server text, shown to the member only.
			 */
			toolNames: v.array(v.string()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "mcp_custom_servers_probe", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const authorized = (await ctx.runQuery(internal.mcp_custom_servers.authorize_server, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			customServerId: args.customServerId,
		})) as authorize_server_Result;
		if (authorized._nay) {
			return authorized;
		}

		const customServer = authorized._yay.customServer!;
		const values = await plugins_mcp_decrypt_custom_secrets({
			customServerId: customServer._id,
			userId: userAuth.id,
			secrets: authorized._yay.secrets,
		}).catch(() => null);
		if (values === null) {
			return Result({ _nay: { message: CANNOT_READ_SECRETS_MESSAGE } });
		}

		const probed = await probe({
			url: customServer.url,
			headers: plugins_mcp_custom_header_values(customServer.headers, values),
		});
		const toolCount = probed.outcome === "ok" ? probed.toolNames.length : null;

		// A server saved with no sign-in may ask for one now. Pin it like a first save. When
		// discovery refuses, the test is still recorded, with discovery's reason as the message.
		let oauthPin = null;
		let message: string | null = probed.message;
		if (probed.outcome === "auth_required" && customServer.auth.kind === "none") {
			const pinned = await discover_pin({ url: customServer.url, challenge: probed.challenge, storedPin: null });
			if (pinned._nay) {
				message = pinned._nay.message;
			} else {
				oauthPin = pinned._yay;
			}
		}

		const recorded = (await ctx.runMutation(internal.mcp_custom_servers.record_test, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			customServerId: customServer._id,
			expectedDestinationFingerprint: customServer.destinationFingerprint,
			lastTest: { at: Date.now(), outcome: probed.outcome, toolCount },
			oauthPin,
		})) as mcp_custom_servers_record_test_Result;
		if (recorded._nay) {
			return recorded;
		}

		return Result({
			_yay: {
				outcome: probed.outcome,
				message,
				toolCount,
				authorizationHost:
					oauthPin?.authorizationHost ??
					(customServer.auth.kind === "oauth" ? customServer.auth.authorizationHost : null),
				// Convex refuses a string with half a character, and a server can send one.
				toolNames: probed.toolNames.filter((name) => name.isWellFormed()).slice(0, TEST_TOOL_NAMES_MAX),
			},
		});
	},
});

/**
 * Record a test outcome. With `oauthPin`, also pin the server's sign-in server. The pin
 * changes where the server sends data, so it is a destination change.
 */
export const record_test = internalMutation({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		customServerId: v.id("mcp_custom_servers"),
		expectedDestinationFingerprint: v.string(),
		lastTest: last_test_validator,
		oauthPin: oauth_pin_validator,
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const member = await db_get_member(ctx, args);
		if (!member?.canUse) {
			return Result({ _nay: { message: plugins_mcp_CANNOT_USE_MESSAGE } });
		}

		const customServer = await db_get_owned_server(ctx, {
			userId: args.userId,
			membership: member.membership,
			customServerId: args.customServerId,
		});
		if (!customServer || customServer.destinationFingerprint !== args.expectedDestinationFingerprint) {
			return Result({ _nay: { message: SERVER_CHANGED_MESSAGE } });
		}

		// Only a server with no headers and no pin yet takes a pin. A stored pin never changes.
		const pin =
			args.oauthPin && customServer.auth.kind === "none"
				? {
						auth: { kind: "oauth" as const, ...args.oauthPin },
						destinationFingerprint: await destination_fingerprint(customServer.url, {
							kind: "oauth",
							...args.oauthPin,
						}),
						updatedAt: Date.now(),
					}
				: null;
		if (pin) {
			await db_forget_destination(ctx, { customServerId: customServer._id, userId: args.userId });
		}

		// A good test also clears a pause, so the next chat turn tries the server again.
		await ctx.db.patch("mcp_custom_servers", customServer._id, {
			lastTest: args.lastTest,
			...(args.lastTest?.outcome === "ok" ? { failures: 0, unhealthyUntil: null } : {}),
			...pin,
		});
		return Result({ _yay: null });
	},
});

export type mcp_custom_servers_record_test_Result =
	typeof record_test extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const set_enabled = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		customServerId: v.id("mcp_custom_servers"),
		enabled: v.boolean(),
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

		const member = await db_get_member(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		const customServer = member
			? await db_get_owned_server(ctx, {
					userId: userAuth.id,
					membership: member.membership,
					customServerId: args.customServerId,
				})
			: null;
		if (!member || !customServer) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (args.enabled && !member.canUse) {
			return Result({ _nay: { message: plugins_mcp_CANNOT_USE_MESSAGE } });
		}

		// Turning a server off keeps its sign-in, like a policy block. Chat turns skip it at once.
		await ctx.db.patch("mcp_custom_servers", customServer._id, { enabled: args.enabled, updatedAt: Date.now() });
		return Result({ _yay: null });
	},
});

export const remove = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		customServerId: v.id("mcp_custom_servers"),
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

		const member = await db_get_member(ctx, { userId: userAuth.id, membershipId: args.membershipId });
		const customServer = member
			? await db_get_owned_server(ctx, {
					userId: userAuth.id,
					membership: member.membership,
					customServerId: args.customServerId,
				})
			: null;
		if (!customServer) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Delete the server first: chat turns stop loading it at once. It has at most 8 secrets.
		await ctx.db.delete("mcp_custom_servers", customServer._id);
		for (const secret of await db_list_secrets(ctx, customServer._id)) {
			await ctx.db.delete("mcp_custom_server_secrets", secret._id);
		}
		await db_forget_destination(ctx, { customServerId: customServer._id, userId: userAuth.id });

		// Call docs can be many, so a job deletes them in batches.
		await ctx.scheduler.runAfter(0, internal.mcp_custom_servers.drain_removed_server, {
			customServerId: customServer._id,
		});
		return Result({ _yay: null });
	},
});

/**
 * Delete the call docs of a removed server, 100 per run, until none are left.
 */
export const drain_removed_server = internalMutation({
	args: {
		customServerId: v.id("mcp_custom_servers"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const calls = await ctx.db
			.query("plugins_mcp_calls")
			.withIndex("by_targetCustomServer", (q) => q.eq("target.customServerId", args.customServerId))
			.take(DRAIN_BATCH_SIZE);
		for (const call of calls) {
			await ctx.db.delete("plugins_mcp_calls", call._id);
		}

		if (calls.length === DRAIN_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.mcp_custom_servers.drain_removed_server, args);
		}
		return null;
	},
});
