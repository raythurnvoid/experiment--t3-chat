import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	files_find_file_stem_end_index,
	files_get_upload_pipeline_state,
	files_get_normalized_node_path_segments,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	files_normalize_markdown_name,
	files_normalize_name_input,
	files_normalize_name,
	files_parse_markdown_to_html,
	files_tiptap_markdown_to_json,
	files_tiptap_markdown_to_plain_text,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
} from "./files.ts";
import { Doc as YDoc } from "yjs";
import stringByteLength from "string-byte-length";
import type { WorkId } from "@convex-dev/workpool";
import type { app_convex_Doc } from "./app-convex.ts";

const FILES_UTF8_BYTE_SIZE_TEXT_ENCODER_MIN_LENGTH = 1e2;
const FILES_UTF8_BYTE_SIZE_CACHE_MAX_MEMORY = 1e5;

// Adapted from string-byte-length's MIT-licensed test corpus:
// https://github.com/ehmicky/string-byte-length/blob/main/src/helpers/strings.test.js
const FILES_UTF8_BYTE_SIZE_CHARACTERS = [
	{ title: "null", string: "\0", size: 1 },
	{ title: "start of heading", string: "\u0001", size: 1 },
	{ title: "backspace", string: "\b", size: 1 },
	{ title: "tab", string: "\t", size: 1 },
	{ title: "newline", string: "\n", size: 1 },
	{ title: "ascii letter", string: "a", size: 1 },
	{ title: "space", string: " ", size: 1 },
	{ title: "delete", string: "\u007f", size: 1 },
	{ title: "two-byte lower bound", string: "\u0080", size: 2 },
	{ title: "two-byte upper bound", string: "\u07ff", size: 2 },
	{ title: "three-byte lower bound", string: "\u0800", size: 3 },
	{ title: "three-byte upper bound", string: "\uffff", size: 3 },
	{ title: "astral lower surrogate pair", string: "\ud800\udc00", size: 4 },
	{ title: "astral upper surrogate pair", string: "\udbff\udfff", size: 4 },
	{ title: "astral code point U+10000", string: "\u{10000}", size: 4 },
	{ title: "astral code point U+1FFFF", string: "\u{1ffff}", size: 4 },
	{ title: "astral code point U+FFFFF", string: "\u{fffff}", size: 4 },
	{ title: "invalid high surrogate lower bound", string: "\ud800", size: 3 },
	{ title: "invalid high surrogate upper bound", string: "\udbff", size: 3 },
	{ title: "invalid low surrogate lower bound", string: "\udc00", size: 3 },
	{ title: "invalid low surrogate upper bound", string: "\udfff", size: 3 },
	{ title: "invalid reversed surrogate pair", string: "\udc00\ud800", size: 6 },
] satisfies Array<{ title: string; string: string; size: number }>;

const FILES_UTF8_BYTE_SIZE_LONG_SPACE = "_".repeat(FILES_UTF8_BYTE_SIZE_TEXT_ENCODER_MIN_LENGTH);
const FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE = "_".repeat(Math.ceil(FILES_UTF8_BYTE_SIZE_CACHE_MAX_MEMORY / 3));
const FILES_UTF8_BYTE_SIZE_CASES = [
	{ title: "empty string", string: "", size: 0 },
	...FILES_UTF8_BYTE_SIZE_CHARACTERS.flatMap(({ title, string, size }) => [
		{ title, string, size },
		{ title: `${title} with appended space`, string: `${string} `, size: size + 1 },
		{ title: `${title} with prepended space`, string: ` ${string}`, size: size + 1 },
		{
			title: `${title} with appended long space`,
			string: `${string}${FILES_UTF8_BYTE_SIZE_LONG_SPACE}`,
			size: size + FILES_UTF8_BYTE_SIZE_LONG_SPACE.length,
		},
		{
			title: `${title} with prepended long space`,
			string: `${FILES_UTF8_BYTE_SIZE_LONG_SPACE}${string}`,
			size: size + FILES_UTF8_BYTE_SIZE_LONG_SPACE.length,
		},
		{
			title: `${title} with appended very long space`,
			string: `${string}${FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE}`,
			size: size + FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE.length,
		},
		{
			title: `${title} with prepended very long space`,
			string: `${FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE}${string}`,
			size: size + FILES_UTF8_BYTE_SIZE_VERY_LONG_SPACE.length,
		},
	]),
] satisfies Array<{ title: string; string: string; size: number }>;

