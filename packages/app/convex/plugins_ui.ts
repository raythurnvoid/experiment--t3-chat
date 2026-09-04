/**
 * Plugin UI pages and file views: manifest-declared HTML entries rendered in sandboxed iframes
 * (`sandbox="allow-scripts allow-same-origin allow-forms"`; the CSP below keeps `form-action
 * 'none'`, so plugin JS can handle submit events but no real HTTP form submission can leave the
 * page). Pages open from the plugins nav; file views open from `/files` when a file's stored
 * content type matches a view's declared content types.
 *
 * Security model:
 * - The host app mints a short-lived `plu_` session token per (user, installation) and hands it
 *   to the iframe over postMessage only — tokens never appear in URLs. The public API resolves
 *   it as a `plugin_ui` principal; its scopes depend on the `workspace.files.read` capability
 *   the workspace consented to (see resolve_principal in public_api.ts).
 * - The iframe's own ConvexClient authenticates with a plugin-session JWT (subject = session id).
 *   The mint and refresh actions below deliver it beside the `plu_` token, and the
 *   `POST /plugins-ui/session-jwt` exchange signs the same JWT for a frame whose host sent none.
 *   Member functions refuse that identity (see server-utils.ts); only the plugin-facing doors
 *   resolve it, and they load the session doc on every call, so revocation and expiry still win
 *   over a signed-valid JWT.
 * - Secret values never reach plugin frontends: `plugin_ui` principals never get `secrets:read`
 *   or `outbound:fetch`, no matter what the installation accepted. Only the plugin backend can
 *   read secrets (plr_ runs via the runner host routes).
 * - Reviewed frontend code is trusted with its UI token and granted workspace data. The sandbox
 *   isolates the host app, but page navigation can send granted data away before the host sees the
 *   next load and revokes the session; that revocation is cleanup, not an egress guarantee.
 * - Assets are served publicly under an immutable version id. That is fine because dists carry
 *   no tenant data and are already public: anyone can browse them as source in GLOBAL/PLUGINS.
 */
import { ConvexError, v } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import { SignJWT } from "jose";
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type ActionCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { Result } from "common/errors-as-values-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	allowed_origins,
	PLUGINS_UI_SESSIONS_JWT_ISSUER,
	server_convex_get_user_fallback_to_anonymous,
} from "../server/server-utils.ts";
import { access_control_db_authorize_membership } from "./access_control.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_fetch_object_from_bucket, r2_get_bucket } from "./r2_client.ts";
import { users_ANONYMOUS_JWT_DEFAULT_KID, users_get_anonymous_jwt_private_key } from "./users.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

// 30 minutes: long enough that an open page rarely refreshes, short enough that a leaked token
// dies fast. On top of this, the resolver rechecks the installation and membership on every call.
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_CLEANUP_BATCH_SIZE = 100;

async function db_plugin_workspace_is_live(
	ctx: QueryCtx,
	args: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> },
) {
	const workspace = await ctx.db.get("organizations_workspaces", args.workspaceId);
	return (
		workspace?.organizationId === args.organizationId && workspace.pluginDataPurgeStartedAt === undefined
	);
}

/**
 * Sign the plugin-session JWT for one session. The frame's own ConvexClient authenticates with it
 * (issuer = the plugins-ui provider in auth.config.ts, subject = the session id). Its `exp` is the
 * session `expiresAt`, nothing shorter: the plugin-facing doors load the session doc on every call,
 * so a deleted or expired session stops them at once and a shorter JWT bought nothing.
 */
async function sign_session_jwt(sessionId: Id<"plugins_ui_sessions">, expiresAt: number) {
	const key = await users_get_anonymous_jwt_private_key();
	return await new SignJWT({})
		.setProtectedHeader({ alg: "ES256", kid: users_ANONYMOUS_JWT_DEFAULT_KID, typ: "JWT" })
		.setIssuer(PLUGINS_UI_SESSIONS_JWT_ISSUER)
		.setAudience("convex")
		.setSubject(sessionId)
		.setIssuedAt()
		.setExpirationTime(Math.floor(expiresAt / 1000))
		.sign(key);
}

