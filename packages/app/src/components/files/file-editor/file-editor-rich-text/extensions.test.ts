import { describe, expect, test } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import { defaultExtensions, nonCollaborativeExtensions } from "./extensions.ts";
import { files_tiptap_markdown_to_json } from "../../../../../shared/files-tiptap.ts";
import {
	table_canonical_2x2,
	table_alignments,
	table_pipe_in_cell,
	table_backslash_before_pipe,
	table_comment_span,
	table_code_span_backslash,
	table_code_span_markdown_active,
} from "../../../../../shared/files-table-markdown-fixtures.ts";

describe("browser extension list table schema", () => {
	// For a non-collaborative file the browser serializer is the only writer of the stored bytes,
	// so a table node missing from `defaultExtensions` would silently drop every table on save
	// while the shared suite stayed green. This test guards the browser list itself.
	const schema = getSchema(defaultExtensions);

	function serialize_markdown(editor: Editor) {
		if (!editor.markdown) {
			throw new Error("Expected the markdown manager to be set");
		}
		return editor.markdown.serialize(editor.getJSON());
	}

	test("registers all four table nodes", () => {
		expect(schema.nodes.table).toBeDefined();
		expect(schema.nodes.tableRow).toBeDefined();
		expect(schema.nodes.tableHeader).toBeDefined();
		expect(schema.nodes.tableCell).toBeDefined();
	});

	test("uses the extended cells with the align attribute", () => {
		// A plain vendored cell has no `align`, so a browser save would drop column alignment.
		expect(schema.nodes.tableCell.spec.attrs?.align?.default).toBe(null);
		expect(schema.nodes.tableHeader.spec.attrs?.align?.default).toBe(null);
	});

	test("keeps the vendored cell attributes", () => {
		const attrs = schema.nodes.tableCell.spec.attrs;
		expect(attrs?.colspan).toBeDefined();
		expect(attrs?.rowspan).toBeDefined();
		expect(attrs?.colwidth).toBeDefined();
	});

	test("keeps cells paragraph-only", () => {
		expect(schema.nodes.tableCell.spec.content).toBe("paragraph+");
		expect(schema.nodes.tableHeader.spec.content).toBe("paragraph+");
	});

	test("serializes a canonical table to the shared canonical string", () => {
		const json = files_tiptap_markdown_to_json({ markdown: table_canonical_2x2, extensions: defaultExtensions });
		if (json._nay) {
			throw new Error("Expected the canonical table to parse through the browser list", { cause: json._nay });
		}

		const editor = new Editor({ element: null, extensions: defaultExtensions, content: json._yay });
		const markdown = serialize_markdown(editor);
		editor.destroy();

		// The block itself has no trailing newline; `files_yjs_doc_get_text` adds the file's one.
		expect(markdown + "\n").toBe(table_canonical_2x2);
	});

	test("keeps a code-marked backslash-pipe cell exact and stable through the browser path", () => {
		const editor = new Editor({
			element: null,
			extensions: defaultExtensions,
			content: {
				type: "doc",
				content: [
					{
						type: "table",
						content: [
							{
								type: "tableRow",
								content: [
									{
										type: "tableHeader",
										content: [
											{
												type: "paragraph",
												content: [{ type: "text", text: "x \\| y", marks: [{ type: "code" }] }],
											},
										],
									},
									{
										type: "tableHeader",
										content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }],
									},
								],
							},
							{
								type: "tableRow",
								content: [
									{
										type: "tableCell",
										content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
									},
									{
										type: "tableCell",
										content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }],
									},
								],
							},
						],
					},
				],
			},
		});
		const firstPass = serialize_markdown(editor);
		editor.destroy();

		expect(firstPass).toBe("| <code>x &#92;&#124; y</code> | c |\n| --- | --- |\n| 1 | 2 |");

		// Parse the entity form back through the browser list: the member's exact text and the
		// code mark must survive, and a second serialization must change nothing.
		const parsed = files_tiptap_markdown_to_json({ markdown: firstPass, extensions: defaultExtensions });
		if (parsed._nay) {
			throw new Error("Expected the entity code form to parse through the browser list", { cause: parsed._nay });
		}

		const flat = JSON.stringify(parsed._yay);
		expect(flat).toContain(JSON.stringify("x \\| y"));
		expect(flat).toContain('"type":"code"');

		const secondEditor = new Editor({ element: null, extensions: defaultExtensions, content: parsed._yay });
		const secondPass = serialize_markdown(secondEditor);
		secondEditor.destroy();

		expect(secondPass).toBe(firstPass);
	});
});

