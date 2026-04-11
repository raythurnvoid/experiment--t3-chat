import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { Result, Result_try_promise } from "../shared/errors-as-values-utils.ts";
import type z from "zod";
import type { Id } from "../convex/_generated/dataModel";
import { users_create_anonymouse_user_display_name, users_create_fallback_display_name } from "../shared/users.ts";
import { path_extract_segments_from } from "../shared/shared-utils.ts";

export * from "../shared/shared-utils.ts";

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS!;
if (!ALLOWED_ORIGINS) {
	throw new Error("`ALLOWED_ORIGINS` env var is not set");
}

type ConvexCtx = GenericMutationCtx<any> | GenericQueryCtx<any> | GenericActionCtx<any>;

export const allowed_origins = ((/* iife */) => {
	function value() {
		const allowedOrigins: string[] = [];

		for (const part of ALLOWED_ORIGINS.split(",")) {
			try {
				allowedOrigins.push(new URL(part).origin);
			} catch {}
		}

		return allowedOrigins;
	}

	let cache: ReturnType<typeof value> | undefined;

	return function allowed_origins() {
		return (cache ??= value());
	};
})();

/**
 * Resolve the current auth state from `ctx.auth.getUserIdentity()`.
 *
 * - Return `null` when Convex reports no identity or when `getUserIdentity()` throws in an HTTP action.
 * - Return `kind: "anonymous"` for authenticated anonymous JWTs. `id` and `subject` are both the Convex
 *   `users` id in that branch.
 * - Return `kind: "signed_in"` for authenticated Clerk users only when the JWT includes a valid `external_id`.
 *   `subject` is the Clerk user id and `id` is the Convex `users` id from `external_id`.
 *
 * Does not load the `users` table or assert the row exists: a verified token is treated as enough to trust
 * `subject` / `external_id`. If a signed-in token is missing `external_id`, treat it as unauthenticated. If a
 * flow must reject soft-deleted accounts or missing profiles, query `users` in that handler and enforce
 * `deletedAt` / presence there.
 */
export async function server_convex_get_user_fallback_to_anonymous(ctx: ConvexCtx) {
	const userIdentityResult = await Result_try_promise(ctx.auth.getUserIdentity());
	if (userIdentityResult._nay || !userIdentityResult._yay) {
		return null;
	}

	const identity = userIdentityResult._yay;

	const isAnonymous = identity.issuer === process.env.VITE_CONVEX_HTTP_URL;

	if (isAnonymous) {
		const userId = identity.subject as Id<"users">;
		return {
			kind: "anonymous",
			isAnonymous: true,
			id: userId,
			subject: userId,
			name: users_create_anonymouse_user_display_name(userId),
			email: null,
		} as const;
	}

	const userId = (identity["external_id"] as Id<"users"> | undefined) ?? null;
	if (!userId) {
		return null;
	}

	return {
		kind: "signed_in",
		isAnonymous: false,
		id: userId,
		subject: identity.subject,
		name: identity.name || identity.nickname || users_create_fallback_display_name(userId ?? identity.subject),
		email: identity.email ?? null,
	} as const;
}

export function server_path_normalize(path: string): string {
	return `/${path_extract_segments_from(path.trim()).join("/")}`;
}

export function server_path_parent_of(path: string): string {
	const segments = path_extract_segments_from(path);
	if (segments.length === 0) return "/";
	return `/${segments.slice(0, -1).join("/")}`;
}

export function server_json_parse_and_validate<T>(json: string, schema: z.ZodSchema<T>) {
	try {
		const value = JSON.parse(json);
		return Result({ _yay: schema.parse(value) });
	} catch (error) {
		return Result({
			_nay: {
				message: "Failed to parse JSON string",
				cause: error as Error,
			},
		});
	}
}

export async function server_request_json_parse_and_validate<T>(request: Request, schema: z.ZodSchema<T>) {
	try {
		const json = await request.json();
		const parseResult = schema.safeParse(json);
		if (parseResult.error) {
			return Result({
				_nay: {
					message: "Request body validation failed",
					cause: parseResult.error,
				},
			});
		}

		return Result({ _yay: parseResult.data });
	} catch (error) {
		return Result({
			_nay: {
				message: "Failed to parse request body as JSON",
				cause: error as Error,
			},
		});
	}
}

export function encode_path_segment(segment: string) {
	return segment.replaceAll("/", "\\/");
}

export function decode_path_segment(segment: string) {
	return segment.replaceAll("\\/", "/");
}
