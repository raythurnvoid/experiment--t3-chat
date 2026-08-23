/**
 * Small HTTP helpers shared across the service. The page and room route modules read and answer
 * requests with them, and the pipeline and the provider adapter read response bodies under a byte
 * cap with them.
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
	// Read the body through the cap rather than `request.text()`. `text()` pulls the whole body into
	// the isolate first, so the cap would only be consulted once the bytes are already here. It also
	// hands back a string, and `String.length` counts UTF-16 code units: one CJK character is one
	// code unit and three UTF-8 bytes, so a 192 KB body passed a 64 KB check.
	let text = "";
	if (request.body) {
		const read = await council_read_stream_with_limit(request.body, REQUEST_MAX_BYTES);
		if (read._nay) {
			return Result<never>({ _nay: { message: "Request body is too large" } });
		}
		text = new TextDecoder().decode(read._yay);
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

/**
 * Read a whole stream into memory, and refuse it as soon as it passes `maxBytes` instead of
 * buffering the rest.
 *
 * This is the streaming sibling of `council_read_json_body`, so the cap belongs to the caller
 * rather than to the helper. The three callers pick very different numbers. The pipeline passes the
 * track ceiling, because transcription has to hold the audio in memory. The provider adapter
 * passes a small ceiling for a JSON diagnostic. The webhook intake passes a small ceiling too, and
 * for a different reason: its route is the only one an anonymous caller can reach, and the
 * signature cannot be checked until the bytes are in memory. Bytes that only move to storage never
 * come through here — uploads stream.
 */
export async function council_read_stream_with_limit(stream: ReadableStream<Uint8Array>, maxBytes: number) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return Result<never>({ _nay: { name: "too_large", message: `Stream exceeded ${maxBytes} bytes` } });
		}
		chunks.push(value);
	}

	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return Result({ _yay: combined });
}

export function council_utf8_byte_length(value: string) {
	return new TextEncoder().encode(value).length;
}

/**
 * Read one string field from a JSON body. The field is required unless the caller passes
 * `optional`. Its UTF-8 encoding may not pass `maxBytes`, and the cap counts encoded bytes rather
 * than characters, so the same limit holds whatever alphabet the value uses.
 */
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