if (!process.env.R2_ENDPOINT) {
	throw new Error("R2_ENDPOINT is not set in Convex env");
}
// Signed download URLs point at the R2 S3 endpoint, and the S3 client may put the bucket in the
// URL path or in the hostname — so allow exactly those two origins. Allowing all of https:
// instead would let a page leak data to any server through img/media loads.
const R2_ENDPOINT_URL = new URL(process.env.R2_ENDPOINT);
const R2_MEDIA_ORIGINS = `${R2_ENDPOINT_URL.origin} ${R2_ENDPOINT_URL.protocol}//${r2_get_bucket()}.${R2_ENDPOINT_URL.host}`;

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
}
// The iframe documents are served from this deployment's HTTP origin (the asset route below), so a
// JWT-exchange request from a plugin frame carries exactly this Origin. Every other Origin is
// refused, including the literal "null" an opaque-origin page sends.
const SITE_ORIGIN = new URL(process.env.VITE_CONVEX_HTTP_URL).origin;

/**
 * Deliberately optional, read at call time like EXA_API_KEY: production deployments never set it,
 * so an unset variable must behave exactly as before instead of failing the deploy or the request.
 *
 * When set to one bare origin, the session-jwt exchange ALSO accepts that exact origin — this is
 * what lets the app's development-only plugin frame override (`VITE_PLUGIN_UI_DEV_*` in
 * packages/app/.env) complete its exchange from a local dev server. Exact string match on the
 * serialized origin: no wildcard, no list, no prefix.
 */
function dev_exchange_origin() {
	const raw = process.env.PLUGINS_UI_DEV_EXCHANGE_ORIGIN?.trim();
	if (!raw) {
		return undefined;
	}

	try {
		// Require the value to already BE a serialized origin, the same rule the frontend override
		// applies. A scheme-less value like "localhost:5174" does not throw in new URL() — its
		// origin serializes to the string "null", which is also the literal Origin header every
		// sandboxed iframe or data: page sends. Accepting it would allowlist every opaque origin.
		const parsed = new URL(raw).origin;
		if (parsed !== raw) {
			console.error("PLUGINS_UI_DEV_EXCHANGE_ORIGIN is set but is not a bare origin", { value: raw });
			return undefined;
		}
		return parsed;
	} catch {
		console.error("PLUGINS_UI_DEV_EXCHANGE_ORIGIN is set but is not a valid URL", { value: raw });
		return undefined;
	}
}

/**
 * CORS headers for the dev exchange, or undefined when they must not appear. They are keyed to the
 * request's exact Origin and only ever echo the ONE configured dev origin, so a response stays
 * unreadable to scripts on every other origin — the property the plain router's missing CORS
 * headers guarantees in production.
 */
function dev_exchange_cors_headers(request: Request): Record<string, string> | undefined {
	const origin = request.headers.get("Origin");
	const devExchangeOrigin = dev_exchange_origin();
	if (origin === null || devExchangeOrigin === undefined || origin !== devExchangeOrigin) {
		return undefined;
	}

	return {
		Vary: "Origin",
		"Access-Control-Allow-Origin": devExchangeOrigin,
		"Access-Control-Allow-Methods": "POST",
		"Access-Control-Allow-Headers": "Content-Type",
	};
}

if (!process.env.CONVEX_CLOUD_URL) {
	throw new Error("CONVEX_CLOUD_URL is not set in Convex env");
}
// The SDK runs its own ConvexClient inside the iframe, and that client talks to the deployment's
// cloud origin over a WebSocket. `https:` in connect-src never authorizes `wss:`, so the CSP must
// list both schemes.
const CONVEX_CLOUD_ORIGIN = new URL(process.env.CONVEX_CLOUD_URL).origin;
const CONVEX_CLOUD_WS_ORIGIN = CONVEX_CLOUD_ORIGIN.replace(/^https:/, "wss:");

/**
 * The frame keeps this asset origin so its public API calls stay same-origin and skip CORS
 * preflights. The host app has a different origin and remains outside the sandbox. The Convex
 * cloud origins let the frame's own ConvexClient connect (https for the client's HTTP calls,
 * wss for the sync WebSocket).
 *
 * `uiOutboundOrigins` are the extra destinations the plugin version declared and the workspace
 * accepted at install. They widen `connect-src` only. An asset request carries a plugin version and a
 * path and nothing else, so the response cannot know which installation is looking at it — which is
 * why the list lives on the immutable version and not on the installation.
 */
