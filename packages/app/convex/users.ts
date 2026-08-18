import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { v } from "convex/values";
import { exportJWK, importPKCS8, importSPKI, SignJWT } from "jose";
import { internal } from "./_generated/api.js";
import { type RegisteredMutation } from "convex/server";
import app_convex_schema from "./schema.ts";
import { doc } from "convex-helpers/validators";
import {
	users_get_user_id_from_jwt,
	users_create_anonymouse_user_display_name,
	users_create_fallback_display_name,
} from "../shared/users.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { quotas_db_ensure } from "./quotas.ts";
import type { Doc, Id } from "./_generated/dataModel";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { server_fetch_json } from "../server/server-fetch.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { organizations_db_ensure_default_organization_and_workspace_for_user } from "./organizations.ts";
import { access_control_db_ensure_organization_member_role } from "./access_control.ts";
import {
	billing_action_delete_polar_customer_by_user_id,
	billing_action_revoke_polar_subscription,
	billing_action_cancel_scheduled_polar_subscription_period_end_cancellation,
	billing_db_ensure_anonymous_user_usage_snapshot,
	billing_action_enqueue_free_subscription_bootstrap,
	billing_action_schedule_polar_subscription_period_end_cancellation,
} from "./billing.ts";
import { billing_polar } from "./billing_polar.ts";
import { rate_limiter_http_client_key, rate_limiter_limit_by_key } from "./rate_limiter.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). Do not keep request state in module-level values.
export const experimental_reuseContext = true;

if (!process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM) {
	throw convex_error({ message: "ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM is not set in Convex env" });
}

/** Private key for signing anonymous users JWT */
const ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM = process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM;

if (!process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM) {
	throw convex_error({ message: "ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM is not set in Convex env" });
}

/** Public key (SPKI) for verifying anonymous users JWT */
const ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM = process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM;

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw convex_error({ message: "VITE_CONVEX_HTTP_URL is not set in Convex env" });
}

/** Issuer of the anonymous users JWT */
const ANONYMOUS_USERS_JWT_ISSUER = process.env.VITE_CONVEX_HTTP_URL;

if (!process.env.CLERK_SECRET_KEY) {
	throw convex_error({ message: "CLERK_SECRET_KEY is not set in Convex env" });
}

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

/**
 * List of kids for the anonymous users JWT.
 *
 * The first kid is the default kid (most recent).
 **/
const ANONYMOUS_USERS_JWT_KID_LIST = ["anonymous-user-jwt-2025-12"];

/**
 * Rotate the stored refresh JWT once it is 7 days away from expiry.
 */
const ANONYMOUS_USERS_JWT_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `aud` of the refresh JWT. Convex only accepts `aud "convex"` (auth.config.ts applicationID), so a
 * refresh JWT can never authenticate a function call. The refresh route requires this audience, and
 * that requirement is what retires pre-split dual-role tokens: they carry `aud "convex"`, so they
 * stop working as refresh credentials even though they still byte-match their stored auth token doc.
 *
 * The whole two-token scheme is the standard OAuth split (RFC 6749 §1.5): only this route reads the
 * token table, every other call verifies a short-lived signed access token. Rotation follows
 * RFC 9700 §4.14, with the `previousToken` grace window (Auth0's "reuse interval") for tab races.
 */
const ANONYMOUS_USERS_REFRESH_JWT_AUD = "anonymous-refresh";

/**
 * The access JWT is the revocation window: after a user is tombstoned, already-issued access tokens
 * keep authenticating for at most this long. The refresh route checks the user doc (including
 * `deletedAt`) on every call, so nothing outlives this window except that route's own 401.
 */
const ANONYMOUS_USERS_ACCESS_JWT_EXPIRY = "1h";

const ANONYMOUS_USERS_REFRESH_JWT_EXPIRY = "30d";

const USERS_RESOLVE_USER_BAD_REQUEST_MESSAGES = [
	"Signed-in user email is required",
	"Email is already linked to another user",
] as const;

/**
 * Returns the public JWK `x` and `y` coordinates for the configured PEM key.
 */
const get_anonymous_users_jwt_public_xy = ((/* iife */) => {
	async function value() {
		const publicKey = await importSPKI(ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM, "ES256");
		const jwk = await exportJWK(publicKey);

		if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
			throw convex_error({ message: "ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM is not an ES256 P-256 public key" });
		}

		return { x: jwk.x, y: jwk.y } as const;
	}

	let cache: ReturnType<typeof value> | undefined;

	return function get_anonymous_users_jwt_public_xy() {
		return (cache ??= value());
	};
})();

const get_anonymous_users_jwt_private_key = ((/* iife */) => {
	function value() {
		return importPKCS8(ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM, "ES256");
	}

	let cache: ReturnType<typeof value> | undefined;

	return function anon_jwt_private_key() {
		return (cache ??= value());
	};
})();

async function sign_anonymous_users_jwt(args: {
	kind: "access" | "refresh";
	subject: string;
	tokenId: Id<"users_anon_tokens">;
	name: string;
	avatarUrl?: string;
}) {
	const key = await get_anonymous_users_jwt_private_key();

	return await new SignJWT({
		name: args.name,
		...(args.avatarUrl ? { avatarUrl: args.avatarUrl } : null),
	})
		.setProtectedHeader({ alg: "ES256", kid: ANONYMOUS_USERS_JWT_KID_LIST[0], typ: "JWT" })
		.setIssuer(ANONYMOUS_USERS_JWT_ISSUER)
		.setAudience(args.kind === "access" ? "convex" : ANONYMOUS_USERS_REFRESH_JWT_AUD)
		.setSubject(args.subject)
		.setJti(args.tokenId)
		.setIssuedAt()
		.setExpirationTime(args.kind === "access" ? ANONYMOUS_USERS_ACCESS_JWT_EXPIRY : ANONYMOUS_USERS_REFRESH_JWT_EXPIRY)
		.sign(key);
}

