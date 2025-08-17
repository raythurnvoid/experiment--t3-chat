import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { auth_ANONYMOUS_USER_ID } from "../shared/shared-auth-constants.ts";
import type { UnknownRecord } from "type-fest";
import { Result } from "../src/lib/errors-as-values-utils.ts";

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

export async function server_convex_get_user_fallback_to_anonymous(ctx: ConvexCtx) {
	const userIdentityResult = await Result.tryPromise(ctx.auth.getUserIdentity());
	if (userIdentityResult.bad) {
		throw new Error("Failed to get user identity", { cause: userIdentityResult.bad });
	}

	const randomColor = "#" + Math.floor(Math.random() * 16777215).toString(16);

	if (userIdentityResult.ok) {
		const sub = userIdentityResult.ok.tokenIdentifier.slice(userIdentityResult.ok.tokenIdentifier.indexOf("|") + 1);
		const userId = sub.slice(sub.indexOf("_") + 1);

		return {
			isAnonymous: false,
			id: userIdentityResult.ok.tokenIdentifier,
			name: userIdentityResult.ok.name || userIdentityResult.ok.nickname || `User ${userId}`,
			avatar: userIdentityResult.ok.pictureUrl || "https://via.placeholder.com/32",
			color: randomColor, // Random color for now
		};
	} else {
		const randomId = crypto.randomUUID();

		return {
			isAnonymous: true,
			id: `${auth_ANONYMOUS_USER_ID}_${randomId}`,
			name: `Anonymous User ${randomId}`,
			avatar: "https://via.placeholder.com/32",
			color: randomColor, /// Random color for now
		};
	}
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

export function server_path_extract_segments_from(path: string): string[] {
	const normalizedPath = path.replaceAll("\\", "/").trim();
	if (normalizedPath === "" || normalizedPath === "/") return [];
	return normalizedPath.split("/").filter(Boolean);
}

export function server_path_normalize(path: string): string {
	return `/${server_path_extract_segments_from(path).join("/")}`;
}

export function server_path_parent_of(path: string): string {
	const segments = server_path_extract_segments_from(path);
	if (segments.length === 0) return "/";
	return `/${segments.slice(0, -1).join("/")}`;
}

export function server_path_name_of(path: string): string {
	return server_path_extract_segments_from(path).at(-1) ?? "";
}
