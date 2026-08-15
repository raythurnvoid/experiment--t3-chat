/**
 * Small HTTP helpers shared by the page and room route modules.
 */

import { Result } from "./result.ts";

/**
 * Never cache anything this Worker answers. Room responses carry a one-time ticket exchange and a
 * session cookie, and the members-only API answers differ per caller.
 */
export const council_NO_STORE_HEADERS = {
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
} as const;

export function council_json(status: number, body: unknown, headers?: Record<string, string>) {
	return Response.json(body, { status, headers: { ...council_NO_STORE_HEADERS, ...headers } });
}

/** Requests are small JSON commands; anything past this size is not one of ours. */
const REQUEST_MAX_BYTES = 64 * 1024;

export async function council_read_json_body(request: Request) {
	const text = await request.text();
	if (text.length > REQUEST_MAX_BYTES) {
		return Result<never>({ _nay: { message: "Request body is too large" } });
	}
	try {
		const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return Result<never>({ _nay: { message: "Request body must be a JSON object" } });
		}
		return Result({ _yay: parsed as Record<string, unknown> });
	} catch {
		return Result<never>({ _nay: { message: "Request body is not valid JSON" } });
	}
}

export function council_utf8_byte_length(value: string) {
	return new TextEncoder().encode(value).length;
}

/** A required string field with a UTF-8 byte cap, per the plan's byte-limit rule. */
export function council_read_string_field(
	body: Record<string, unknown>,
	field: string,
	args: { maxBytes: number; optional?: boolean },
) {
	const value = body[field];
	if (value === undefined || value === null || value === "") {
		if (args.optional) {
			return Result({ _yay: null });
		}
		return Result<never>({ _nay: { message: `${field} is required` } });
	}
	if (typeof value !== "string") {
		return Result<never>({ _nay: { message: `${field} must be a string` } });
	}
	if (council_utf8_byte_length(value) > args.maxBytes) {
		return Result<never>({ _nay: { message: `${field} is longer than ${args.maxBytes} bytes` } });
	}
	return Result({ _yay: value as string | null });
}

export function council_get_bearer(request: Request) {
	const header = request.headers.get("Authorization");
	const prefix = "Bearer ";
	if (!header?.startsWith(prefix)) {
		return null;
	}
	const token = header.slice(prefix.length).trim();
	return token.length > 0 ? token : null;
}
