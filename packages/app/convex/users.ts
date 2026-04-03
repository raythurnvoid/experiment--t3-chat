import {
	action,
	httpAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
	type ActionCtx,
} from "./_generated/server.js";
import { v } from "convex/values";
import { exportJWK, importPKCS8, importSPKI, SignJWT } from "jose";
import { internal } from "./_generated/api.js";
import { type RouteSpec } from "convex/server";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { RouterForConvexModules } from "./http.ts";
import app_convex_schema from "./schema.ts";
import { doc } from "convex-helpers/validators";
import {
	users_get_user_id_from_jwt,
	users_create_anonymouse_user_display_name,
	users_create_fallback_display_name,
} from "../shared/users.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { user_limits } from "../shared/limits.ts";
import type { Id } from "./_generated/dataModel";
import { v_result } from "../server/convex-utils.ts";
import { server_fetch_json } from "../server/server-fetch.ts";
import { workspaces_db_ensure_default_workspace_and_project_for_user } from "../server/workspaces.ts";

if (!process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM) {
	throw new Error("ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM is not set in Convex env");
}

/** Private key for signing anonymous users JWT */
const ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM = process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM;

if (!process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM) {
	throw new Error("ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM is not set in Convex env");
}

/** Public key (SPKI) for verifying anonymous users JWT */
const ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM = process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM;

if (!process.env.VITE_CONVEX_HTTP_URL) {
	throw new Error("VITE_CONVEX_HTTP_URL is not set in Convex env");
}

/** Issuer of the anonymous users JWT */
const ANONYMOUS_USERS_JWT_ISSUER = process.env.VITE_CONVEX_HTTP_URL;

if (!process.env.CLERK_SECRET_KEY) {
	throw new Error("CLERK_SECRET_KEY is not set in Convex env");
}

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

/**
 * List of kids for the anonymous users JWT.
 *
 * The first kid is the default kid (most recent).
 **/
const ANONYMOUS_USERS_JWT_KID_LIST = ["anonymous-user-jwt-2025-12"];

/**
 * Refresh tokens that are 7 days away from expiry.
 */
const ANONYMOUS_USERS_JWT_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns the public JWK `x` and `y` coordinates for the configured PEM key.
 */
const get_anonymous_users_jwt_public_xy = ((/* iife */) => {
	async function value() {
		const publicKey = await importSPKI(ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM, "ES256");
		const jwk = await exportJWK(publicKey);

		if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
			throw new Error("ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM is not an ES256 P-256 public key");
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
		.setAudience("convex")
		.setSubject(args.subject)
		.setJti(args.tokenId)
		.setIssuedAt()
		.setExpirationTime("30d")
		.sign(key);
}

export const users_create_anonymous_user = internalMutation({
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

		await ctx.db.insert("limits_per_user", {
			userId,
			limitName: user_limits.EXTRA_WORKSPACES.name,
			usedCount: 0,
			maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
			createdAt: now,
			updatedAt: now,
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
				})
				.then(async (anagraphicId) => {
					await ctx.db.patch("users", userId, {
						anagraphic: anagraphicId,
					});

					return anagraphicId;
				}),

			workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
				userId,
				now,
			}),
		]);

		return {
			userId,
			tokenId,
		};
	},
});

export const users_set_anonymous_auth_token = internalMutation({
	args: {
		tokenId: v.id("users_anon_tokens"),
		token: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch("users_anon_tokens", args.tokenId, {
			token: args.token,
			updatedAt: Date.now(),
		});

		return null;
	},
});

export const users_clear_anonymous_auth_token = internalMutation({
	args: {
		userId: v.id("users"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user) {
			return null;
		}

		await Promise.all([
			ctx.db
				.query("users_anon_tokens")
				.withIndex("by_userId", (q) => q.eq("userId", args.userId))
				.first()
				.then((anonymousAuthToken) =>
					anonymousAuthToken ? ctx.db.delete("users_anon_tokens", anonymousAuthToken._id) : undefined,
				),
			ctx.db.patch("users", args.userId, {
				anonymousAuthToken: undefined,
			}),
		]);

		return null;
	},
});

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
		if (!user || !user.anonymousAuthToken || user.anonymousAuthToken !== tokenId) {
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
 */
export const get_anagraphic = query({
	args: {
		userId: v.id("users"),
	},
	returns: v.union(doc(app_convex_schema, "users_anagraphics"), v.null()),
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.userId);
		if (!user || !user.anagraphic) {
			return null;
		}

		return await ctx.db.get("users_anagraphics", user.anagraphic);
	},
});

async function users_mint_anonymous_jwt(ctx: ActionCtx) {
	const { userId, tokenId } = await ctx.runMutation(internal.users.users_create_anonymous_user);

	// Keep JWT signing in the action because Convex queries/mutations cannot use crypto randomness.
	const jwt = await sign_anonymous_users_jwt({
		subject: userId,
		tokenId,
		name: users_create_anonymouse_user_display_name(userId),
	});

	await ctx.runMutation(internal.users.users_set_anonymous_auth_token, {
		tokenId,
		token: jwt,
	});

	return { jwt, userId };
}