function plugin_page_csp(uiOutboundOrigins: readonly string[]) {
	return [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		`img-src ${R2_MEDIA_ORIGINS} data: blob:`,
		`media-src ${R2_MEDIA_ORIGINS} blob:`,
		`connect-src ${["'self'", CONVEX_CLOUD_ORIGIN, CONVEX_CLOUD_WS_ORIGIN, ...uiOutboundOrigins].join(" ")}`,
		"font-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
		`frame-ancestors ${allowed_origins().join(" ")}`,
	].join("; ");
}

/**
 * Insert the session doc for a plugin page. Internal on purpose: `mint_page_session` (the action
 * below) runs it and then adds the JWT.
 */
export const insert_page_session = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginName: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			expiresAt: v.number(),
			pluginVersionId: v.id("plugins_versions"),
			sessionId: v.id("plugins_ui_sessions"),
		}),
		// Only the rate-limit refusal fills this in. The frame turns the wait into a sentence the
		// member can act on, because a mint refusal is the whole alert they get.
		_nay: { data: v.object({ retryAfterMs: v.optional(v.number()) }) },
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (!(await db_plugin_workspace_is_live(ctx, membership))) {
			return Result({ _nay: { message: "Not found" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_ui_session_mint", key: userAuth.id });
		if (rateLimit) {
			// Carry the wait back to the caller, the same way `rotate_ui_session` does. The frame does
			// not retry a mint by itself, so this number is only there to tell the member how long to
			// wait before pressing Retry.
			return Result({ _nay: { message: rateLimit.message, data: { retryAfterMs: rateLimit.retryAfterMs } } });
		}

		// Opening an installed page is not managing plugins, so we do not ask for
		// `workspace.plugins.manage`. But the token created here can read files through the public API,
		// so it must not go to someone who cannot read the workspace. Checking when the token is
		// created avoids minting a useless file token. Public file routes also map their scope to an app
		// permission and recheck it on every request.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) {
			return authorized;
		}

		const installation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("status", "enabled")
					.eq("pluginName", args.pluginName),
			)
			.first();
		if (!installation) {
			return Result({ _nay: { message: "Not found" } });
		}
		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (
			!version ||
			version.sourceStatus !== "ready" ||
			version.reviewStatus !== "passed" ||
			version.pages.length === 0
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const now = Date.now();
		const expiresAt = now + SESSION_TTL_MS;
		const token = `plu_${crypto_random_hex(32)}`;
		const sessionId = await ctx.db.insert("plugins_ui_sessions", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installation._id,
			pluginVersionId: installation.pluginVersionId,
			userId: userAuth.id,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt,
		});

		// Delete the doc exactly at expiry: Convex reruns queries on writes, not on wall clock, so
		// without this job a live subscription through the plugin-facing doors would keep streaming past
		// `expiresAt` until the daily cleanup cron.
		const expiryJobId = await ctx.scheduler.runAt(expiresAt, internal.plugins_ui.expire_ui_session, { sessionId });
		await ctx.db.patch("plugins_ui_sessions", sessionId, { expiryJobId });

		// The plaintext token is returned exactly once; only its hash is stored.
		return Result({ _yay: { token, expiresAt, pluginVersionId: installation.pluginVersionId, sessionId } });
	},
});

type insert_page_session_Result =
	typeof insert_page_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Mint the session for a plugin page: insert the session doc, then sign its JWT. This is an action
 * because ECDSA signing needs cryptographic randomness, which Convex allows only in actions. Auth
 * flows from this action into the mutation.
 */
export const mint_page_session = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginName: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			expiresAt: v.number(),
			jwt: v.string(),
			jwtExpiresAt: v.number(),
			pluginVersionId: v.id("plugins_versions"),
			sessionId: v.id("plugins_ui_sessions"),
		}),
		// Passed straight through from `insert_page_session`; see the note on its own validator.
		_nay: { data: v.object({ retryAfterMs: v.optional(v.number()) }) },
	}),
	handler: async (ctx, args) => {
		const inserted = (await ctx.runMutation(
			internal.plugins_ui.insert_page_session,
			args,
		)) as insert_page_session_Result;
		if (inserted._nay) {
			return inserted;
		}

		// The JWT rides with the token, so the frame gets both credentials in one message and needs
		// no exchange round trip.
		const jwt = await sign_session_jwt(inserted._yay.sessionId, inserted._yay.expiresAt);
		return Result({ _yay: { ...inserted._yay, jwt, jwtExpiresAt: inserted._yay.expiresAt } });
	},
});

