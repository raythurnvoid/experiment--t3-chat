import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	pages_parse_markdown_to_html,
	pages_tiptap_markdown_to_json,
	pages_tiptap_markdown_to_plain_text,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_markdown,
} from "./pages.ts";
import { Doc as YDoc } from "yjs";

describe("pages_tiptap_markdown_to_json", () => {
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
		const result = pages_tiptap_markdown_to_json({
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
		const result = pages_tiptap_markdown_to_json({
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
		const noTrailingWhitespace = pages_tiptap_markdown_to_json({
			markdown: "hello",
		});
		const trailingSpace = pages_tiptap_markdown_to_json({
			markdown: "hello ",
		});
		const trailingNewline = pages_tiptap_markdown_to_json({
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
		expect((trailingNewline._yay.content ?? []).length).toBeGreaterThan((noTrailingWhitespace._yay.content ?? []).length);
	});

	test("preserves trailing whitespace at EOF for heading markdown through JSON conversion", () => {
		const result = pages_tiptap_markdown_to_json({
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

describe("pages_tiptap_markdown_to_plain_text", () => {
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

		const result = pages_tiptap_markdown_to_plain_text({
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

		const result = pages_tiptap_markdown_to_plain_text({
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

describe("pages_parse_markdown_to_html", () => {
	test("preserves trailing newline shape at EOF", () => {
		const noTrailingNewline = pages_parse_markdown_to_html("hello");
		const oneTrailingNewline = pages_parse_markdown_to_html("hello\n");
		const threeTrailingNewlines = pages_parse_markdown_to_html("hello\n\n\n");

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
		const noTrailingSpace = pages_parse_markdown_to_html("hello");
		const oneTrailingSpace = pages_parse_markdown_to_html("hello ");

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

describe("pages_yjs_doc_update_from_markdown", () => {
	test("preserves trailing whitespace at EOF through the Yjs round-trip", () => {
		const yjsDoc = new YDoc();
		const updateResult = pages_yjs_doc_update_from_markdown({
			markdown: "hello ",
			mut_yjsDoc: yjsDoc,
		});

		if (updateResult._nay) {
			throw new Error("Expected markdown to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = pages_yjs_doc_get_markdown({
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
		const updateResult = pages_yjs_doc_update_from_markdown({
			markdown: "# Base\n\n ",
			mut_yjsDoc: yjsDoc,
		});

		if (updateResult._nay) {
			throw new Error("Expected markdown with trailing whitespace-only line to Yjs conversion to succeed", {
				cause: updateResult._nay,
			});
		}

		const markdownResult = pages_yjs_doc_get_markdown({
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