type StringByteLengthGlobal = typeof globalThis & {
	Buffer?: {
		byteLength?: (string: string, encoding?: string) => number;
	};
	TextEncoder?: typeof TextEncoder;
};

async function import_string_byte_length_with_runtime(args: {
	bufferByteLength: "current" | "removed";
	textEncoder: "current" | "removed";
}) {
	const typedGlobal = globalThis as StringByteLengthGlobal;
	const buffer = typedGlobal.Buffer;
	const bufferByteLengthDescriptor = buffer ? Object.getOwnPropertyDescriptor(buffer, "byteLength") : undefined;
	const textEncoderDescriptor = Object.getOwnPropertyDescriptor(typedGlobal, "TextEncoder");

	try {
		vi.resetModules();
		if (args.bufferByteLength === "removed" && buffer) {
			Reflect.deleteProperty(buffer, "byteLength");
		}
		if (args.textEncoder === "removed") {
			Reflect.deleteProperty(typedGlobal, "TextEncoder");
		}

		return (await import("string-byte-length")).default;
	} finally {
		if (buffer) {
			if (bufferByteLengthDescriptor) {
				Object.defineProperty(buffer, "byteLength", bufferByteLengthDescriptor);
			} else {
				Reflect.deleteProperty(buffer, "byteLength");
			}
		}
		if (textEncoderDescriptor) {
			Object.defineProperty(typedGlobal, "TextEncoder", textEncoderDescriptor);
		} else {
			Reflect.deleteProperty(typedGlobal, "TextEncoder");
		}
		vi.resetModules();
	}
}

describe("files_get_utf8_byte_size", () => {
	test.each(FILES_UTF8_BYTE_SIZE_CASES)("computes UTF-8 byte size for $title", ({ string, size }) => {
		expect(files_get_utf8_byte_size(string)).toBe(size);
	});

	test.each(FILES_UTF8_BYTE_SIZE_CASES)("matches TextEncoder for $title", ({ string }) => {
		expect(files_get_utf8_byte_size(string)).toBe(new TextEncoder().encode(string).byteLength);
	});

	test.each(FILES_UTF8_BYTE_SIZE_CASES)("matches string-byte-length package for $title", ({ string, size }) => {
		expect(stringByteLength(string)).toBe(size);
	});
});

describe("string-byte-length runtime paths", () => {
	test.each([
		["without Buffer.byteLength", { bufferByteLength: "removed", textEncoder: "current" }],
		["without Buffer.byteLength or TextEncoder", { bufferByteLength: "removed", textEncoder: "removed" }],
	] satisfies Array<
		[
			string,
			{
				bufferByteLength: Parameters<typeof import_string_byte_length_with_runtime>[0]["bufferByteLength"];
				textEncoder: Parameters<typeof import_string_byte_length_with_runtime>[0]["textEncoder"];
			},
		]
	>)("matches the upstream corpus %s", async (_title, runtime) => {
		const stringByteLengthForRuntime = await import_string_byte_length_with_runtime(runtime);

		for (const { title, string, size } of FILES_UTF8_BYTE_SIZE_CASES) {
			expect(stringByteLengthForRuntime(string), title).toBe(size);
		}
	});
});

describe("files_find_file_stem_end_index", () => {
	test.each([
		["notes.md", 5],
		["archive.tar.gz", 11],
		["notes", 5],
		[".env", 4],
		["trailing.", 8],
		["", 0],
	])("finds the stem end in %s", (fileName, expected) => {
		expect(files_find_file_stem_end_index({ fileName })).toBe(expected);
	});
});