/**
 * Insert the session doc for a plugin file view. Internal on purpose: `mint_file_view_session` (the
 * action below) runs it and then adds the JWT.
 */
export const insert_file_view_session = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginName: v.string(),
		fileViewId: v.string(),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			expiresAt: v.number(),
			pluginVersionId: v.id("plugins_versions"),
			sessionId: v.id("plugins_ui_sessions"),
		}),
		// Same as `insert_page_session`: only the rate-limit refusal fills this in, and the frame turns
		// it into a sentence the member can act on.
		_nay: { data: v.object({ retryAfterMs: v.optional(v.number()) }) },
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		if (!(await db_plugin_workspace_is_live(ctx, membership))) {
			return Result({ _nay: { message: "Not found" } });
		}

		// File views mint on every file switch and every details/view toggle, so they get their own
		// browsing-sized bucket instead of the strict page bucket.
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "plugins_ui_file_view_session_mint",
			key: userAuth.id,
		});
		if (rateLimit) {
			// Carry the wait back, same reason as the page mint above.
			return Result({ _nay: { message: rateLimit.message, data: { retryAfterMs: rateLimit.retryAfterMs } } });
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (!fileNode) {
			return Result({ _nay: { message: "Not found" } });
		}
		// The token minted here follows the same content.read rule as `mint_page_session`, but the
		// permission is checked against the node, not the workspace, so a file inside a restricted
		// folder is refused even for somebody the workspace lets read everything else.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return authorized;
		}

		const installation = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("status", "enabled")
					.eq("pluginName", args.pluginName),
			)
			.first();
		if (!installation) {
			return Result({ _nay: { message: "Not found" } });
		}
		const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
		if (!version || version.sourceStatus !== "ready" || version.reviewStatus !== "passed") {
			return Result({ _nay: { message: "Not found" } });
		}
		// The view must both exist and declare the node's stored content type, so a plugin cannot
		// open itself for types it never passed review with.
		const fileView = version.fileViews.find((fileView) => fileView.id === args.fileViewId);
		if (!fileView || !fileNode.contentType || !fileView.contentTypes.includes(fileNode.contentType)) {
			return Result({ _nay: { message: "Not found" } });
		}

		const now = Date.now();
		const expiresAt = now + SESSION_TTL_MS;
		const token = `plu_${crypto_random_hex(32)}`;
		const sessionId = await ctx.db.insert("plugins_ui_sessions", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installation._id,
			pluginVersionId: installation.pluginVersionId,
			userId: userAuth.id,
			fileNodeId: fileNode._id,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt,
		});

		// Same reactive-expiry job as in mint_page_session.
		const expiryJobId = await ctx.scheduler.runAt(expiresAt, internal.plugins_ui.expire_ui_session, { sessionId });
		await ctx.db.patch("plugins_ui_sessions", sessionId, { expiryJobId });

		// The plaintext token is returned exactly once; only its hash is stored.
		return Result({ _yay: { token, expiresAt, pluginVersionId: installation.pluginVersionId, sessionId } });
	},
});

type insert_file_view_session_Result =
	typeof insert_file_view_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Mint the session for a plugin file view. Same two-step shape as `mint_page_session`.
 */
export const mint_file_view_session = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginName: v.string(),
		fileViewId: v.string(),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			expiresAt: v.number(),
			jwt: v.string(),
			jwtExpiresAt: v.number(),
			pluginVersionId: v.id("plugins_versions"),
			sessionId: v.id("plugins_ui_sessions"),
		}),
		// Passed straight through from `insert_file_view_session`; see the note on its own validator.
		_nay: { data: v.object({ retryAfterMs: v.optional(v.number()) }) },
	}),
	handler: async (ctx, args) => {
		const inserted = (await ctx.runMutation(
			internal.plugins_ui.insert_file_view_session,
			args,
		)) as insert_file_view_session_Result;
		if (inserted._nay) {
			return inserted;
		}

		const jwt = await sign_session_jwt(inserted._yay.sessionId, inserted._yay.expiresAt);
		return Result({ _yay: { ...inserted._yay, jwt, jwtExpiresAt: inserted._yay.expiresAt } });
	},
});

/**
 * Rotate the token hash on an existing session doc. Internal on purpose: `refresh_ui_session` (the
 * action below) runs it and then adds the JWT.
 */
