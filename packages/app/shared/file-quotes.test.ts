import { describe, expect, test } from "vitest";
import {
	file_quotes_decode_draft_data,
	file_quotes_draft_to_text,
	file_quotes_MAX_TEXT_BYTES,
	file_quotes_parse_draft,
	file_quotes_schema,
	file_quotes_serialize_draft,
} from "./file-quotes.ts";

describe("file_quotes_schema", () => {
	test("keeps text without file details after access is lost", () => {
		expect(file_quotes_schema.parse({ fileNodeId: null, text: "Sent text" })).toEqual({
			fileNodeId: null,
			text: "Sent text",
		});
		expect(file_quotes_schema.safeParse({ fileNodeId: "file-id", text: "Text", path: "/private.md" }).success).toBe(
			false,
		);
	});

	test("limits UTF-8 bytes and refuses blank text", () => {
		expect(
			file_quotes_schema.safeParse({ fileNodeId: "file-id", text: "a".repeat(file_quotes_MAX_TEXT_BYTES) }).success,
		).toBe(true);
		expect(
			file_quotes_schema.safeParse({ fileNodeId: "file-id", text: "é".repeat(file_quotes_MAX_TEXT_BYTES) }).success,
		).toBe(false);
		expect(file_quotes_schema.safeParse({ fileNodeId: "file-id", text: " \n " }).success).toBe(false);
	});
});

describe("file_quotes_parse_draft", () => {
	test("keeps quote text and surrounding text in order", () => {
		const quote = { fileNodeId: "file-id", text: 'A "quote"\n[brackets] <tag> & punctuation' };
		const draft = `Before\n${file_quotes_serialize_draft(quote)}\nAfter`;
		expect(file_quotes_parse_draft(draft)).toEqual([
			{ type: "text", text: "Before\n" },
			{ type: "data-file-quote", data: quote },
			{ type: "text", text: "\nAfter" },
		]);
		expect(file_quotes_draft_to_text(draft)).toBe(`Before\n${quote.text}\nAfter`);
	});

	test("keeps marker-like selected text inside one quote", () => {
		const quote = { fileNodeId: null, text: '[file-quote data="not JSON"]\nSecond line' };
		expect(file_quotes_parse_draft(file_quotes_serialize_draft(quote))).toEqual([
			{ type: "data-file-quote", data: quote },
		]);
	});

	test("leaves malformed markers as ordinary text", () => {
		const draft = 'Before [file-quote data="%broken"] After';
		expect(file_quotes_parse_draft(draft)).toEqual([{ type: "text", text: draft }]);
		expect(file_quotes_decode_draft_data(null)).toBeNull();
	});

	test("keeps two quotes and an empty draft", () => {
		const first = { fileNodeId: "first-id", text: "First" };
		const second = { fileNodeId: null, text: "Second" };
		expect(file_quotes_parse_draft(file_quotes_serialize_draft(first) + file_quotes_serialize_draft(second))).toEqual([
			{ type: "data-file-quote", data: first },
			{ type: "data-file-quote", data: second },
		]);
		expect(file_quotes_parse_draft("")).toEqual([]);
	});
});