describe("files_get_upload_pipeline_state", () => {
	test.each(
		[
			[null, "not_applicable"],
			[{ kind: "content", r2Key: "content-key" }, "not_applicable"],
			[{ kind: "upload" }, "waiting_for_upload"],
			[{ kind: "upload", conversionWorkId: null }, "terminal"],
			[{ kind: "upload", r2Key: "upload-key" }, "pending_processing"],
			[{ kind: "upload", r2Key: "upload-key", conversionWorkId: "work_1" as WorkId }, "processing"],
			[{ kind: "upload", r2Key: "upload-key", conversionWorkId: null }, "terminal"],
		] satisfies Array<
			[Parameters<typeof files_get_upload_pipeline_state>[0], ReturnType<typeof files_get_upload_pipeline_state>]
		>,
	)("returns expected state for case %#", (asset, expected) => {
		expect(files_get_upload_pipeline_state(asset)).toBe(expected);
	});
});

describe("files_node_has_editable_yjs_state", () => {
	const assetId = "asset" as NonNullable<app_convex_Doc<"files_nodes">["assetId"]>;
	const yjsSnapshotId = "snapshot" as NonNullable<app_convex_Doc<"files_nodes">["yjsSnapshotId"]>;
	const yjsLastSequenceId = "sequence" as NonNullable<app_convex_Doc<"files_nodes">["yjsLastSequenceId"]>;

	test("requires a file with an asset and both Yjs pointers", () => {
		expect(
			files_node_has_editable_yjs_state({
				kind: "file",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId,
			}),
		).toBe(true);

		expect(
			files_node_has_editable_yjs_state({
				kind: "file",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId: undefined,
			}),
		).toBe(false);
		expect(
			files_node_has_editable_yjs_state({
				kind: "folder",
				assetId,
				yjsSnapshotId,
				yjsLastSequenceId,
			}),
		).toBe(false);
	});
});

describe("files_get_normalized_node_path_segments", () => {
	test.each(
		[
			[null, "docs/readme", null],
			["file", "", null],
			["file", "/", null],
			["folder", "Docs / Feature Plan", { normalizedPathSegments: ["docs", "feature-plan"] }],
			["file", "Docs / readme", { normalizedPathSegments: ["docs", "README.md"] }],
			["file", "docs/archive.tar.md", { normalizedPathSegments: ["docs", "archive-tar.md"] }],
			["file", "docs/archive.tar.gz", { validationMessage: "Invalid file name" }],
			["folder", "docs/Bad Name", { normalizedPathSegments: ["docs", "bad-name"] }],
			["file", "docs/bad.m d", { validationMessage: "Invalid file name" }],
		] satisfies Array<[Parameters<typeof files_get_normalized_node_path_segments>[0]["kind"], string, unknown]>,
	)("normalizes %#", (kind, nameOrPath, expected) => {
		expect(files_get_normalized_node_path_segments({ kind, nameOrPath })).toEqual(expected);
	});
});

describe("files_normalize_name_input", () => {
	test.each(
		[
			[{ kind: "file", previousText: "", insertedText: "A", nextText: "" }, "a"],
			[{ kind: "file", previousText: "", insertedText: "é", nextText: "" }, "e"],
			[{ kind: "folder", previousText: "", insertedText: "é", nextText: "" }, "e"],
			[{ kind: "file", previousText: "file", insertedText: " ", nextText: "name" }, "-"],
			[{ kind: "file", previousText: "file-", insertedText: " ", nextText: "name" }, ""],
			[{ kind: "file", previousText: "notes", insertedText: ".", nextText: "md" }, "."],
			[{ kind: "folder", previousText: "notes", insertedText: ".", nextText: "md" }, "-"],
			[{ kind: "file", previousText: "a-", insertedText: "_", nextText: "b" }, ""],
			[{ kind: "file", previousText: "a", insertedText: "_", nextText: "-b" }, ""],
			[{ kind: "file", previousText: "a", insertedText: ".", nextText: "-b" }, ""],
			[{ kind: "file", previousText: "a_", insertedText: ".", nextText: "b" }, ""],
			[{ kind: "folder", previousText: "a", insertedText: "_", nextText: "-b" }, ""],
			[{ kind: "file", previousText: "file", insertedText: "2026", nextText: "" }, "2026"],
			[{ kind: "folder", previousText: "", insertedText: "2026", nextText: "" }, "2026"],
			[{ kind: "file", previousText: "foo", insertedText: "-", nextText: "" }, "-"],
			[{ kind: "file", previousText: "foo", insertedText: "_", nextText: "" }, "_"],
			[{ kind: "file", previousText: "foo", insertedText: "/bar", nextText: "" }, "/bar"],
			[{ kind: "folder", previousText: "foo", insertedText: "\\bar", nextText: "" }, "/bar"],
			[{ kind: "file", previousText: "", insertedText: "-file", nextText: "" }, "file"],
		] satisfies Array<[Parameters<typeof files_normalize_name_input>[0], string]>,
	)("normalizes live input %#", (input, expected) => {
		expect(files_normalize_name_input(input)).toBe(expected);
	});
});

