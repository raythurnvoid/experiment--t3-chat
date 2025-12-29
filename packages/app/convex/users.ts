import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";
import { exportJWK, importPKCS8, importSPKI, SignJWT } from "jose";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { type ActionCtx } from "./_generated/server.js";
import { type RouteSpec } from "convex/server";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { RouterForConvexModules } from "./http.ts";
import app_convex_schema from "./schema.ts";
import { doc } from "convex-helpers/validators";
import { users_get_user_id_from_jwt } from "../shared/users.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import type { Id } from "./_generated/dataModel";

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

async function sign_anonymous_users_jwt(args: { subject: string; name: string; picture: string }) {
	const key = await get_anonymous_users_jwt_private_key();

	return await new SignJWT({
		name: args.name,
		picture: args.picture,
	})
		.setProtectedHeader({ alg: "ES256", kid: ANONYMOUS_USERS_JWT_KID_LIST[0], typ: "JWT" })
		.setIssuer(ANONYMOUS_USERS_JWT_ISSUER)
		.setAudience("convex")
		.setSubject(args.subject)
		.setIssuedAt()
		.setExpirationTime("30d")
		.sign(key);
}

export const users_create_anonymous_user = internalMutation({
	args: {
		uuid: v.string(),
	},
	returns: v.id("users"),
	handler: async (ctx, args) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId: null,
			anonymousAuthToken: null,
			displayName: `anonymous_${args.uuid}`,
		});
		return userId;
	},
});

export const users_set_anonymous_auth_token = internalMutation({
	args: {
		userId: v.id("users"),
		token: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.userId, {
			anonymousAuthToken: args.token,
		});
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
		return await ctx.db.get(userId);
	},
});

async function users_mint_anonymous_jwt(ctx: ActionCtx) {
	const uuid = crypto.randomUUID();

	const userId = await ctx.runMutation(internal.users.users_create_anonymous_user, {
		uuid,
	});

	const jwt = await sign_anonymous_users_jwt({
		subject: userId,
		name: `Anonymous ${uuid.slice(0, 8)}`,
		picture: "https://via.placeholder.com/32",
	});

	await ctx.runMutation(internal.users.users_set_anonymous_auth_token, {
		userId,
		token: jwt,
	});

	return { jwt, userId };
}

export const users_upsert_clerk_user = internalMutation({
	args: {
		clerkUserId: v.string(),
		displayName: v.optional(v.string()),
	},
	returns: v.id("users"),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("users")
			.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
			.take(2);

		if (existing.length > 0) {
			const user = existing[0]!;
			if (args.displayName && !user.displayName) {
				await ctx.db.patch(user._id, { displayName: args.displayName });
			}
			return user._id;
		}

		const displayName = args.displayName ?? "";
		const userId = await ctx.db.insert("users", {
			clerkUserId: args.clerkUserId,
			anonymousAuthToken: null,
			displayName: displayName,
		});

		if (!displayName) {
			await ctx.db.patch(userId, { displayName: `User ${userId}` });
		}

		return userId;
	},
});

export const resolve_user = internalMutation({
	args: {
		clerkUserId: v.string(),
		anonymousUserToken: v.optional(v.string()),
		displayName: v.string(),
	},
	returns: v.union(
		v.object({ _yay: v.object({ userId: v.id("users") }) }),
		v.object({ _nay: v.object({ message: v.string() }) }),
	),
	handler: async (ctx, args) => {
		let resultUserId: Id<"users"> | undefined;

		// Case 1: Token provided - link anonymous user to Clerk
		if (args.anonymousUserToken) {
			let userIdFromToken: string;
			try {
				userIdFromToken = users_get_user_id_from_jwt(args.anonymousUserToken);
			} catch {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`" } });
			}

			const userId = ctx.db.normalizeId("users", userIdFromToken);
			if (!userId) {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`" } });
			}

			const user = await ctx.db.get(userId);
			if (!user) {
				return Result({ _nay: { message: "Invalid `anonymousUserToken`" } });
			}

			if (!user.clerkUserId) {
				// If a user already exists for this Clerk account (e.g. from a previous sign-in),
				// remove it so the anonymous user can become the canonical user record.
				const existingClerkUsers = await ctx.db
					.query("users")
					.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
					.collect();
				for (const existingUser of existingClerkUsers) {
					if (existingUser._id !== user._id) {
						await ctx.db.delete(existingUser._id);
					}
				}

				if (user.anonymousAuthToken !== args.anonymousUserToken) {
					return Result({ _nay: { message: "Invalid `anonymousUserToken`, cannot link to Clerk account" } });
				}

				await ctx.db.patch(user._id, {
					clerkUserId: args.clerkUserId,
					anonymousAuthToken: null,
					displayName: args.displayName,
				});
			}
			// The user is already linked to another Clerk account, this should never happen
			else if (user.clerkUserId !== args.clerkUserId) {
				return Result({ _nay: { message: "User already linked to different Clerk account" } });
			}

			resultUserId = user._id;
		} else {
			const user = await ctx.db
				.query("users")
				.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId))
				.first();

			if (user) {
				resultUserId = user._id;
			}
			// Create new user for this Clerk account if none exists
			else {
				const userId = await ctx.db.insert("users", {
					clerkUserId: args.clerkUserId,
					anonymousAuthToken: null,
					displayName: args.displayName,
				});

				resultUserId = userId;
			}
		}

		return Result({ _yay: { userId: resultUserId } });
	},
});

async function clerk_set_external_id(args: { clerkUserId: string; userId: string }) {
	const response = await fetch(`https://api.clerk.com/v1/users/${args.clerkUserId}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${CLERK_SECRET_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			external_id: args.userId,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Failed to set Clerk external_id (${response.status}): ${text}`);
	}
}

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

							// Refresh path: if token is provided, extract user ID and re-issue for same user
							if (body?.token) {
								const sub = users_get_user_id_from_jwt(body.token);
								if (!sub) {
									return { status: 400, body: { message: "Invalid token subject" } } as const;
								}

								const user = await ctx.runQuery(internal.users.get, {
									userId: sub,
								});
								if (!user || user.anonymousAuthToken !== body.token) {
									return { status: 401, body: { message: "Invalid token" } } as const;
								}

								const newJwt = await sign_anonymous_users_jwt({
									subject: user._id,
									name: user.displayName,
									picture: "https://via.placeholder.com/32",
								});

								await ctx.runMutation(internal.users.users_set_anonymous_auth_token, {
									userId: user._id,
									token: newJwt,
								});

								return { status: 200, body: { token: newJwt, userId: user._id } } as const;
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
							const userId = identity.external_id as Id<"users"> | undefined;

							// TODO: we should call resolve_user to recreate the new user if it got deleted from the DB
							if (userId) {
								return {
									status: 200,
									body: Result({ _yay: { userId: userId } }),
								} as const;
							}

							const resolveUserResult = await ctx.runMutation(internal.users.resolve_user, {
								clerkUserId: clerkUserId,
								anonymousUserToken: body?.anonymousUserToken,
								displayName: identity.name || identity.nickname || `User ${clerkUserId}`,
							});

							if (resolveUserResult._nay) {
								return {
									status: 401,
									body: resolveUserResult,
								} as const;
							}

							// Ensure Clerk has external_id set to the Convex user id.
							try {
								await clerk_set_external_id({ clerkUserId, userId: resolveUserResult._yay.userId });
							} catch (error) {
								const message = "Failed to set Clerk external_id";
								console.error(`AppAuthProvider: ${message} Failed to set Clerk external_id`, error);
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