export const rotate_ui_session = internalMutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("plugins_ui_sessions"),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			expiresAt: v.number(),
			pluginVersionId: v.id("plugins_versions"),
		}),
		// Only the rate-limit refusal fills this in. The frame waits that long and rotates once more
		// instead of leaving the page with a token it cannot renew.
		_nay: { data: v.object({ retryAfterMs: v.optional(v.number()) }) },
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const session = await ctx.db.get("plugins_ui_sessions", args.sessionId);
		if (
			!session ||
			session.userId !== userAuth.id ||
			session.organizationId !== membership.organizationId ||
			session.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const installation = await ctx.db.get("plugins_workspace_installations", session.installationId);
		if (
			!installation ||
			installation.status !== "enabled" ||
			installation.pluginVersionId !== session.pluginVersionId ||
			installation.organizationId !== session.organizationId ||
			installation.workspaceId !== session.workspaceId
		) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!(await db_plugin_workspace_is_live(ctx, session))) {
			return Result({ _nay: { message: "Not found" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "plugins_ui_session_mint",
			key: userAuth.id,
		});
		if (rateLimit) {
			// Carry the wait back to the caller. A frame that only has to pause a moment keeps its
			// document, its state, and its live subscriptions instead of dying with no message.
			return Result({ _nay: { message: rateLimit.message, data: { retryAfterMs: rateLimit.retryAfterMs } } });
		}

		// Rotating a token creates a new one, so it follows the same rule as the mint that created the
		// session. A file-view session checks against its file node, so a restriction added after the
		// mint stops the refresh.
		const fileNode = session.fileNodeId ? await ctx.db.get("files_nodes", session.fileNodeId) : null;
		if (session.fileNodeId && !fileNode) {
			return Result({ _nay: { message: "Not found" } });
		}
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode: fileNode ?? undefined,
		});
		if (authorized._nay) {
			return authorized;
		}

		const now = Date.now();
		const expiresAt = now + SESSION_TTL_MS;
		const token = `plu_${crypto_random_hex(32)}`;

		// Move the expiry-deletion job to the new expiry. Cancelling a job that already ran is a
		// no-op, and the job re-checks `expiresAt` anyway, so a leftover job cannot kill the
		// refreshed session.
		if (session.expiryJobId) {
			await ctx.scheduler.cancel(session.expiryJobId);
		}
		const expiryJobId = await ctx.scheduler.runAt(expiresAt, internal.plugins_ui.expire_ui_session, {
			sessionId: session._id,
		});

		// Rotate the hash on the same session so the old plaintext token stops resolving immediately.
		await ctx.db.patch("plugins_ui_sessions", session._id, {
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt,
			expiryJobId,
		});

		return Result({ _yay: { token, expiresAt, pluginVersionId: session.pluginVersionId } });
	},
});

type rotate_ui_session_Result =
	typeof rotate_ui_session extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Rotates the bearer token for an open plugin page or file view so the frame can keep working past
 * the 30-minute token lifetime. The SDK calls this shortly before expiry or after a 401 response.
 * The answer carries the new `plu_` token and a new JWT signed for the same new expiry.
 *
 * The existing session doc is updated instead of creating another session. This keeps one session
 * to revoke and makes the previous token stop working immediately. Refresh succeeds only while the
 * current user still owns the session and the same plugin version remains enabled in the workspace.
 * A file-view session also re-checks that the user can still read its file node.
 */
export const refresh_ui_session = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("plugins_ui_sessions"),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			expiresAt: v.number(),
			jwt: v.string(),
			jwtExpiresAt: v.number(),
			pluginVersionId: v.id("plugins_versions"),
		}),
		// Passed straight through from `rotate_ui_session`; see the note on its own validator.
		_nay: { data: v.object({ retryAfterMs: v.optional(v.number()) }) },
	}),
	handler: async (ctx, args) => {
		const rotated = (await ctx.runMutation(internal.plugins_ui.rotate_ui_session, args)) as rotate_ui_session_Result;
		if (rotated._nay) {
			return rotated;
		}

		const jwt = await sign_session_jwt(args.sessionId, rotated._yay.expiresAt);
		return Result({ _yay: { ...rotated._yay, jwt, jwtExpiresAt: rotated._yay.expiresAt } });
	},
});