describe("files_normalize_name", () => {
	test.each([
		["docs", "docs"],
		["new-folder", "new-folder"],
		["UPPER_lower-123", "upper_lower-123"],
		["Résumé", "resume"],
		["a\u1ab0folder", "afolder"],
		["---docs---", "docs"],
		["___docs___", "docs"],
		["a@b#c!", "a-b-c"],
		["asd/.txt", "asd-txt"],
		["test.", "test"],
		[".test", "test"],
		[".", "untitled"],
		["test/test.txt", "test-test-txt"],
		["test//test.txt", "test-test-txt"],
		["test.txt/test", "test-txt-test"],
		["bad\\name", "bad-name"],
		["  spaced name  ", "spaced-name"],
		["你好", "untitled"],
		["2026 plan", "2026-plan"],
		["a__b", "a_b"],
		["a--b", "a-b"],
		["test___test", "test_test"],
		["test---test", "test-test"],
	])("normalizes folder %s to %s", (input, expected) => {
		expect(files_normalize_name("folder", input)).toEqual({ _yay: expected });
	});

	test.each(["..", "test..test"])("rejects folder %s", (input) => {
		const result = files_normalize_name("folder", input);
		if (!result._nay) {
			throw new Error("Expected folder name normalization to fail");
		}

		expect(result._nay.message).toBe("Invalid folder name");
	});

	test.each([
		["notes.md", "notes.md"],
		["notes", "notes.md"],
		["NOTES.MD", "notes.md"],
		["readme", "README.md"],
		["README", "README.md"],
		["readme.md", "README.md"],
		["README.md", "README.md"],
		["New File.md", "new-file.md"],
		["a\u1ab0file.md", "afile.md"],
		["---notes---.MD", "notes.md"],
		["___notes___.md", "notes.md"],
		["a@b#c!.md", "a-b-c.md"],
		["x.", "x.md"],
		["test.", "test.md"],
		["bad\\name.md", "bad-name.md"],
		["archive.tar.md", "archive-tar.md"],
		["folder/file.name.with.many.md", "folder-file-name-with-many.md"],
		["  spaced name.md  ", "spaced-name.md"],
		["你好", "untitled.md"],
		["你好.md", "untitled.md"],
		["emoji😊file.md", "emoji-file.md"],
		["test___test.md", "test_test.md"],
		["test---test.md", "test-test.md"],
	])("normalizes file %s to %s", (input, expected) => {
		expect(files_normalize_name("file", input)).toEqual({ _yay: expected });
	});

	test.each([
		"..",
		".",
		"test..test",
		".test",
		"readme.txt",
		"notes.txt",
		"Résumé.DOC",
		"asd/.txt",
		"test/test.txt",
		"test//test.txt",
		"test.txt/test",
		"test.txt\\test",
		"archive.tar.gz",
		"folder/file.name.with.many.dots",
		"2026 plan.final",
		"multi___under.txt",
		"test.m d",
	])(
		"rejects file %s",
		(input) => {
			const result = files_normalize_name("file", input);
			if (!result._nay) {
				throw new Error("Expected file name normalization to fail");
			}

			expect(result._nay.message).toBe("Invalid file name");
		},
	);
});

describe("files_normalize_markdown_name", () => {
	test("normalizes extensionless names as Markdown files", () => {
		expect(files_normalize_markdown_name("Feature Plan")).toEqual({ _yay: "feature-plan.md" });
	});

	test("rejects non-Markdown extensions instead of rewriting them", () => {
		expect(files_normalize_markdown_name("Feature Plan.pdf")).toEqual({
			_nay: { name: "nay", message: "Invalid file name" },
		});
	});
});