export const resolve_user = internalMutation({
	args: {
		clerkUserId: v.string(),
		anonymousUserToken: v.optional(v.string()),
		displayName: v.string(),
	},
	returns: v_result({ _yay: v.object({ userId: v.id("users") }) }),
	handler: async (ctx, args) => {
		let resultUserId: Id<"users"> | undefined;

		const now = Date.now();

		// Case 1: Token provided - link anonymous user to Clerk
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
			if (!user) {
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
				anonymousAuthTokenDoc.token !== args.anonymousUserToken
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
						.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
						.collect()
						.then((existingClerkUsers) =>
							Promise.all(
								existingClerkUsers.map(async (existingUser) => {
									if (existingUser._id !== user._id) {
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

					Promise.try(async () => {
						if (user.anagraphic) {
							await ctx.db.patch("users_anagraphics", user.anagraphic, {
								displayName: args.displayName,
								updatedAt: now,
							});
						} else {
							const anagraphicId = await ctx.db.insert("users_anagraphics", {
								userId: user._id,
								displayName: args.displayName,
								updatedAt: now,
							});
							await ctx.db.patch("users", user._id, { anagraphic: anagraphicId });
						}
					}),

					workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
						userId,
						now,
					}),
				]);
			} else {
				// The user is already linked to another Clerk account, this should never happen
				if (user.clerkUserId !== args.clerkUserId) {
					return Result({ _nay: { message: "User already linked to different Clerk account" } });
				}

				await workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
					userId,
					now,
				});
			}

			resultUserId = user._id;
		}
		// Case 2: No token provided - create new user
		else {
			const user = await ctx.db
				.query("users")
				.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
				.first();

			// If we realize that the user already exists, we can use the existing user
			// but this should never happen.
			if (user) {
				resultUserId = user._id;
			}
			// Create new user for this Clerk account if none exists
			else {
				const userId = await ctx.db.insert("users", {
					clerkUserId: args.clerkUserId,
				});

				await Promise.all([
					ctx.db.insert("limits_per_user", {
						userId,
						limitName: user_limits.EXTRA_WORKSPACES.name,
						usedCount: 0,
						maxCount: user_limits.EXTRA_WORKSPACES.maxCount,
						createdAt: now,
						updatedAt: now,
					}),
					ctx.db
						.insert("users_anagraphics", {
							userId: userId,
							displayName: args.displayName,
							updatedAt: Date.now(),
						})
						.then((anagraphicId) =>
							ctx.db.patch("users", userId, { anagraphic: anagraphicId }).then(() => anagraphicId),
						),
					workspaces_db_ensure_default_workspace_and_project_for_user(ctx, {
						userId,
						now,
					}),
				]);

				resultUserId = userId;
			}
		}

		return Result({ _yay: { userId: resultUserId } });
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

async function clerk_delete_user(args: { clerkUserId: string }) {
	return await server_fetch_json<null>({
		url: `https://api.clerk.com/v1/users/${args.clerkUserId}`,
		method: "DELETE",
		headers: {
			Authorization: `Bearer ${CLERK_SECRET_KEY}`,
		},
	});
}

export const sync_current_user_profile_mirror = mutation({
	args: {
		displayName: v.string(),
		avatarUrl: v.union(v.string(), v.null()),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity?.external_id) {
			return Result({
				_nay: {
					message: "Unauthorized",
				},
			});
		}

		const user = await ctx.runQuery(internal.users.get, {
			userId: identity.external_id,
		});
		if (!user) {
			return Result({
				_nay: {
					message: "Unauthorized",
				},
			});
		}

		const now = Date.now();
		if (user.anagraphic) {
			await ctx.db.patch("users_anagraphics", user.anagraphic, {
				displayName: args.displayName,
				avatarUrl: args.avatarUrl ?? undefined,
				updatedAt: now,
			});
		} else {
			const anagraphicId = await ctx.db.insert("users_anagraphics", {
				userId: user._id,
				displayName: args.displayName,
				avatarUrl: args.avatarUrl ?? undefined,
				updatedAt: now,
			});

			await ctx.db.patch("users", user._id, {
				anagraphic: anagraphicId,
			});
		}

		return Result({ _yay: null });
	},
});

