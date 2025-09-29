import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { auth_ANONYMOUS_USER_ID } from "../shared/shared-auth-constants.ts";
import { Result, Result_try_promise } from "../src/lib/errors-as-values-utils.ts";
import type z from "zod";

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
	const userIdentityResult = await Result_try_promise(ctx.auth.getUserIdentity());
	if (userIdentityResult._nay) {
		throw new Error("Failed to get user identity", { cause: userIdentityResult._nay });
	}

	const randomColor = "#" + Math.floor(Math.random() * 16777215).toString(16);

	if (userIdentityResult._yay) {
		const sub = userIdentityResult._yay.tokenIdentifier.slice(userIdentityResult._yay.tokenIdentifier.indexOf("|") + 1);
		const userId = sub.slice(sub.indexOf("_") + 1);

		return {
			isAnonymous: false,
			id: userIdentityResult._yay.tokenIdentifier,
			name: userIdentityResult._yay.name || userIdentityResult._yay.nickname || `User ${userId}`,
			avatar: userIdentityResult._yay.pictureUrl || "https://via.placeholder.com/32",
			color: randomColor, // Random color for now
		};
	} else {
		// TODO: this should be randomized once per session
		const randomId = "randomId";

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
	body: Result<{ _nay: any }>["_nay"];
	status?: number;
	headers?: Record<string, string> | Headers;
}) {
	const headers = server_convex_headers_error_response();
	if (args?.headers) {
		for (const [key, value] of Object.entries(args.headers)) {
			headers.append(key, value);
		}
	}

	return new Response(JSON.stringify(args.body), {
		headers,
		status: args?.status ?? 500,
	});
}

export function server_convex_response_error_server(args: {
	body: Result<{ _nay: any }>["_nay"];
	headers?: Record<string, string> | Headers;
}) {
	return server_convex_response_error({ body: args.body, status: 500 });
}

export function server_convex_response_error_client(args: {
	body: Result<{ _nay: any }>["_nay"];
	headers?: Record<string, string> | Headers;
}) {
	return server_convex_response_error({ body: args.body, status: 400 });
}

export function server_convex_response_success_json(args: {
	body: Result<{ _yay: any }>["_yay"];
	headers?: Record<string, string> | Headers;
}) {
	return new Response(JSON.stringify(args.body), {
		headers: args.headers,
		status: 200,
	});
}

export function server_path_extract_segments_from(path: string): string[] {
	const normalizedPath = path.trim();
	if (normalizedPath === "" || normalizedPath === "/") return [];
	return normalizedPath
		.split(/(?<!\\)\//) // split on / not preceeded by \
		.filter(Boolean);
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

		return Result({ _yay: schema.parse(json) });
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
