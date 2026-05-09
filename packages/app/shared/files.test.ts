import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	files_find_file_stem_end_index,
	files_get_normalized_node_path_segments,
	files_normalize_name_input,
	files_normalize_name,
	files_parse_markdown_to_html,
	files_tiptap_markdown_to_json,
	files_tiptap_markdown_to_plain_text,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
} from "./files.ts";
import { Doc as YDoc } from "yjs";

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

describe("files_get_normalized_node_path_segments", () => {
	test.each(
		[
			[null, "docs/readme", null],
			["file", "", null],
			["file", "/", null],
			["folder", "Docs / Feature Plan", { normalizedPathSegments: ["docs", "feature-plan"] }],
			["file", "Docs / readme", { normalizedPathSegments: ["docs", "README.md"] }],
			["file", "docs/archive.tar.gz", { normalizedPathSegments: ["docs", "archive-tar.md"] }],
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
		["readme.txt", "README.md"],
		["New File.md", "new-file.md"],
		["notes.txt", "notes.md"],
		["Résumé.DOC", "resume.md"],
		["a\u1ab0file.md", "afile.md"],
		["---notes---.MD", "notes.md"],
		["___notes___.md", "notes.md"],
		["a@b#c!.md", "a-b-c.md"],
		["asd/.txt", "asd.md"],
		["x.", "x.md"],
		["test.", "test.md"],
		[".test", "untitled.md"],
		["test/test.txt", "test-test.md"],
		["test//test.txt", "test-test.md"],
		["bad\\name.md", "bad-name.md"],
		["archive.tar.gz", "archive-tar.md"],
		["folder/file.name.with.many.dots", "folder-file-name-with-many.md"],
		["  spaced name.md  ", "spaced-name.md"],
		["你好.md", "untitled.md"],
		["emoji😊file.md", "emoji-file.md"],
		["2026 plan.final", "2026-plan.md"],
		["multi___under.txt", "multi_under.md"],
		["test___test.md", "test_test.md"],
		["test---test.md", "test-test.md"],
	])("normalizes file %s to %s", (input, expected) => {
		expect(files_normalize_name("file", input)).toEqual({ _yay: expected });
	});

	test.each(["..", ".", "test..test", "test.txt/test", "test.txt\\test", "test.m d"])(
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