export const revoke_ui_session = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		sessionId: v.id("plugins_ui_sessions"),
	},
	returns: v_result({ _yay: v.object({}) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const session = await ctx.db.get("plugins_ui_sessions", args.sessionId);
		// Revocation is idempotent because cleanup or a prior request may already have removed the session.
		if (!session) {
			return Result({ _yay: {} });
		}
		if (
			session.userId !== userAuth.id ||
			session.organizationId !== membership.organizationId ||
			session.workspaceId !== membership.workspaceId
		) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		await ctx.db.delete("plugins_ui_sessions", session._id);
		return Result({ _yay: {} });
	},
});

export const list_ui_pages = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			pluginName: v.string(),
			displayName: v.string(),
			pluginVersionId: v.id("plugins_versions"),
			pages: v.array(
				v.object({
					id: v.string(),
					title: v.string(),
					entry: v.string(),
					navItem: v.union(v.object({ label: v.string(), icon: v.union(v.string(), v.null()) }), v.null()),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}
		if (!(await db_plugin_workspace_is_live(ctx, membership))) {
			return [];
		}

		// Which plugins a workspace runs counts as workspace content, like the activity feed.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) {
			return [];
		}

		// The status+pluginName index yields enabled installations already in plugin-name order.
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("status", "enabled"),
			)
			.collect();

		const entries = await Promise.all(
			installations.map(async (installation) => {
				const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
				if (
					!version ||
					version.sourceStatus !== "ready" ||
					version.reviewStatus !== "passed" ||
					version.pages.length === 0
				) {
					return null;
				}
				return {
					pluginName: installation.pluginName,
					displayName: version.displayName,
					pluginVersionId: version._id,
					pages: version.pages,
				};
			}),
		);

		return entries.filter((entry) => entry !== null);
	},
});

export const list_file_views = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
	},
	returns: v.array(
		v.object({
			pluginName: v.string(),
			pluginVersionId: v.id("plugins_versions"),
			installationCreatedAt: v.number(),
			fileViews: v.array(
				v.object({
					id: v.string(),
					title: v.string(),
					entry: v.string(),
					contentTypes: v.array(v.string()),
				}),
			),
		}),
	),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return [];
		}
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}
		if (!(await db_plugin_workspace_is_live(ctx, membership))) {
			return [];
		}

		// Which plugins a workspace runs counts as workspace content, like the activity feed.
		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
		});
		if (authorized._nay) {
			return [];
		}

		// The status+pluginName index yields enabled installations already in plugin-name order.
		const installations = await ctx.db
			.query("plugins_workspace_installations")
			.withIndex("by_organization_workspace_status_pluginName", (q) =>
				q
					.eq("organizationId", membership.organizationId)
					.eq("workspaceId", membership.workspaceId)
					.eq("status", "enabled"),
			)
			.collect();

		const entries = await Promise.all(
			installations.map(async (installation) => {
				const version = await ctx.db.get("plugins_versions", installation.pluginVersionId);
				if (
					!version ||
					version.sourceStatus !== "ready" ||
					version.reviewStatus !== "passed" ||
					version.fileViews.length === 0
				) {
					return null;
				}
				return {
					pluginName: installation.pluginName,
					pluginVersionId: version._id,
					// The files UI orders view tabs by installation creation time, so tab order does not
					// depend on query order.
					installationCreatedAt: installation._creationTime,
					fileViews: version.fileViews,
				};
			}),
		);

		return entries.filter((entry) => entry !== null);
	},
});

export const get_ui_asset = internalQuery({
	args: {
		pluginVersionId: v.string(),
		path: v.string(),
	},
	returns: v.union(
		v.object({ r2Key: v.string(), contentType: v.string(), uiOutboundOrigins: v.array(v.string()) }),
		v.null(),
	),
	handler: async (ctx, args) => {
		const pluginVersionId = ctx.db.normalizeId("plugins_versions", args.pluginVersionId);
		if (!pluginVersionId) {
			return null;
		}
		const version = await ctx.db.get("plugins_versions", pluginVersionId);
		if (!version || version.sourceStatus !== "ready" || version.reviewStatus !== "passed") {
			return null;
		}
		const file = version.files.find((file) => file.path === args.path);
		if (!file) {
			return null;
		}
		return { r2Key: file.r2Key, contentType: file.contentType, uiOutboundOrigins: version.uiOutboundOrigins };
	},
});

