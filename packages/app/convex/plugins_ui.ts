/**
 * Plugin UI pages: manifest-declared HTML entries rendered in sandboxed iframes
 * (`sandbox="allow-scripts"`, opaque origin).
 *
 * Security model:
 * - The host app mints a short-lived `plu_` session token per (user, installation) and hands it
 *   to the iframe over postMessage only — tokens never appear in URLs. The public API resolves
 *   it as a `plugin_ui` principal; its scopes depend on the `workspace.files.read` capability
 *   the workspace consented to (see resolve_principal in public_api.ts).
 * - Secret values never reach plugin frontends: `plugin_ui` principals never get `secrets:read`
 *   or `outbound:fetch`, no matter what the installation accepted. Only the plugin backend can
 *   read secrets (plr_ runs via the runner host routes).
 * - Assets are served publicly under an immutable version id. That is fine because dists carry
 *   no tenant data and are already public: anyone can browse them as source in GLOBAL/PLUGINS.
 */
import { ConvexError, v } from "convex/values";
import { httpAction, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { Result } from "common/errors-as-values-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { allowed_origins, server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_fetch_object_from_bucket, r2_get_bucket } from "./r2.ts";
import type { RouterForConvexModules } from "./http.ts";

// 30 minutes: long enough that an open page rarely refreshes, short enough that a leaked token
// dies fast. On top of this, the resolver rechecks the installation and membership on every call.
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_CLEANUP_BATCH_SIZE = 100;

const ASSET_PATH_PREFIX = "/plugins-ui/";

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
}
const HOST_ORIGIN = process.env.VITE_CONVEX_HTTP_URL;

if (!process.env.R2_ENDPOINT) {
	throw new Error("R2_ENDPOINT is not set in Convex env");
}
// Signed download URLs point at the R2 S3 endpoint, and the S3 client may put the bucket in the
// URL path or in the hostname — so allow exactly those two origins. Allowing all of https:
// instead would let a page leak data to any server through img/media loads.
const R2_ENDPOINT_URL = new URL(process.env.R2_ENDPOINT);
const R2_MEDIA_ORIGINS = `${R2_ENDPOINT_URL.origin} ${R2_ENDPOINT_URL.protocol}//${r2_get_bucket()}.${R2_ENDPOINT_URL.host}`;

// A sandboxed document has an opaque origin, so CSP 'self' matches nothing: every source must be
// explicit.
const PLUGIN_PAGE_CSP = [
	"default-src 'none'",
	`script-src ${HOST_ORIGIN}`,
	`style-src ${HOST_ORIGIN} 'unsafe-inline'`,
	`img-src ${R2_MEDIA_ORIGINS} data: blob:`,
	`media-src ${R2_MEDIA_ORIGINS} blob:`,
	`connect-src ${HOST_ORIGIN}`,
	`font-src ${HOST_ORIGIN}`,
	"base-uri 'none'",
	"form-action 'none'",
	`frame-ancestors ${allowed_origins().join(" ")}`,
].join("; ");

export const mint_page_session = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		pluginName: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			token: v.string(),
			expiresAt: v.number(),
			pluginVersionId: v.id("plugins_versions"),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		// Membership is enough on purpose: using an installed page is not plugin management.
		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}
		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "plugins_ui_session_mint", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
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
		if (!version || (version.pages ?? []).length === 0) {
			return Result({ _nay: { message: "Not found" } });
		}

		const now = Date.now();
		const expiresAt = now + SESSION_TTL_MS;
		const token = `plu_${crypto_random_hex(32)}`;
		await ctx.db.insert("plugins_ui_sessions", {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			installationId: installation._id,
			pluginVersionId: installation.pluginVersionId,
			userId: userAuth.id,
			tokenHash: await crypto_sha256_hex(token),
			createdAt: now,
			expiresAt,
		});

		// The plaintext token is returned exactly once; only its hash is stored.
		return Result({ _yay: { token, expiresAt, pluginVersionId: installation.pluginVersionId } });
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
				const pages = version?.pages ?? [];
				if (!version || pages.length === 0) {
					return null;
				}
				return {
					pluginName: installation.pluginName,
					displayName: version.displayName,
					pluginVersionId: version._id,
					pages,
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
	returns: v.union(v.object({ r2Key: v.string(), contentType: v.string() }), v.null()),
	handler: async (ctx, args) => {
		const pluginVersionId = ctx.db.normalizeId("plugins_versions", args.pluginVersionId);
		if (!pluginVersionId) {
			return null;
		}
		const version = await ctx.db.get("plugins_versions", pluginVersionId);
		if (!version || version.reviewStatus !== "passed") {
			return null;
		}
		const file = version.files.find((file) => file.path === args.path);
		if (!file) {
			return null;
		}
		return { r2Key: file.r2Key, contentType: file.contentType };
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
export function plugins_ui_http_routes(router: RouterForConvexModules) {
	router.route({
		pathPrefix: ASSET_PATH_PREFIX,
		method: "GET",
		handler: httpAction(async (ctx, request) => {
			const pathname = new URL(request.url).pathname;
			const rest = pathname.slice(ASSET_PATH_PREFIX.length);
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
				// The sandboxed page fetches its own module scripts/stylesheets in CORS mode with
				// Origin: null (Vite emits crossorigin attributes, and module scripts are always
				// CORS). Dists are public immutable content, so the wildcard gives away nothing
				// sensitive.
				"Access-Control-Allow-Origin": "*",
			});
			// CSP only matters when a resource is rendered as a document, so setting it on every
			// response costs nothing for subresources and makes sure no document slips through
			// without a policy. Without it, a "text/html;charset=..." content type or a scriptable
			// type like SVG would render with no policy when opened directly.
			headers.set("Content-Security-Policy", PLUGIN_PAGE_CSP);
			return new Response(object.body, { status: 200, headers });
		}),
	});
}