export const create_anonymous_user = internalMutation({
	args: {},
	returns: v.object({
		userId: v.id("users"),
		tokenId: v.id("users_anon_tokens"),
	}),
	handler: async (ctx, _args) => {
		const now = Date.now();

		const userId = await ctx.db.insert("users", {
			clerkUserId: null,
		});

		await quotas_db_ensure(ctx, {
			quotaName: "extra_organizations",
			userId,
			now,
		});

		await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
			userId,
			now,
		});

		const [tokenId] = await Promise.all([
			ctx.db
				.insert("users_anon_tokens", {
					userId,
					token: "",
					updatedAt: now,
				})
				.then((tokenId) =>
					ctx.db
						.patch("users", userId, {
							anonymousAuthToken: tokenId,
						})
						.then(() => tokenId),
				),
			ctx.db
				.insert("users_anagraphics", {
					userId: userId,
					displayName: users_create_anonymouse_user_display_name(userId),
					updatedAt: now,
					email: "",
				})
				.then(async (anagraphicId) => {
					await ctx.db.patch("users", userId, {
						anagraphic: anagraphicId,
					});

					return anagraphicId;
				}),

			billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId, now }),
		]);

		return {
			userId,
			tokenId,
		};
	},
});

export const set_anonymous_auth_token = internalMutation({
	args: {
		tokenId: v.id("users_anon_tokens"),
		token: v.string(),
		/**
		 * Rotation guard: write only when the auth token doc still holds this token. Two tabs can pass the
		 * route's validation with the same old token and both try to rotate; without this guard the
		 * second write would orphan the first tab's token and the shared localStorage copy could end
		 * up matching neither. The loser gets the winner's token back and returns that to its client.
		 */
		expectedCurrentToken: v.optional(v.string()),
	},
	returns: v.string(),
	handler: async (ctx, args) => {
		const row = await ctx.db.get("users_anon_tokens", args.tokenId);
		if (!row) {
			throw convex_error({ message: "Anonymous auth token not found" });
		}

		if (args.expectedCurrentToken !== undefined && row.token !== args.expectedCurrentToken) {
			return row.token;
		}

		await ctx.db.patch("users_anon_tokens", args.tokenId, {
			token: args.token,
			// Keep the replaced token accepted once more, so a tab that read localStorage just before
			// this rotation still converges instead of minting a new user.
			...(row.token ? { previousToken: row.token } : null),
			updatedAt: Date.now(),
		});

		return args.token;
	},
});

type set_anonymous_auth_token_Result =
	typeof set_anonymous_auth_token extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const clear_clerk_user_id_after_clerk_delete = internalMutation({
	args: {
		userId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = ctx.db.normalizeId("users", args.userId);
		if (!userId) {
			return null;
		}

		const user = await ctx.db.get("users", userId);
		if (!user?.deletedAt) {
			return null;
		}

		await ctx.db.patch("users", userId, {
			clerkUserId: null,
		});

		return null;
	},
});

async function db_upsert_anagraphic(
	ctx: MutationCtx,
	args: {
		userId: Id<"users">;
		anagraphicId: Id<"users_anagraphics"> | undefined;
		displayName: string;
		email: string;
		now: number;
	},
) {
	if (args.anagraphicId) {
		await ctx.db.patch("users_anagraphics", args.anagraphicId, {
			displayName: args.displayName,
			email: args.email,
			updatedAt: args.now,
		});
		return;
	}

	const anagraphicId = await ctx.db.insert("users_anagraphics", {
		userId: args.userId,
		displayName: args.displayName,
		email: args.email,
		updatedAt: args.now,
	});

	await ctx.db.patch("users", args.userId, {
		anagraphic: anagraphicId,
	});
}

function users_resolve_user_is_bad_request_message(message: string) {
	return USERS_RESOLVE_USER_BAD_REQUEST_MESSAGES.some((value) => value === message);
}

const users_v_account_deletion_blocking_organizations = v.array(
	v.object({
		organization: doc(app_convex_schema, "organizations"),
		defaultWorkspace: doc(app_convex_schema, "organizations_workspaces"),
	}),
);

type Users_AccountDeletionBlockingOrganization = {
	organization: Doc<"organizations">;
	defaultWorkspace: Doc<"organizations_workspaces">;
};

async function users_db_list_account_deletion_blocking_organizations(ctx: QueryCtx, args: { userId: Id<"users"> }) {
	const ownedOrganizations = await ctx.db
		.query("organizations")
		.withIndex("by_ownerUser", (q) => q.eq("ownerUserId", args.userId))
		.collect();

	const blockingOrganizations = await Promise.all(
		ownedOrganizations.map(async (organization) => {
			if (organization.default || !organization.defaultWorkspaceId) {
				return null;
			}

			const [defaultWorkspace, deletionRequest] = await Promise.all([
				ctx.db.get("organizations_workspaces", organization.defaultWorkspaceId),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_organization_scope", (q) =>
						q.eq("organizationId", organization._id).eq("scope", "organization"),
					)
					.first(),
			]);
			// Treat an organization already queued through `delete_organization` as resolved for account deletion.
			if (deletionRequest) {
				return null;
			}
			if (!defaultWorkspace) {
				return null;
			}

			return {
				organization,
				defaultWorkspace,
			};
		}),
	);

	return blockingOrganizations
		.filter((organization): organization is Users_AccountDeletionBlockingOrganization => organization !== null)
		.sort(
			(left, right) =>
				left.organization.name.localeCompare(right.organization.name) ||
				String(left.organization._id).localeCompare(String(right.organization._id)),
		);
}