/**
 * Scheduled per session at its `expiresAt` by the mints, and moved by refresh. The deletion is
 * what ends live plugin subscriptions at expiry (see the schema comment on `expiryJobId`).
 *
 * Revoke, uninstall, cleanup, or account deletion may have deleted the doc first, and a refresh
 * racing this run may have moved the expiry forward — both make this run a no-op.
 */
export const expire_ui_session = internalMutation({
	args: { sessionId: v.id("plugins_ui_sessions") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const session = await ctx.db.get("plugins_ui_sessions", args.sessionId);
		if (!session || session.expiresAt > Date.now()) {
			return null;
		}

		await ctx.db.delete("plugins_ui_sessions", session._id);
		return null;
	},
});

export const cleanup_expired_ui_sessions = internalMutation({
	args: {
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const batchSize = Math.min(Math.max(args.batchSize ?? SESSION_CLEANUP_BATCH_SIZE, 1), SESSION_CLEANUP_BATCH_SIZE);
		const expired = await ctx.db
			.query("plugins_ui_sessions")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
			.take(batchSize);
		for (const session of expired) {
			await ctx.db.delete("plugins_ui_sessions", session._id);
		}

		const done = expired.length < batchSize;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.plugins_ui.cleanup_expired_ui_sessions, {
				batchSize: args.batchSize,
			});
		}

		return { deletedCount: expired.length, done };
	},
});

/**
 * Serves published plugin dist files to the iframe. Registered on the plain router because asset
 * GETs are navigations/subresources that need no CORS, and the CORS wrapper must not touch their
 * headers.
 */
export async function plugins_ui_http_handle_request(ctx: ActionCtx, request: Request, pathPrefix: "/plugins-ui/") {
	const pathname = new URL(request.url).pathname;
	const rest = pathname.slice(pathPrefix.length);
	const slashIndex = rest.indexOf("/");
	if (slashIndex <= 0) {
		return Response.json({ message: "Not found" }, { status: 404 });
	}
	const pluginVersionId = rest.slice(0, slashIndex);
	let filePath: string;
	try {
		filePath = decodeURIComponent(rest.slice(slashIndex + 1));
	} catch {
		// Malformed percent-encoding is a caller error, not an internal one.
		return Response.json({ message: "Not found" }, { status: 404 });
	}
	// Paths were validated at publish; re-check cheaply before matching anyway.
	if (
		!filePath.startsWith("dist/") ||
		filePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
	) {
		return Response.json({ message: "Not found" }, { status: 404 });
	}

	const asset = await ctx.runQuery(internal.plugins_ui.get_ui_asset, { pluginVersionId, path: filePath });
	if (!asset) {
		return Response.json({ message: "Not found" }, { status: 404 });
	}

	// Only the object fetch gets a try/catch: the path checks and get_ui_asset misses above
	// already return clean 404s, and anything else that throws here is a bug that should
	// surface.
	let object: Response;
	try {
		object = await r2_fetch_object_from_bucket({ key: asset.r2Key });
	} catch (error) {
		// ConvexError's constructor stringifies the whole data payload into .message, and
		// r2_fetch_object_from_bucket puts the R2 key in data.cause — log only the short
		// data.message, never the full error or its cause. Plain errors (network-level fetch
		// failures) can embed the signed R2 URL in .message, so log only their name.
		const sanitizedMessage =
			error instanceof ConvexError
				? typeof error.data === "object" &&
					error.data !== null &&
					"message" in error.data &&
					typeof error.data.message === "string"
					? error.data.message
					: "ConvexError"
				: error instanceof Error
					? error.name
					: String(error);
		console.error("Failed to fetch plugin ui asset object", {
			pluginVersionId,
			path: filePath,
			errorName: error instanceof Error ? error.name : "Error",
			errorMessage: sanitizedMessage,
		});
		// no-store stops Cloudflare from caching this outage response under the immutable
		// version URL. The 200 path below is cached forever, so a cached 502 would never go
		// away.
		return Response.json(
			{ message: "Temporarily unavailable" },
			{ status: 502, headers: { "Cache-Control": "no-store", "Retry-After": "3" } },
		);
	}
	const headers = new Headers({
		"Content-Type": asset.contentType,
		"X-Content-Type-Options": "nosniff",
		// The URL embeds the immutable version id, so content never changes under it.
		"Cache-Control": "public, max-age=31536000, immutable",
		"Cross-Origin-Resource-Policy": "cross-origin",
	});
	// CSP only matters when a resource is rendered as a document, so setting it on every
	// response costs nothing for subresources and makes sure no document slips through
	// without a policy. Without it, a "text/html;charset=..." content type or a scriptable
	// type like SVG would render with no policy when opened directly.
	headers.set("Content-Security-Policy", plugin_page_csp(asset.uiOutboundOrigins));
	return new Response(object.body, { status: 200, headers });
}

