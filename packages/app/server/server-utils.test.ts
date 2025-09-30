import "../convex/test.setup.ts";
import { test, expect } from "vitest";
import { z } from "zod";
import {
	server_path_extract_segments_from,
	server_path_normalize,
	server_path_parent_of,
	server_path_name_of,
	encode_path_segment,
	decode_path_segment,
	server_json_parse_and_validate,
	server_request_json_parse_and_validate,
} from "./server-utils.ts";

test("server_path_extract_segments_from handles root and simple paths", () => {
	expect(server_path_extract_segments_from("/")).toEqual([]);
	expect(server_path_extract_segments_from("/foo/bar")).toEqual(["foo", "bar"]);
});

test("server_path_extract_segments_from preserves escaped slashes", () => {
	const input = "/foo/a\\/b/bar"; // a\/b should be treated as a single segment
	expect(server_path_extract_segments_from(input)).toEqual(["foo", "a\\/b", "bar"]);
});

test("server_path_normalize trims and collapses", () => {
	expect(server_path_normalize("  /foo//bar/  ")).toBe("/foo/bar");
	expect(server_path_normalize("foo/bar")).toBe("/foo/bar");
	expect(server_path_normalize("/")).toBe("/");
});

test("server_path_parent_of computes parent correctly", () => {
	expect(server_path_parent_of("/")).toBe("/");
	expect(server_path_parent_of("/a")).toBe("/");
	expect(server_path_parent_of("/a/b")).toBe("/a");
});

test("server_path_name_of returns last segment", () => {
	expect(server_path_name_of("/")).toBe("");
	expect(server_path_name_of("/a")).toBe("a");
	expect(server_path_name_of("/a/b")).toBe("b");
});

test("encode/decode path segment roundtrip", () => {
	const original = "a/b/c";
	const encoded = encode_path_segment(original);
	expect(encoded).toBe("a\\/b\\/c");
	expect(decode_path_segment(encoded)).toBe(original);
});

test("server_json_parse_and_validate success and failure", () => {
	const schema = z.object({ a: z.number() });
	const ok = server_json_parse_and_validate('{"a":1}', schema);
	expect(ok._yay).toEqual({ a: 1 });

	const bad = server_json_parse_and_validate("not json", schema);
	expect(bad._nay).toBeTruthy();
	expect(bad._nay?.message).toBe("Failed to parse JSON string");
});

test("server_request_json_parse_and_validate handles valid, invalid shape, and invalid JSON", async () => {
	const schema = z.object({ a: z.number() });

	const reqOk = new Request("https://x", {
		method: "POST",
		body: JSON.stringify({ a: 1 }),
		headers: { "Content-Type": "application/json" },
	});
	const resOk = await server_request_json_parse_and_validate(reqOk, schema);
	expect(resOk._yay).toEqual({ a: 1 });

	const reqShape = new Request("https://x", {
		method: "POST",
		body: JSON.stringify({ a: "x" }),
		headers: { "Content-Type": "application/json" },
	});
	const resShape = await server_request_json_parse_and_validate(reqShape, schema);
	expect(resShape._nay).toBeTruthy();
	expect(resShape._nay?.message).toBe("Request body validation failed");

	const reqBad = new Request("https://x", {
		method: "POST",
		body: "not json",
		headers: { "Content-Type": "application/json" },
	});
	const result = await server_request_json_parse_and_validate(reqBad, schema);
	expect(result._nay).toBeTruthy();
	expect(result._nay?.message).toBe("Failed to parse request body as JSON");
});