export const get = internalQuery({
	args: {
		userId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "users"), v.null()),
	handler: async (ctx, args) => {
		const userId = ctx.db.normalizeId("users", args.userId);
		if (!userId) {
			return null;
		}
		return await ctx.db.get("users", userId);
	},
});

export const get_with_anagraphic = internalQuery({
	args: {
		userId: v.string(),
	},
	returns: v.union(
		v.object({
			user: doc(app_convex_schema, "users"),
			anagraphic: v.union(doc(app_convex_schema, "users_anagraphics"), v.null()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userId = ctx.db.normalizeId("users", args.userId);
		if (!userId) {
			return null;
		}

		const user = await ctx.db.get("users", userId);
		if (!user) {
			return null;
		}

		const anagraphic = user.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;

		return {
			user,
			anagraphic,
		};
	},
});

export const get_with_anagraphic_and_anonymous_auth_token = internalQuery({
	args: {
		userId: v.string(),
		tokenId: v.string(),
	},
	returns: v.union(
		v.object({
			user: doc(app_convex_schema, "users"),
			anagraphic: v.union(doc(app_convex_schema, "users_anagraphics"), v.null()),
			anonymousAuthToken: doc(app_convex_schema, "users_anon_tokens"),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const userId = ctx.db.normalizeId("users", args.userId);
		const tokenId = ctx.db.normalizeId("users_anon_tokens", args.tokenId);
		if (!userId || !tokenId) {
			return null;
		}

		const user = await ctx.db.get("users", userId);
		// Deleting an anonymous account only sets `deletedAt` on the user. The token doc stays until
		// the retention job removes it much later. Without the `deletedAt` check here, the deleted
		// account could keep getting new JWTs during all that time.
		// This only stops new JWTs. A JWT that was already given out keeps working until it expires,
		// because `server_convex_get_user_fallback_to_anonymous` trusts the JWT and never loads the
		// user doc.
		if (!user || user.deletedAt != null || !user.anonymousAuthToken || user.anonymousAuthToken !== tokenId) {
			return null;
		}

		const [anagraphic, anonymousAuthToken] = await Promise.all([
			user.anagraphic ? ctx.db.get("users_anagraphics", user.anagraphic) : null,
			ctx.db.get("users_anon_tokens", tokenId),
		]);
		if (!anonymousAuthToken || anonymousAuthToken.userId !== user._id) {
			return null;
		}

		return {
			user,
			anagraphic,
			anonymousAuthToken,
		};
	},
});

/**
 * Return a user's app-owned profile document.
 *
 * You can also use this for the current logged-in profile in the UI by passing
 * the authenticated `userId` from `AppAuthProvider.useAuth()`.
 *
 * `email` comes back only when you ask for yourself.
 */
export const get_anagraphic = query({
	args: {
		userId: v.id("users"),
	},
	returns: v.union(doc(app_convex_schema, "users_anagraphics"), v.null()),
	handler: async (ctx, args) => {
		// Being logged in, anonymous included, is the only rule for reading a name and avatar. They are
		// shown next to file edits, snapshots and notifications, where the caller often shares no
		// organization with the person being named. We also do not check `deletedAt` here, unlike the
		// membership helper: an account waiting to be deleted still reads names everywhere else in the
		// app, and there is nothing sensitive to reach here.
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const user = await ctx.db.get("users", args.userId);
		if (!user || !user.anagraphic) {
			return null;
		}

		const anagraphic = await ctx.db.get("users_anagraphics", user.anagraphic);
		if (!anagraphic) {
			return null;
		}

		// Anyone who can call this query needs only a `users` id, and ids are not secret: a presence
		// list hands out a whole room of them at once. Without this, a caller could turn that list into
		// a list of email addresses. We send `""`, which is what anonymous users already have, so every
		// reader already handles an empty email.
		return user._id === userAuth.id ? anagraphic : { ...anagraphic, email: "" };
	},
});

/**
 * Return a workspace member's profile, including email.
 *
 * Use this on the Users page. `get_anagraphic` blanks email for anyone but the caller because its
 * only argument is a `users` id, and those ids are not secret. This query first proves that the
 * caller and the named user are both active members of the same workspace, so the address is only
 * shown to people who already share that workspace.
 */
export const get_workspace_member_anagraphic = query({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
	},
	returns: v.union(doc(app_convex_schema, "users_anagraphics"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const [currentWorkspaceMembership, targetWorkspaceMembership, user] = await Promise.all([
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", userAuth.id)
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId),
				)
				.first(),
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_active_user_organization_workspace", (q) =>
					q
						.eq("active", true)
						.eq("userId", args.userId)
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId),
				)
				.first(),
			ctx.db.get("users", args.userId),
		]);

		// Both memberships are required. Without the target's, a caller who is in the workspace could
		// still ask about any `users` id and read that person's email. Without the caller's, this would
		// be the same as widening `get_anagraphic`.
		if (!currentWorkspaceMembership || !targetWorkspaceMembership || !user?.anagraphic) {
			return null;
		}

		return await ctx.db.get("users_anagraphics", user.anagraphic);
	},
});

export const list_current_user_account_deletion_blocking_organizations = query({
	args: {},
	returns: users_v_account_deletion_blocking_organizations,
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) =>
			userAuth ? ctx.db.get("users", userAuth.id) : null,
		);
		if (!user || user.deletedAt) {
			throw convex_error({ message: "Unauthenticated" });
		}

		return await users_db_list_account_deletion_blocking_organizations(ctx, {
			userId: user._id,
		});
	},
});

export const list_account_deletion_blocking_organizations = internalQuery({
	args: {
		userId: v.id("users"),
	},
	returns: users_v_account_deletion_blocking_organizations,
	handler: async (ctx, args) => {
		return await users_db_list_account_deletion_blocking_organizations(ctx, args);
	},
});

