import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { auth_ANONYMOUS_USER_ID } from "../../shared/shared_auth_constants.ts";
import type { UnknownRecord } from "type-fest";

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS!;
if (!ALLOWED_ORIGINS) {
	throw new Error("`ALLOWED_ORIGINS` env var is not set");
}

export function server_convex_headers_preflight_cors() {
	const headers = new Headers();
	headers_append_cors_preflight_headers(headers);
	return headers;
}

export function server_convex_headers_cors() {
	const headers = new Headers();
	headers_append_cors_headers(headers);
	return headers;
}

export function server_convex_headers_error_response() {
	const headers = new Headers();
	headers_append_error_response_headers(headers);
	return headers;
}

type ConvexCtx = GenericMutationCtx<any> | GenericQueryCtx<any> | GenericActionCtx<any>;

export async function server_convex_get_user_id_fallback_to_anonymous(ctx: ConvexCtx): Promise<string> {
	const user = await ctx.auth.getUserIdentity();

	if (user) {
		return user.tokenIdentifier;
	}

	return auth_ANONYMOUS_USER_ID;
}

function headers_append_cors_preflight_headers(headers: Headers) {
	headers_append_cors_headers(headers);
	headers.append("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function headers_append_cors_headers(headers: Headers) {
	headers.append("Access-Control-Allow-Origin", ALLOWED_ORIGINS);
}

function headers_append_error_response_headers(headers: Headers) {
	headers_append_cors_headers(headers);
	headers.append("Content-Type", "application/json; charset=utf-8");
}

export function server_convex_response_error(args: {
	message: string;
	meta?: UnknownRecord;
	status?: number;
	headers?: Record<string, string>;
}) {
	const headers = server_convex_headers_error_response();
	if (args?.headers) {
		for (const [key, value] of Object.entries(args.headers)) {
			headers.append(key, value);
		}
	}

	return new Response(JSON.stringify({ message: args?.message, meta: args?.meta }), {
		headers,
		status: args?.status ?? 500,
	});
}