export type plugins_ui_http_session_jwt_Body = { token?: string };

/**
 * Fallback exchange: signs the plugin-session JWT for a live `plu_` session token. The iframe's own
 * ConvexClient authenticates with that JWT (subject = session id), which is how a plugin page
 * subscribes to Convex queries directly instead of proxying through the host window. The mint and
 * refresh actions already deliver the same JWT beside the token, so the SDK calls this route only
 * when its host sent none.
 *
 * Registered on the plain router ON PURPOSE: the frame calls this route from the same origin, so
 * it needs no CORS — and the response must never gain CORS headers, because that would make the
 * JWT readable to scripts on other origins. The Origin check refuses cross-origin browser calls
 * outright, including the literal "null" an opaque-origin page sends.
 *
 * Development-only exception: when the deployment sets PLUGINS_UI_DEV_EXCHANGE_ORIGIN to one bare
 * origin, that exact origin is accepted too and its responses carry CORS headers — but ONLY for
 * that origin, so no other page can ever read a response body. Production deployments do not set
 * the variable, which restores today's behavior exactly.
 *
 * The exchange never extends the session. Only `refresh_ui_session` (member auth in the host
 * window) moves `expiresAt`, and it signs the JWT for the new expiry itself.
 */
export async function plugins_ui_http_session_jwt(ctx: ActionCtx, request: Request) {
	const devExchangeOrigin = dev_exchange_origin();
	const devCorsHeaders = dev_exchange_cors_headers(request);
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== SITE_ORIGIN && origin !== devExchangeOrigin) {
		return { status: 403, body: Result({ _nay: { message: "Unauthorized" } }), headers: devCorsHeaders } as const;
	}

	const body = (await request.json().catch(() => null)) as null | plugins_ui_http_session_jwt_Body;
	if (typeof body?.token !== "string") {
		return { status: 400, body: Result({ _nay: { message: "Request body must carry a token" } }), headers: devCorsHeaders } as const;
	}

	const principalResult = await ctx.runQuery(internal.public_api.resolve_principal, { presented: body.token });
	if (principalResult._nay || principalResult._yay.kind !== "plugin_ui") {
		return { status: 401, body: Result({ _nay: { message: "Unauthenticated" } }), headers: devCorsHeaders } as const;
	}
	const principal = principalResult._yay;

	// resolve_principal leaves the expiry verdict to its callers (see its doc comment).
	const now = Date.now();
	if (principal.sessionExpiresAt <= now) {
		return { status: 401, body: Result({ _nay: { message: "Unauthenticated" } }), headers: devCorsHeaders } as const;
	}

	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "plugins_ui_session_jwt_exchange",
		key: principal.sessionId,
	});
	if (rateLimit) {
		return {
			status: 429,
			body: { message: rateLimit.message, retryAfterMs: rateLimit.retryAfterMs },
			headers: devCorsHeaders,
		} as const;
	}

	const jwt = await sign_session_jwt(principal.sessionId, principal.sessionExpiresAt);

	return {
		status: 200,
		body: Result({ _yay: { jwt, sessionExpiresAt: principal.sessionExpiresAt } }),
		headers: devCorsHeaders,
	} as const;
}

/**
 * Answers the CORS preflight a cross-origin exchange POST from the dev frame needs. The SDK sends
 * `Content-Type: application/json`, which is not a simple header, so the browser asks first even
 * though the real request is refused without the dev exception too. Outside the dev configuration
 * this answers like any unregistered route (404), keeping production's refusal surface unchanged.
 */
export function plugins_ui_http_session_jwt_preflight(request: Request) {
	const corsHeaders = dev_exchange_cors_headers(request);
	if (!corsHeaders) {
		return new Response(null, { status: 404 });
	}

	return new Response(null, { status: 204, headers: corsHeaders });
}
