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
	files_pending_path_overlay_build,
	files_pending_path_overlay_list_injections,
	files_pending_path_overlay_pick_visible_entry,
	files_pending_path_overlay_project_committed_path,
	files_pending_path_overlay_translate_path,
	files_ROOT_ID,
	files_tiptap_markdown_to_json,
	files_tiptap_markdown_to_plain_text,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	type files_PendingPathOverlayNode,
	type files_PendingPathOverlayRow,
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
			[{ kind: "content", processingWorkId: "work_1" as WorkId }, "processing"],
			[{ kind: "content", processingWorkId: null }, "terminal"],
			[{ kind: "upload" }, "waiting_for_upload"],
			[{ kind: "upload", processingWorkId: null }, "terminal"],
			[{ kind: "upload", r2Key: "upload-key" }, "pending_processing"],
			[{ kind: "upload", r2Key: "upload-key", processingWorkId: "work_1" as WorkId }, "processing"],
			[{ kind: "upload", r2Key: "upload-key", processingWorkId: null }, "terminal"],
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
			["folder", "Docs / release.v1", { normalizedPathSegments: ["docs", "release.v1"] }],
			["file", "Docs / readme", { normalizedPathSegments: ["docs", "README.md"] }],
			["file", "docs/archive.tar.md", { normalizedPathSegments: ["docs", "archive.tar.md"] }],
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
			[{ kind: "folder", previousText: "notes", insertedText: ".", nextText: "md" }, "."],
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
		["test/test.txt", "test-test.txt"],
		["test//test.txt", "test-test.txt"],
		["test.txt/test", "test.txt-test"],
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
		["archive.tar.md", "archive.tar.md"],
		["folder/file.name.with.many.md", "folder-file.name.with.many.md"],
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
		const trailingBlankLine = files_tiptap_markdown_to_json({
			markdown: "hello\n\n",
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
		if (trailingBlankLine._nay) {
			throw new Error("Expected markdown conversion with trailing blank line to succeed", {
				cause: trailingBlankLine._nay,
			});
		}

		expect(trailingSpace._yay).not.toEqual(noTrailingWhitespace._yay);
		expect(trailingSpace._yay.content?.[0]).toMatchObject({
			type: "paragraph",
			content: [{ type: "text", text: "hello " }],
		});

		// One final `\n` is a plain line terminator, not an empty line; only newlines
		// beyond it become empty paragraphs.
		expect(trailingNewline._yay).toEqual(noTrailingWhitespace._yay);
		expect((trailingBlankLine._yay.content ?? []).length).toBeGreaterThan(
			(trailingNewline._yay.content ?? []).length,
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
		const twoTrailingNewlines = files_parse_markdown_to_html("hello\n\n");
		const fourTrailingNewlines = files_parse_markdown_to_html("hello\n\n\n\n");

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
		if (twoTrailingNewlines._nay) {
			throw new Error("Expected markdown to HTML conversion with two trailing newlines to succeed", {
				cause: twoTrailingNewlines._nay,
			});
		}
		if (fourTrailingNewlines._nay) {
			throw new Error("Expected markdown to HTML conversion with four trailing newlines to succeed", {
				cause: fourTrailingNewlines._nay,
			});
		}

		// One final `\n` is a plain line terminator, not an empty line; each extra
		// pair of newlines beyond it is one empty paragraph.
		expect(oneTrailingNewline._yay).toBe(noTrailingNewline._yay);
		expect(oneTrailingNewline._yay.match(/<p><\/p>/g) ?? []).toHaveLength(0);
		expect(twoTrailingNewlines._yay.match(/<p><\/p>/g) ?? []).toHaveLength(1);
		expect(fourTrailingNewlines._yay.match(/<p><\/p>/g) ?? []).toHaveLength(2);
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

		// The trailing space survives; serialized non-empty file content ends with one `\n`.
		expect(markdownResult._yay).toBe("hello \n");
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

		// The whitespace-only line survives; serialized non-empty file content ends with one `\n`.
		expect(markdownResult._yay).toBe("# Base\n\n \n");
	});
});

