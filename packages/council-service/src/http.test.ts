import { describe, expect, test } from "vitest";

import {
	council_get_bearer,
	council_json,
	council_read_json_body,
	council_read_stream_with_limit,
	council_read_string_field,
} from "./http.ts";

/** The module's own cap, restated here so a test says what it is checking. */
const REQUEST_MAX_BYTES = 64 * 1024;

function post(body: BodyInit | null) {
	return new Request("https://council.example/api/meetings/list", {
		method: "POST",
		body,
		// Node needs this to accept a stream as a request body.
		duplex: "half",
	} as RequestInit);
}

/** A request carrying one raw `Authorization` header value, or none at all. */
function authorized(header: string | null) {
	return new Request("https://council.example/api/meetings/list", {
		method: "POST",
		headers: header === null ? {} : { Authorization: header },
	});
}

/** A stream of `count` four-byte chunks that records whether the reader gave up on it. */
function chunked_stream(count: number, state: { cancelled: boolean }) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (let index = 0; index < count; index++) {
				controller.enqueue(new Uint8Array(4));
			}
			controller.close();
		},
		cancel() {
			state.cancelled = true;
		},
	});
}

describe("council_read_stream_with_limit", () => {
	test("refuses a body past the cap and cancels the reader instead of buffering the rest", async () => {
		const state = { cancelled: false };

		const read = await council_read_stream_with_limit(chunked_stream(4, state), 6);

		// The read pulls the whole body into the Worker's memory. Without the cap a body that is not
		// what the caller thinks it is would be buffered in one piece.
		expect(read._nay?.name).toBe("too_large");
		expect(state.cancelled).toBe(true);
	});

	test("returns the whole body when it fits", async () => {
		const state = { cancelled: false };

		const read = await council_read_stream_with_limit(chunked_stream(2, state), 8);

		expect(read._yay?.byteLength).toBe(8);
		expect(state.cancelled).toBe(false);
	});
});

describe("council_read_json_body", () => {
	test("measures the cap in UTF-8 bytes, so a CJK body cannot pass it three times over", async () => {
		// 25,000 CJK characters. `String.length` counts UTF-16 code units and calls this 25 KB, but
		// each character is three UTF-8 bytes, so the request really carries 75 KB.
		const body = `{"title":"${"銀".repeat(25_000)}"}`;
		expect(body.length).toBeLessThan(REQUEST_MAX_BYTES);
		expect(new TextEncoder().encode(body).length).toBeGreaterThan(REQUEST_MAX_BYTES);

		const read = await council_read_json_body(post(body));

		expect(read._nay?.message).toBe("Request body is too large");
	});

	test("stops reading at the cap instead of pulling the whole body in first", async () => {
		// One chunk per kilobyte. A cap that runs after the read would pull all 128 of them.
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				controller.enqueue(new Uint8Array(1024));
				if (pulled === 128) {
					controller.close();
				}
			},
		});

		const read = await council_read_json_body(post(stream));

		expect(read._nay?.message).toBe("Request body is too large");
		expect(pulled).toBeLessThanOrEqual(REQUEST_MAX_BYTES / 1024 + 1);
	});

	test("reads a JSON object that fits and refuses one that is not an object", async () => {
		const object = await council_read_json_body(post(`{"meetingId":"meeting-1"}`));
		expect(object._yay).toEqual({ meetingId: "meeting-1" });

		const array = await council_read_json_body(post("[1, 2]"));
		expect(array._nay?.message).toBe("Request body must be a JSON object");

		const broken = await council_read_json_body(post("{"));
		expect(broken._nay?.message).toBe("Request body is not valid JSON");
	});

	test("a request with no body reads as an empty command", async () => {
		const read = await council_read_json_body(post(null));

		expect(read._yay).toEqual({});
	});
});

describe("council_json", () => {
	test("every answer carries the caller's status and the no-store and no-referrer headers", () => {
		const response = council_json(200, { received: true });

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		// One policy for everything this Worker answers. The no-referrer half earns its place on the
		// room page, which spreads the same constant in `room-page.ts`: that URL carries the meeting
		// id in its query string, and the page loads the provider SDK from other origins, so without
		// the header the browser would hand them that id in `Referer`.
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});
});

describe("council_read_string_field", () => {
	test("an empty string is a missing field, not a value", () => {
		// A page can post `{"title":""}` as easily as it can leave the key out, and both mean the
		// member typed nothing. So a required field refuses, and an optional one reads as absent
		// rather than handing an empty string on to the code that stores it.
		const required = council_read_string_field({ title: "" }, "title", { maxBytes: 200 });
		expect(required._nay?.message).toBe("title is required");

		const optional = council_read_string_field({ email: "" }, "email", { maxBytes: 254, optional: true });
		expect(optional._yay).toBeNull();
	});
});

describe("council_get_bearer", () => {
	test("reads the token only under the Bearer scheme", () => {
		const token = "plu_0123456789abcdef";
		expect(council_get_bearer(authorized(`Bearer ${token}`))).toBe(token);

		// "Foobar!" is exactly as long as "Bearer ", so a check that slices seven characters off
		// without confirming the scheme first would read the real token out of this header and let
		// the caller in. The app's own bearer check has this same twin case pinned in
		// `packages/app/convex/r2.test.ts`; keep the two in step.
		expect(council_get_bearer(authorized(`Foobar!${token}`))).toBeNull();
		expect(council_get_bearer(authorized(`Basic ${token}`))).toBeNull();
		// A bare scheme with no token. A header written as "Bearer " arrives in this shape too,
		// because the Fetch layer strips trailing whitespace from every header value.
		expect(council_get_bearer(authorized("Bearer"))).toBeNull();
		expect(council_get_bearer(authorized(null))).toBeNull();
	});
});