async function action_mint_anonymous_jwt(ctx: ActionCtx) {
	const { userId, tokenId } = await ctx.runMutation(internal.users.create_anonymous_user);

	// Keep JWT signing in the action because Convex queries/mutations cannot use crypto randomness.
	const name = users_create_anonymouse_user_display_name(userId);
	const [refreshJwt, accessJwt] = await Promise.all([
		sign_anonymous_users_jwt({ kind: "refresh", subject: userId, tokenId, name }),
		sign_anonymous_users_jwt({ kind: "access", subject: userId, tokenId, name }),
	]);

	await ctx.runMutation(internal.users.set_anonymous_auth_token, {
		tokenId,
		token: refreshJwt,
	});

	return { accessJwt, refreshJwt, userId };
}

export const resolve_user = internalMutation({
	args: {
		clerkUserId: v.string(),
		email: v.string(),
		anonymousUserToken: v.optional(v.string()),
		displayName: v.string(),
	},
	returns: v_result({ _yay: v.object({ userId: v.id("users"), restoredDeletedAccount: v.boolean() }) }),
	handler: async (ctx, args) => {
		// Resolve Clerk sign-in in product-precedence order:
		// 1. Reuse the existing live Clerk-linked user.
		// 2. Reclaim a tombstoned signed-in user by verified email.
		// 3. Upgrade the anonymous user in place when the client sends an anonymous token.
		// 4. Create a brand new user only when every reuse path misses.
		const now = Date.now();
		const email = args.email.trim().toLowerCase();
		if (!email) {
			return Result({ _nay: { message: "Signed-in user email is required" } });
		}

		const existingUsersForClerk = await ctx.db
			.query("users")
			.withIndex("by_clerkUser", (q) => q.eq("clerkUserId", args.clerkUserId))
			.collect();
		const existingLiveUser = existingUsersForClerk.find((user) => user.deletedAt == null) ?? null;

		// Reuse the live Clerk-linked user before you attempt recovery or upgrade logic.
		if (existingLiveUser) {
			await Promise.all([
				db_upsert_anagraphic(ctx, {
					userId: existingLiveUser._id,
					anagraphicId: existingLiveUser.anagraphic,
					displayName: args.displayName,
					email,
					now,
				}),
				quotas_db_ensure(ctx, {
					quotaName: "extra_organizations",
					userId: existingLiveUser._id,
					now,
				}),
				organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
					userId: existingLiveUser._id,
					now,
				}),
			]);

			return Result({ _yay: { userId: existingLiveUser._id, restoredDeletedAccount: false } });
		}

		const anagraphicByEmail = await ctx.db
			.query("users_anagraphics")
			.withIndex("by_email", (q) => q.eq("email", email))
			.unique()
			.catch(() => "duplicate_email" as const);
		if (anagraphicByEmail === "duplicate_email") {
			return Result({ _nay: { message: "Email is already linked to another user" } });
		}

		const userByEmail = anagraphicByEmail ? await ctx.db.get("users", anagraphicByEmail.userId) : null;

		// Reclaim the deleted signed-in account before you process anonymous upgrade.
		// Keep this branch ahead of the anonymous-token path so a returning deleted user
		// wins over any temporary anonymous session created before sign-in.
		const deletedUser = userByEmail?.deletedAt != null ? userByEmail : null;
		if (userByEmail && !deletedUser) {
			return Result({ _nay: { message: "Email is already linked to another user" } });
		}

		if (deletedUser) {
			const [memberships, deletionRequests] = await Promise.all([
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_user_organization_workspace_active", (q) => q.eq("userId", deletedUser._id))
					.collect(),
				ctx.db
					.query("data_deletion_requests")
					.withIndex("by_user", (q) => q.eq("userId", deletedUser._id))
					.collect(),
			]);

			const reactivatedMemberships = memberships.filter((membership) => membership.active === false);

			await Promise.all([
				ctx.db.patch("users", deletedUser._id, {
					clerkUserId: args.clerkUserId,
					deletedAt: undefined,
				}),
				db_upsert_anagraphic(ctx, {
					userId: deletedUser._id,
					anagraphicId: deletedUser.anagraphic,
					displayName: args.displayName,
					email,
					now,
				}),
				quotas_db_ensure(ctx, {
					quotaName: "extra_organizations",
					userId: deletedUser._id,
					now,
				}),
				...reactivatedMemberships.map((membership) =>
					ctx.db.patch("organizations_workspaces_users", membership._id, {
						active: true,
						updatedAt: now,
					}),
				),
				...deletionRequests
					.filter((row) => row.scope === "user")
					.map((row) => ctx.db.delete("data_deletion_requests", row._id)),
			]);

			// A membership that comes back also needs its organization role back. The role assignment
			// normally survives account deletion, because `delete_role` lowers an inactive holder
			// instead of deleting them. But the old migration
			// `backfill_access_control_member_assignments` skipped inactive docs. So a membership that
			// was already waiting for deletion when that migration ran comes back with no role at all.
			// That user would be an active member with zero permissions: the file tree would load empty
			// instead of showing an error, and nobody could tell what is wrong. The helper keeps any role
			// that is still there, whatever it is.
			await Promise.all(
				reactivatedMemberships.map(async (membership) => {
					const organization = await ctx.db.get("organizations", membership.organizationId);
					if (!organization) {
						return;
					}

					await access_control_db_ensure_organization_member_role(ctx, {
						organization,
						workspaceId: membership.workspaceId,
						userId: deletedUser._id,
						now,
					});
				}),
			);

			await organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
				userId: deletedUser._id,
				now,
			});

			return Result({ _yay: { userId: deletedUser._id, restoredDeletedAccount: true } });
		}

		// Upgrade the anonymous user in place only after live-user reuse and deleted-account reclaim miss.
		if (args.anonymousUserToken) {
			let authFromToken: ReturnType<typeof users_get_user_id_from_jwt>;
			try {
				authFromToken = users_get_user_id_from_jwt(args.anonymousUserToken);
			} catch {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`" } });
			}

			const userId = ctx.db.normalizeId("users", authFromToken.userId);
			if (!userId) {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`" } });
			}

			const user = await ctx.db.get("users", userId);
			// Refuse a tombstoned anonymous source like a missing one: upgrading it would resurrect
			// an account that deletion already retired, the same gap the refresh route closes.
			if (!user || user.deletedAt != null) {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`" } });
			}

			const tokenId = authFromToken.tokenId ? ctx.db.normalizeId("users_anon_tokens", authFromToken.tokenId) : null;
			if (!tokenId || !user.anonymousAuthToken || user.anonymousAuthToken !== tokenId) {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`, cannot link to Clerk account" } });
			}

			const anonymousAuthTokenDoc = await ctx.db.get("users_anon_tokens", tokenId);
			if (
				!anonymousAuthTokenDoc ||
				anonymousAuthTokenDoc.userId !== user._id ||
				// Accept the previous token too, mirroring the refresh route: sign-in can race a
				// refresh-token rotation in another tab.
				(anonymousAuthTokenDoc.token !== args.anonymousUserToken &&
					anonymousAuthTokenDoc.previousToken !== args.anonymousUserToken)
			) {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`, cannot link to Clerk account" } });
			}

			// Upgrade anonymous user to canonical user
			if (!user.clerkUserId) {
				await Promise.all([
					// If a user already exists for this Clerk account (e.g. from a previous sign-in),
					// remove it so the anonymous user can become the canonical user record.
					ctx.db
						.query("users")
						.withIndex("by_clerkUser", (q) => q.eq("clerkUserId", args.clerkUserId))
						.collect()
						.then((existingClerkUsers) =>
							Promise.all(
								existingClerkUsers.map(async (existingUser) => {
									if (existingUser._id !== user._id && existingUser.deletedAt == null) {
										await Promise.all([
											existingUser.anagraphic ? ctx.db.delete("users_anagraphics", existingUser.anagraphic) : undefined,
											ctx.db.delete("users", existingUser._id),
										]);
									}
								}),
							),
						),

					ctx.db.patch("users", user._id, {
						clerkUserId: args.clerkUserId,
						anonymousAuthToken: undefined,
					}),

					anonymousAuthTokenDoc && ctx.db.delete("users_anon_tokens", anonymousAuthTokenDoc._id),

					db_upsert_anagraphic(ctx, {
						userId: user._id,
						anagraphicId: user.anagraphic,
						displayName: args.displayName,
						email,
						now,
					}),

					quotas_db_ensure(ctx, {
						quotaName: "extra_organizations",
						userId,
						now,
					}),

					organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
						userId,
						now,
					}),

					// Discard the anonymous billing snapshot; the signed-in Free
					// bootstrap will create a fresh Polar-backed snapshot.
					ctx.db
						.query("billing_usage_snapshots")
						.withIndex("by_user", (q) => q.eq("userId", user._id))
						.first()
						.then((usageSnapshot) =>
							usageSnapshot ? ctx.db.delete("billing_usage_snapshots", usageSnapshot._id) : undefined,
						),
				]);

				return Result({ _yay: { userId: user._id, restoredDeletedAccount: false } });
			}

			if (user.clerkUserId !== args.clerkUserId) {
				return Result({ _nay: { message: "User already linked to different Clerk account" } });
			}

			await Promise.all([
				db_upsert_anagraphic(ctx, {
					userId: user._id,
					anagraphicId: user.anagraphic,
					displayName: args.displayName,
					email,
					now,
				}),
				quotas_db_ensure(ctx, {
					quotaName: "extra_organizations",
					userId,
					now,
				}),
				organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
					userId,
					now,
				}),
			]);

			return Result({ _yay: { userId: user._id, restoredDeletedAccount: false } });
		}

		// Create a brand new signed-in user only when no existing live, deleted, or anonymous identity matches.
		const userId = await ctx.db.insert("users", {
			clerkUserId: args.clerkUserId,
		});

		await Promise.all([
			quotas_db_ensure(ctx, {
				quotaName: "extra_organizations",
				userId,
				now,
			}),
			db_upsert_anagraphic(ctx, {
				userId,
				anagraphicId: undefined,
				displayName: args.displayName,
				email,
				now,
			}),
			organizations_db_ensure_default_organization_and_workspace_for_user(ctx, {
				userId,
				now,
			}),
		]);

		return Result({ _yay: { userId, restoredDeletedAccount: false } });
	},
});

async function clerk_set_external_id(args: { clerkUserId: string; userId: string }) {
	return await server_fetch_json<unknown>({
		url: `https://api.clerk.com/v1/users/${args.clerkUserId}`,
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${CLERK_SECRET_KEY}`,
		},
		body: {
			external_id: args.userId,
		},
	});
}

async function delete_clerk_account(args: { clerkUserId: string }) {
	const clerkDeleteUserResult = await server_fetch_json<null>({
		url: `https://api.clerk.com/v1/users/${args.clerkUserId}`,
		method: "DELETE",
		headers: {
			Authorization: `Bearer ${CLERK_SECRET_KEY}`,
		},
	});
	if (clerkDeleteUserResult._nay && clerkDeleteUserResult._nay.data?.status !== 404) {
		return Result({
			_nay: {
				message: "Failed to delete Clerk user",
				cause: clerkDeleteUserResult._nay,
			},
		});
	}

	return Result({ _yay: null });
}