describe("files_tiptap_markdown_to_json", () => {
	beforeEach(() => {
		const domParser = globalThis.window?.DOMParser;
		if (!domParser) {
			vi.stubGlobal("window", undefined);
			return;
		}

		try {
			new domParser();
		} catch {
			vi.stubGlobal("window", undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("keeps default markdown behavior when replaceNewLineToBr is not provided", () => {
		const result = files_tiptap_markdown_to_json({
			markdown: "first line\nsecond line",
		});
		if (result._nay) {
			throw new Error("Expected markdown conversion to succeed by default", {
				cause: result._nay,
			});
		}

		expect(result).toMatchInlineSnapshot(
			{
				_yay: {
					content: [
						{
							content: [{ text: expect.any(String) }],
						},
					],
				},
			},
			`
			{
			  "_yay": {
			    "content": [
			      {
			        "content": [
			          {
			            "text": Any<String>,
			            "type": "text",
			          },
			        ],
			        "type": "paragraph",
			      },
			    ],
			    "type": "doc",
			  },
			}
			`,
		);
	});

	test("preserves inline line breaks when replaceNewLineToBr is true", () => {
		const result = files_tiptap_markdown_to_json({
			markdown: "first line\nsecond line",
			replaceNewLineToBr: true,
		});
		if (result._nay) {
			throw new Error("Expected markdown conversion to succeed when replacing new lines with <br>", {
				cause: result._nay,
			});
		}

		expect(result).toMatchInlineSnapshot(
			{
				_yay: {
					content: [
						{
							content: [{ text: expect.any(String) }, {}, { text: expect.any(String) }],
						},
					],
				},
			},
			`
			{
			  "_yay": {
			    "content": [
			      {
			        "content": [
			          {
			            "text": Any<String>,
			            "type": "text",
			          },
			          {
			            "type": "hardBreak",
			          },
			          {
			            "text": Any<String>,
			            "type": "text",
			          },
			        ],
			        "type": "paragraph",
			      },
			    ],
			    "type": "doc",
			  },
			}
			`,
		);
	});

	test("preserves trailing whitespace at EOF through JSON conversion", () => {
		const noTrailingWhitespace = files_tiptap_markdown_to_json({
			markdown: "hello",
		});
		const trailingSpace = files_tiptap_markdown_to_json({
			markdown: "hello ",
		});
		const trailingNewline = files_tiptap_markdown_to_json({
			markdown: "hello\n",
		});

		if (noTrailingWhitespace._nay) {
			throw new Error("Expected markdown conversion without trailing whitespace to succeed", {
				cause: noTrailingWhitespace._nay,
			});
		}
		if (trailingSpace._nay) {
			throw new Error("Expected markdown conversion with trailing space to succeed", {
				cause: trailingSpace._nay,
			});
		}
		if (trailingNewline._nay) {
			throw new Error("Expected markdown conversion with trailing newline to succeed", {
				cause: trailingNewline._nay,
			});
		}

		expect(trailingSpace._yay).not.toEqual(noTrailingWhitespace._yay);
		expect(trailingSpace._yay.content?.[0]).toMatchObject({
			type: "paragraph",
			content: [{ type: "text", text: "hello " }],
		});

		expect(trailingNewline._yay).not.toEqual(noTrailingWhitespace._yay);
		expect((trailingNewline._yay.content ?? []).length).toBeGreaterThan(
			(noTrailingWhitespace._yay.content ?? []).length,
		);
	});

	test("preserves trailing whitespace at EOF for heading markdown through JSON conversion", () => {
		const result = files_tiptap_markdown_to_json({
			markdown: "# Base ",
		});

		if (result._nay) {
			throw new Error("Expected heading markdown conversion with trailing space to succeed", {
				cause: result._nay,
			});
		}

		expect(result._yay.content).toEqual([
			{
				type: "heading",
				attrs: {
					level: 1,
				},
				content: [{ type: "text", text: "Base " }],
			},
		]);
	});
});

describe("files_tiptap_markdown_to_plain_text", () => {
	beforeEach(() => {
		const domParser = globalThis.window?.DOMParser;
		if (!domParser) {
			vi.stubGlobal("window", undefined);
			return;
		}

		try {
			new domParser();
		} catch {
			vi.stubGlobal("window", undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("extracts searchable plain text without markdown markers", () => {
		const markdown = [
			"# Search Title",
			"",
			"Paragraph with [link label](https://example.com).",
			"",
			"```ts",
			"const chunkValue = 123;",
			"```",
		].join("\n");

		const result = files_tiptap_markdown_to_plain_text({
			markdown,
		});
		if (result._nay) {
			throw new Error("Expected markdown plain-text conversion to succeed", {
				cause: result._nay,
			});
		}

		expect(result._yay).toContain("Search Title");
		expect(result._yay).toContain("link label");
		expect(result._yay).toContain("const chunkValue = 123;");
		expect(result._yay).not.toContain("```");
		expect(result._yay).not.toContain("https://example.com");
	});

	test("keeps markdown table cells in plain text output", () => {
		const markdown = ["| Name | Value |", "| --- | --- |", "| one | 1 |", "| two | 2 |"].join("\n");

		const result = files_tiptap_markdown_to_plain_text({
			markdown,
		});
		if (result._nay) {
			throw new Error("Expected markdown table plain-text conversion to succeed", {
				cause: result._nay,
			});
		}

		expect(result._yay).toContain("Name");
		expect(result._yay).toContain("Value");
		expect(result._yay).toContain("one");
		expect(result._yay).toContain("1");
		expect(result._yay).toContain("two");
		expect(result._yay).toContain("2");
	});
});

describe("files_parse_markdown_to_html", () => {
	test("preserves trailing newline shape at EOF", () => {
		const noTrailingNewline = files_parse_markdown_to_html("hello");
		const oneTrailingNewline = files_parse_markdown_to_html("hello\n");
		const threeTrailingNewlines = files_parse_markdown_to_html("hello\n\n\n");

		if (noTrailingNewline._nay) {
			throw new Error("Expected markdown to HTML conversion without trailing newline to succeed", {
				cause: noTrailingNewline._nay,
			});
		}
		if (oneTrailingNewline._nay) {
			throw new Error("Expected markdown to HTML conversion with one trailing newline to succeed", {
				cause: oneTrailingNewline._nay,
			});
		}
		if (threeTrailingNewlines._nay) {
			throw new Error("Expected markdown to HTML conversion with three trailing newlines to succeed", {
				cause: threeTrailingNewlines._nay,
			});
		}

		expect(oneTrailingNewline._yay).not.toBe(noTrailingNewline._yay);
		expect(oneTrailingNewline._yay.match(/<p><\/p>/g) ?? []).toHaveLength(1);
		expect(threeTrailingNewlines._yay.match(/<p><\/p>/g) ?? []).toHaveLength(2);
	});

	test("preserves trailing space at EOF", () => {
		const noTrailingSpace = files_parse_markdown_to_html("hello");
		const oneTrailingSpace = files_parse_markdown_to_html("hello ");

		if (noTrailingSpace._nay) {
			throw new Error("Expected markdown to HTML conversion without trailing space to succeed", {
				cause: noTrailingSpace._nay,
			});
		}
		if (oneTrailingSpace._nay) {
			throw new Error("Expected markdown to HTML conversion with trailing space to succeed", {
				cause: oneTrailingSpace._nay,
			});
		}

		expect(oneTrailingSpace._yay).not.toBe(noTrailingSpace._yay);
	});
});

describe("files_yjs_doc_update_from_markdown", () => {
	test("preserves trailing whitespace at EOF through the Yjs round-trip", () => {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_markdown({
			markdown: "hello ",
			mut_yjsDoc: yjsDoc,
		});

		if (updateResult._nay) {
			throw new Error("Expected markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_markdown({
			yjsDoc,
		});
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		expect(markdownResult._yay).toBe("hello ");
	});

	test("preserves trailing whitespace-only line at EOF through the Yjs round-trip", () => {
		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_markdown({
			markdown: "# Base\n\n ",
			mut_yjsDoc: yjsDoc,
		});

		if (updateResult._nay) {
			throw new Error("Expected markdown with trailing whitespace-only line to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_markdown({
			yjsDoc,
		});
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion with trailing whitespace-only line to succeed", {
				cause: markdownResult._nay,
			});
		}

		expect(markdownResult._yay).toBe("# Base\n\n ");
	});
});