describe("non-collaborative markdown normalization is idempotent", () => {
	// The mounted non-collaborative editor is the only writer of these files, and it serializes
	// with `nonCollaborativeExtensions`, not the shared list. This suite proves that serializer
	// is stable: the first pass may reformat, and every pass after that changes nothing.
	//
	// Do not use `files_headless_tiptap_editor_create` here: it always starts from the shared
	// list, so it would mount two StarterKits and two Markdown extensions. Copy its headless
	// `Editor` options instead, including the state update that installs plugins, which
	// `createView()` would normally do.
	function normalize(markdown: string) {
		const json = files_tiptap_markdown_to_json({ markdown, extensions: nonCollaborativeExtensions });
		if (json._nay) {
			throw new Error("Expected markdown to parse through the non-collaborative list", { cause: json._nay });
		}

		const editor = new Editor({
			element: null,
			content: json._yay,
			extensions: nonCollaborativeExtensions,
			enableCoreExtensions: false,
			enableInputRules: false,
			enablePasteRules: false,
			coreExtensionOptions: {
				delete: { async: false },
			},
		});
		editor.view.updateState(
			editor.state.reconfigure({
				plugins: editor.extensionManager.plugins,
			}),
		);

		if (!editor.markdown) {
			throw new Error("Expected the markdown manager to be set");
		}
		const output: string = editor.markdown.serialize(editor.getJSON());
		editor.destroy();

		// The trailing-`\n` rule the editor's `getCurrentText` applies before every save.
		return output !== "" && !output.endsWith("\n") ? output + "\n" : output;
	}

	// A table that loses its column count comes back from marked as a plain paragraph, and the parse
	// keeps the paragraph's newlines, so the pipe lines survive in the text. Looking for a delimiter
	// row in the output would therefore pass on a document with no table in it. Parse the output back
	// and look for the node instead.
	function expect_still_a_table(markdown: string) {
		const json = files_tiptap_markdown_to_json({ markdown, extensions: nonCollaborativeExtensions });
		if (json._nay) {
			throw new Error("Expected table markdown to parse", { cause: json._nay });
		}

		expect(JSON.stringify(json._yay)).toContain('"type":"table"');
	}

	test("keeps a canonical document byte for byte, so the second save is a no-op", () => {
		const input = "# Heading\n\nBody text\n";
		expect(normalize(input)).toBe(input);
	});

	test("un-escapes a backslash-escaped date once, then holds still", () => {
		const once = normalize("Meeting on 2026\\-08\\-30\n");
		expect(once).toContain("2026-08-30");
		expect(normalize(once)).toBe(once);
	});

	test("settles headings, lists, code fences, task lists and frontmatter after one pass", () => {
		const fixtures = [
			"# Title\n\nDated 2026-08-30\n",
			"* one\n* two\n",
			"1. one\n2. two\n",
			"```ts\nconst a = 1;\n```\n",
			"- [ ] todo\n- [x] done\n",
			'---\nfoo: bar\nbaz: "qux"\n---\n\nBody\n',
		];
		for (const fixture of fixtures) {
			const once = normalize(fixture);
			expect(normalize(once)).toBe(once);
		}
	});

	test("settles trailing-newline variants", () => {
		for (const fixture of ["text", "text\n", "text\n\n\n"]) {
			const once = normalize(fixture);
			expect(normalize(once)).toBe(once);
		}
	});

	test("keeps a paragraph comment mark span stable", () => {
		// The targeted comment save writes exactly this span through this serializer.
		const once = normalize('Hello <span data-type="comment" data-lb-thread-id="t1">world</span> again.\n');
		expect(once).toContain('data-lb-thread-id="t1"');
		expect(normalize(once)).toBe(once);
	});

	// Table fixtures never assert idempotence alone: a table degraded to a paragraph is
	// idempotent too. Assert the exact expected bytes and parse the output back for the node.
	test("keeps the imported canonical table fixtures byte for byte", () => {
		const fixtures = [
			table_canonical_2x2,
			table_alignments,
			table_pipe_in_cell,
			table_backslash_before_pipe,
			table_comment_span,
		];
		for (const fixture of fixtures) {
			const output = normalize(fixture);
			expect(output).toBe(fixture);
			expect_still_a_table(output);
		}
	});

	test("reformats the code-span backslash fixture once, then holds still", () => {
		// Product decision: the serializer writes the span as an HTML code element with numeric
		// character references, so the backslash run cannot grow.
		const expected = "| <code>x &#92;&#92;&#124; y</code> | c |\n| --- | --- |\n| 1 | 2 |\n";
		const output = normalize(table_code_span_backslash);
		expect(output).toBe(expected);
		expect_still_a_table(output);
		expect(normalize(output)).toBe(output);
	});

	test("disarms markdown syntax inside the HTML code element form, stable", () => {
		// Between the written code tags the text is ordinary inline markdown to marked, so an
		// unescaped `**b**` would come back as bold and the asterisks would be deleted.
		const expected = "| <code>a &#42;&#42;b&#42;&#42; &#92;&#92;&#124; c</code> | d |\n| --- | --- |\n| 1 | 2 |\n";
		const output = normalize(table_code_span_markdown_active);
		expect(output).toBe(expected);
		expect_still_a_table(output);
		expect(normalize(output)).toBe(output);
	});
});