export const delete_current_user_account = action({
	args: {},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) =>
			userAuth
				? ctx.runQuery(internal.users.get, {
						userId: userAuth.id,
					})
				: null,
		);
		if (!user) {
			return Result({
				_nay: {
					message: "Unauthenticated",
				},
			});
		}

		if (user.deletedAt) {
			return Result({ _yay: null });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "account_delete", key: user._id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const blockingOrganizations: Users_AccountDeletionBlockingOrganization[] = await ctx.runQuery(
			internal.users.list_account_deletion_blocking_organizations,
			{
				userId: user._id,
			},
		);
		if (blockingOrganizations.length > 0) {
			return Result({
				_nay: {
					message: "Resolve owned organizations before deleting account",
				},
			});
		}

		const currentSubscription = await billing_polar.getCurrentSubscription(ctx, { userId: user._id });

		const requestId: Id<"data_deletion_requests"> | null = await ctx.runMutation(
			internal.data_deletion.init_user_deletion,
			{
				userId: user._id,
				nowTs: Date.now(),
			},
		);

		if (requestId === null) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		let shouldClearClerkUserId = false;

		if (user.clerkUserId) {
			const clerkDeleteUserResult = await delete_clerk_account({
				clerkUserId: user.clerkUserId,
			});
			if (clerkDeleteUserResult._nay) {
				console.error("Failed to clean up Clerk account after local deletion", {
					clerkDeleteUserResult,
					clerkUserId: user.clerkUserId,
					requestId,
					userId: user._id,
				});
			} else {
				shouldClearClerkUserId = true;
			}
		}

		if (currentSubscription) {
			await billing_action_schedule_polar_subscription_period_end_cancellation(ctx, {
				userId: user._id,
				subscriptionId: currentSubscription.id,
			}).catch((error) => {
				console.error("Failed to schedule Polar subscription period-end cancellation after local deletion", {
					error,
					requestId,
					subscriptionId: currentSubscription.id,
					userId: user._id,
				});
			});
		}

		if (shouldClearClerkUserId) {
			await ctx.runMutation(internal.users.clear_clerk_user_id_after_clerk_delete, {
				userId: user._id,
			});
		}

		return Result({ _yay: null });
	},
});

