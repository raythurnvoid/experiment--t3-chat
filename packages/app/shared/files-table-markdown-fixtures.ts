/**
 * Markdown fixtures for the GFM table round trip.
 *
 * Both `packages/app/shared/files.test.ts` and the browser suite in
 * `packages/app/src/components/files/file-editor/file-editor-rich-text/extensions.test.ts` import
 * these, so the two suites cannot drift apart. Keep the backslash counts exactly as written: a
 * wrong count turns a fixture into a different test that still passes.
 */

export const table_canonical_2x2 = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
export const table_alignments = "| L | C | R |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n";

// Cell text holds one pipe. One backslash in the file escapes it.
export const table_pipe_in_cell = "| a \\| b | c |\n| --- | --- |\n| 1 | 2 |\n";

// Cell text holds a real backslash and then a pipe. That needs THREE backslashes in the file.
// With only two, marked reads a real backslash plus a real pipe, the row gains a cell, and the
// whole table becomes a paragraph. This is the fixture that catches the table-destroying bug.
export const table_backslash_before_pipe = "| a \\\\\\| b | c |\n| --- | --- |\n| 1 | 2 |\n";

export const table_empty_cell = "| a |  |\n| --- | --- |\n| 1 | 2 |\n";
export const table_inline_marks =
	"| **b** | `x \\| y` | [l](https://e.com) |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n";
export const table_comment_span =
	'| <span data-type="comment" data-lb-thread-id="th_1">hi</span> | b |\n| --- | --- |\n| 1 | 2 |\n';
export const table_hard_break = "| a<br>b | c |\n| --- | --- |\n| 1 | 2 |\n";
export const table_between_paragraphs = "before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n";
export const table_last_block = "before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";

// A code span cannot hold a backslash in front of a pipe with backticks: the backslash run would
// grow on every save. The serializer writes such a span as an HTML code element with numeric
// character references instead, so the first pass reformats it and every pass after that is stable.
export const table_code_span_backslash = "| `x \\\\\\| y` | c |\n| --- | --- |\n| 1 | 2 |\n";

// The same entity rewrite must also disarm markdown syntax inside the code text. Between the
// written code tags the text is ordinary inline markdown to marked, so an unescaped `**b**`
// would come back as bold and the asterisks would be deleted from the member's code.
export const table_code_span_markdown_active = "| `a **b** \\\\\\| c` | d |\n| --- | --- |\n| 1 | 2 |\n";

// Foreign inputs. The first normalize reformats them; every normalize after that changes nothing.
export const table_ragged = "|  A   |B|\n|---|:-:|\n| 1 |    2 |\n";
export const table_no_outer_pipes = "A | B\n--- | ---\n1 | 2\n";
export const table_padded_cells = "| a  |   b |\n| --- | --- |\n| 1 | 2 |\n";
export const table_in_list_item = "- item\n\n  | A | B |\n  | --- | --- |\n  | 1 | 2 |\n";
