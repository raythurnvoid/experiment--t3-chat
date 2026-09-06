import "../convex/setup.test.ts";
import { compareValues } from "convex/values";
import { describe, test, expect } from "vitest";
import { z } from "zod";
import {
	path_extract_segments_from,
	server_path_normalize,
	server_path_parent_of,
	path_join,
	path_tree_prefix_upper_bound,
	string_prefix_upper_bound,
	path_name_of,
	encode_path_segment,
	decode_path_segment,
	json_parse_and_validate,
	server_request_json_parse_and_validate,
} from "./server-utils.ts";

test("server_path_extract_segments_from handles root and simple paths", () => {
	expect(path_extract_segments_from("/")).toEqual([]);
	expect(path_extract_segments_from("/foo/bar")).toEqual(["foo", "bar"]);
});

test("server_path_extract_segments_from preserves escaped slashes", () => {
	const input = "/foo/a\\/b/bar"; // a\/b should be treated as a single segment
	expect(path_extract_segments_from(input)).toEqual(["foo", "a\\/b", "bar"]);
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

test("path_join handles root without changing the joined segment", () => {
	expect(path_join("/", "a")).toBe("/a");
	expect(path_join("/a", "b")).toBe("/a/b");
	expect(path_join("/a", "b/c")).toBe("/a/b/c");
});

test("server_path_name_of returns last segment", () => {
	expect(path_name_of("/")).toBe("");
	expect(path_name_of("/a")).toBe("a");
	expect(path_name_of("/a/b")).toBe("b");
});

test("encode/decode path segment roundtrip", () => {
	const original = "a/b/c";
	const encoded = encode_path_segment(original);
	expect(encoded).toBe("a\\/b\\/c");
	expect(decode_path_segment(encoded)).toBe(original);
});

describe("path_tree_prefix_upper_bound", () => {
	test.each([
		["/", "0"],
		["/docs/", "/docs0"],
		["/😀/", "/😀0"],
	])("covers every Unicode descendant of %s", (prefix, expected) => {
		const upper = path_tree_prefix_upper_bound(prefix);
		expect(upper).toBe(expected);
		expect(compareValues(prefix, upper)).toBeLessThan(0);
		for (let point = 0; point <= 0x10ffff; point++) {
			if (point >= 0xd800 && point <= 0xdfff) continue;
			const path = `${prefix}${String.fromCodePoint(point)}/file.md`;
			if (compareValues(path, prefix) < 0 || compareValues(path, upper) >= 0) {
				throw new Error(`Missing descendant at U+${point.toString(16)}`);
			}
		}
	});

	test("includes the folder key and descendants but excludes sibling prefixes", () => {
		const lower = "/docs/";
		const upper = path_tree_prefix_upper_bound(lower);
		for (const path of [
			"/docs/",
			"/docs/readme.md",
			"/docs/😀/file.md",
			"/docs/\uffff/file.md",
			"/docs/\u{10ffff}",
			"/docs-archive/file.md",
			"/docs0/file.md",
			"/docset/file.md",
		]) {
			expect(compareValues(path, lower) >= 0 && compareValues(path, upper) < 0).toBe(path.startsWith(lower));
		}
	});
});

describe("string_prefix_upper_bound", () => {
	test.each([
		["", null],
		["op", "oq"],
		["é", "ê"],
		["\0", "\x01"],
		["\ud7ff", "\ue000"],
		["\uffff", "\u{10000}"],
		["😀", "😁"],
		["\u{10ffff}", null],
		["\u{10ffff}\u{10ffff}", null],
		["op\u{10ffff}\u{10ffff}", "oq"],
		["\ud7ff\u{10ffff}", "\ue000"],
	] as const)("finds the bound for %j", (prefix, expected) => {
		expect(string_prefix_upper_bound(prefix)).toBe(expected);
	});

	test("covers every Unicode scalar and carries past trailing U+10FFFF", () => {
		let count = 0;
		for (let point = 0; point <= 0x10ffff; point++) {
			if (point >= 0xd800 && point <= 0xdfff) continue;
			const value = String.fromCodePoint(point);
			const expected = point === 0x10ffff ? null : String.fromCodePoint(point === 0xd7ff ? 0xe000 : point + 1);
			if (string_prefix_upper_bound(value) !== expected) {
				throw new Error(`Wrong bound at U+${point.toString(16)}`);
			}
			const carried = string_prefix_upper_bound(`x${value}\u{10ffff}`);
			if (carried !== (expected === null ? "y" : `x${expected}`)) {
				throw new Error(`Wrong carry at U+${point.toString(16)}`);
			}
			count++;
		}
		expect(count).toBe(1_112_064);
	});

	test.each([199, 200, 201, 10_000, 200_000])("handles %i characters without a call argument limit", (length) => {
		expect(string_prefix_upper_bound("a".repeat(length))).toBe(`${"a".repeat(length - 1)}b`);
		expect(string_prefix_upper_bound("\u{10ffff}".repeat(length))).toBeNull();
	});

	test("matches startsWith using Convex ordering across varied Unicode strings", () => {
		let seed = 0x12345678;
		function random_string() {
			const chars: string[] = [];
			for (let i = 0; i < 4; i++) {
				seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				const scalar = (seed >>> 0) % 1_112_064;
				chars.push(String.fromCodePoint(scalar >= 0xd800 ? scalar + 0x800 : scalar));
			}
			return chars.join("");
		}
		for (let i = 0; i < 10_000; i++) {
			const prefix = i % 5 === 0 ? "\u{10ffff}".repeat(i % 3) : random_string();
			const upper = string_prefix_upper_bound(prefix);
			const candidates = [prefix, prefix + random_string(), random_string(), [...prefix].slice(0, -1).join("")];
			if (upper !== null) candidates.push(upper, upper + random_string());
			for (const candidate of candidates) {
				const inRange = compareValues(candidate, prefix) >= 0 && (upper === null || compareValues(candidate, upper) < 0);
				if (inRange !== candidate.startsWith(prefix)) {
					throw new Error(`Wrong prefix range: ${JSON.stringify({ prefix, candidate, upper })}`);
				}
			}
		}
	});
});

test("json_parse_and_validate success and failure", () => {
	const schema = z.object({ a: z.number() });
	const ok = json_parse_and_validate('{"a":1}', schema);
	expect(ok._yay).toEqual({ a: 1 });

	const bad = json_parse_and_validate("not json", schema);
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