export async function users_http_get_jwks(_ctx: ActionCtx, _request: Request) {
	const publicXY = await get_anonymous_users_jwt_public_xy();
	const jwks = ANONYMOUS_USERS_JWT_KID_LIST.map((kid) => {
		return {
			kty: "EC",
			crv: "P-256",
			x: publicXY.x,
			y: publicXY.y,
			kid: kid,
			use: "sig",
			alg: "ES256",
		} as const;
	});
	return {
		status: 200,
		body: {
			keys: jwks,
		},
		headers: {
			"Cache-Control": "public, max-age=86400", // 1 day
		},
	} as const;
}

export type users_http_create_anonymous_Body = { refreshToken?: string };

export async function users_http_create_anonymous(ctx: ActionCtx, request: Request) {
	const body = (await request.json().catch(() => null)) as null | users_http_create_anonymous_Body;

	// Refresh path: validate the refresh JWT against the stored auth token doc, then mint a fresh
	// short-lived access JWT. The doc itself rotates only near its own expiry.
	if (body?.refreshToken) {
		let authFromToken: ReturnType<typeof users_get_user_id_from_jwt>;
		try {
			authFromToken = users_get_user_id_from_jwt(body.refreshToken);
		} catch {
			return { status: 401, body: { message: "Invalid token" } } as const;
		}
		if (!authFromToken.userId) {
			return { status: 400, body: { message: "Invalid token subject" } } as const;
		}

		// Load-bearing, not defense in depth: this route never verifies signatures, only
		// byte-equality with the stored auth token doc. Pre-split dual-role JWTs still byte-match
		// their doc, and only this audience check retires them (they carry aud "convex").
		if (!authFromToken.audiences.includes(ANONYMOUS_USERS_REFRESH_JWT_AUD)) {
			return { status: 401, body: { message: "Invalid token" } } as const;
		}

		const userWithAnagraphicAndAnonToken = await ctx.runQuery(
			internal.users.get_with_anagraphic_and_anonymous_auth_token,
			{
				userId: authFromToken.userId,
				tokenId: authFromToken.tokenId ?? "",
			},
		);
		if (
			!userWithAnagraphicAndAnonToken ||
			!authFromToken.tokenId ||
			!userWithAnagraphicAndAnonToken.user.anonymousAuthToken ||
			userWithAnagraphicAndAnonToken.anonymousAuthToken._id !==
				userWithAnagraphicAndAnonToken.user.anonymousAuthToken ||
			userWithAnagraphicAndAnonToken.anonymousAuthToken.userId !== userWithAnagraphicAndAnonToken.user._id ||
			// Accept the previous token too: a tab that read localStorage just before a
			// rotation converges here instead of losing the identity.
			(userWithAnagraphicAndAnonToken.anonymousAuthToken.token !== body.refreshToken &&
				userWithAnagraphicAndAnonToken.anonymousAuthToken.previousToken !== body.refreshToken)
		) {
			return { status: 401, body: { message: "Invalid token" } } as const;
		}

		// Charge validation against the read limiter, not the auth write limiter. Every
		// page load validates the cached token at least twice, and `auth_http` has
		// capacity 2. An ordinary reload therefore returned 429, and the client answered
		// that by minting a new anonymous user. The previous user's workspace became
		// unreachable.
		const readRateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "auth_http_refresh",
			key: userWithAnagraphicAndAnonToken.user._id,
		});
		if (readRateLimit) {
			return {
				status: 429,
				body: {
					message: readRateLimit.message,
					retryAfterMs: readRateLimit.retryAfterMs,
				},
			} as const;
		}

		const anonTokenRow = userWithAnagraphicAndAnonToken.anonymousAuthToken;
		const displayName =
			userWithAnagraphicAndAnonToken.anagraphic?.displayName ??
			users_create_anonymouse_user_display_name(userWithAnagraphicAndAnonToken.user._id);

		// Every refresh call mints a fresh access JWT. Pure signing, no database write, so
		// the hourly client refresh stays on the read limiter.
		const accessJwt = await sign_anonymous_users_jwt({
			kind: "access",
			subject: userWithAnagraphicAndAnonToken.user._id,
			tokenId: anonTokenRow._id,
			name: displayName,
		});

		// The stored refresh JWT rotates only when the presented current token is close to
		// its expiry. A previous-token match never rotates; the doc already holds a newer
		// token and the client just needs it back.
		let refreshTokenForClient = anonTokenRow.token;
		const presentedIsCurrent = anonTokenRow.token === body.refreshToken;
		const farFromExpiry =
			authFromToken.expiresAt && authFromToken.expiresAt > Date.now() + ANONYMOUS_USERS_JWT_REFRESH_THRESHOLD_MS;
		if (presentedIsCurrent && !farFromExpiry) {
			// Rotation writes, so it also spends the stricter auth limiter.
			const rateLimit = await rate_limiter_limit_by_key(ctx, {
				name: "auth_http",
				key: userWithAnagraphicAndAnonToken.user._id,
			});
			if (rateLimit) {
				return {
					status: 429,
					body: {
						message: rateLimit.message,
						retryAfterMs: rateLimit.retryAfterMs,
					},
				} as const;
			}

			const newRefreshJwt = await sign_anonymous_users_jwt({
				kind: "refresh",
				subject: userWithAnagraphicAndAnonToken.user._id,
				tokenId: anonTokenRow._id,
				name: displayName,
			});

			// Compare-and-swap: if another tab rotated first, this returns the winner's
			// token and the client converges on it.
			refreshTokenForClient = (await ctx.runMutation(internal.users.set_anonymous_auth_token, {
				tokenId: anonTokenRow._id,
				token: newRefreshJwt,
				expectedCurrentToken: anonTokenRow.token,
			})) as set_anonymous_auth_token_Result;
		}

		return {
			status: 200,
			body: {
				token: accessJwt,
				refreshToken: refreshTokenForClient,
				userId: userWithAnagraphicAndAnonToken.user._id,
			},
		} as const;
	}

	// Create path: no refresh token provided, create new anonymous user
	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "auth_http",
		key: rate_limiter_http_client_key(request),
	});
	if (rateLimit) {
		return {
			status: 429,
			body: {
				message: rateLimit.message,
				retryAfterMs: rateLimit.retryAfterMs,
			},
		} as const;
	}

	const { accessJwt, refreshJwt, userId } = await action_mint_anonymous_jwt(ctx);
	return {
		status: 200,
		body: {
			token: accessJwt,
			refreshToken: refreshJwt,
			userId: userId,
		},
	} as const;
}

