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

export async function server_convex_get_user_fallback_to_anonymous(ctx: ConvexCtx) {
	const userIdentityResult = await Result_try_promise(ctx.auth.getUserIdentity());
	if (userIdentityResult._nay) {
		throw new Error("Failed to get user identity", { cause: userIdentityResult._nay });
	}

	if (!userIdentityResult._yay) {
		throw new Error("Unauthenticated");
	}

	const isAnonymous = userIdentityResult._yay.issuer === process.env.VITE_CONVEX_HTTP_URL;

	let userId;

	if (isAnonymous) {
		// For anonymous users, the subject is the Convex user id
		userId = userIdentityResult._yay.subject as Id<"users">;
	} else {
		// For Clerk users, the external_id is the Clerk user id
		userId = userIdentityResult._yay["external_id"] as Id<"users">;
		if (!userId) {
			throw new Error("Missing `external_id` in signed-in user JWT");
		}
	}

	return {
		isAnonymous,
		id: userId,
		name: isAnonymous
			? users_create_anonymouse_user_display_name(userId)
			: userIdentityResult._yay.name || users_create_fallback_display_name(userId),
	};
}

export function server_path_normalize(path: string): string {
	return `/${path_extract_segments_from(path).join("/")}`;
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