export const delete_current_user_account = action({
	args: {},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity?.external_id) {
			return Result({
				_nay: {
					message: "Unauthorized",
				},
			});
		}

		const user = await ctx.runQuery(internal.users.get, {
			userId: identity.external_id,
		});
		if (!user || user.deletedAt) {
			return Result({ _yay: null });
		}

		const requestResult = await ctx.runMutation(internal.account_deletion.enqueue_user_deletion_request, {
			clerkUserId: identity.subject,
			userId: identity.external_id,
			nowTs: Date.now(),
		});

		try {
			if (!requestResult.alreadyCompleted) {
				await ctx.runMutation(internal.account_deletion.process_user_deletion_request, {
					requestId: requestResult.requestId,
					nowTs: Date.now(),
				});
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Failed to delete account";

			console.error("[users.delete_current_user_account] Failed to delete current user account", {
				error,
				clerkUserId: identity.subject,
				requestId: requestResult.requestId,
			});

			await ctx.runMutation(internal.account_deletion.mark_user_deletion_request_failed, {
				requestId: requestResult.requestId,
				errorMessage,
				nowTs: Date.now(),
			});

			return Result({
				_nay: {
					message: errorMessage,
				},
			});
		}

		const clerkDeleteUserResult = await clerk_delete_user({
			clerkUserId: identity.subject,
		});

		if (clerkDeleteUserResult._nay && clerkDeleteUserResult._nay.data?.status !== 404) {
			await ctx.runMutation(internal.account_deletion.mark_user_deletion_request_failed, {
				requestId: requestResult.requestId,
				errorMessage: "Failed to clean up Clerk account after local deletion",
				nowTs: Date.now(),
			});

			console.error("[users.delete_current_user_account] Failed to clean up Clerk account after local deletion", {
				clerkDeleteUserResult,
				clerkUserId: identity.subject,
				requestId: requestResult.requestId,
			});
		}

		return Result({ _yay: null });
	},
});

export function users_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/.well-known/jwks.json" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "GET" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = never;

						const handler = async (_ctx: ActionCtx, _request: Request) => {
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

		...((/* iife */ path = "/api/auth/anonymous" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = { token?: string };

						const handler = async (ctx: ActionCtx, request: Request) => {
							const body = (await request.json().catch(() => null)) as null | Body;

							// Refresh path: if token is provided, only re-issue when it is close to expiry.
							if (body?.token) {
								const authFromToken = users_get_user_id_from_jwt(body.token);
								if (!authFromToken.userId) {
									return { status: 400, body: { message: "Invalid token subject" } } as const;
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
									userWithAnagraphicAndAnonToken.anonymousAuthToken.userId !==
										userWithAnagraphicAndAnonToken.user._id ||
									userWithAnagraphicAndAnonToken.anonymousAuthToken.token !== body.token
								) {
									return { status: 401, body: { message: "Invalid token" } } as const;
								}

								if (
									authFromToken.expiresAt &&
									authFromToken.expiresAt > Date.now() + ANONYMOUS_USERS_JWT_REFRESH_THRESHOLD_MS
								) {
									return {
										status: 200,
										body: { token: body.token, userId: userWithAnagraphicAndAnonToken.user._id },
									} as const;
								}

								const newJwt = await sign_anonymous_users_jwt({
									subject: userWithAnagraphicAndAnonToken.user._id,
									tokenId: userWithAnagraphicAndAnonToken.anonymousAuthToken._id,
									name:
										userWithAnagraphicAndAnonToken.anagraphic?.displayName ??
										users_create_anonymouse_user_display_name(userWithAnagraphicAndAnonToken.user._id),
								});

								await ctx.runMutation(internal.users.users_set_anonymous_auth_token, {
									tokenId: userWithAnagraphicAndAnonToken.anonymousAuthToken._id,
									token: newJwt,
								});

								return {
									status: 200,
									body: { token: newJwt, userId: userWithAnagraphicAndAnonToken.user._id },
								} as const;
							}

							// Create path: no token provided, create new anonymous user
							const { jwt, userId } = await users_mint_anonymous_jwt(ctx);
							return {
								status: 200,
								body: {
									token: jwt,
									userId: userId,
								},
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

		...((/* iife */ path = "/api/auth/resolve-user" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = { anonymousUserToken?: string };

						const handler = async (ctx: ActionCtx, request: Request) => {
							const body = (await request.json().catch(() => null)) as null | Body;

							const identity = await ctx.auth.getUserIdentity();
							if (!identity) {
								return {
									status: 401,
									body: Result({ _nay: { message: "Unauthorized: Clerk authentication required" } }),
								} as const;
							}

							const clerkUserId = identity.subject;
							if (identity.external_id) {
								const user = await ctx.runQuery(internal.users.get, {
									userId: identity.external_id,
								});
								if (user) {
									return {
										status: 200,
										body: Result({ _yay: { userId: user._id } }),
									} as const;
								}
							}

							const resolveUserResult = await ctx.runMutation(internal.users.resolve_user, {
								clerkUserId: clerkUserId,
								anonymousUserToken: body?.anonymousUserToken,
								displayName: identity.name || identity.nickname || users_create_fallback_display_name(clerkUserId),
							});

							if (resolveUserResult._nay) {
								return {
									status: 401,
									body: resolveUserResult,
								} as const;
							}

							// Ensure Clerk has external_id set to the Convex user id.
							const clerk_set_external_id_result = await clerk_set_external_id({
								clerkUserId,
								userId: resolveUserResult._yay.userId,
							});
							if (clerk_set_external_id_result._nay) {
								const message = "Failed to set Clerk external_id";
								console.error("[users.users_http_routes] Failed to set Clerk external_id", {
									clerkSetExternalIdResult: clerk_set_external_id_result,
									clerkUserId,
									userId: resolveUserResult._yay.userId,
								});
								return {
									status: 401,
									body: Result({ _nay: { message } }),
								} as const;
							}

							return {
								status: 200,
								body: resolveUserResult,
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