export type users_http_resolve_user_Body = { anonymousUserToken?: string };

export async function users_http_resolve_user(ctx: ActionCtx, request: Request) {
	const body = (await request.json().catch(() => null)) as null | users_http_resolve_user_Body;

	const identity = await ctx.auth.getUserIdentity().catch(() => null);
	if (!identity) {
		return {
			status: 401,
			body: Result({ _nay: { message: "Unauthorized" } }),
		} as const;
	}

	const clerkUserId = identity.subject;

	// Let already-linked Clerk tokens take the read-only fast path so repeated signed-in
	// bootstraps do not consume the auth write limiter. Only usable accounts can
	// short-circuit: a tombstoned user or one missing its default tenant pointers
	// (first sign-in after a data wipe) must fall through to `resolve_user` so
	// default-tenant and billing-bootstrap repair runs.
	if (identity.external_id) {
		const user = await ctx.runQuery(internal.users.get, {
			userId: identity.external_id,
		});
		if (user && user.deletedAt == null && user.defaultOrganizationId && user.defaultWorkspaceId) {
			return {
				status: 200,
				body: Result({ _yay: { userId: user._id, restoredDeletedAccount: false } }),
			} as const;
		}
	}

	const rateLimit = await rate_limiter_limit_by_key(ctx, {
		name: "auth_http",
		key: identity.external_id ?? clerkUserId,
	});
	if (rateLimit) {
		return {
			status: 429,
			body: {
				message: rateLimit.message,
				retryAfterMs: rateLimit.retryAfterMs,
			},
		} as const;
	}

	const displayName = identity.name || identity.nickname || users_create_fallback_display_name(clerkUserId);
	const resolveUserResult = await ctx.runMutation(internal.users.resolve_user, {
		clerkUserId: clerkUserId,
		email: identity.email ?? "",
		anonymousUserToken: body?.anonymousUserToken,
		displayName,
	});

	if (resolveUserResult._nay) {
		return {
			status: users_resolve_user_is_bad_request_message(resolveUserResult._nay.message) ? 400 : 401,
			body: resolveUserResult,
		} as const;
	}

	// Ensure Clerk has external_id set to the Convex user id.
	const clerk_set_external_id_result = await clerk_set_external_id({
		clerkUserId,
		userId: resolveUserResult._yay.userId,
	});
	if (clerk_set_external_id_result._nay) {
		const errorMessage = "Failed to set Clerk external_id";
		console.error(errorMessage, {
			clerkSetExternalIdResult: clerk_set_external_id_result,
			clerkUserId,
			userId: resolveUserResult._yay.userId,
		});
		return {
			status: 401,
			body: Result({ _nay: { message: errorMessage } }),
		} as const;
	}

	if (!identity.email) {
		console.error("Missing Clerk email for billing bootstrap", {
			clerkUserId,
			userId: resolveUserResult._yay.userId,
		});
		return {
			status: 200,
			body: resolveUserResult,
		} as const;
	}

	await billing_action_enqueue_free_subscription_bootstrap(ctx, {
		userId: resolveUserResult._yay.userId,
		email: identity.email,
		name: displayName,
		...(resolveUserResult._yay.restoredDeletedAccount ? { restoreCanceledSubscription: true } : {}),
	}).catch((error) => {
		console.error("Failed to enqueue Free subscription bootstrap", {
			error,
			clerkUserId,
			userId: resolveUserResult._yay.userId,
		});
	});

	return {
		status: 200,
		body: resolveUserResult,
	} as const;
}