describe("frontmatter parsing via marked", () => {
	test("emits <pre data-frontmatter> for leading YAML frontmatter", () => {
		const html = files_parse_markdown_to_html("---\nfoo: bar\n---\n\nBody");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).toContain("<pre data-frontmatter>foo: bar</pre>");
	});

	test("escapes HTML special chars inside the frontmatter body", () => {
		const html = files_parse_markdown_to_html('---\nfrom: "Marcus Dane <marcus@example.com>"\n---\n');
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).toContain(
			'<pre data-frontmatter>from: "Marcus Dane &lt;marcus@example.com&gt;"</pre>',
		);
	});

	test("does not match a non-leading ---...--- block", () => {
		const html = files_parse_markdown_to_html("Some text.\n\n---\nfoo: bar\n---\n\nMore text.");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).not.toContain("data-frontmatter");
	});

	test("does not close on a line that only starts with ---", () => {
		const html = files_parse_markdown_to_html("---\nfoo: bar\n---not-a-closing-marker\n\nBody");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).not.toContain("data-frontmatter");
	});

	test("does not match frontmatter-like content inside a list item", () => {
		const html = files_parse_markdown_to_html("- ---\n  foo: bar\n  ---");
		if (html._nay) throw new Error("Expected markdown parse to succeed", { cause: html._nay });
		expect(html._yay).not.toContain("data-frontmatter");
	});
});