// Override default convex auth types
declare module "convex/server" {
	interface UserIdentity {
		/**
		 * Official Clerk JWT claim, not directly supported by convex.
		 *
		 * We use this to store the Convex user id for Clerk users.
		 */
		external_id?: Id<"users">;
	}
}

// #region admin
export const purge_deleted_user_tombstone = internalMutation({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user) {
			return null;
		}

		if (user.deletedAt == null) {
			throw convex_error({ message: "Cannot purge tombstone for a non-deleted user" });
		}

		if (user.anagraphic) {
			await ctx.db.delete("users_anagraphics", user.anagraphic);
		}

		await ctx.db.delete("users", args.userId);

		return null;
	},
});

/**
 * Admin reset or hard delete for one user.
 *
 * One successful call owns its bounded user-local continuations. Auth-removing modes tombstone
 * before calling providers, then hand any tenant requests to the existing deletion Workpool.
 * Retry the same user and mode only when an external provider makes this action fail.
 */
export const hard_delete_user_now = internalAction({
	args: {
		userId: v.id("users"),
		purgeUserMod: v.optional(
			v.union(v.literal("data"), v.literal("data_and_auth"), v.literal("data_auth_and_user_record")),
		),
		_test_batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const user = await ctx.runQuery(internal.users.get, {
			userId: args.userId,
		});
		if (!user) {
			return null;
		}

		const purgeUserMod = args.purgeUserMod ?? "data";
		if (purgeUserMod === "data") {
			// Treat data mode as a live account reset; keep it out of the account-deletion billing/auth cleanup below.
			for (let step = 0; step < 25; step += 1) {
				const result = await ctx.runMutation(internal.data_deletion.hard_delete_user_data, {
					userId: user._id,
					_test_batchSize: args._test_batchSize,
				});
				if (result.done) {
					return null;
				}
			}
			if (!args._test_disableReschedule) {
				// Continue the same user and mode. Reset readback must finish before plugin reseeding starts.
				await ctx.scheduler.runAfter(0, internal.users.hard_delete_user_now, {
					userId: user._id,
					purgeUserMod: "data",
				});
			}
			return null;
		}

		const currentSubscription = await billing_polar.getCurrentSubscription(ctx, { userId: user._id });
		const purgeUserRecord = purgeUserMod === "data_auth_and_user_record";

		let prepared = false;
		for (let step = 0; step < 25; step += 1) {
			prepared = await ctx.runMutation(internal.data_deletion.prepare_user_for_hard_deletion, {
				userId: user._id,
				_test_batchSize: args._test_batchSize,
			});
			if (prepared) {
				break;
			}
		}
		if (!prepared) {
			if (!args._test_disableReschedule) {
				await ctx.scheduler.runAfter(0, internal.users.hard_delete_user_now, {
					userId: user._id,
					purgeUserMod,
				});
			}
			return null;
		}

		if (purgeUserRecord && currentSubscription) {
			const revokeSubscriptionResult = await billing_action_revoke_polar_subscription({
				subscriptionId: currentSubscription.id,
			});
			if (revokeSubscriptionResult._nay) {
				// Provider SDK errors are not Convex values and must not cross this action boundary.
				throw convex_error({
					message: "Failed to revoke Polar subscription",
				});
			}
		}

		if (purgeUserRecord) {
			const deletePolarCustomerResult = await billing_action_delete_polar_customer_by_user_id(ctx, {
				userId: user._id,
			});
			if (deletePolarCustomerResult._nay) {
				// Keep the provider SDK error out of the serializable public error payload.
				throw convex_error({
					message: "Failed to delete Polar customer",
				});
			}
		}

		if (purgeUserRecord) {
			// Keep the scheduled cancellation until every Polar delete succeeds. It remains
			// the retry safety net when revoke or customer deletion fails partway through.
			await billing_action_cancel_scheduled_polar_subscription_period_end_cancellation(ctx, {
				userId: user._id,
			});
		}

		if (!purgeUserRecord && currentSubscription) {
			await billing_action_schedule_polar_subscription_period_end_cancellation(ctx, {
				userId: user._id,
				subscriptionId: currentSubscription.id,
			});
		}

		if (user.clerkUserId) {
			const clerkDeleteUserResult = await delete_clerk_account({
				clerkUserId: user.clerkUserId,
			});
			if (clerkDeleteUserResult._nay) {
				throw convex_error({
					message: "Failed to delete Clerk user",
					cause: clerkDeleteUserResult._nay,
				});
			}
		}

		await ctx.runMutation(internal.data_deletion.finalize_user_deletion_data, {
			userId: user._id,
			deleteUserAuth: true,
			deleteBillingState: purgeUserRecord,
		});
		const hasDeletionRequests = await ctx.runQuery(internal.data_deletion.has_deletion_requests_for_user, {
			userId: user._id,
		});
		if (hasDeletionRequests && !args._test_disableReschedule) {
			// The Workpool is the only owner once tenant cleanup has been queued.
			await ctx.runAction(internal.data_deletion.enqueue_deletion_requests_processing, {});
		}

		if (purgeUserRecord) {
			await ctx.runMutation(internal.users.purge_deleted_user_tombstone, {
				userId: args.userId,
			});
		}

		return null;
	},
});
// #endregion