describe("frontmatter round-trip through Yjs", () => {
	test("preserves the AI-style mail frontmatter and body byte-for-byte", () => {
		const input = [
			"---",
			'to: ["ops@company.example"]',
			'cc: ["security@company.example","engineering@company.example"]',
			'from: "Marcus Dane <marcus.dane@company.example>"',
			'subject: "Access logs review — suspected burst"',
			'date: "2026-03-13"',
			'messageId: "<aurorareef-20260313-md-1@company.example>"',
			'threadId: "aurorareef-access-logs"',
			"---",
			"",
			"Hi team,",
			"",
			"We're seeing a short burst of failed authentication events around the `gateway-aurora` edge.",
			"",
		].join("\n");

		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_markdown({
			markdown: input,
			mut_yjsDoc: yjsDoc,
		});
		if (updateResult._nay) {
			throw new Error("Expected frontmatter+body markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_markdown({ yjsDoc });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		expect(markdownResult._yay).toBe(input);
	});

	test("preserves a frontmatter-only document", () => {
		const input = '---\nfoo: bar\nbaz: "qux"\n---';

		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_markdown({
			markdown: input,
			mut_yjsDoc: yjsDoc,
		});
		if (updateResult._nay) {
			throw new Error("Expected frontmatter-only markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_markdown({ yjsDoc });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		// ProseMirror appends a trailing empty paragraph so the document remains
		// editable when its only block is an atom; the markdown renderer surfaces
		// that as `\n\n` after the closing fence. A second round-trip is stable.
		expect(markdownResult._yay).toBe(`${input}\n\n`);
	});

	test("does not invent a frontmatter node for a body-only document", () => {
		const input = "# Heading\n\nBody text\n";

		const yjsDoc = new YDoc();
		const updateResult = files_yjs_doc_update_from_markdown({
			markdown: input,
			mut_yjsDoc: yjsDoc,
		});
		if (updateResult._nay) {
			throw new Error("Expected body-only markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = files_yjs_doc_get_markdown({ yjsDoc });
		if (markdownResult._nay) {
			throw new Error("Expected Yjs to markdown conversion to succeed", {
				cause: markdownResult._nay,
			});
		}

		expect(markdownResult._yay).toBe(input);
	});
});

describe("files_pending_path_overlay", () => {
	function make_overlay_node_id(value: string) {
		return value as app_convex_Doc<"files_nodes">["_id"];
	}

	function make_overlay_node(id: string, path: string, kind: "file" | "folder"): files_PendingPathOverlayNode {
		return { _id: make_overlay_node_id(id), path, kind };
	}

	function make_move_row(args: {
		nodeId: string;
		destParentId: string | typeof files_ROOT_ID;
		destName: string;
		replacesNodeId?: string;
	}): files_PendingPathOverlayRow {
		return {
			fileNodeId: make_overlay_node_id(args.nodeId),
			pendingMove: {
				destParentId: args.destParentId === files_ROOT_ID ? files_ROOT_ID : make_overlay_node_id(args.destParentId),
				destName: args.destName,
				fromPath: "",
				replacesNodeId: args.replacesNodeId ? make_overlay_node_id(args.replacesNodeId) : undefined,
			},
		};
	}

	function make_copy_row(args: {
		destNodeId: string;
		sourceNodeId: string;
		sourcePath: string;
		archivesSourceOnAccept?: boolean;
	}): files_PendingPathOverlayRow {
		return {
			fileNodeId: make_overlay_node_id(args.destNodeId),
			copiedFrom: {
				nodeId: make_overlay_node_id(args.sourceNodeId),
				path: args.sourcePath,
				archivesSourceOnAccept: args.archivesSourceOnAccept,
			},
		};
	}

	function build_overlay(rows: files_PendingPathOverlayRow[], nodes: files_PendingPathOverlayNode[]) {
		return files_pending_path_overlay_build({
			pendingUpdates: rows,
			nodesById: new Map<string, files_PendingPathOverlayNode>(nodes.map((node) => [node._id, node])),
		});
	}

	describe("rows that never affect paths", () => {
		test("an empty overlay leaves every path unchanged", () => {
			const overlay = build_overlay([], []);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});

		test("a content-only row leaves every path unchanged", () => {
			const overlay = build_overlay(
				[{ fileNodeId: make_overlay_node_id("a") }],
				[make_overlay_node("a", "/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
		});

		test("a plain copy row (no archivesSourceOnAccept) leaves the source visible", () => {
			// The copy destination is a real committed node already, so the overlay has nothing to add.
			const overlay = build_overlay(
				[make_copy_row({ destNodeId: "dest", sourceNodeId: "src", sourcePath: "/a.md" })],
				[make_overlay_node("src", "/a.md", "file"), make_overlay_node("dest", "/copy.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/copy.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
			// The copy destination is an eagerly created committed node; listings show it as-is.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/copy.md")).toBe("/copy.md");
		});
	});

	describe("file move", () => {
		const nodes = [make_overlay_node("a", "/a.md", "file"), make_overlay_node("docs", "/docs", "folder")];
		const rows = [make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" })];

		test("the destination path redirects to the committed source path", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/docs/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
		});

		test("the vacated source path is hidden", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "hidden" });
		});

		test("the committed source path projects onto the destination path", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/docs/b.md");
		});

		test("a file move hides only the exact source path, not lookalike siblings", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/ab.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/ab.md")).toBe("/ab.md");
		});

		test("a committed node at the claimed destination path is hidden from listings", () => {
			// A file created at /docs/b.md after the proposal is shadowed for the proposer;
			// accept auto-replaces it. Projection drops it so listings show the moved node once.
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/docs/b.md")).toBe(null);
		});

		test("the destination folder listing injects the moved file under its new name", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_list_injections(overlay, "/docs")).toEqual([
				{ nodeId: make_overlay_node_id("a"), kind: "file", committedPath: "/a.md", visibleName: "b.md" },
			]);
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});

		test("a move to the root folder works like any other destination", () => {
			const overlay = build_overlay(
				[make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b.md" })],
				[make_overlay_node("a", "/docs/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/docs/a.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/docs/a.md")).toBe("/b.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([
				{ nodeId: make_overlay_node_id("a"), kind: "file", committedPath: "/docs/a.md", visibleName: "b.md" },
			]);
		});

		test("an in-place rename projects the new name and adds no injection", () => {
			// The committed listing of /docs already contains the node; projection renames it.
			// An injection on top would show the same node twice.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" })],
				[make_overlay_node("a", "/docs/a.md", "file"), make_overlay_node("docs", "/docs", "folder")],
			);

			expect(files_pending_path_overlay_project_committed_path(overlay, "/docs/a.md")).toBe("/docs/b.md");
			expect(files_pending_path_overlay_translate_path(overlay, "/docs/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/docs/a.md",
			});
			expect(files_pending_path_overlay_list_injections(overlay, "/docs")).toEqual([]);
		});
	});

	describe("folder move", () => {
		const nodes = [make_overlay_node("a", "/a", "folder"), make_overlay_node("b", "/b", "folder")];
		const rows = [make_move_row({ nodeId: "a", destParentId: "b", destName: "c" })];

		test("the destination folder path and its descendants redirect into the source subtree", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/b/c")).toEqual({
				kind: "redirected",
				committedPath: "/a",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/b/c/sub/file.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/sub/file.md",
			});
		});

		test("the vacated folder path and its descendants are hidden", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/a")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_translate_path(overlay, "/a/sub/file.md")).toEqual({ kind: "hidden" });
		});

		test("committed descendant paths project onto the destination subtree", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a")).toBe("/b/c");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/sub/file.md")).toBe("/b/c/sub/file.md");
		});

		test("prefix matching respects path segment boundaries", () => {
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_translate_path(overlay, "/ab.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/b/cd.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/ab.md")).toBe("/ab.md");
		});

		test("committed paths at or under the claimed destination are hidden from listings", () => {
			// A committed folder or file created inside the claimed /b/c area after the
			// proposal is shadowed by the redirect; the source subtree shows there instead.
			const overlay = build_overlay(rows, nodes);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b/c")).toBe(null);
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b/c/late.md")).toBe(null);
		});
	});

	describe("stacked moves", () => {
		test("a move into a moved folder resolves through the parent's visible path", () => {
			// Folder /a becomes /b, and /x.md moves into that folder: the file shows at /b/x.md.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "x.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/x.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/x.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/b/x.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/b")).toEqual([
				{ nodeId: make_overlay_node_id("x"), kind: "file", committedPath: "/x.md", visibleName: "x.md" },
			]);
		});

		test("a rename inside a moved folder projects once and adds no injection", () => {
			// /a/x.md is already a committed child of the moved folder, so listing the
			// redirected folder /b covers it; its own rename row only changes the name.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "y.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/a/x.md", "file")],
			);

			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/x.md")).toBe("/b/y.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/b")).toEqual([]);
		});

		test("a renamed child's old visible path under a moved folder is hidden", () => {
			// /a/x.md is renamed to y.md inside the moved folder: the folder-prefix redirect
			// for /b/x.md no longer projects back onto /b/x.md, so the old path reads as gone.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "y.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/a/x.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/x.md")).toEqual({ kind: "hidden" });
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/b/x.md", occupantNodeId: null }),
			).toBe("none");
			// The child's own rename keeps working through the exact-redirect branch.
			expect(files_pending_path_overlay_translate_path(overlay, "/b/y.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/x.md",
			});
		});

		test("an untouched sibling under the same moved folder still redirects", () => {
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "a", destName: "y.md" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("x", "/a/x.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/s.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/s.md",
			});
		});

		test("a move claiming a vacated visible path inside a moved folder shadows the committed child", () => {
			// Folder /a becomes /b and /z.md moves onto /b/x.md (the visible path of the
			// committed child /a/x.md). The exact claim wins: lookups at /b/x.md read Z, so
			// projecting the committed child there too would make listings disagree with reads.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "z", destParentId: "a", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("x", "/a/x.md", "file"),
					make_overlay_node("z", "/z.md", "file"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/z.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/z.md")).toBe("/b/x.md");
			// The committed child is shadowed by the exact claim; the injection owns the path.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/x.md")).toBe(null);
			expect(files_pending_path_overlay_list_injections(overlay, "/b")).toEqual([
				{ nodeId: make_overlay_node_id("z"), kind: "file", committedPath: "/z.md", visibleName: "x.md" },
			]);
		});

		test("siblings inside the moved folder still project when another move claims one child path", () => {
			// The producing ancestor's own visible path prefixes every rewritten child, so only
			// EXACT claims may shadow: siblings of the claimed path keep projecting through.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "z", destParentId: "a", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("x", "/a/x.md", "file"),
					make_overlay_node("s", "/a/s.md", "file"),
					make_overlay_node("z", "/z.md", "file"),
				],
			);

			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/s.md")).toBe("/b/s.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a/sub/deep.md")).toBe("/b/sub/deep.md");
			expect(files_pending_path_overlay_translate_path(overlay, "/b/s.md")).toEqual({
				kind: "redirected",
				committedPath: "/a/s.md",
			});
		});

		test("chained moves keep each mapping single-hop", () => {
			// /a.md -> /b.md while /c.md -> /a.md: the vacated path is reused, no transitive chasing.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b.md" }),
					make_move_row({ nodeId: "c", destParentId: files_ROOT_ID, destName: "a.md" }),
				],
				[make_overlay_node("a", "/a.md", "file"), make_overlay_node("c", "/c.md", "file")],
			);

			// The redirect into /a.md wins over the "moved away" hiding of the same path.
			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({
				kind: "redirected",
				committedPath: "/c.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/c.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/b.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/c.md")).toBe("/a.md");
		});

		test("two files can swap paths", () => {
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b.md" }),
					make_move_row({ nodeId: "b", destParentId: files_ROOT_ID, destName: "a.md" }),
				],
				[make_overlay_node("a", "/a.md", "file"), make_overlay_node("b", "/b.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({
				kind: "redirected",
				committedPath: "/b.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/b.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b.md")).toBe("/a.md");
		});

		test("a destination-parent cycle drops all cycling rows", () => {
			// Folder /a into /b while folder /b into /a: no visible path can resolve, so
			// both rows are ignored instead of guessing an order.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: "b", destName: "a" }),
					make_move_row({ nodeId: "b", destParentId: "a", destName: "b" }),
				],
				[make_overlay_node("a", "/a", "folder"), make_overlay_node("b", "/b", "folder")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/b")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a")).toBe("/a");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b")).toBe("/b");
		});

		test("a destination-parent cycle leaves unrelated rows applied", () => {
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: "b", destName: "a" }),
					make_move_row({ nodeId: "b", destParentId: "a", destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "docs", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("b", "/b", "folder"),
					make_overlay_node("x", "/x.md", "file"),
					make_overlay_node("docs", "/docs", "folder"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/docs/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/x.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/docs/x.md");
		});

		test("a move into a committed subfolder of a moved folder resolves through the prefix rewrite", () => {
			// Folder /a becomes /b; /a/sub has NO row of its own, its visible path /b/sub
			// exists only through the ancestor rewrite. A move whose destination parent is
			// that committed subfolder must land under the rewritten path.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: files_ROOT_ID, destName: "b" }),
					make_move_row({ nodeId: "x", destParentId: "sub", destName: "x.md" }),
				],
				[
					make_overlay_node("a", "/a", "folder"),
					make_overlay_node("sub", "/a/sub", "folder"),
					make_overlay_node("x", "/x.md", "file"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b/sub/x.md")).toEqual({
				kind: "redirected",
				committedPath: "/x.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/b/sub/x.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/b/sub")).toEqual([
				{ nodeId: make_overlay_node_id("x"), kind: "file", committedPath: "/x.md", visibleName: "x.md" },
			]);
		});

		test("two moves onto the same visible path drop all colliding rows", () => {
			// Proposal-time validation prevents this state; if rows still collide, do not
			// guess a winner — both nodes stay visible at their committed paths.
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "x", destParentId: files_ROOT_ID, destName: "n.md" }),
					make_move_row({ nodeId: "y", destParentId: files_ROOT_ID, destName: "n.md" }),
				],
				[make_overlay_node("x", "/x.md", "file"), make_overlay_node("y", "/y.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/n.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/x.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_translate_path(overlay, "/y.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/x.md")).toBe("/x.md");
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});
	});

	describe("replace-move", () => {
		test("a structural replace shows the source at the destination and hides the replaced node", () => {
			// mv -f between non-editable files: the SOURCE node moves onto the destination
			// path and the current destination owner is archived on accept.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "src", destParentId: "media", destName: "new.mp4", replacesNodeId: "target" })],
				[
					make_overlay_node("src", "/old.mp4", "file"),
					make_overlay_node("media", "/media", "folder"),
					make_overlay_node("target", "/media/new.mp4", "file"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/media/new.mp4")).toEqual({
				kind: "redirected",
				committedPath: "/old.mp4",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/old.mp4")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/old.mp4")).toBe("/media/new.mp4");
			// The replaced node leaves the visible tree entirely.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/media/new.mp4")).toBe(null);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, {
					requestedPath: "/media/new.mp4",
					occupantNodeId: "target",
				}),
			).toBe("redirected");
			// The moved-away source at its vacated path reads as missing.
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/old.mp4", occupantNodeId: "src" }),
			).toBe("none");
		});

		test("a replace whose target node is missing degrades to a plain move", () => {
			// The target was archived or deleted after the proposal. Accept then performs a
			// plain move, so the overlay must show the same thing instead of going inert.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "src", destParentId: "media", destName: "new.mp4", replacesNodeId: "ghost" })],
				[make_overlay_node("src", "/old.mp4", "file"), make_overlay_node("media", "/media", "folder")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/media/new.mp4")).toEqual({
				kind: "redirected",
				committedPath: "/old.mp4",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/old.mp4")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/old.mp4")).toBe("/media/new.mp4");
		});

		test("a replace whose target has its own pending move lets both rows apply", () => {
			// Node a is moving to /docs/b.md, and node c replaces it at /a.md. Node a follows
			// its own move instead of being hidden as a replaced target. This matches the
			// non-destructive accept order (accept a's move first, then c's move onto the
			// vacated path proceeds plainly).
			const overlay = build_overlay(
				[
					make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" }),
					make_move_row({ nodeId: "c", destParentId: files_ROOT_ID, destName: "a.md", replacesNodeId: "a" }),
				],
				[
					make_overlay_node("a", "/a.md", "file"),
					make_overlay_node("c", "/c.md", "file"),
					make_overlay_node("docs", "/docs", "folder"),
				],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/docs/b.md")).toEqual({
				kind: "redirected",
				committedPath: "/a.md",
			});
			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({
				kind: "redirected",
				committedPath: "/c.md",
			});
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/docs/b.md");
			expect(files_pending_path_overlay_project_committed_path(overlay, "/c.md")).toBe("/a.md");
		});

		test("an editable replace hides the source and keeps the destination committed", () => {
			// mv -f between editable files is stored as a copy on the destination node plus
			// archivesSourceOnAccept: only the source disappears from the visible tree.
			const overlay = build_overlay(
				[
					make_copy_row({
						destNodeId: "dest",
						sourceNodeId: "src",
						sourcePath: "/a.md",
						archivesSourceOnAccept: true,
					}),
				],
				[make_overlay_node("src", "/a.md", "file"), make_overlay_node("dest", "/b.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "hidden" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe(null);
			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({ kind: "unchanged" });
			// The destination keeps its identity; listings show it at its own path.
			expect(files_pending_path_overlay_project_committed_path(overlay, "/b.md")).toBe("/b.md");
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/b.md", occupantNodeId: "dest" }),
			).toBe("occupant");
			// The copy-archived source at its own path reads as missing.
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/a.md", occupantNodeId: "src" }),
			).toBe("none");
		});
	});

	describe("files_pending_path_overlay_pick_visible_entry", () => {
		const nodes = [make_overlay_node("a", "/a.md", "file"), make_overlay_node("docs", "/docs", "folder")];
		const rows = [make_move_row({ nodeId: "a", destParentId: "docs", destName: "b.md" })];

		test("an untouched committed occupant wins", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/other.md", occupantNodeId: "n" }),
			).toBe("occupant");
		});

		test("a redirect with no committed occupant is presented", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/docs/b.md", occupantNodeId: null }),
			).toBe("redirected");
		});

		test("the moved-away occupant of a vacated path reads as missing", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/a.md", occupantNodeId: "a" }),
			).toBe("none");
		});

		test("a node created at a vacated path after the proposal stays visible", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, {
					requestedPath: "/a.md",
					occupantNodeId: "newcomer",
				}),
			).toBe("occupant");
		});

		test("a pending move claims its destination even over a newer committed node", () => {
			// Someone created /docs/b.md after the proposal. The move keeps its claim: the
			// proposer sees the moved node there, and accept auto-replaces (soft-archives)
			// the occupant like mv -f. The pending panel shows "Replaces" before accept.
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, {
					requestedPath: "/docs/b.md",
					occupantNodeId: "newcomer",
				}),
			).toBe("redirected");
		});

		test("a missing path with no redirect reads as missing", () => {
			const overlay = build_overlay(rows, nodes);
			expect(
				files_pending_path_overlay_pick_visible_entry(overlay, { requestedPath: "/nope.md", occupantNodeId: null }),
			).toBe("none");
		});
	});

	describe("rows with missing node data are inert", () => {
		test("a move row whose node is not in nodesById does nothing", () => {
			const overlay = build_overlay(
				[make_move_row({ nodeId: "ghost", destParentId: files_ROOT_ID, destName: "b.md" })],
				[],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/b.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_list_injections(overlay, "/")).toEqual([]);
		});

		test("a move row whose destination parent is not in nodesById does nothing", () => {
			// The source must stay visible: a half-applied overlay would hide the node everywhere.
			const overlay = build_overlay(
				[make_move_row({ nodeId: "a", destParentId: "ghost-folder", destName: "b.md" })],
				[make_overlay_node("a", "/a.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
			expect(files_pending_path_overlay_project_committed_path(overlay, "/a.md")).toBe("/a.md");
		});

		test("an editable replace row whose source node is not in nodesById hides nothing", () => {
			const overlay = build_overlay(
				[
					make_copy_row({
						destNodeId: "dest",
						sourceNodeId: "ghost",
						sourcePath: "/a.md",
						archivesSourceOnAccept: true,
					}),
				],
				[make_overlay_node("dest", "/b.md", "file")],
			);

			expect(files_pending_path_overlay_translate_path(overlay, "/a.md")).toEqual({ kind: "unchanged" });
		});
	});
});
