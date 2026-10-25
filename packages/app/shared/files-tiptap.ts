// Tiptap/Markdown helpers for files: the marked pipeline, shared extensions, and headless editors.
//
// Split out of `shared/files.ts` for module-eval weight: the Tiptap suite (and `marked`) must not
// load for consumers that only need the lean helpers in `shared/files.ts` or the Yjs helpers in
// `shared/files-yjs.ts`.

import { StarterKit } from "@tiptap/starter-kit";
import { Code } from "@tiptap/extension-code";
import { Markdown, MarkdownManager, type MarkdownExtensionOptions } from "@tiptap/markdown";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { Highlight } from "@tiptap/extension-highlight";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import {
	marked,
	Marked,
	Lexer,
	Renderer,
	Tokenizer,
	type Links,
	type MarkedExtension,
	type Rules,
	type Token,
	type Tokens,
} from "marked";
import type { Doc as YDoc } from "yjs";
import {
	Editor,
	Extension,
	Mark,
	Node,
	getMarkDelimiters,
	getSchema,
	getText,
	getTextSerializersFromSchema,
	markdownSyntaxAttribute,
	type Extensions,
} from "@tiptap/core";
import type { JSONContent as TiptapJSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { DOMParser as ProseMirrorDOMParser, Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { DOMParser as LinkedomDOMParser } from "linkedom/worker";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { is_browser, should_never_happen } from "./shared-utils.ts";
import { files_COMMENT_MARK_TYPE, files_CommentsExtension } from "./files-tiptap-comments.ts";
import { generateJSON as tiptap_generateJSON_server } from "@tiptap/html/server";
import { generateJSON as tiptap_generateJSON_browser } from "@tiptap/html";
import { Result } from "common/errors-as-values-utils.ts";
import { files_tiptap_empty_doc_json, files_YJS_DOC_KEYS, type files_YjsRootKind } from "./files.ts";
import {
	files_yjs_doc_check_text_addressable,
	files_yjs_doc_create_from_tiptap_editor,
	files_yjs_doc_create_plain_text_from_text,
	files_yjs_doc_get_plain_text,
	files_yjs_doc_update_from_tiptap_editor,
	files_yjs_doc_update_plain_text_from_text,
} from "./files-yjs.ts";

// The lookbehinds make a trailing-run regex try each run only from its first character. Without them,
// the regex retried from every character of a long run in the middle of the text, which took seconds.
const TRAILING_SPACES_OR_TABS_REGEX = /(?<![ \t])[ \t]+$/;
const TRAILING_WHITESPACE_ONLY_LINE_REGEX = /\n([ \t]+)$/;
const TRAILING_NEWLINES_REGEX = /(?<!\n)\n+$/;
// Newlines between two HTML tags are the writer's layout, not document text. Marked puts a blank
// line between two raw HTML blocks, so this must match a run of newlines. With only one newline
// matched, the blank line survived into the document as a "\n\n" text node next to an inline
// image, and every re-parse wrote it back plus a new blank line, so each copy of a copy grew.
const STRUCTURAL_HTML_WHITESPACE_REGEX = />(?:\n[ \t]*)+</g;
const HTML_TAG_NAME_START_REGEX = /^<\/?([a-z][a-z0-9-]*)/i;
// A newline between two of these tags is a soft line break in the text, like `*a*\n<u>b</u>`.
const HTML_INLINE_LAYOUT_TAG_NAMES = new Set([
	"a",
	"b",
	"br",
	"code",
	"del",
	"em",
	"i",
	"img",
	"kbd",
	"mark",
	"s",
	"span",
	"strike",
	"strong",
	"sub",
	"sup",
	"u",
]);
const TRAILING_HARD_BREAKS_REGEX = /(?<!\\\n)(?:\\\n)+$/;
const HARD_BREAK_REGEX = /\\\n/g;
const HIGHLIGHT_SPACE_INSIDE_REGEX = /^==\s|\s==$/;
const CODE_BLOCK_HTML_FINAL_NEWLINE_REGEX = /\n<\/code><\/pre>\n$/;
const LIST_MARKER_REGEX = /^ {0,3}(?:([*+])|\d{1,9}(\)))/;
const NESTED_LIST_LINE_REGEX = /^ *(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const VIDEO_BLOCK_START_REGEX = /^<video[\s>]/m;
const VIDEO_BLOCK_REGEX = /^(<video\b[^>]*>(?:\s*<\/video>)?)[ \t]*(?:\n|$)/;
const FOOTNOTE_DEFINITION_START_REGEX = /^ {0,3}\[\^[^\]\s]+\]:/;
// The line end, then any blank lines, before the next part of a footnote definition block.
const FOOTNOTE_DEFINITION_GAP_REGEX = /^\n(?:[ \t]*\n)*/;
const FOOTNOTE_DEFINITION_INDENTED_LINE_REGEX = /^(?: {4}|\t)[ \t]*\S/;
// Marked's own paragraph rule, with a cheaper table check. Every instance here uses `gfm: true`.
// At each line the rule asks whether a table starts there, with the whole table pattern. Its rows part
// reads every later line that cannot end a table, so lines like `<?a?>` and `-|-` made each check read
// the rest of the file. The rows part can always match nothing, so a check that keeps only the header
// and align lines gives the same answer.
const PARAGRAPH_REGEX = ((/* iife */) => {
	const paragraph = Lexer.rules.block.gfm.paragraph;
	const table = Lexer.rules.block.gfm.table.source.replace(/^\^/, "");
	const rowsStart = table.indexOf("(?:\\n((?:(?! *\\n|");
	// Require the rows group to repeat with `*`. Only then can it match nothing.
	if (!paragraph.source.includes(table) || rowsStart === -1 || !table.endsWith(")*)\\n*|$)")) {
		throw should_never_happen("Marked's paragraph or table pattern changed");
	}

	return new RegExp(
		paragraph.source.replace(table, () => table.slice(0, rowsStart) + "(?:\\n|$)"),
		paragraph.flags,
	);
})();
// The line patterns Tiptap's Markdown tokenizers use for ordered list items and task items. An ordered
// item may be empty, like `2.`.
const ORDERED_LIST_ITEM_LINE_REGEX = /^(\s*)(\d+)\.(?:\s+(.*))?$/;
const TASK_ITEM_LINE_REGEX = /^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$/;
const INDENTED_LINE_REGEX = /^\s/;
// A markdown link destination ends at the first space or unbalanced parenthesis, so a url
// containing either needs the `<...>` form instead.
const MARKDOWN_URL_NEEDS_ANGLE_BRACKETS_REGEX = /[\s()]/;

// Work units of a limited Markdown parse. One unit is about one nanosecond of local CPU. The weights come
// from timing slow inputs, such as many `*a ` in one paragraph, against Marked 17.
const MARKDOWN_WORK_NONBLANK_LINE = 2000;
const MARKDOWN_WORK_BLANK_LINE = 200;
const MARKDOWN_WORK_BLOCK_STEP = 1000;
const MARKDOWN_WORK_BLOCK_TEXT_PER_CHAR = 8;
const MARKDOWN_WORK_INLINE_TEXT_PER_CHAR = 1;
const MARKDOWN_WORK_INLINE_STEP = 800;
const MARKDOWN_WORK_INLINE_STEP_PER_CHAR = 0.25;
const MARKDOWN_WORK_INLINE_EMAIL_SCAN_PER_CHAR = 3;
const MARKDOWN_WORK_INLINE_ESCAPED_CHAR = 130;
const MARKDOWN_WORK_LINK_SCAN_PER_CHAR = 3;
const MARKDOWN_WORK_URL_SCAN_PER_CHAR = 2;
const MARKDOWN_WORK_MARKER_SEARCH_PER_CHAR = 0.5;
const MARKDOWN_WORK_MARKER_SEARCH_PER_CANDIDATE = 60;
const MARKDOWN_WORK_URL_BACKPEDAL_PER_CHAR = 6;
const MARKDOWN_WORK_INLINE_MASK_PER_CHAR = 0.3;
const MARKDOWN_WORK_EMPHASIS_SCAN_PER_CHAR = 100;
const MARKDOWN_WORK_STRIKE_SCAN_PER_CHAR = 70;
const MARKDOWN_WORK_CODE_SPAN_SCAN_PER_CHAR = 1.5;
const MARKDOWN_WORK_VIDEO_SCAN_PER_CHAR = 10;
const MARKDOWN_WORK_VIDEO_START_PER_CHAR = 1;
const MARKDOWN_WORK_FOOTNOTE_SCAN_PER_CHAR = 1;
const MARKDOWN_WORK_LIST_BLOCK_PER_CHAR = 4;
const MARKDOWN_WORK_LEXER_CALL = 1500;
const MARKDOWN_WORK_LINK_DEFINITION_PER_CALL = 100;
const MARKDOWN_WORK_REFERENCE_COPIED_CHAR = 40;
const MARKDOWN_WORK_TASK_LIST_COPIED_LINE = 6;
const MARKDOWN_WORK_TASK_LIST_REREAD_CHAR = 1;
const MARKDOWN_WORK_SETEXT_SCAN_PER_CHAR = 3;
const MARKDOWN_WORK_SETEXT_SCAN_PER_LINE = 40;
const MARKDOWN_WORK_BLOCKQUOTE_COPIED_LINE = 8;
const MARKDOWN_WORK_BLOCKQUOTE_COPIED_CHAR = 2;
const MARKDOWN_WORK_TABLE_CELL = 500;
const MARKDOWN_WORK_HTML_TABLE_SCAN_PER_CHAR = 1;
const MARKDOWN_NONBLANK_LINE_REGEX = /^[ \t]*[^ \t\n]/gm;

/**
 * Most characters Tiptap may copy for nested list items in one limited parse. For each nesting level,
 * Tiptap's ordered and task lists copy the text of every item below it and keep the copies until the
 * parse ends. That costs memory, not time, so the work units cannot limit it. About 4 bytes of memory
 * per character were measured, so this keeps the copies near 8 MB. A normal nested list needs far less.
 */
const MARKDOWN_MAX_LIST_COPIED_CHARS = 2_000_000;

class MarkdownWorkLimitError extends Error {}

/**
 * The work counter of the limited parse that runs now, or `null`. Marked parses synchronously, so only
 * one parse uses it at a time.
 */
let markdown_work: { used: number; limit: number; listCopiedChars: number } | null = null;

/**
 * The hidden-link check of the public parse that runs now, or `null`. It gets a link's address and
 * returns the text that replaces a hidden link's label, or `null` to keep the label.
 */
let markdown_hidden_link_text: ((href: string) => string | null) | null = null;

function markdown_work_add(units: number) {
	if (markdown_work === null) {
		return;
	}

	markdown_work.used += units;
	if (markdown_work.used > markdown_work.limit) {
		throw new MarkdownWorkLimitError("Markdown needs too much work to parse");
	}
}

/**
 * Configure Markdown parsing for files and editor instances.
 */
function configure_marked(instance: Marked | typeof marked) {
	instance.setOptions({
		gfm: true,
		breaks: false,
	});

	// Tiptap registers a custom `taskList` tokenizer on the same marked instance
	// in `packages/app/vendor/tiptap/packages/extension-list/src/task-list/task-list.ts` (line 76).
	// Add a renderer for it so `marked.parse()` can emit HTML for task lists.
	instance.use({
		extensions: [
			{
				// YAML-style frontmatter. Recognized only at the start of the root
				// document token stream so nested list/blockquote content keeps its
				// normal Markdown meaning. The emitted HTML round-trips through
				// `files_frontmatter_node.parseHTML` -> Tiptap JSON -> `renderMarkdown`.
				// It has no `start`. Marked runs this tokenizer first at the start of the document anyway. With a
				// `start`, Marked ended a paragraph after its first character when `---` came next. So `\---`
				// became a lone `\` and a divider.
				name: "frontmatter",
				level: "block",
				tokenizer(this: { lexer: { tokens: unknown } }, src, tokens) {
					if (tokens !== this.lexer.tokens) return undefined;
					if (tokens && tokens.length > 0) return undefined;
					if (!src.startsWith("---\n")) return undefined;
					const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src);
					if (!match) return undefined;
					return {
						type: "frontmatter",
						raw: match[0],
						text: match[1],
					};
				},
				renderer(token) {
					const text = (token as { text?: string }).text ?? "";
					const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
					return `<pre data-frontmatter>${escaped}</pre>`;
				},
			},
			{
				// `<video>` embeds. Marked keeps a raw HTML tag at the top level only when its tag
				// name is in the CommonMark block list, and `video` is not in it. Without this
				// tokenizer the tag comes back wrapped in `<p>`, and parsing the block video node
				// out of that wrapper splits the paragraph and leaves an empty one behind. The
				// document would then grow a blank line on every markdown round-trip.
				name: "videoBlock",
				level: "block",
				start(src) {
					// Marked uses this index only to cut a top-level paragraph. Inside a list item it asks
					// again before every line, so a search there read the rest of the item at each line.
					if (!this.lexer.state.top) {
						return -1;
					}

					// Only a video line inside the paragraph Marked reads next matters. Search this line and
					// the lines Marked's own paragraph rule takes after it. Searching up to the next blank
					// line read the rest of the file when headings ended each paragraph.
					const firstLineEnd = src.indexOf("\n");
					const nextLines = firstLineEnd === -1 ? null : PARAGRAPH_REGEX.exec(src.slice(firstLineEnd + 1));
					const paragraphEnd = firstLineEnd === -1 ? src.length : firstLineEnd + 1 + (nextLines?.[0].length ?? 0);
					markdown_work_add(paragraphEnd * MARKDOWN_WORK_VIDEO_START_PER_CHAR);
					return src.slice(0, paragraphEnd).match(VIDEO_BLOCK_START_REGEX)?.index ?? -1;
				},
				tokenizer(src) {
					// A `<video` without a closing `>` makes this pattern read the rest of the file.
					if (src.startsWith("<video")) {
						markdown_work_add((src.indexOf(">") + 1 || src.length) * MARKDOWN_WORK_VIDEO_SCAN_PER_CHAR);
					}

					const match = VIDEO_BLOCK_REGEX.exec(src);
					if (!match) return undefined;
					return {
						type: "videoBlock",
						raw: match[0],
						text: match[1],
					};
				},
				renderer(token) {
					return (token as { text?: string }).text ?? "";
				},
			},
			{
				// Footnote definitions, like `[^1]: The note.`. When a note is one word, Marked read it as a link
				// definition. Then `[^1]` in the text became a link to that word, and the indented lines under the
				// definition became code.
				//
				// The block takes the definition with its wrapped lines, the indented lines under it, and the
				// definitions right after it. So a list of notes stays one block, and save adds no blank lines
				// between them.
				//
				// The block also takes link definitions, like `[x]: http://e.com`. Marked shows nothing for them,
				// so save lost them, and lost every definition that no link used. The block registers each one,
				// like Marked does, so `[a][x]` still finds its link.
				//
				// It has no `start`: like a link definition, it cannot end a paragraph.
				//
				// It takes footnotes only in the document's own token list, like the frontmatter tokenizer. In a
				// list, save drops the blank line before a footnote block, and in a numbered list the next read no
				// longer finds the footnote. `state.top` is not enough, because Tiptap's numbered list reads its
				// items with it set. Link definitions keep their place in a list, so it takes them everywhere.
				name: "footnoteDefinition",
				level: "block",
				tokenizer(this: { lexer: { tokens: Token[] & { links: Links }; tokenizer: Tokenizer } }, src, tokens) {
					const nested = tokens !== this.lexer.tokens;

					// Take a link definition, or a footnote definition with the lines Marked's paragraph rule adds
					// to it. After a footnote definition, an indented part belongs to the note too.
					let end = 0;
					let hasFootnote = false;
					let afterFootnote = false;
					for (;;) {
						const gap = end === 0 ? "" : (FOOTNOTE_DEFINITION_GAP_REGEX.exec(src.slice(end))?.[0] ?? "");
						const next = src.slice(end + gap.length);
						if (end > 0 && !gap) {
							break;
						}

						const linkDefinition = FOOTNOTE_DEFINITION_START_REGEX.test(next)
							? undefined
							: this.lexer.tokenizer.def(next);
						if (linkDefinition) {
							this.lexer.tokens.links[linkDefinition.tag] ??= {
								href: linkDefinition.href,
								title: linkDefinition.title,
							};
							end += gap.length + linkDefinition.raw.replace(TRAILING_NEWLINES_REGEX, "").length;
							afterFootnote = false;
						} else if (
							!nested &&
							(FOOTNOTE_DEFINITION_START_REGEX.test(next) ||
								(afterFootnote && FOOTNOTE_DEFINITION_INDENTED_LINE_REGEX.test(next)))
						) {
							end += gap.length + (PARAGRAPH_REGEX.exec(next)?.[0].length ?? 0);
							hasFootnote = true;
							afterFootnote = true;
						} else {
							break;
						}
					}
					if (end === 0) {
						return undefined;
					}
					markdown_work_add(end * MARKDOWN_WORK_FOOTNOTE_SCAN_PER_CHAR);

					const raw = src.slice(0, end);
					return { type: "footnoteDefinition", raw, text: raw, hasFootnote };
				},
				// A public parse writes footnotes as a code block, which the share page can show. Like Marked, it
				// shows nothing for link definitions alone.
				renderer(token) {
					const { text = "", hasFootnote } = token as { text?: string; hasFootnote?: boolean };
					if (markdown_hidden_link_text !== null) {
						return hasFootnote ? `<pre><code>${html_escape_text(text, HTML_TEXT_ESCAPE_REGEX)}</code></pre>` : "";
					}

					return `<div data-footnote-definition="${encodeURIComponent(text)}"></div>`;
				},
			},
			{
				name: "taskList",
				renderer(token) {
					const taskListToken = token as {
						items?: Array<{
							checked?: boolean;
							text?: string;
							tokens?: unknown[];
							nestedTokens?: Array<{ type: string }>;
						}>;
					};
					const itemsHtml = (taskListToken.items ?? [])
						.map((itemToken) => {
							const itemTextHtml =
								itemToken.tokens && itemToken.tokens.length > 0
									? this.parser.parseInline(itemToken.tokens as Parameters<typeof this.parser.parseInline>[0])
									: (itemToken.text ?? "");
							const nestedHtml =
								itemToken.nestedTokens && itemToken.nestedTokens.length > 0
									? this.parser.parse(itemToken.nestedTokens as Parameters<typeof this.parser.parse>[0])
									: "";
							// Keep a blank line before the item's blocks, like the `listitem` renderer.
							const loose = itemToken.nestedTokens?.some((child) => child.type === "space");
							return `<li data-type="taskItem" data-checked="${
								itemToken.checked ? "true" : "false"
							}"${loose ? " data-loose" : ""}><p>${itemTextHtml}</p>${nestedHtml}</li>`;
						})
						.join("");
					// Keep a `*` or `+` bullet, like the `list` renderer.
					const bullet = LIST_MARKER_REGEX.exec(token.raw)?.[1];
					return `<ul data-type="taskList"${bullet ? ` data-bullet="${bullet}"` : ""}>${itemsHtml}</ul>`;
				},
			},
			// Tiptap's inline tokens also need HTML renderers for standalone parsing and search.
			{
				name: "highlight",
				renderer(token) {
					return `<mark>${this.parser.parseInline(token.tokens as Parameters<typeof this.parser.parseInline>[0])}</mark>`;
				},
			},
			// An HTML table or details block that `html_merge_tokens` joined. A public parse writes its parts as
			// Marked does.
			{
				name: "htmlTable",
				renderer(token) {
					const parts = (token as { tokens?: Token[] }).tokens ?? [];
					return markdown_hidden_link_text !== null
						? this.parser.parse(parts)
						: html_table_to_editor_html({ raw: token.raw, parts, parse: (tokens) => this.parser.parse(tokens) });
				},
			},
			{
				name: "htmlDetails",
				renderer(token) {
					const parts = (token as { tokens?: Token[] }).tokens ?? [];
					return markdown_hidden_link_text !== null
						? this.parser.parse(parts)
						: html_details_to_editor_html({ raw: token.raw, parts, parse: (tokens) => this.parser.parse(tokens) });
				},
			},
		],
		hooks: {
			processAllTokens: (tokens) => html_hide_unmodeled_inline_tags(html_merge_tokens(tokens)),
		},
		renderer: {
			heading(token) {
				const headingToken = token as {
					raw?: string;
					depth?: number;
					text?: string;
					tokens?: unknown[];
				};
				const raw = headingToken.raw ?? "";
				const trailingSpaces = raw.match(TRAILING_SPACES_OR_TABS_REGEX)?.[0];
				// Keep closing marks like `## a ##` and an underline like `===`, so save writes the heading as
				// the file did.
				const lines = raw.trimEnd().split("\n");
				const underline = lines.length > 1 ? /^ {0,3}(=+|-+)[ \t]*$/.exec(lines.at(-1) ?? "")?.[1] : undefined;
				const closing = lines.length === 1 ? /^ {0,3}#{1,6}[ \t]+.*?([ \t]+#+)$/.exec(lines[0] ?? "")?.[1] : undefined;
				const attributes = `${underline ? ` data-markdown-underline="${underline}"` : ""}${
					closing ? ` data-markdown-closing="${closing}"` : ""
				}`;

				if (!trailingSpaces && !attributes) {
					return false;
				}

				const depth = headingToken.depth ?? 1;
				const bodyHtml =
					headingToken.tokens && headingToken.tokens.length > 0
						? this.parser.parseInline(headingToken.tokens as Parameters<typeof this.parser.parseInline>[0])
						: (headingToken.text ?? "");

				return `<h${depth}${attributes}>${bodyHtml}${trailingSpaces ?? ""}</h${depth}>`;
			},

			// Handle trailing `\\\n` in paragraphs that are not converted to `<br>` by default
			paragraph(token) {
				const paragraphToken = token as {
					raw?: string;
				};
				const raw = paragraphToken.raw ?? "";
				const trailingHardBreaks = raw.match(TRAILING_HARD_BREAKS_REGEX)?.[0];

				if (!trailingHardBreaks) {
					return false;
				}

				const hardBreakCount = (trailingHardBreaks.match(HARD_BREAK_REGEX) ?? []).length;
				const bodyRaw = raw.slice(0, raw.length - trailingHardBreaks.length);
				// Count this second parse too, when a limited parse runs.
				const bodyHtml = instance.parseInline(bodyRaw, { async: false, tokenizer: new WorkCountingTokenizer() });

				return `<p>${bodyHtml}${"<br>".repeat(hardBreakCount)}</p>`;
			},

			// Keep a break written with two spaces as it is. A plain `<br>` saves as a backslash.
			br(token) {
				return token.raw.startsWith("\\") ? false : `<br data-markdown-break="${encodeURIComponent(token.raw)}">`;
			},

			// Keep a rule written as `***`, `___` or `- - -`. Save writes `---` for a new rule.
			hr(token) {
				const source = token.raw.trim();
				return source === "---" ? false : `<hr data-markdown-source="${source}">\n`;
			},

			// Marked ends the code with a `\n` before `</code>`. The code block keeps every character of
			// `<pre>`, so that `\n` became part of the code. The save then wrote it as an empty line before
			// the closing fence. So drop it here.
			//
			// Also keep a `~~~` or longer fence, and an indented block, so save writes the block as the file did.
			code(token) {
				const opening = /^ {0,3}(`{3,}|~{3,})([ \t]*)/.exec(token.raw);
				const fence =
					token.codeBlockStyle === "indented" ? "indented" : opening && `${opening[1]}${token.lang ? opening[2] : ""}`;
				const html = Renderer.prototype.code
					.call(this, token)
					.replace(CODE_BLOCK_HTML_FINAL_NEWLINE_REGEX, "</code></pre>\n");
				return fence && fence !== "```" ? html.replace(/^<pre/, `<pre data-markdown-fence="${fence}"`) : html;
			},

			// A one-word footnote in a quote or a list, like `> [^1]: note`, which Marked reads as a link
			// definition. Marked shows nothing for it, so keep it as the same source text block.
			def(token) {
				if (markdown_hidden_link_text !== null) {
					return false;
				}

				const text = token.raw.replace(TRAILING_NEWLINES_REGEX, "");
				return `<div data-footnote-definition="${encodeURIComponent(text)}"></div>`;
			},

			// Keep a `*` or `+` bullet, a `1)` number, and blank lines between the items, so a save does not
			// rewrite every list in the file. A new marker also starts a new list, so two lists next to each
			// other stay two lists.
			list(token) {
				const marker = LIST_MARKER_REGEX.exec(token.raw);
				let attributes = marker?.[1]
					? ` data-bullet="${marker[1]}"`
					: marker?.[2]
						? ` data-delimiter="${marker[2]}"`
						: "";
				if (list_has_blank_line_between_items(token)) {
					attributes += " data-loose";
				}
				// Keep a list that numbers every item the same, like `1.` `1.` `1.`.
				const numbers = token.ordered ? token.items.map((item) => /^ *(\d+)/.exec(item.raw)?.[1]) : [];
				if (numbers.length > 1 && numbers.every((number) => Number(number) === (token.start || 1))) {
					attributes += " data-same-number";
				}

				if (!attributes) {
					return false;
				}

				return Renderer.prototype.list.call(this, token).replace(/^<(ul|ol)/, `<$1${attributes}`);
			},

			// Keep a blank line between the blocks inside an item, like before a code block. Marked adds a `space`
			// token for it. Before, save dropped the blank line.
			//
			// Also keep the indent of a nested list when the file put it past the item's text, like 4 spaces
			// under `- `. Save used the smallest indent before. A nested paragraph keeps its own extra spaces,
			// so it does not take the indent. Count from the marker, because a nested item's raw keeps the
			// spaces before it.
			//
			// A list item must start with a paragraph. When the file starts it with another block, like `- # Title`
			// or a fence, put an empty paragraph first. Without it the editor moved the block out of the list.
			// `data-block-on-marker` lets save write the block back on the marker line.
			listitem(item) {
				// The first space token only means the item's text starts on the next line.
				let attributes = item.tokens.some((child, index) => index > 0 && child.type === "space") ? " data-loose" : "";
				const firstBlock = item.tokens.find((child) => child.type !== "space");
				const startsWithBlock =
					firstBlock !== undefined && firstBlock.type !== "text" && firstBlock.type !== "paragraph";
				if (startsWithBlock && /^ *\S+[ \t]+\S/.test(item.raw)) {
					attributes += " data-block-on-marker";
				}
				const [firstLine = "", ...lines] = item.raw.split("\n");
				const markerIndent = /^ */.exec(firstLine)?.[0].length ?? 0;
				// Read the nested list's first line, past any wrapped lines of the item's text.
				const listLine = lines.find((line) => NESTED_LIST_LINE_REGEX.test(line));
				const indent = (listLine?.match(/^ */)?.[0].length ?? 0) - markerIndent;
				const textColumn = (/^ *\S+ /.exec(firstLine)?.[0].length ?? Infinity) - markerIndent;
				if (item.tokens.slice(1).find((child) => child.type !== "space")?.type === "list" && indent > textColumn) {
					attributes += ` data-indent="${indent}"`;
				}

				// Marked writes a text after the block bare, like `<h1>h</h1>\ntext`, and the editor kept that `\n`
				// in the text. Write it as a paragraph, like Marked does in a loose list.
				const html = Renderer.prototype.listitem.call(
					this,
					startsWithBlock
						? {
								...item,
								tokens: item.tokens.map((child) => (child.type === "text" ? { ...child, type: "paragraph" } : child)),
							}
						: item,
				);
				return html.replace(/^<li>/, `<li${attributes}>${startsWithBlock ? "<p></p>" : ""}`);
			},

			// Marked stops escaping text after an unclosed `<code>`, `<kbd>`, `<pre>`, or `<script>` tag. Then
			// typed text like `a<b` becomes a tag. It takes in the next link, and the file name shows without its
			// address on a shared page. So always escape text. `WorkCountingTokenizer.escape` already charges for
			// this escaping.
			//
			// Also mark each HTML entity and each backslash escape, so save writes them back as the file wrote
			// them (`files_html_entity_mark`, `files_markdown_escape_mark`). Marked renders an escape with
			// this renderer too.
			text(token) {
				if ("tokens" in token && token.tokens) {
					return false;
				}
				if (token.type === "escape") {
					return `<span data-markdown-escape>${Renderer.prototype.text.call(this, { ...token, escaped: false })}</span>`;
				}

				return html_entities_wrap(token.text, (text) =>
					Renderer.prototype.text.call(this, { ...token, text, escaped: false }),
				);
			},

			// Turn an inline tag that the editor cannot show or save back the same, or an inline comment, into a
			// hidden tag node (`files_html_tag_node`), so save writes it back. An HTML block goes to
			// `html_block_to_editor_html`.
			//
			// A public parse keeps the raw HTML. The public page must see the real tags to remove a script, a
			// form or an SVG with the text inside them. It drops the other unknown tags and comments itself, so
			// it shows the same text as the editor.
			html(token) {
				if (markdown_hidden_link_text !== null) {
					return false;
				}

				if (token.block) {
					return html_block_to_editor_html(token.text);
				}

				const name = INLINE_HTML_TAG_NAME_REGEX.exec(token.text)?.[1]?.toLowerCase();
				// A `<br>` tag stays a tag on save, like the file wrote it.
				if (name === "br") {
					return `<br data-markdown-break="${encodeURIComponent(token.text)}">`;
				}
				if (name !== undefined && INLINE_HTML_SUPPORTED_TAGS.has(name) && !html_hidden_inline_tags.has(token)) {
					return html_shown_tag_to_editor_html(token.text, name);
				}

				return `<span data-html-tag="${encodeURIComponent(token.text)}"></span>`;
			},

			// Mark bold and italic written with underscores, and a strikethrough with one `~`, so save writes
			// `__x__`, `_x_` and `~x~` back instead of `**x**`, `*x*` and `~~x~~`. The fork's marks keep it in
			// `markdownSyntax`.
			strong(token) {
				return token.raw.startsWith("__")
					? Renderer.prototype.strong.call(this, token).replace(/^<strong>/, '<strong data-markdown-syntax="__">')
					: false;
			},

			em(token) {
				return token.raw.startsWith("_")
					? Renderer.prototype.em.call(this, token).replace(/^<em>/, '<em data-markdown-syntax="_">')
					: false;
			},

			del(token) {
				return token.raw.startsWith("~") && !token.raw.startsWith("~~")
					? Renderer.prototype.del.call(this, token).replace(/^<del>/, '<del data-markdown-syntax="~">')
					: false;
			},

			// Author-typed HTML can still take in a link's tag, for example a line `<div x="`. Then the address
			// is lost in an attribute, and the label shows as plain text. So a public parse writes the hidden
			// text instead of a hidden link's label and title. The file name never gets into its HTML.
			//
			// The editor marks a bare `https://…` or an `<https://…>` auto link, so save writes it back the same
			// instead of as `[https://…](https://…)`.
			link(token) {
				if (markdown_hidden_link_text === null) {
					return token.raw.startsWith("[")
						? false
						: Renderer.prototype.link
								.call(this, token)
								.replace(/^<a /, `<a data-markdown-autolink="${token.raw.startsWith("<") ? "angle" : "bare"}" `);
				}

				const hiddenText = markdown_hidden_link_text(token.href);
				return hiddenText === null
					? false
					: Renderer.prototype.link.call(this, {
							...token,
							title: null,
							tokens: [{ type: "text", raw: hiddenText, text: hiddenText }],
						});
			},
		},
	});
}

/**
 * Return the part of `src` that one Tiptap list tokenizer can read, or `null` when no list starts here.
 *
 * Marked tries Tiptap's ordered list and task list tokenizers at the start of every block. Each one
 * splits the whole rest of the file into lines, so a big file took seconds. Both tokenizers give up
 * when the first non-blank line is not one of their items. Both also stop at the first line that
 * starts with a non-space character and is not an item. So cutting the text after that line keeps
 * the same result.
 *
 * The task list tokenizer also ends its list before a line that is not indented under the item: at
 * the blank lines before such a line, or before a non-item line itself. Cut there too, so each item
 * does not read the rest of the file again.
 *
 * The block must start with an item. Tiptap's task list skips blank lines before its first item but
 * leaves them out of the token's text. Marked then removed the wrong text and repeated the item. So
 * blank lines are left to Marked's own blank-line step.
 */
function cut_list_block(src: string, args: { itemLineRegex: RegExp; endsAtOutdent: boolean }) {
	let itemIndent: number | null = null;
	let blankRunStart: number | null = null;
	let lineStart = 0;
	while (lineStart < src.length) {
		const newlineIndex = src.indexOf("\n", lineStart);
		const lineEnd = newlineIndex === -1 ? src.length : newlineIndex;
		const line = src.slice(lineStart, lineEnd);
		const itemMatch = args.itemLineRegex.exec(line);

		if (itemIndent === null) {
			if (!itemMatch) {
				return null;
			}

			itemIndent = itemMatch[1].length;
		} else if (line.trim() === "") {
			blankRunStart ??= lineStart;
		} else {
			const indent = line.length - line.trimStart().length;
			if (args.endsAtOutdent && blankRunStart !== null && indent <= itemIndent) {
				return src.slice(0, blankRunStart);
			}

			blankRunStart = null;
			// An item that is not indented under the current item starts the next item of the same list.
			if (itemMatch && indent <= itemIndent) {
				itemIndent = indent;
			} else if (!itemMatch && args.endsAtOutdent && indent <= itemIndent) {
				return src.slice(0, lineStart);
			} else if (!itemMatch && !INDENTED_LINE_REGEX.test(line)) {
				return src.slice(0, lineEnd);
			}
		}

		lineStart = lineEnd + 1;
	}

	return src;
}

/**
 * Charge the work Tiptap's ordered or task list does outside Marked before it runs.
 *
 * Both lists parse the nested items of each item again by themselves, without Marked, and keep a copy
 * of that text. So a line is read and copied once for each item it is nested under. A deeply nested
 * task list took almost half a second, and a deeply nested list with long items used over 64 MB.
 *
 * At each blank line inside a task item, Tiptap also copies all the lines after it to find the next
 * non-blank line. It does this again for each nesting level. So many blank lines in a long list took
 * seconds.
 */
function markdown_work_add_list_rescans(listSrc: string, args: { itemLineRegex: RegExp; isTaskList: boolean }) {
	if (markdown_work === null) {
		return;
	}

	const lines = listSrc.split("\n");
	const itemIndents = new Set<number>();
	// The indents of the items that the current line is nested under.
	const openItemIndents: number[] = [];
	let copiedLines = 0;
	let rereadChars = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") {
			copiedLines += lines.length - i;
			continue;
		}

		const indent = line.length - line.trimStart().length;
		while (openItemIndents.length > 0 && openItemIndents[openItemIndents.length - 1] >= indent) {
			openItemIndents.pop();
		}
		rereadChars += line.length * openItemIndents.length;

		if (args.itemLineRegex.test(line)) {
			itemIndents.add(indent);
			openItemIndents.push(indent);
		}
	}

	markdown_work.listCopiedChars += rereadChars;
	if (markdown_work.listCopiedChars > MARKDOWN_MAX_LIST_COPIED_CHARS) {
		throw new MarkdownWorkLimitError("Markdown lists are nested too deeply to parse");
	}
	if (args.isTaskList) {
		markdown_work_add(
			copiedLines * itemIndents.size * MARKDOWN_WORK_TASK_LIST_COPIED_LINE +
				rereadChars * MARKDOWN_WORK_TASK_LIST_REREAD_CHAR,
		);
	}
}

/**
 * The characters of an email address in Marked's inline patterns.
 */
const EMAIL_CHARS = "[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]";

/**
 * Match the run of email characters at `lastIndex`. At each step, Marked's text and url patterns look
 * for an email address, so they read the run after the step's first character. A sticky `[...]*` finds
 * the run end about four times faster than a search for the first character that is not in it.
 */
const EMAIL_CHAR_RUN_REGEX = ((/* iife */) => {
	if (!Lexer.rules.inline.gfm.text.source.includes(`(?=${EMAIL_CHARS}+@)`)) {
		throw should_never_happen("Marked's inline text pattern changed");
	}

	return new RegExp(`${EMAIL_CHARS}*`, "y");
})();

/**
 * The characters where Marked's inline text step always stops, and `=`. Taken from Marked's
 * text pattern. The step also stops before `http`, `www.`, an email address, or two spaces at a line
 * end, but those stops read only a few characters or the email characters after them.
 */
const MARKER_START_SEARCH_REGEX = ((/* iife */) => {
	const stopChars = "\\\\<!\\[`*~_";
	const source = Lexer.rules.inline.gfm.text.source;
	if (!source.startsWith("^([`~]+|[^`~])") || !source.includes(`[\\s\\S]*?(?:(?=[${stopChars}]|`)) {
		throw should_never_happen("Marked's inline text pattern changed");
	}

	return new RegExp(`[=${stopChars}]`, "g");
})();

/**
 * The last answer of `find_marker_starts`.
 */
let marker_starts: { src: string; highlight: number } | null = null;

/**
 * Find where Tiptap's highlight (`==`) text can start, for Marked's inline `start`.
 * Tiptap's own `start` reads the rest of the paragraph with `indexOf` at every inline step. That is slow
 * on long text, and even slower on text in some alphabets, where `indexOf` stops at many letters.
 *
 * Marked uses these indexes only to cut the text that its inline text step reads. That step always stops
 * at the first stop character, such as `*` or `<`. It reads past that character only through the email
 * characters after it, as in `a*b@c`. So a marker after those characters does not change the step, and
 * the answer can be -1 instead. Parsed text stays the same as with Tiptap's `start`.
 */
function find_marker_starts(src: string) {
	if (marker_starts?.src === src) {
		return marker_starts;
	}

	// Marked's text step takes a leading run of "`" or "~" as one piece, so search after it.
	let index = 0;
	while (index < src.length && (src.charCodeAt(index) === 96 || src.charCodeAt(index) === 126)) {
		index += 1;
	}

	let highlight = -1;
	let stop = -1;
	let scanned = src.length;
	let candidates = 0;
	MARKER_START_SEARCH_REGEX.lastIndex = index;
	for (let match = MARKER_START_SEARCH_REGEX.exec(src); match; match = MARKER_START_SEARCH_REGEX.exec(src)) {
		if (match[0] !== "=") {
			stop = match.index;
			scanned = stop;
			break;
		}

		candidates += 1;
		if (src[match.index + 1] === "=") {
			highlight = match.index;
			scanned = match.index;
			break;
		}
	}
	// Each `=` costs one more search call.
	markdown_work_add(
		scanned * MARKDOWN_WORK_MARKER_SEARCH_PER_CHAR + candidates * MARKDOWN_WORK_MARKER_SEARCH_PER_CANDIDATE,
	);

	// A marker after the stop character counts only inside the email characters that follow it.
	if (stop !== -1) {
		EMAIL_CHAR_RUN_REGEX.lastIndex = stop;
		const emailRun = EMAIL_CHAR_RUN_REGEX.exec(src)?.[0] ?? "";
		markdown_work_add(emailRun.length * MARKDOWN_WORK_INLINE_EMAIL_SCAN_PER_CHAR);
		const runIndex = emailRun.indexOf("==");
		highlight = runIndex === -1 ? -1 : stop + runIndex;
	}

	marker_starts = { src, highlight };
	return marker_starts;
}

/**
 * Wrap Tiptap's tokenizers while Tiptap registers them on Marked. List tokenizers get `cut_list_block`,
 * and the highlight `start` search uses `find_marker_starts`.
 */
function bound_tiptap_tokenizers(extension: MarkedExtension): MarkedExtension {
	return {
		...extension,
		extensions: extension.extensions?.flatMap((tokenizerExtension) => {
			// Keep Marked's GFM table parser. Tiptap's extra pipe scan reads the whole remaining
			// document at every line, outside our work budget. Our serializer already escapes pipes.
			if (tokenizerExtension.name === "table") return [];
			// Tiptap's details nodes read a Pandoc `:::details` block. GitHub shows that text as it is, so keep it.
			if (DETAILS_NODE_NAMES.has(tokenizerExtension.name)) return [];
			// GitHub and the other Markdown apps have no `++` underline, so `C++ and C++17` is plain text.
			// Underline still saves as `<u>`, which every reader shows.
			if (tokenizerExtension.name === "underline") return [];

			if (tokenizerExtension.name === "highlight" && "start" in tokenizerExtension && tokenizerExtension.start) {
				// `find_marker_starts` gives the same parse only while Tiptap's `start` returns the first `==`.
				const probe = "a *b ==c";
				if (tokenizerExtension.start.call({ lexer: new Lexer() }, probe) !== probe.indexOf("==")) {
					throw should_never_happen("Tiptap's highlight start changed");
				}

				const markerTokenizer = tokenizerExtension.tokenizer;
				return {
					...tokenizerExtension,
					start: (src) => find_marker_starts(src).highlight,
					tokenizer(src, tokens) {
						const token = markerTokenizer.call(this, src, tokens);
						// A space just inside the markers keeps them plain text, like `*` emphasis. So `a == b == c`
						// stays a comparison.
						if (token && HIGHLIGHT_SPACE_INSIDE_REGEX.test(token.raw)) {
							return undefined;
						}
						// Tiptap's `==` can pair across a link, as in `a== <p> [Bob ==x](...)`. A typed block tag
						// inside the pair then splits the line, and the public page would show the start of the
						// hidden name. So a public parse keeps a pair that holds a `<` as plain text.
						if (token && markdown_hidden_link_text !== null && token.raw.includes("<")) {
							return undefined;
						}

						return token;
					},
				};
			}

			const isTaskList = tokenizerExtension.name === "taskList";
			const cutArgs =
				tokenizerExtension.name === "orderedList"
					? { itemLineRegex: ORDERED_LIST_ITEM_LINE_REGEX, endsAtOutdent: false }
					: isTaskList
						? { itemLineRegex: TASK_ITEM_LINE_REGEX, endsAtOutdent: true }
						: null;
			if (!cutArgs || !("tokenizer" in tokenizerExtension)) {
				return tokenizerExtension;
			}

			const tokenizer = tokenizerExtension.tokenizer;
			return {
				...tokenizerExtension,
				tokenizer(src, tokens) {
					const listSrc = cut_list_block(src, cutArgs);
					if (listSrc === null) {
						return undefined;
					}

					// Tiptap splits the whole block into lines and matches each one.
					markdown_work_add(listSrc.length * MARKDOWN_WORK_LIST_BLOCK_PER_CHAR);
					markdown_work_add_list_rescans(listSrc, { itemLineRegex: cutArgs.itemLineRegex, isTaskList });

					return tokenizer.call(this, listSrc, tokens);
				},
			};
		}),
	};
}

/**
 * Tell if a blank line comes after one of the list's items, before the next item. A blank line inside
 * an item does not count, because it does not put blank lines between the items.
 *
 * Marked keeps the blank line at the end of the item's text, after the item's own line break. Tiptap's
 * ordered list tokenizer leaves out the item's own line break and sets no `loose`, so there the blank
 * line shows as one final line break. Only the end of each item is read, so this stays cheap in a long
 * list.
 */
function list_has_blank_line_between_items(token: Tokens.List) {
	const lineBreaksWhenTight = "loose" in token ? 1 : 0;
	return token.items.slice(0, -1).some((item) => {
		const tail = item.raw.slice(item.raw.trimEnd().length);
		return tail.split("\n").length - 1 > lineBreaksWhenTight;
	});
}

/**
 * Count the characters that Marked's renderer escapes with its slow pattern. `<` is not counted,
 * because each `<` starts its own inline step, which is charged already.
 */
function count_inline_escaped_chars(text: string) {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		// `"`, `&`, `'`, `>`
		if (code === 34 || code === 38 || code === 39 || code === 62) {
			count += 1;
		}
	}
	return count;
}

const LINK_LABEL_STOP_REGEX = /[[\]]/g;

/**
 * How far Marked's link pattern reads at a step that starts with `[` or `![`, in characters.
 *
 * After `](` the pattern reads the destination up to the next space, then goes back one character at a
 * time to look for a title or `)`. A `"`, `'`, or `(` title reads to its closing character. So text like
 * `![a](![a](![a](` is read again at each `![`.
 */
function link_scan_length(src: string) {
	const labelStart = src.startsWith("![") ? 2 : src.startsWith("[") ? 1 : 0;
	if (labelStart === 0) {
		return 0;
	}

	// Stop at the first bracket. A nested label such as `[a [b]](` is rare and reads little.
	LINK_LABEL_STOP_REGEX.lastIndex = labelStart;
	const labelEnd = LINK_LABEL_STOP_REGEX.exec(src)?.index ?? -1;
	if (labelEnd === -1 || src[labelEnd] !== "]" || src[labelEnd + 1] !== "(") {
		return 0;
	}

	// Skip the spaces after `(`, then read the destination up to a space or a control character.
	let end = labelEnd + 2;
	while (end < src.length && src.charCodeAt(end) <= 32) {
		end += 1;
	}
	while (end < src.length && src.charCodeAt(end) > 32) {
		end += 1;
	}

	let titleStart = end;
	while (titleStart < src.length && (src[titleStart] === " " || src[titleStart] === "\t" || src[titleStart] === "\n")) {
		titleStart += 1;
	}
	const titleClose =
		src[titleStart] === "(" ? ")" : src[titleStart] === '"' || src[titleStart] === "'" ? src[titleStart] : null;
	if (titleClose !== null) {
		const titleEnd = src.indexOf(titleClose, titleStart + 1);
		end = titleEnd === -1 ? src.length : titleEnd + 1;
	}

	return end - labelEnd;
}

/**
 * The text steps that Marked's url pattern reads: `http://`, `https://`, `ftp://`, and `www.`, with any
 * letter case in the protocol, like Marked's own pattern.
 */
const URL_STEP_REGEX = /^(?:[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.)/;
const URL_STOP_REGEX = /[\s<]/g;

/**
 * How far Marked's url pattern reads at a step, in characters. It reads to the next space or `<`. Its
 * backpedal pattern then reads that part again, which `UrlBackpedalCountingRegExp` counts.
 */
function url_scan_length(src: string) {
	if (!URL_STEP_REGEX.test(src)) {
		return 0;
	}

	URL_STOP_REGEX.lastIndex = 0;
	return URL_STOP_REGEX.exec(src)?.index ?? src.length;
}

/**
 * Find where Marked's setext heading pattern stops reading: at a blank line, at a line that starts
 * another block, or at an underline. Built from Marked's own pattern, so it stops where Marked stops.
 */
const SETEXT_HEADING_STOP_REGEX = ((/* iife */) => {
	const source = Lexer.rules.block.gfm.lheading.source;
	const lineStarts = source.slice("^(?!".length, source.indexOf(")((?:.|\\n(?!\\s*?\\n|"));
	if (source !== `^(?!${lineStarts})((?:.|\\n(?!\\s*?\\n|${lineStarts}))+?)\\n {0,3}(=+|-+) *(?:\\n+|$)`) {
		throw should_never_happen("Marked's setext heading pattern changed");
	}

	return new RegExp(`\\n(?:\\s*?\\n|${lineStarts}| {0,3}(?:=+|-+) *(?:\\n|$))`);
})();
// Marked turns every `\r` into `\n` before it parses, so this counts line ends. With only `\n`, V8
// searches like `indexOf("\n")`, which also stops at letters such as `Њ` (U+040A) and is slow on them.
const NEWLINE_REGEX = /[\n\r]/g;

/**
 * A copy of one of Marked's masking patterns that counts each search while a limited parse runs.
 * Before Marked reads a paragraph, it rebuilds the whole paragraph text after each match of these.
 */
class WorkCountingRegExp extends RegExp {
	override exec(text: string) {
		markdown_work_add(text.length * MARKDOWN_WORK_INLINE_MASK_PER_CHAR);
		return super.exec(text);
	}
}

/**
 * A copy of Marked's url backpedal pattern that counts each search while a limited parse runs. Marked
 * runs it on the url again after each change, and each run may drop only one `&b;` at the end. So a url
 * full of `&b;` costs its length times the number of `&b;`.
 */
class UrlBackpedalCountingRegExp extends RegExp {
	override exec(text: string) {
		markdown_work_add(text.length * MARKDOWN_WORK_URL_BACKPEDAL_PER_CHAR);
		return super.exec(text);
	}
}

/**
 * A Marked tokenizer that counts Marked's scanning work while a limited parse runs.
 *
 * Marked is not linear on some input. At each step in a paragraph it can scan the rest of the
 * paragraph again. Each nested blockquote or list parses its text again. So each lexer call charges its
 * text once, and each step charges the rest of the text. A missing closing `*`, `_`, or `~` makes Marked
 * scan the rest of the paragraph with a slow pattern, so those scans cost much more.
 */
class WorkCountingTokenizer extends Tokenizer {
	private lexerCallStarted = false;
	private linkDefinitionCount = 0;

	constructor() {
		super();

		// Marked sets `lexer` at the start of every block and inline lexer call, so watch it to find the
		// first step of each call. The base class declares `lexer` and `rules` as fields, so replace the
		// fields here.
		// Each call has a fixed cost, even for an empty table cell that never reaches a step. Each inline
		// call also lists every link definition before its first step.
		let lexer = this.lexer;
		Object.defineProperty(this, "lexer", {
			get: () => lexer,
			set: (value: typeof lexer) => {
				lexer = value;
				this.lexerCallStarted = true;
				markdown_work_add(MARKDOWN_WORK_LEXER_CALL + this.linkDefinitionCount * MARKDOWN_WORK_LINK_DEFINITION_PER_CALL);
			},
		});

		// Marked gives every tokenizer the shared pattern objects. Count the masking patterns on copies, and
		// use the paragraph rule with the cheaper table check.
		let rules = this.rules;
		Object.defineProperty(this, "rules", {
			get: () => rules,
			set: (value: Rules) => {
				rules = {
					...value,
					block: { ...value.block, paragraph: PARAGRAPH_REGEX },
					inline: {
						...value.inline,
						anyPunctuation: new WorkCountingRegExp(value.inline.anyPunctuation),
						blockSkip: new WorkCountingRegExp(value.inline.blockSkip),
						reflinkSearch: new WorkCountingRegExp(value.inline.reflinkSearch),
						_backpedal: new UrlBackpedalCountingRegExp(value.inline._backpedal),
					},
				};
			},
		});
	}

	private takeLexerCallStart() {
		const started = this.lexerCallStarted;
		this.lexerCallStarted = false;
		return started;
	}

	// Marked calls `space` first at every block step.
	override space(src: string) {
		const textUnits = this.takeLexerCallStart() ? src.length * MARKDOWN_WORK_BLOCK_TEXT_PER_CHAR : 0;
		markdown_work_add(MARKDOWN_WORK_BLOCK_STEP + textUnits);
		return super.space(src);
	}

	// Marked calls `escape` first at every inline step. Each step also tries about a dozen patterns. So a
	// step costs about half a microsecond even when it reads one character, like each `!` in `!!!!`.
	override escape(src: string) {
		const callStart = this.takeLexerCallStart();
		if (markdown_work !== null) {
			// The renderer escapes `"`, `'`, `>`, and `&` in text with a slow pattern, about 0.1 µs each.
			const textUnits = callStart
				? src.length * MARKDOWN_WORK_INLINE_TEXT_PER_CHAR +
					count_inline_escaped_chars(src) * MARKDOWN_WORK_INLINE_ESCAPED_CHAR
				: 0;
			EMAIL_CHAR_RUN_REGEX.lastIndex = 1;
			const emailScan = EMAIL_CHAR_RUN_REGEX.exec(src)?.[0].length ?? 0;
			markdown_work_add(
				textUnits +
					MARKDOWN_WORK_INLINE_STEP +
					src.length * MARKDOWN_WORK_INLINE_STEP_PER_CHAR +
					emailScan * MARKDOWN_WORK_INLINE_EMAIL_SCAN_PER_CHAR +
					link_scan_length(src) * MARKDOWN_WORK_LINK_SCAN_PER_CHAR +
					url_scan_length(src) * MARKDOWN_WORK_URL_SCAN_PER_CHAR,
			);
		}

		return super.escape(src);
	}

	// Marked's setext heading pattern reads until a blank line, a line that starts another block, or an
	// underline. Marked tries it at every line of a list item, and at each paragraph that ends at a line
	// such as `***`, which this pattern reads past. So it can read the rest of the file many times.
	// At each line it also tests every pattern that starts a block, so short lines cost more per char.
	override lheading(src: string) {
		if (markdown_work !== null) {
			const scanned = SETEXT_HEADING_STOP_REGEX.exec(src)?.index ?? src.length;
			let lines = 1;
			NEWLINE_REGEX.lastIndex = 0;
			while (NEWLINE_REGEX.exec(src) !== null && NEWLINE_REGEX.lastIndex <= scanned) {
				lines += 1;
			}
			markdown_work_add(scanned * MARKDOWN_WORK_SETEXT_SCAN_PER_CHAR + lines * MARKDOWN_WORK_SETEXT_SCAN_PER_LINE);
		}

		return super.lheading(src);
	}

	// Marked copies the rest of a blockquote's lines once for each run of `>` lines in it. When the quote
	// holds a list, it also joins, parses, and splits the rest of the text again. So lines that switch
	// between `>` and lazy continuation lines cost lines times runs. Count the copies first.
	override blockquote(src: string) {
		const match = markdown_work === null ? null : this.rules.block.blockquote.exec(src);
		if (match) {
			const lines = match[0].replace(TRAILING_NEWLINES_REGEX, "").split("\n");
			let copiedLines = lines.length;
			let remainingChars = match[0].length;
			let copiedChars = remainingChars;
			let i = 0;
			while (i < lines.length) {
				let inQuote = false;
				while (i < lines.length) {
					if (this.rules.other.blockquoteStart.test(lines[i])) {
						inQuote = true;
					} else if (inQuote) {
						break;
					}
					remainingChars -= lines[i].length + 1;
					i += 1;
				}
				copiedLines += lines.length - i;
				copiedChars += Math.max(0, remainingChars);
			}
			markdown_work_add(
				copiedLines * MARKDOWN_WORK_BLOCKQUOTE_COPIED_LINE + copiedChars * MARKDOWN_WORK_BLOCKQUOTE_COPIED_CHAR,
			);
		}

		return super.blockquote(src);
	}

	// Marked pads every table row to the header's column count, even a short row. So a wide header over
	// many short rows makes header cells times rows cells, far more than the text. Count them first.
	override table(src: string) {
		const match = markdown_work === null ? null : this.rules.block.table.exec(src);
		if (match) {
			const columns = match[1].split("|").length;
			const rows = match[3] ? match[3].split("\n").length : 0;
			markdown_work_add(columns * (rows + 1) * MARKDOWN_WORK_TABLE_CELL);
		}

		return super.table(src);
	}

	// A repeated label adds no new definition, so this count can only be too high.
	override def(src: string) {
		const token = super.def(src);
		if (token) {
			this.linkDefinitionCount += 1;
		}

		return token;
	}

	// A reference such as `[a]` copies the whole URL and title of its definition into the HTML. So many
	// short references to one long definition would build a huge HTML string. Charge the copied text.
	override reflink(src: string, links: Links) {
		const token = super.reflink(src, links);
		if (token && (token.type === "link" || token.type === "image")) {
			markdown_work_add((token.href.length + (token.title?.length ?? 0)) * MARKDOWN_WORK_REFERENCE_COPIED_CHAR);
		}

		return token;
	}

	// Marked's code span pattern looks for a closing run of as many backticks as the opening run. With no
	// such run, it reads the rest of the text. So runs of many different lengths read the text many times.
	override codespan(src: string) {
		const token = super.codespan(src);
		if (!token && src.startsWith("`")) {
			markdown_work_add(src.length * MARKDOWN_WORK_CODE_SPAN_SCAN_PER_CHAR);
		}

		return token;
	}

	override emStrong(src: string, maskedSrc: string, prevChar?: string) {
		const token = super.emStrong(src, maskedSrc, prevChar);

		// Marked scans only after an opening delimiter such as `*a`. A lone `*` before a space returns at once.
		const opening = token ? null : this.rules.inline.emStrongLDelim.exec(src);
		if (token || (opening && (opening[1] || opening[2] || opening[3] || opening[4]))) {
			markdown_work_add((token?.raw.length ?? src.length) * MARKDOWN_WORK_EMPHASIS_SCAN_PER_CHAR);
		}

		return token;
	}

	override del(src: string, maskedSrc: string, prevChar?: string) {
		const token = super.del(src, maskedSrc, prevChar);
		if (token || this.rules.inline.delLDelim.exec(src)) {
			markdown_work_add((token?.raw.length ?? src.length) * MARKDOWN_WORK_STRIKE_SCAN_PER_CHAR);
		}

		return token;
	}
}

const files_marked = ((/* iife */) => {
	function value() {
		const instance = marked;
		configure_marked(instance);
		// Standalone HTML parsing needs the same task and inline tokenizers as an editor. Tiptap registers
		// them through `use`, so give it a view of `marked` whose `use` bounds those tokenizers first.
		// Tiptap's tokenizers parse item text with the running lexer. Tiptap makes a new lexer only to test a
		// tokenizer that has no start pattern. Give that lexer its own counting tokenizer. A tokenizer
		// remembers its lexer, so sharing one with the main parse made the paragraph after a list lose its text.
		const tiptapMarked: typeof marked = Object.create(instance);
		tiptapMarked.use = (...extensions) => instance.use(...extensions.map(bound_tiptap_tokenizers));
		tiptapMarked.Lexer = class extends instance.Lexer {
			constructor() {
				super({ ...instance.defaults, tokenizer: new WorkCountingTokenizer() });
			}
		} as typeof instance.Lexer;
		// Creating the manager registers Tiptap's tokenizers through `tiptapMarked.use`.
		new MarkdownManager({
			marked: tiptapMarked,
			extensions: get_tiptap_shared_extensions_list(),
		});

		return {
			parse(markdown: string) {
				// Give each parse its own tokenizer. Otherwise Marked keeps one tokenizer in the shared `marked`
				// options, and a tokenizer remembers the lexer that used it last.
				return instance.parse(markdown, { async: false, tokenizer: new WorkCountingTokenizer() });
			},
		};
	}

	let cache: ReturnType<typeof value>;

	return function files_marked() {
		return (cache ??= value());
	};
})();

/**
 * Parse markdown string to HTML.
 */
function tiptap_markdown_to_html(args: {
	markdown: string;
	extensions?: Extensions;
	replaceNewLineToBr?: boolean;
	workLimit?: number;
	hiddenLinkText?: (href: string) => string | null;
}) {
	const markdown = args.replaceNewLineToBr ? args.markdown.replaceAll("\n", "<br>") : args.markdown;

	// const markdownWithoutTrailingHardBreaks = markdown.replace(/(?:\\\n)+$/g, "");

	let html;
	markdown_work = args.workLimit === undefined ? null : { used: 0, limit: args.workLimit, listCopiedChars: 0 };
	markdown_hidden_link_text = args.hiddenLinkText ?? null;
	try {
		// Marked spends about two microseconds on each non-blank line. Part of it comes before the first
		// counted step, for example while Marked collects the items of a long list.
		// Tiptap turns blank lines into empty paragraphs, which the HTML steps after the parse walk too.
		if (markdown_work) {
			const nonBlankLines = markdown.match(MARKDOWN_NONBLANK_LINE_REGEX)?.length ?? 0;
			let lines = 1;
			for (let index = markdown.indexOf("\n"); index !== -1; index = markdown.indexOf("\n", index + 1)) {
				lines += 1;
			}
			markdown_work_add(
				nonBlankLines * MARKDOWN_WORK_NONBLANK_LINE + (lines - nonBlankLines) * MARKDOWN_WORK_BLANK_LINE,
			);
		}

		html = files_marked().parse(markdown);
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message:
					error instanceof MarkdownWorkLimitError
						? "Markdown needs too much work to parse"
						: "Error while parsing markdown to HTML",
				cause: error,
			},
		});
	} finally {
		markdown_work = null;
		markdown_hidden_link_text = null;
	}

	const trailingWhitespaceOnlyLine = markdown.match(TRAILING_WHITESPACE_ONLY_LINE_REGEX)?.[1];
	if (trailingWhitespaceOnlyLine) {
		return Result({
			_yay: html + `<p>${trailingWhitespaceOnlyLine}</p>`,
		});
	}

	// Preserve trailing empty lines at EOF (Markdown usually ignores them).
	// A single final `\n` is a plain line terminator (POSIX file shape), not an empty
	// line, so only the newlines beyond it become empty paragraphs (2 `\n` each, odd
	// counts round up). files_yjs_doc_get_text's rich branch mirrors this by ending
	// non-empty file content with one `\n`, so newline-terminated text round-trips byte-exact.
	const trailingNewlines = markdown.match(TRAILING_NEWLINES_REGEX)?.[0] ?? "";
	const newlineCount = trailingNewlines.length;
	const paragraphCount = Math.ceil(Math.max(0, newlineCount - 1) / 2);
	if (paragraphCount === 0) return Result({ _yay: html });

	return Result({
		_yay: html + "<p></p>".repeat(paragraphCount),
	});
}

/**
 * Parse markdown string to HTML.
 *
 * Pass `options` for text from a public link. `cache: false` skips the cache. The parse does not read
 * it and does not add to it. The cache keeps every input and output, and public revisions must not pile
 * up there. `workLimit` stops the parse with an error once Marked has done about that many nanoseconds
 * of work, so a hostile file cannot use a query's whole time. The public link reader also passes
 * `hiddenLinkText`. It gets each link's address and returns the text that replaces the label of a link
 * the public page hides.
 */
export const files_parse_markdown_to_html = ((/* iife */) => {
	function value(markdown: string) {
		return tiptap_markdown_to_html({
			markdown,
		});
	}

	const cache = new Map<Parameters<typeof value>[0], ReturnType<typeof value>>();

	return function files_parse_markdown_to_html(
		markdown: string,
		options?: { cache: false; workLimit: number; hiddenLinkText?: (href: string) => string | null },
	) {
		if (options?.cache === false) {
			return tiptap_markdown_to_html({
				markdown,
				workLimit: options.workLimit,
				hiddenLinkText: options.hiddenLinkText,
			});
		}

		const cachedValue = cache.get(markdown);
		if (cachedValue) {
			return cachedValue;
		}

		const result = value(markdown);
		cache.set(markdown, result);
		return result;
	};
})();

export function files_tiptap_html_to_json(args: { html: string; extensions?: Extensions }) {
	const extensions = args.extensions ?? get_tiptap_shared_extensions_list();
	const parseOptions = {
		preserveWhitespace: "full" as const,
	};
	// Keep a newline between two inline tags. It is text: dropping it joined `*a*\n<u>b</u>` into `*a*<u>b</u>`.
	const normalizedHtml = args.html
		.replace(STRUCTURAL_HTML_WHITESPACE_REGEX, (match, offset: number) => {
			const before = HTML_TAG_NAME_START_REGEX.exec(args.html.slice(args.html.lastIndexOf("<", offset)))?.[1];
			const after = HTML_TAG_NAME_START_REGEX.exec(args.html.slice(offset + match.length - 1))?.[1];
			const inline =
				before !== undefined &&
				after !== undefined &&
				HTML_INLINE_LAYOUT_TAG_NAMES.has(before.toLowerCase()) &&
				HTML_INLINE_LAYOUT_TAG_NAMES.has(after.toLowerCase());
			return inline ? match : "><";
		})
		.trimEnd();

	const json = is_browser()
		? tiptap_generateJSON_browser(normalizedHtml, extensions, parseOptions)
		: tiptap_generateJSON_server(normalizedHtml, extensions, parseOptions);

	return json;
}

// #region frontmatter
// The frontmatter parser lives inside `files_marked()` above as a custom marked
// block tokenizer. This Node is the Tiptap end of the round-trip: it picks up
// the `<pre data-frontmatter>` HTML emitted by marked and re-emits the YAML
// fence when serializing back to markdown.
export const files_frontmatter_node = Node.create({
	name: "frontmatter",
	// Above `codeBlock` (default priority 100) so `<pre data-frontmatter>` is
	// picked up by this node instead of being parsed as a generic code block.
	priority: 1000,
	group: "block",
	// Keep the YAML as plain editable text, like a code block. Users edit the
	// front matter directly in place, so there is no structured UI or separate
	// edit mode, and bulk edits work like normal document text.
	content: "text*",
	marks: "",
	code: true,
	defining: true,

	parseHTML() {
		return [{ tag: "pre[data-frontmatter]", preserveWhitespace: "full" }];
	},

	renderHTML() {
		return ["pre", { "data-frontmatter": "" }, 0];
	},

	renderMarkdown(node, _helpers, context) {
		const text = (node.content ?? []).map((child) => child.text ?? "").join("");
		// The `---` fence reads back as frontmatter only at the start of the document, and a `---` line
		// in the text would end it early. Elsewhere write the HTML that `parseHTML` reads, so the text
		// never turns into Markdown. A slice written on its own (inline AI prompt text) has no parent type.
		if (context.index !== 0 || (context.parentType ?? "doc") !== "doc" || /^---$/m.test(text)) {
			const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			return `<pre data-frontmatter>${escaped}</pre>`;
		}
		// The doc renderer joins block-level siblings with "\n\n",
		// so frontmatter must not emit its own trailing newlines.
		return `---\n${text}\n---`;
	},
});
// #endregion frontmatter

// #region media embeds
// Images and videos in a document reference a workspace file by node id
// (`bonobo-file://<fileNodeId>`) or hold a plain external url. The bytes never live in the
// document, and a signed url must never be written into `src`: signed urls expire after
// minutes, so one would be dead by the time anyone reads the file again. The client resolves
// a reference to a signed url only while rendering.

/**
 * Escape text that goes inside `![...]`.
 *
 * An unescaped bracket would end the alt text early, and a newline would end the image.
 */
function markdown_escape_image_alt(text: string) {
	return text.replace(/([\\[\]])/g, "\\$1").replace(/\r?\n/g, " ");
}

/**
 * Write a url as a markdown link destination.
 */
function markdown_link_destination(url: string) {
	if (!MARKDOWN_URL_NEEDS_ANGLE_BRACKETS_REGEX.test(url)) {
		return url;
	}

	return `<${url.replace(/([<>\\])/g, "\\$1")}>`;
}

function html_escape_attribute(value: string) {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const IMAGE_PIXEL_WIDTH_REGEX = /^[1-9]\d*$/;

/**
 * Write an image as a raw `<img>` tag. Keep the attribute order fixed so the round-trip stays byte-stable.
 */
function image_html_tag(node: TiptapJSONContent) {
	const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
	const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
	const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
	const width =
		typeof node.attrs?.width === "number" && Number.isFinite(node.attrs.width) && node.attrs.width > 0
			? Math.round(node.attrs.width)
			: null;
	const align = node.attrs?.align === "center" || node.attrs?.align === "right" ? node.attrs.align : null;

	const altAttribute = alt ? ` alt="${html_escape_attribute(alt)}"` : "";
	const titleAttribute = title ? ` title="${html_escape_attribute(title)}"` : "";
	const widthAttribute = width !== null ? ` width="${width}"` : "";
	const alignAttribute = align !== null ? ` align="${align}"` : "";
	return `<img src="${html_escape_attribute(src)}"${altAttribute}${titleAttribute}${widthAttribute}${alignAttribute}${html_kept_attributes(node)}>`;
}

/**
 * Image embed.
 *
 * Inline because CommonMark images are inline. Marked wraps a standalone `![alt](src)` in
 * `<p>`, so a block image node would split that paragraph and leave an empty one behind on
 * every round-trip.
 */
const files_image_node = Node.create({
	name: "image",
	inline: true,
	group: "inline",
	draggable: true,

	addAttributes() {
		return {
			src: { default: null },
			alt: { default: null },
			title: { default: null },
			// Pixel width picked with the resize handle. Markdown image syntax cannot carry a
			// width, so a sized image serializes as a raw `<img>` tag (see `renderMarkdown`).
			width: {
				default: null,
				parseHTML: (element) => {
					const value = element.getAttribute("width") ?? "";
					// A file's `width="50%"` is not a pixel width. `htmlAttributes` keeps it as written.
					if (element.hasAttribute("data-html-kept") && !IMAGE_PIXEL_WIDTH_REGEX.test(value)) {
						return null;
					}

					const parsed = Number.parseInt(value, 10);
					return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
				},
			},
			// Horizontal placement. `null` is the inline/left default; markdown cannot carry it,
			// so an aligned image serializes as a raw `<img>` tag like a sized one (see
			// `renderMarkdown`).
			align: {
				default: null,
				parseHTML: (element) => {
					const value = element.getAttribute("align");
					return value === "center" || value === "right" ? value : null;
				},
			},
			// The attributes of a file's `<img>` that the attributes above do not hold, like `height` or
			// `align="left"`.
			htmlAttributes: html_kept_attributes_attribute(
				(attribute) =>
					attribute.name === "src" ||
					attribute.name === "alt" ||
					attribute.name === "title" ||
					(attribute.name === "width" && IMAGE_PIXEL_WIDTH_REGEX.test(attribute.value)) ||
					(attribute.name === "align" && (attribute.value === "center" || attribute.value === "right")),
			),
			// Set while an upload runs, so the client can find its own placeholder node again
			// after the upload mutations resolve. `rendered: false` keeps it out of the HTML,
			// and `renderMarkdown` below ignores it, so it never reaches the saved markdown.
			uploadId: { default: null, rendered: false },
		};
	},

	parseHTML() {
		// A browser reads an `<image>` tag as `<img>`. Read it the same way on the server, so a server
		// check sees every image the browser editor would save.
		return [{ tag: "img[src]" }, { tag: "image[src]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["img", HTMLAttributes];
	},

	renderMarkdown(node) {
		const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
		const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
		const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
		const width =
			typeof node.attrs?.width === "number" && Number.isFinite(node.attrs.width) && node.attrs.width > 0
				? Math.round(node.attrs.width)
				: null;
		const align = node.attrs?.align === "center" || node.attrs?.align === "right" ? node.attrs.align : null;

		// A sized or aligned image, or one with other attributes, rides through markdown as a raw `<img>`
		// tag, the same way the video node below always does.
		if (width !== null || align !== null || html_kept_attributes(node)) {
			return image_html_tag(node);
		}

		const image = `![${markdown_escape_image_alt(alt)}](${markdown_link_destination(src)}`;
		return title ? `${image} "${title.replace(/([\\"])/g, "\\$1")}")` : `${image})`;
	},

	// Write the image inside the link or bold around it. Without this, save closes the marks before
	// the image, so a linked image `[![i](src)](page)` lost its link.
	markdownOptions: {
		staysInsideMarks: true,
	},
});

/**
 * Write a video as a raw `<video>` tag. Keep the attribute order fixed so the round-trip stays byte-stable.
 */
function video_html_tag(node: TiptapJSONContent) {
	const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
	const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
	const width =
		typeof node.attrs?.width === "number" && Number.isFinite(node.attrs.width) && node.attrs.width > 0
			? Math.round(node.attrs.width)
			: null;
	const align = node.attrs?.align === "center" || node.attrs?.align === "right" ? node.attrs.align : null;

	const titleAttribute = title ? ` title="${html_escape_attribute(title)}"` : "";
	const widthAttribute = width !== null ? ` width="${width}"` : "";
	const alignAttribute = align !== null ? ` align="${align}"` : "";
	return `<video src="${html_escape_attribute(src)}"${titleAttribute}${widthAttribute}${alignAttribute}></video>`;
}

/**
 * Video embed.
 *
 * Markdown has no video syntax, so it serializes to a raw `<video>` tag, the same way
 * comments and underlines already ride through markdown as HTML. The parse direction needs
 * the `videoBlock` tokenizer in `files_marked()`, otherwise marked wraps the tag in `<p>`.
 */
const files_video_node = Node.create({
	name: "video",
	group: "block",
	atom: true,
	draggable: true,

	addAttributes() {
		return {
			src: { default: null },
			// Caption text, like the image node's `title`. The raw `<video>` tag is already the
			// only markdown form, so the caption rides as a `title` attribute on it.
			title: { default: null },
			// Same pixel width as the image node above.
			width: {
				default: null,
				parseHTML: (element) => {
					const parsed = Number.parseInt(element.getAttribute("width") ?? "", 10);
					return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
				},
			},
			// Same horizontal placement as the image node above.
			align: {
				default: null,
				parseHTML: (element) => {
					const value = element.getAttribute("align");
					return value === "center" || value === "right" ? value : null;
				},
			},
			// Same upload placeholder marker as the image node above.
			uploadId: { default: null, rendered: false },
		};
	},

	parseHTML() {
		return [{ tag: "video[src]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["video", { controls: "true", ...HTMLAttributes }];
	},

	renderMarkdown(node) {
		return video_html_tag(node);
	},
});
// #endregion media embeds

// #region tables
// marked writes the column alignment onto every cell of the column, header and body alike, so
// the alignment lives on cells here too. GFM only knows these three values.
const files_table_cell_align_attribute = {
	align: {
		default: null as "left" | "center" | "right" | null,
		parseHTML: (element: HTMLElement) => {
			const align = element.getAttribute("align");
			return align === "left" || align === "center" || align === "right" ? align : null;
		},
		renderHTML: (attributes: Record<string, unknown>) => {
			const align = attributes.align;
			return align ? { align } : {};
		},
	},
};

/**
 * An attribute that keeps HTML that the Marked renderer stored URI-encoded in the data attribute `name`.
 */
function html_data_attribute(name: string) {
	return {
		default: null,
		rendered: false,
		parseHTML: (element: HTMLElement) => {
			const value = element.getAttribute(name);
			return value === null ? null : html_attribute_decode(value);
		},
	};
}

/**
 * An attribute that keeps the HTML attributes that the editor does not use, like `style` or `class`, as text.
 * Save writes them back on the tag. They are not rendered, because an author `style` could load a remote image.
 *
 * Only elements that `html_table_to_editor_html` or `html_shown_tag_to_editor_html` marked with
 * `data-html-kept` have them. A table pasted from a web page has no mark, so it does not keep the page's
 * classes and stays a pipe table.
 */
function html_kept_attributes_attribute(isModeled: (attribute: Attr) => boolean) {
	return {
		default: null,
		rendered: false,
		parseHTML: (element: HTMLElement) => {
			if (!element.hasAttribute("data-html-kept")) {
				return null;
			}

			let attributes = "";
			for (const attribute of Array.from(element.attributes)) {
				if (!attribute.name.startsWith("data-html-") && !isModeled(attribute)) {
					attributes += ` ${attribute.name}="${html_escape_attribute(attribute.value)}"`;
				}
			}
			return attributes || null;
		},
	};
}

const TABLE_CELL_MODELED_ATTRIBUTES = ["colspan", "rowspan", "colwidth", "data-colwidth", "align"];

// Cells hold any blocks, so an HTML table keeps the lists and code in its cells. A pipe table cannot hold
// them, so a table with one saves as an HTML table (`table_fits_pipe`).
const files_table_cell_node = TableCell.extend({
	content: "block+",

	// The explicit `this` annotation is needed because `extend` types its config against a
	// union, which loses the `parent` member from the inferred context.
	addAttributes(this: { parent?: () => Record<string, unknown> }) {
		return {
			...this.parent?.(),
			...files_table_cell_align_attribute,
			htmlAttributes: html_kept_attributes_attribute((attribute) =>
				TABLE_CELL_MODELED_ATTRIBUTES.includes(attribute.name),
			),
		};
	},
});

const files_table_header_node = TableHeader.extend({
	content: "block+",

	addAttributes(this: { parent?: () => Record<string, unknown> }) {
		return {
			...this.parent?.(),
			...files_table_cell_align_attribute,
			htmlAttributes: html_kept_attributes_attribute((attribute) =>
				TABLE_CELL_MODELED_ATTRIBUTES.includes(attribute.name),
			),
		};
	},
});

/**
 * A table row. `section` says if an HTML table had it in `<thead>`, `<tbody>` or `<tfoot>`. `htmlBefore` keeps
 * the HTML before the row that the editor does not show, like a caption or a comment between rows.
 */
const files_table_row_node = TableRow.extend({
	addAttributes(this: { parent?: () => Record<string, unknown> }) {
		return {
			...this.parent?.(),
			section: {
				default: null,
				rendered: false,
				parseHTML: (element: HTMLElement) => {
					const value = element.getAttribute("data-html-row-section");
					return value === "head" || value === "body" || value === "foot" ? value : null;
				},
			},
			htmlBefore: html_data_attribute("data-html-before"),
			htmlAttributes: html_kept_attributes_attribute(() => false),
		};
	},
});

const BACKSLASH_BEFORE_PIPE_REGEX = /\\\|/;

/**
 * Turn one table cell into the text between two pipes.
 */
function files_render_table_cell_markdown(cell: TiptapJSONContent, helpers: MarkdownRendererHelpers) {
	// Markdown has no way to put a second block inside a table cell, so the blocks are joined
	// with `<br>`. A real newline would end the row and destroy the whole table.
	const rendered = (cell.content ?? [])
		.map((paragraph) => {
			const parts: string[] = [];
			let inline: TiptapJSONContent[] = [];
			for (const node of paragraph.content ?? []) {
				if (
					node.type === "text" &&
					typeof node.text === "string" &&
					BACKSLASH_BEFORE_PIPE_REGEX.test(node.text) &&
					node.marks?.some((mark) => mark.type === "code")
				) {
					parts.push(helpers.renderChildren(inline));
					inline = [];
					// Backtick code would grow its backslashes on every save. Write HTML directly:
					// Tiptap now escapes HTML in text nodes. Entities also disarm inline Markdown.
					const escaped = node.text.replace(/[^A-Za-z0-9 ]/gu, (char) => `&#${char.codePointAt(0)};`);
					parts.push(`<code>${escaped}</code>`);
				} else {
					inline.push(node);
				}
			}
			parts.push(helpers.renderChildren(inline));
			return parts.join("");
		})
		.join("<br>");

	// A hard break serializes as spaces plus a newline, never as a backslash. Turn every newline,
	// with the spaces around it, into `<br>` for the same reason.
	const singleLine = rendered.replace(/[ \t]*\n[ \t]*/g, "<br>").trim();

	// A backslash right before an inserted `<br>` would escape the `<` on the next parse and turn
	// the break into literal text. Tiptap doubled them; write one reference per original backslash.
	const brSafe = singleLine.replace(/\\+(?=<br>)/g, (run) => "&#92;".repeat(run.length / 2));

	// GFM drops the spaces around cell text when it parses, so trim here too, or the next parse
	// would not give the same text back.
	//
	// Tiptap already doubles literal backslashes. Only the table's pipe escape remains.
	return brSafe.replace(/\|/g, "\\|");
}

/**
 * Write a table as a GFM pipe table. `table_fits_pipe` must say yes first, so no cell is merged.
 *
 * Keep compact rows without column padding, and keep code backslashes stable across saves. The
 * upstream renderer does not handle those cases.
 */
function files_render_table_markdown(node: TiptapJSONContent, helpers: MarkdownRendererHelpers) {
	const rows = node.content ?? [];
	const firstRowCells = rows[0]?.content ?? [];

	// marked fixes the column count from the delimiter row, and a row with a different count breaks
	// the table, so every row we write gets exactly this many cells. Take the widest row, not the
	// first one: an empty leading `<tr>` in pasted HTML parses as a narrow first row, and measuring
	// there would throw away the real table below it.
	const columnCount = rows.reduce((widest, row) => Math.max(widest, row.content?.length ?? 0), 0);
	if (columnCount === 0) {
		return "";
	}

	const renderRow = (rowIndex: number) => {
		const cells: string[] = [];
		for (let column = 0; column < columnCount; column += 1) {
			const cell = rows[rowIndex]?.content?.[column];
			cells.push(cell ? files_render_table_cell_markdown(cell, helpers) : "");
		}
		return `| ${cells.join(" | ")} |`;
	};

	const firstRowIsHeader = firstRowCells.some((cell) => cell.type === "tableHeader");

	// GFM always needs a header row. When the document's first row holds body cells, write an
	// empty header and keep every row in the body. The next parse gives that empty header back,
	// so the round trip after this one changes nothing.
	const headerLine = firstRowIsHeader ? renderRow(0) : `| ${new Array(columnCount).fill("").join(" | ")} |`;

	// Read the alignment from the first row whether or not it is a header row, so a table whose
	// header was toggled off keeps its columns aligned.
	const alignments = firstRowCells.map((cell) => {
		const align = cell.attrs?.align;
		return align === "left" || align === "center" || align === "right" ? align : null;
	});

	const delimiterCells = new Array(columnCount).fill(null).map((_unused, index) => {
		switch (alignments[index]) {
			case "left":
				return ":---";
			case "center":
				return ":---:";
			case "right":
				return "---:";
			default:
				return "---";
		}
	});

	const firstBodyRow = firstRowIsHeader ? 1 : 0;
	const bodyLines = rows.slice(firstBodyRow).map((_row, index) => renderRow(firstBodyRow + index));

	// No leading and no trailing newline: the `doc` node already joins blocks with `\n\n`, and
	// `files_yjs_doc_get_text` adds the file's final newline.
	return [headerLine, `| ${delimiterCells.join(" | ")} |`, ...bodyLines].join("\n");
}

/**
 * Say if a pipe table can hold the table. It cannot hold a merged cell, a block other than a paragraph in a
 * cell, or kept HTML. Several paragraphs in a cell are fine: they are joined with `<br>`, so pressing Enter in
 * a cell does not turn the table into HTML.
 */
function table_fits_pipe(table: TiptapJSONContent) {
	if (table.attrs?.htmlAttributes || table.attrs?.htmlAfterRows) {
		return false;
	}

	return (table.content ?? []).every(
		(row) =>
			!row.attrs?.htmlAttributes &&
			!row.attrs?.htmlBefore &&
			(row.content ?? []).every(
				(cell) =>
					(Number(cell.attrs?.colspan) || 1) === 1 &&
					(Number(cell.attrs?.rowspan) || 1) === 1 &&
					!cell.attrs?.htmlAttributes &&
					(cell.content ?? []).every((block) => block.type === "paragraph"),
			),
	);
}

const HTML_MERGE_TAG_REGEX = /<(\/?)(table|details)(?=[\s/>])/gi;
const HTML_BLOCK_MERGE_START_REGEX = /^<(table|details)[\s>]/i;
const HTML_TABLE_STRUCTURE_TAG_REGEX = /^(?:table|thead|tbody|tfoot|tr|td|th)$/;
const WHITESPACE_WITH_NEWLINE_REGEX = /\s*\n\s*/g;
const HTML_TABLE_TEXT_ESCAPE_REGEX = /[&<>\n]/g;
const HTML_TABLE_SECTIONS = { thead: "head", tbody: "body", tfoot: "foot" } as const;
const HTML_TABLE_SECTION_TAGS = { head: "thead", body: "tbody", foot: "tfoot" } as const;
/**
 * Block tags that a table cell reads as blocks.
 */
const HTML_TABLE_BLOCK_TAGS = new Set([
	"p",
	"ul",
	"ol",
	"li",
	"pre",
	"blockquote",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"video",
	"details",
	"summary",
]);

/**
 * Join each HTML table or details block that Marked split into several blocks into one `htmlTable` or
 * `htmlDetails` token.
 *
 * Marked ends an HTML block at a blank line. So a README table with Markdown in a cell comes as an HTML block
 * that opens the table, the Markdown blocks, and an HTML block that closes it. A GitHub `<details>` with
 * Markdown inside comes the same way. Read one by one, the closing block became an `htmlBlock`, and the
 * Markdown moved out of the table. A join happens only when its last block ends right after the closing tag, so
 * no other content shares its source text (`htmlSource`).
 */
function html_merge_tokens(mut_tokens: Token[]) {
	// Pair each opening tag with its closing tag in one pass, like brackets. Many unclosed tags then stay cheap.
	const opens = { table: [], details: [] } as Record<
		"table" | "details",
		Array<{ tokenIndex: number; joins: boolean }>
	>;
	const pairs = new Map<number, { name: "table" | "details"; lastTokenIndex: number }>();
	mut_tokens.forEach((token, tokenIndex) => {
		if (token.type !== "html") {
			return;
		}

		markdown_work_add(token.text.length * MARKDOWN_WORK_HTML_TABLE_SCAN_PER_CHAR);
		// Only a block that starts with the tag can start a join.
		let joinName = token.block ? HTML_BLOCK_MERGE_START_REGEX.exec(token.text.trimStart())?.[1].toLowerCase() : null;
		for (const match of token.text.matchAll(HTML_MERGE_TAG_REGEX)) {
			const name = match[2].toLowerCase() === "table" ? "table" : "details";
			if (!match[1]) {
				opens[name].push({ tokenIndex, joins: joinName === name });
				joinName = null;
				continue;
			}

			const open = opens[name].pop();
			const closeEnd = token.text.indexOf(">", match.index) + 1;
			if (open?.joins && closeEnd > 0 && token.text.slice(closeEnd).trim() === "") {
				pairs.set(open.tokenIndex, { name, lastTokenIndex: tokenIndex });
			}
		}
	});

	// Join the pairs between `from` and `to`. A table reads the tables inside it itself, so they stay split. A
	// table and a details block can cross, like `<details> <table> </details> </table>`. Then the inner one stays
	// split.
	const join = (from: number, to: number, inTable: boolean): Token[] => {
		const joined: Token[] = [];
		for (let index = from; index < to; index++) {
			const pair = pairs.get(index);
			if (pair === undefined || pair.lastTokenIndex >= to || (inTable && pair.name === "table")) {
				joined.push(mut_tokens[index]);
				continue;
			}

			const last = pair.lastTokenIndex;
			const parts =
				last === index
					? [mut_tokens[index]]
					: [mut_tokens[index], ...join(index + 1, last, inTable || pair.name === "table"), mut_tokens[last]];
			joined.push({
				type: pair.name === "table" ? "htmlTable" : "htmlDetails",
				raw: mut_tokens
					.slice(index, last + 1)
					.map((part) => part.raw)
					.join(""),
				tokens: parts,
			});
			index = last;
		}
		return joined;
	};

	if (pairs.size > 0) {
		const joined = join(0, mut_tokens.length, false);
		// Keep the array itself. Marked keeps the link definitions on it.
		mut_tokens.length = 0;
		for (const token of joined) {
			mut_tokens.push(token);
		}
	}

	// Lists and quotes hold their own blocks, also inside a joined token.
	const mergeNested = (tokens: Token[]) => {
		for (const token of tokens) {
			if (token.type === "list") {
				for (const item of token.items) {
					html_merge_tokens(item.tokens);
				}
			} else if (token.type === "blockquote") {
				html_merge_tokens(token.tokens ?? []);
			} else if (token.type === "htmlTable" || token.type === "htmlDetails") {
				mergeNested((token as { tokens?: Token[] }).tokens ?? []);
			}
		}
	};
	mergeNested(mut_tokens);

	return mut_tokens;
}

/**
 * Turn the parts of an HTML table (`html_table_merge_tokens`) into editor HTML.
 *
 * Table, row and cell tags, and the block tags that a cell reads, stay tags. Any other tag in a cell becomes a
 * hidden tag node, like in an HTML block. Markdown parts in a cell render as usual.
 *
 * The editor does not show a caption, a `colgroup`, or anything between rows. Their HTML goes on the next row
 * (`htmlBefore`), or on the table after its last row (`htmlAfterRows`), so save writes them back. Section tags
 * become each row's `section`. The outer table keeps its whole source in `htmlSource`, so save writes it back
 * exactly while nobody changes the table.
 */
function html_table_to_editor_html(args: { raw: string; parts: Token[]; parse: (tokens: Token[]) => string }) {
	const pieces: Array<{ kind: "text" | "pre" | "tag" | "hidden" | "markdown"; html: string; name?: string }> = [];
	// One entry per open table, the innermost last.
	const tables: Array<{
		openPiece: { html: string };
		section: "head" | "body" | "foot" | null;
		cellDepth: number;
		kept: string[];
	}> = [];
	// A caption or a colgroup that is read now.
	let keptPart: { name: string; html: string } | null = null;
	let preDepth = 0;
	const readInlineTag = html_inline_tag_reader();

	const keep = (html: string) => {
		if (keptPart) {
			keptPart.html += html;
		} else {
			tables.at(-1)?.kept.push(html);
		}
	};
	const endKeptPart = () => {
		if (keptPart) {
			tables.at(-1)?.kept.push(keptPart.html);
			keptPart = null;
		}
	};
	const inCell = () => keptPart === null && (tables.at(-1)?.cellDepth ?? 0) > 0;

	const readTag = (tag: string) => {
		const name = INLINE_HTML_TAG_NAME_REGEX.exec(tag)?.[1]?.toLowerCase() ?? "";
		const closing = tag.startsWith("</");
		// A browser ends a caption or a colgroup at the next row, cell, section or table tag, so do the same.
		if (keptPart && !(closing && name === keptPart.name) && !HTML_TABLE_STRUCTURE_TAG_REGEX.test(name)) {
			keptPart.html += tag;
			return;
		}
		if (keptPart && closing && name === keptPart.name) {
			keptPart.html += tag;
			endKeptPart();
			return;
		}
		endKeptPart();

		const table = tables.at(-1);
		if (name === "table") {
			if (closing) {
				const closed = tables.pop();
				if (closed && closed.kept.length > 0) {
					closed.openPiece.html = html_tag_with_attributes(
						closed.openPiece.html,
						name,
						` data-html-after="${encodeURIComponent(closed.kept.join("\n"))}"`,
					);
				}
				pieces.push({ kind: "tag", html: tag, name });
				return;
			}

			const source = tables.length === 0 ? args.raw.replace(TRAILING_NEWLINES_REGEX, "") : null;
			const openPiece = {
				kind: "tag" as const,
				html: html_tag_with_attributes(
					tag,
					name,
					" data-html-kept" + (source === null ? "" : ` data-html-source="${encodeURIComponent(source)}"`),
				),
				name,
			};
			pieces.push(openPiece);
			tables.push({ openPiece, section: null, cellDepth: 0, kept: [] });
			return;
		}
		if (!table) {
			return;
		}

		if (name === "thead" || name === "tbody" || name === "tfoot") {
			table.section = closing ? null : HTML_TABLE_SECTIONS[name];
		} else if (name === "tr" && !closing) {
			const section = table.section === null ? "" : ` data-html-row-section="${table.section}"`;
			const before = table.kept.length === 0 ? "" : ` data-html-before="${encodeURIComponent(table.kept.join("\n"))}"`;
			table.kept = [];
			pieces.push({
				kind: "tag",
				html: html_tag_with_attributes(tag, name, " data-html-kept" + section + before),
				name,
			});
		} else if (name === "td" || name === "th") {
			table.cellDepth = Math.max(0, table.cellDepth + (closing ? -1 : 1));
			pieces.push({ kind: "tag", html: closing ? tag : html_tag_with_attributes(tag, name, " data-html-kept"), name });
		} else if (name === "tr") {
			pieces.push({ kind: "tag", html: tag, name });
		} else if (table.cellDepth === 0) {
			if (!closing && (name === "caption" || name === "colgroup") && !tag.endsWith("/>")) {
				keptPart = { name, html: tag };
			} else {
				keep(tag);
			}
		} else if (HTML_TABLE_BLOCK_TAGS.has(name) || (name === "code" && preDepth > 0)) {
			// A code block's `<code class="language-js">` holds its language, so it is not a hidden tag.
			if (name === "pre") {
				preDepth = Math.max(0, preDepth + (closing ? -1 : 1));
			}
			pieces.push({ kind: "tag", html: tag, name });
		} else if (readInlineTag(tag)) {
			pieces.push({ kind: "tag", html: html_shown_tag_to_editor_html(tag, name), name });
		} else {
			pieces.push({ kind: "hidden", html: tag });
		}
	};

	const readText = (text: string) => {
		if (inCell()) {
			pieces.push({ kind: preDepth > 0 ? "pre" : "text", html: text });
		} else if (keptPart) {
			keptPart.html += text;
		} else if (text.trim()) {
			keep(text.trim());
		}
	};

	for (const part of args.parts) {
		if (part.type === "html") {
			let textStart = 0;
			for (const match of part.text.matchAll(HTML_TAG_REGEX)) {
				if (match.index > textStart) {
					readText(part.text.slice(textStart, match.index));
				}
				readTag(match[0]);
				textStart = match.index + match[0].length;
			}
			if (textStart < part.text.length) {
				readText(part.text.slice(textStart));
			}
		} else if (inCell()) {
			pieces.push({ kind: "markdown", html: args.parse([part]) });
		} else if (part.type !== "space") {
			keep(part.raw.replace(TRAILING_NEWLINES_REGEX, ""));
		}
	}

	// A line break next to a hidden tag is the author's layout. Move it into the tag, like in an HTML block. Any
	// other line break in a cell's text shows as a space, like in a browser. At a cell or block edge it shows as
	// nothing.
	const isEdge = (piece: (typeof pieces)[number] | undefined) =>
		piece === undefined ||
		piece.kind === "markdown" ||
		(piece.kind === "tag" && piece.name !== undefined && !INLINE_HTML_SUPPORTED_TAGS.has(piece.name)) ||
		piece.name === "br";
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index];
		const before = pieces[index - 1];
		const after = pieces[index + 1];
		if (piece.kind !== "hidden") {
			continue;
		}

		const whitespaceBefore = before?.kind === "text" ? TRAILING_WHITESPACE_REGEX.exec(before.html)?.[0] : undefined;
		if (whitespaceBefore?.includes("\n")) {
			before.html = before.html.slice(0, -whitespaceBefore.length);
			piece.html = whitespaceBefore + piece.html;
		}
		const whitespaceAfter = after?.kind === "text" ? LEADING_WHITESPACE_REGEX.exec(after.html)?.[0] : undefined;
		if (whitespaceAfter?.includes("\n")) {
			after.html = after.html.slice(whitespaceAfter.length);
			piece.html += whitespaceAfter;
		}
	}

	return pieces
		.map((piece, index) => {
			if (piece.kind === "hidden") {
				return `<span data-html-tag="${encodeURIComponent(piece.html)}"></span>`;
			}
			if (piece.kind === "pre") {
				return piece.html.replaceAll("<", "&lt;");
			}
			if (piece.kind !== "text") {
				return piece.html;
			}

			const text = piece.html.replace(WHITESPACE_WITH_NEWLINE_REGEX, (whitespace, offset: number) =>
				(offset === 0 && isEdge(pieces[index - 1])) ||
				(offset + whitespace.length === piece.html.length && isEdge(pieces[index + 1]))
					? ""
					: " ",
			);
			return text.replaceAll("<", "&lt;");
		})
		.join("");
}

/**
 * Write the HTML attributes text that `html_kept_attributes_attribute` kept.
 */
function html_kept_attributes(node: TiptapJSONContent) {
	return typeof node.attrs?.htmlAttributes === "string" ? node.attrs.htmlAttributes : "";
}

/**
 * Write a table as an HTML table, for a table that a pipe table cannot hold. Each row is one line. No line is
 * blank: a blank line would end the HTML block, and the rest of the table would read as Markdown.
 */
function html_table_render(table: TiptapJSONContent) {
	const lines = [`<table${html_kept_attributes(table)}>`];
	let openSection: string | null = null;
	for (const row of table.content ?? []) {
		const sectionName: unknown = row.attrs?.section;
		const section =
			sectionName === "head" || sectionName === "body" || sectionName === "foot"
				? HTML_TABLE_SECTION_TAGS[sectionName]
				: null;
		if (section !== openSection && openSection !== null) {
			lines.push(`</${openSection}>`);
		}
		if (typeof row.attrs?.htmlBefore === "string") {
			lines.push(row.attrs.htmlBefore);
		}
		if (section !== openSection) {
			if (section !== null) {
				lines.push(`<${section}>`);
			}
			openSection = section;
		}

		const cells = (row.content ?? []).map((cell) => {
			const tag = cell.type === "tableHeader" ? "th" : "td";
			const colspan = Number(cell.attrs?.colspan) || 1;
			const rowspan = Number(cell.attrs?.rowspan) || 1;
			const align = cell.attrs?.align;
			const attributes =
				(colspan > 1 ? ` colspan="${colspan}"` : "") +
				(rowspan > 1 ? ` rowspan="${rowspan}"` : "") +
				(align === "left" || align === "center" || align === "right" ? ` align="${align}"` : "") +
				html_kept_attributes(cell);
			return `<${tag}${attributes}>${html_render_item_content(cell.content ?? [])}</${tag}>`;
		});
		lines.push(`<tr${html_kept_attributes(row)}>${cells.join("")}</tr>`);
	}
	if (openSection !== null) {
		lines.push(`</${openSection}>`);
	}
	if (typeof table.attrs?.htmlAfterRows === "string") {
		lines.push(table.attrs.htmlAfterRows);
	}
	lines.push("</table>");

	return lines.join("\n");
}

/**
 * Write the content of a cell or a list item. One paragraph is written as bare text, so a small edit does not
 * wrap every cell in `<p>`.
 */
function html_render_item_content(content: TiptapJSONContent[]) {
	return content.length === 1 && content[0].type === "paragraph"
		? html_render_inline(content[0].content ?? [], HTML_TABLE_TEXT_ESCAPE_REGEX)
		: html_render_blocks(content);
}

/**
 * Write blocks inside an HTML table cell as HTML. `files.test.ts` checks that every block node type of the
 * shared schema has a branch here.
 */
function html_render_blocks(content: TiptapJSONContent[]): string {
	return content
		.map((node) => {
			const children = node.content ?? [];
			const childText = children.map((child) => child.text ?? "").join("");
			switch (node.type) {
				case "paragraph":
					return `<p>${html_render_inline(children, HTML_TABLE_TEXT_ESCAPE_REGEX)}</p>`;
				case "heading": {
					const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
					return `<h${level}>${html_render_inline(children, HTML_TABLE_TEXT_ESCAPE_REGEX)}</h${level}>`;
				}
				case "blockquote":
					return `<blockquote>${html_render_blocks(children)}</blockquote>`;
				case "bulletList":
					return `<ul>${html_render_blocks(children)}</ul>`;
				case "orderedList": {
					const start = Number(node.attrs?.start) || 1;
					return `<ol${start === 1 ? "" : ` start="${start}"`}>${html_render_blocks(children)}</ol>`;
				}
				case "listItem":
					return `<li>${html_render_item_content(children)}</li>`;
				case "taskList":
					return `<ul data-type="taskList">${html_render_blocks(children)}</ul>`;
				case "taskItem":
					return `<li data-type="taskItem" data-checked="${node.attrs?.checked ? "true" : "false"}">${html_render_item_content(children)}</li>`;
				case "codeBlock": {
					const language = typeof node.attrs?.language === "string" && node.attrs.language ? node.attrs.language : null;
					const languageAttribute = language === null ? "" : ` class="language-${html_escape_attribute(language)}"`;
					return `<pre><code${languageAttribute}>${html_escape_text(childText, HTML_TABLE_TEXT_ESCAPE_REGEX)}</code></pre>`;
				}
				case "horizontalRule":
					return "<hr>";
				case "video":
					return video_html_tag(node);
				case "table":
					return html_table_render(node);
				case "details":
					return html_details_render(node, html_render_blocks(node.content?.[1]?.content ?? []), "html");
				case "frontmatter":
					return `<pre data-frontmatter>${html_escape_text(childText, HTML_TABLE_TEXT_ESCAPE_REGEX)}</pre>`;
				// A comment in a cell reads back as a hidden tag in a paragraph. An HTML block and a footnote
				// definition read back as a paragraph.
				case "htmlComment":
					return `<p><!--${childText}--></p>`;
				case "footnoteDefinition":
					return `<p>${html_escape_text(childText, HTML_TABLE_TEXT_ESCAPE_REGEX)}</p>`;
				case "htmlBlock":
					return typeof node.attrs?.htmlSource === "string" && node.attrs.htmlSourceContent === JSON.stringify(children)
						? node.attrs.htmlSource
						: `<p>${html_render_inline(children, HTML_TABLE_TEXT_ESCAPE_REGEX)}</p>`;
				default:
					return "";
			}
		})
		.join("");
}

const files_table_node = Table.extend({
	addAttributes(this: { parent?: () => Record<string, unknown> }) {
		return {
			...this.parent?.(),
			// Like `htmlSource` on `files_html_block_node`: the source of a table read from HTML.
			htmlSource: html_data_attribute("data-html-source"),
			htmlSourceContent: { default: null, rendered: false, parseHTML: () => null },
			htmlAfterRows: html_data_attribute("data-html-after"),
			htmlAttributes: html_kept_attributes_attribute(() => false),
		};
	},

	// A table read from HTML stays HTML. Save writes its source exactly while its content is the same. A pipe
	// table stays a pipe table until it holds something a pipe table cannot write.
	renderMarkdown(node, helpers) {
		if (typeof node.attrs?.htmlSource === "string") {
			return node.attrs.htmlSourceContent === JSON.stringify(node.content ?? [])
				? node.attrs.htmlSource
				: html_table_render(node);
		}

		return table_fits_pipe(node) ? files_render_table_markdown(node, helpers) : html_table_render(node);
	},
});
// #endregion tables

// #region details
const DETAILS_NODE_NAMES = new Set(["details", "detailsSummary", "detailsContent"]);
const HTML_DETAILS_SUMMARY_REGEX = /^\s*(<summary(?=[\s>])[^>]*>)([\s\S]*?)<\/summary\s*>/i;
const HTML_DETAILS_CLOSE_REGEX = /<\/details(?=[\s/>])[^>]*>\s*$/i;

/**
 * Turn the parts of a details block (`html_merge_tokens`) into editor HTML for `files_details_node`.
 *
 * The first part starts with the `<details>` tag and usually holds the `<summary>`. The Markdown parts between
 * the first and the last part are the body. HTML text around them in the first or last part, like the body of a
 * details block with no blank lines, becomes an HTML block. The details block keeps its whole source in
 * `htmlSource`, so save writes it back exactly while nobody changes it.
 */
function html_details_to_editor_html(args: { raw: string; parts: Token[]; parse: (tokens: Token[]) => string }) {
	const first = args.parts[0];
	const last = args.parts[args.parts.length - 1];
	const leading = first.raw.length - first.raw.trimStart().length;
	const openMatch = first.raw.slice(leading).matchAll(HTML_TAG_REGEX).next().value;
	// Marked's tag pattern did not read the `<details>` tag. Read the parts one by one, like before the join.
	if (openMatch?.index !== 0) {
		return args.parse(args.parts);
	}

	const openTag = openMatch[0];
	let head = first.raw.slice(leading + openTag.length);
	let tail = "";
	const close = HTML_DETAILS_CLOSE_REGEX.exec(args.parts.length === 1 ? head : last.raw);
	if (close === null) {
		return args.parse(args.parts);
	}
	if (args.parts.length === 1) {
		head = head.slice(0, close.index);
	} else {
		tail = last.raw.slice(0, close.index);
	}

	// The editor shows the summary on one line. Save writes the summary's source back while nobody changes it.
	// Without a summary element, the DOM step moves the body out of the block, so write an empty one.
	const summary = HTML_DETAILS_SUMMARY_REGEX.exec(head);
	const summaryHtml =
		summary === null
			? "<summary></summary>"
			: `<summary data-html-open-tag="${encodeURIComponent(summary[1])}">${html_inline_to_editor_html(summary[2])
					.html.trim()
					.replace(WHITESPACE_WITH_NEWLINE_REGEX, " ")}</summary>`;
	const looseHtml = (html: string) => {
		const text = html.trim();
		return text ? html_block_to_editor_html(text) || text : "";
	};
	const body =
		looseHtml(summary === null ? head : head.slice(summary[0].length)) +
		args.parse(args.parts.slice(1, -1)) +
		looseHtml(tail);

	const source = encodeURIComponent(args.raw.replace(TRAILING_NEWLINES_REGEX, ""));
	return `<details data-html-source="${source}" data-html-open-tag="${encodeURIComponent(openTag)}">${summaryHtml}<div data-type="detailsContent">${body}</div></details>`;
}

/**
 * Write a details block around its `body`. The `markdown` layout is GitHub's: a blank line around the body, so
 * the body reads as Markdown. In a table cell no line may be blank, so the `html` layout writes the body as HTML
 * on one line.
 */
function html_details_render(details: TiptapJSONContent, body: string, layout: "markdown" | "html") {
	const summary = details.content?.[0];
	const openTag = typeof details.attrs?.htmlOpenTag === "string" ? details.attrs.htmlOpenTag : "<details>";
	const summaryOpenTag = typeof summary?.attrs?.htmlOpenTag === "string" ? summary.attrs.htmlOpenTag : null;
	const summaryHtml = html_render_inline(summary?.content ?? [], HTML_TABLE_TEXT_ESCAPE_REGEX);
	// Write no summary when the file had none and nobody typed one. A browser then shows its own "Details" label.
	const summaryLine =
		summaryHtml || summaryOpenTag !== null ? `${summaryOpenTag ?? "<summary>"}${summaryHtml}</summary>` : "";

	if (layout === "html") {
		return `${openTag}${summaryLine}${body}</details>`;
	}

	const head = summaryLine ? `${openTag}\n${summaryLine}` : openTag;
	return body ? `${head}\n\n${body}\n\n</details>` : `${head}\n\n</details>`;
}

/**
 * A `<details>` block that opens and closes, like on GitHub. Its body is Markdown.
 *
 * Like `files_html_block_node`, it keeps its source in `htmlSource`, and save writes the source exactly while the
 * content is the same. After an edit, save writes GitHub's layout (`html_details_render`). The open state is not
 * saved: it changes only the view, and a `<details open>` tag stays in `htmlOpenTag`.
 */
const files_details_node = Details.extend({
	addAttributes() {
		return {
			htmlSource: html_data_attribute("data-html-source"),
			htmlSourceContent: { default: null, rendered: false, parseHTML: () => null },
			htmlOpenTag: html_data_attribute("data-html-open-tag"),
		};
	},

	// Tiptap's plugin moves the caret out of a closed details block. It reads the editor view, and a headless
	// editor has none, so only the browser editor adds it back (`extensions.ts`).
	addProseMirrorPlugins() {
		return [];
	},

	renderMarkdown(node, helpers) {
		const content = node.content ?? [];
		if (typeof node.attrs?.htmlSource === "string" && node.attrs.htmlSourceContent === JSON.stringify(content)) {
			return node.attrs.htmlSource;
		}

		return html_details_render(node, helpers.renderChildren(content[1]?.content ?? [], "\n\n"), "markdown");
	},
});

const files_details_summary_node = DetailsSummary.extend({
	// Tiptap's summary holds only plain text. Hold formatting and hidden tags too.
	content: "inline*",

	addAttributes() {
		return {
			htmlOpenTag: html_data_attribute("data-html-open-tag"),
		};
	},
});
// #endregion details

// #region keyboard keys
/**
 * Keyboard keys, like `<kbd>Ctrl</kbd>`. Markdown has no syntax for them, so save writes the tag back.
 */
export const files_kbd_mark = Mark.create({
	name: "kbd",

	parseHTML() {
		return [{ tag: "kbd" }];
	},

	renderHTML() {
		return ["kbd", 0];
	},

	renderMarkdown(node, helpers) {
		return `<kbd>${helpers.renderChildren(node.content || [])}</kbd>`;
	},
});
// #endregion keyboard keys

// #region html entities
/**
 * An HTML entity in the file text, like `&copy;`, `&nbsp;` or `&amp;`. Markdown reads `&#?\w+;` as an
 * entity, and so does Marked when it decides what to escape.
 */
const HTML_ENTITY_REGEX = /&#?\w+;/g;

/**
 * Turn `text` into HTML. Each entity becomes a `<span data-html-entity>` that `files_html_entity_mark`
 * reads. `escape` writes the text between the entities.
 */
function html_entities_wrap(text: string, escape: (text: string) => string) {
	if (!text.includes("&")) {
		return escape(text);
	}

	let html = "";
	let textStart = 0;
	for (const match of text.matchAll(HTML_ENTITY_REGEX)) {
		html += escape(text.slice(textStart, match.index));
		html += `<span data-html-entity="${encodeURIComponent(match[0])}">${match[0]}</span>`;
		textStart = match.index + match[0].length;
	}
	return html + escape(text.slice(textStart));
}

/**
 * The text that save writes for `text` under an entity mark. It is the entity while the text is still
 * its character, and `null` after the user changed it.
 */
function html_entity_render_text(text: string, attributes: Record<string, unknown>) {
	const { source, text: entityText } = attributes;
	if (typeof source !== "string" || typeof entityText !== "string" || !source || !entityText) {
		return null;
	}

	// The same entity twice in a row, like `&nbsp;&nbsp;`, is one text node under one mark.
	const count = text.length / entityText.length;
	return Number.isInteger(count) && text === entityText.repeat(count) ? source.repeat(count) : null;
}

/**
 * Remember how the file wrote an HTML entity. The editor shows the character, and save writes the entity
 * back. Without it, a save turned `&copy;` into `©` and `&nbsp;` into an invisible no-break space.
 *
 * The `text` renderer in `configure_marked` wraps each entity in a `<span data-html-entity>`. The DOM gives
 * the span the entity's character, and the mark keeps the character in `text`. When the user changes the
 * character, the text no longer matches, and save writes the new text with the usual escaping.
 */
export const files_html_entity_mark = Mark.create({
	name: "htmlEntity",
	// Text typed next to an entity is new text, so it does not take the mark.
	inclusive: false,

	addAttributes() {
		return {
			source: {
				default: "",
				parseHTML: (element) => html_attribute_decode(element.getAttribute("data-html-entity") ?? ""),
				renderHTML: (attributes) => ({ "data-html-entity": encodeURIComponent(String(attributes.source)) }),
			},
			// Marked's span holds one entity, so its text is the character. A copied editor span can hold
			// the same entity more than once, so it carries the character in an attribute.
			text: {
				default: "",
				parseHTML: (element) => {
					const text = element.getAttribute("data-html-entity-text");
					return text === null ? (element.textContent ?? "") : html_attribute_decode(text);
				},
				renderHTML: (attributes) => ({ "data-html-entity-text": encodeURIComponent(String(attributes.text)) }),
			},
		};
	},

	parseHTML() {
		return [{ tag: "span[data-html-entity]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["span", HTMLAttributes, 0];
	},

	renderMarkdown(node, helpers) {
		return helpers.renderChildren(node.content || []);
	},

	markdownOptions: {
		renderText: html_entity_render_text,
	},
});
// #endregion html entities

// #region markdown escapes
/**
 * ASCII punctuation, the characters a Markdown backslash can escape. The table writer keeps a `\|` that is
 * already escaped, so a `|` under the mark does not get a second backslash in a table.
 */
const MARKDOWN_ESCAPABLE_REGEX = /^[!-/:-@[-`{-~]+$/;

/**
 * The text that save writes for `text` under an escape mark: each character with its backslash. It is
 * `null` after the user typed a letter or a space inside, because `\a` is not an escape.
 */
function markdown_escape_render_text(text: string) {
	if (!MARKDOWN_ESCAPABLE_REGEX.test(text)) {
		return null;
	}

	return text.replace(/./g, "\\$&");
}

/**
 * Remember a backslash escape that the file wrote, like `\*`, `C\#` or `\$5`. The editor shows the
 * character, and save writes the backslash back. Without it, a save dropped every escape that the writer
 * did not need, so `\(a+b\)` lost the math markers that MathJax reads.
 *
 * The `text` renderer in `configure_marked` wraps each Marked escape in a `<span data-markdown-escape>`.
 */
export const files_markdown_escape_mark = Mark.create({
	name: "markdownEscape",
	// Text typed next to an escape is new text, so it does not take the mark.
	inclusive: false,

	parseHTML() {
		return [{ tag: "span[data-markdown-escape]" }];
	},

	renderHTML() {
		return ["span", { "data-markdown-escape": "" }, 0];
	},

	renderMarkdown(node, helpers) {
		return helpers.renderChildren(node.content || []);
	},

	markdownOptions: {
		renderText: markdown_escape_render_text,
	},
});
// #endregion markdown escapes

// #region hidden html tags
/**
 * Inline HTML tags that the editor reads as formatting, a link, an image, a video, or a line break.
 * `image` is here because a browser reads an `<image>` tag as `<img>`.
 */
const INLINE_HTML_SUPPORTED_TAGS = new Set([
	"u",
	"mark",
	"span",
	"br",
	"img",
	"image",
	"video",
	"code",
	"a",
	"b",
	"strong",
	"i",
	"em",
	"s",
	"del",
	"strike",
	"sub",
	"sup",
	"kbd",
]);

const INLINE_HTML_TAG_NAME_REGEX = /^<\/?([a-z][a-z0-9-]*)/i;
const HTML_TAG_ATTRIBUTE_REGEX = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Say if the editor can show this opening tag as formatting and save it back without a loss.
 *
 * Each mark writes its tag with a fixed set of attributes. So a tag with any other attribute, like
 * `<span class>` or `<a target>`, would lose it on save. A typed `a<b and c>d` reads as a `<b>` tag too,
 * and it lost "b and c". Such a tag becomes a hidden tag instead, and its text shows as plain text.
 *
 * An image keeps its other attributes itself (`htmlAttributes`), and a video stays as before.
 */
function html_inline_tag_is_modeled(tag: string, name: string) {
	if (name === "img" || name === "image" || name === "video") {
		return true;
	}
	// A browser reads `<b/>` as an open `<b>`, which save would not write back.
	if (tag.endsWith("/>")) {
		return name === "br";
	}

	const attributes = Array.from(tag.slice(name.length + 1, -1).matchAll(HTML_TAG_ATTRIBUTE_REGEX), (match) => ({
		name: match[1].toLowerCase(),
		value: match[2] ?? match[3] ?? match[4] ?? "",
	}));
	const names = attributes
		.map((attribute) => attribute.name)
		.sort()
		.join(" ");
	// The style must hold only the one rule that the mark keeps, like `color: red`.
	const styleIsOnly = (property: string) => {
		const rules = (attributes.find((attribute) => attribute.name === "style")?.value ?? "")
			.split(";")
			.filter((rule) => rule.trim() !== "");
		return rules.length === 1 && rules[0].split(":")[0].trim().toLowerCase() === property;
	};

	switch (name) {
		case "a":
			return names === "href" || names === "href title";
		case "span":
			return (
				(names === "style" && styleIsOnly("color")) ||
				(names === "data-lb-thread-id data-type" &&
					attributes.some((attribute) => attribute.name === "data-type" && attribute.value === "comment"))
			);
		case "mark":
			return names === "" || (names === "style" && styleIsOnly("background-color"));
		default:
			return names === "";
	}
}

/**
 * Read the inline tags of one block in order. The returned function says for each tag if the editor shows
 * it. A closing tag shows only when its opening tag shows. Otherwise it is hidden too, so save writes the
 * pair back. A closing tag with no opening tag is hidden as well, because the DOM would drop it.
 */
function html_inline_tag_reader() {
	// The open tags of each name, the last one opened last. Each entry says if its tag shows.
	const openTags = new Map<string, boolean[]>();

	return (tag: string) => {
		const name = INLINE_HTML_TAG_NAME_REGEX.exec(tag)?.[1]?.toLowerCase();
		if (name === undefined || !INLINE_HTML_SUPPORTED_TAGS.has(name)) {
			return false;
		}
		if (tag.startsWith("</")) {
			return openTags.get(name)?.pop() ?? false;
		}

		const shown = html_inline_tag_is_modeled(tag, name);
		// These tags have no closing tag.
		if (name !== "br" && name !== "img" && name !== "image" && !tag.endsWith("/>")) {
			const open = openTags.get(name) ?? [];
			open.push(shown);
			openTags.set(name, open);
		}
		return shown;
	};
}

/**
 * Add `attributes` right after the tag name, so the tag's own attributes stay after them.
 */
function html_tag_with_attributes(tag: string, name: string, attributes: string) {
	return tag.slice(0, name.length + 1) + attributes + tag.slice(name.length + 1);
}

/**
 * A bold, italic, strikethrough, code or highlight tag with no attributes. Save writes it back as the same tag.
 */
const HTML_MARK_SYNTAX_TAG_REGEX = /^<(?:b|strong|i|em|s|del|strike|code|mark)>$/i;

/**
 * Write a tag that the editor shows. An image from the file gets `data-html-kept`, so the image node keeps
 * its other attributes (`htmlAttributes`). A pasted image has no mark, so it does not keep a web page's
 * classes.
 *
 * A bare formatting tag or a link tag gets `data-markdown-syntax`, so save writes `<b>` back instead of `**`.
 */
function html_shown_tag_to_editor_html(tag: string, name: string) {
	if (name === "img" || name === "image") {
		return html_tag_with_attributes(tag, name, " data-html-kept");
	}

	// Keep a link's own tag, so save writes `<a href>` back instead of `[text](href)`. Quote it with the
	// quote mark the tag does not use. Skip a tag with both quote marks or with `&`, because the DOM would
	// decode an `&amp;` and save would change it.
	if (name === "a" && /^<a\s/i.test(tag) && !tag.includes("&") && !(tag.includes("'") && tag.includes('"'))) {
		const quote = tag.includes("'") ? '"' : "'";
		return html_tag_with_attributes(tag, name, ` data-markdown-syntax=${quote}${tag}${quote}`);
	}

	// Write the tag unescaped. It has no quote or `&`, and happy-dom does not decode `&lt;` in attributes.
	return HTML_MARK_SYNTAX_TAG_REGEX.test(tag)
		? html_tag_with_attributes(tag, name, ` data-markdown-syntax="${tag}"`)
		: tag;
}

/**
 * The inline tag tokens that `html_hide_unmodeled_inline_tags` found. The `html` renderer writes them as
 * hidden tags.
 */
const html_hidden_inline_tags = new WeakSet<Token>();

/**
 * Bold, italic, a strikethrough, a highlight and a link hold inline tokens of their block. Their tags pair
 * with the other tags of the block.
 */
const HTML_INLINE_CONTAINER_TOKEN_TYPES = new Set(["strong", "em", "del", "link", "highlight"]);

/**
 * Find the supported inline tags that the editor must not show (`html_inline_tag_reader`), in every block
 * of the parsed file. Marked gives each tag as its own token, so the `html` renderer alone cannot pair them.
 */
function html_hide_unmodeled_inline_tags(tokens: Token[], readTag = html_inline_tag_reader()) {
	for (const token of tokens) {
		if (token.type === "html" && !token.block) {
			if (!readTag(token.text)) {
				html_hidden_inline_tags.add(token);
			}
			continue;
		}

		// Each block reads its tags with a new reader. `undefined` gives one.
		const parts = token as {
			tokens?: Token[];
			nestedTokens?: Token[];
			items?: Token[];
			header?: Array<{ tokens: Token[] }>;
			rows?: Array<Array<{ tokens: Token[] }>>;
		};
		if (parts.tokens) {
			html_hide_unmodeled_inline_tags(
				parts.tokens,
				HTML_INLINE_CONTAINER_TOKEN_TYPES.has(token.type) ? readTag : undefined,
			);
		}
		if (parts.nestedTokens) {
			html_hide_unmodeled_inline_tags(parts.nestedTokens);
		}
		for (const item of parts.items ?? []) {
			html_hide_unmodeled_inline_tags([item]);
		}
		for (const cell of [...(parts.header ?? []), ...(parts.rows ?? []).flat()]) {
			html_hide_unmodeled_inline_tags(cell.tokens);
		}
	}
	return tokens;
}

/**
 * Read back HTML that the Marked renderers stored URI-encoded in an attribute. happy-dom, the test DOM,
 * does not decode `&lt;` in an attribute, so HTML escaping would not read back the same in every parser.
 */
function html_attribute_decode(value: string) {
	// Pasted HTML from outside the app can hold a broken escape. Keep the raw text then.
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * An inline HTML tag that the editor cannot show, or an inline HTML comment. Examples: `<owner>`,
 * `<Foo />`, `</div>`, `<!-- note -->`.
 *
 * Before, the editor dropped these tags and kept only the text around them, so the next save deleted
 * them from the file. Now the tag is an empty node that shows nothing, and save writes it back exactly.
 * Code view, the agent, and the API still see the tag in the file.
 *
 * Marked gives each tag as its own token, and the `html` renderer in `configure_marked` writes it as
 * `<span data-html-tag>`. The DOM must never read the tag itself: it would treat `<owner>` as an open tag
 * that wraps the rest of the line, and it would write the name in lowercase.
 */
const files_html_tag_node = Node.create({
	name: "htmlTag",
	inline: true,
	group: "inline",
	atom: true,
	selectable: false,

	addAttributes() {
		return {
			html: {
				default: "",
				parseHTML: (element) => html_attribute_decode(element.getAttribute("data-html-tag") ?? ""),
				renderHTML: (attributes) => ({ "data-html-tag": encodeURIComponent(String(attributes.html)) }),
			},
		};
	},

	parseHTML() {
		return [{ tag: "span[data-html-tag]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["span", { ...HTMLAttributes, contenteditable: "false" }];
	},

	renderMarkdown(node) {
		return typeof node.attrs?.html === "string" ? node.attrs.html : "";
	},

	// Write the tag inside the bold or link around it, where the file had it. Without this, save closes
	// the marks before the tag and opens them again after it, so `**<a target>x</a>**` became
	// `<a target>**x**</a>`.
	markdownOptions: {
		staysInsideMarks: true,
	},
});
// #endregion hidden html tags

// #region html blocks
/**
 * Marked's inline tag pattern, changed to find every tag in a text instead of one tag at its start.
 */
const HTML_TAG_REGEX = ((/* iife */) => {
	const source = Lexer.rules.inline.gfm.tag.source;
	if (!source.startsWith("^<!--")) {
		throw should_never_happen("Marked's inline tag pattern changed");
	}

	return new RegExp(source.slice(1).replaceAll("|^<", "|<"), "g");
})();
const HTML_BLOCK_ALIGN_REGEX = /^<(?:p|div)\s[^>]*?\balign\s*=\s*["']?(left|center|right)\b/i;
const HTML_BLOCK_CENTER_REGEX = /^<center[\s>]/i;
const HTML_BLOCK_SCRIPT_OR_STYLE_REGEX = /^<(?:script|style)[\s>]/i;
const HTML_BLOCK_TABLE_REGEX = /^<table[\s>]/i;
const LEADING_WHITESPACE_REGEX = /^\s+/;
const TRAILING_WHITESPACE_REGEX = /(?<!\s)\s+$/;
const HTML_TEXT_ESCAPE_REGEX = /[&<>]/g;
const HTML_AND_MARKDOWN_TEXT_ESCAPE_REGEX = /[&<>\\`*_[\]~]/g;

/**
 * Turn one HTML block from Marked into editor HTML, or return `false` to keep Marked's own HTML.
 *
 * A block that is one comment becomes an `htmlComment` node. Any other block with a tag that the editor
 * cannot show becomes an `htmlBlock` node. Its unknown tags become hidden tag nodes, and its text and
 * known inline tags work as usual. A block with only known tags (the `<img width>` line that the image node
 * writes) stays plain inline content. Marked's HTML stays for a table, and for the `<pre data-frontmatter>`
 * that the frontmatter node writes.
 */
function html_block_to_editor_html(text: string) {
	const source = text.replace(TRAILING_NEWLINES_REGEX, "");
	const start = source.trimStart();
	if (start.startsWith("<pre data-frontmatter>") || HTML_BLOCK_TABLE_REGEX.test(start)) {
		return false;
	}

	// The block is one comment, with nothing after it on its last line.
	if (source.startsWith("<!--") && source.indexOf("-->", 4) === source.length - 3) {
		return `<div data-html-comment="${encodeURIComponent(source.slice(4, -3))}"></div>`;
	}

	let content: string;
	// Script and style text is code, not text for the reader. So the whole block is one hidden tag.
	if (HTML_BLOCK_SCRIPT_OR_STYLE_REGEX.test(start)) {
		content = `<span data-html-tag="${encodeURIComponent(source)}"></span>`;
	} else {
		const inline = html_inline_to_editor_html(source);
		// A block with no tag at all, like an unclosed `<!-- note`, still becomes an `htmlBlock`. With
		// Marked's HTML, the DOM would read it as a comment and drop it.
		if (inline.onlyKnownTags) {
			return inline.html;
		}
		content = inline.html;
	}

	const align = HTML_BLOCK_CENTER_REGEX.test(start)
		? "center"
		: (HTML_BLOCK_ALIGN_REGEX.exec(start)?.[1]?.toLowerCase() ?? null);
	const alignAttribute = align === null ? "" : ` data-align="${align}"`;
	return `<div data-html-block data-html-source="${encodeURIComponent(source)}"${alignAttribute}>${content}</div>`;
}

/**
 * Turn HTML text into editor inline HTML. Tags the editor cannot show become hidden tag nodes. Its text and
 * known inline tags work as usual. `onlyKnownTags` says if the text has a tag and every tag is known.
 */
function html_inline_to_editor_html(source: string) {
	const pieces: Array<{ kind: "text" | "tag" | "hidden"; html: string }> = [];
	const readInlineTag = html_inline_tag_reader();
	let textStart = 0;
	for (const match of source.matchAll(HTML_TAG_REGEX)) {
		if (match.index > textStart) {
			pieces.push({ kind: "text", html: source.slice(textStart, match.index) });
		}

		const name = INLINE_HTML_TAG_NAME_REGEX.exec(match[0])?.[1]?.toLowerCase();
		// A video is a block node. Inside inline content it would split the block in two.
		const known = name !== undefined && name !== "video" && readInlineTag(match[0]);
		pieces.push(
			known ? { kind: "tag", html: html_shown_tag_to_editor_html(match[0], name) } : { kind: "hidden", html: match[0] },
		);
		textStart = match.index + match[0].length;
	}
	if (textStart < source.length) {
		pieces.push({ kind: "text", html: source.slice(textStart) });
	}

	// A line break next to a hidden tag is the author's layout. Move it into the tag, so the editor does not
	// show an empty line for it, and save writes it back. The DOM step also removes a line break between two
	// tags (`STRUCTURAL_HTML_WHITESPACE_REGEX`), but not one inside an attribute.
	for (let index = 0; index < pieces.length; index++) {
		const piece = pieces[index];
		const before = pieces[index - 1];
		const after = pieces[index + 1];
		if (piece.kind !== "hidden") {
			continue;
		}

		const whitespaceBefore = before?.kind === "text" ? TRAILING_WHITESPACE_REGEX.exec(before.html)?.[0] : undefined;
		if (whitespaceBefore?.includes("\n")) {
			before.html = before.html.slice(0, -whitespaceBefore.length);
			piece.html = whitespaceBefore + piece.html;
		}
		const whitespaceAfter = after?.kind === "text" ? LEADING_WHITESPACE_REGEX.exec(after.html)?.[0] : undefined;
		if (whitespaceAfter?.includes("\n")) {
			after.html = after.html.slice(whitespaceAfter.length);
			piece.html += whitespaceAfter;
		}
	}

	// A `<` left in the text is not a whole tag, like the start of an unclosed comment. Escape it, so the DOM
	// shows it as text instead of reading the rest of the block as a tag.
	const html = pieces
		.map((piece) =>
			piece.kind === "hidden"
				? `<span data-html-tag="${encodeURIComponent(piece.html)}"></span>`
				: piece.kind === "text"
					? html_entities_wrap(piece.html, (text) => text.replaceAll("<", "&lt;"))
					: piece.html,
		)
		.join("");
	return {
		html,
		onlyKnownTags: pieces.some((piece) => piece.kind === "tag") && !pieces.some((piece) => piece.kind === "hidden"),
	};
}

/**
 * An HTML comment block, like `<!-- note -->` on its own lines. It shows as a dim block of plain text, like
 * the frontmatter node, and save writes it back as a comment.
 */
const files_html_comment_node = Node.create({
	name: "htmlComment",
	// Above `codeBlock` (default priority 100), so the `pre` that `renderHTML` writes reads back as this node.
	priority: 1000,
	group: "block",
	content: "text*",
	marks: "",
	code: true,
	defining: true,

	parseHTML() {
		return [
			// The Marked renderer keeps the text in an attribute. As the content of a `pre`, the DOM would drop
			// a line break right after `<pre>`, and the DOM step would drop a text of only line breaks.
			{
				tag: "div[data-html-comment]",
				getContent: (element, schema) => {
					const commentText = html_attribute_decode((element as HTMLElement).getAttribute("data-html-comment") ?? "");
					return commentText ? Fragment.from(schema.text(commentText)) : Fragment.empty;
				},
			},
			// A copy and paste inside the editor reads back the `pre` that `renderHTML` writes.
			{ tag: "pre[data-html-comment]", preserveWhitespace: "full" },
		];
	},

	renderHTML() {
		return ["pre", { "data-html-comment": "" }, 0];
	},

	renderMarkdown(node) {
		const commentText = (node.content ?? []).map((child) => child.text ?? "").join("");
		return `<!--${commentText}-->`;
	},
});

/**
 * Footnote definitions, like `[^1]: The note.` and the indented lines under it, and link definitions,
 * like `[x]: http://e.com`. The editor cannot show them, so they show as a block of source text, like a
 * comment block. Save writes the text back as it is.
 */
const files_footnote_definition_node = Node.create({
	name: "footnoteDefinition",
	// Above `codeBlock` (default priority 100), so the `pre` that `renderHTML` writes reads back as this node.
	priority: 1000,
	group: "block",
	content: "text*",
	marks: "",
	code: true,
	defining: true,

	parseHTML() {
		return [
			// Like the comment block, the Marked renderer keeps the text in an attribute.
			{
				tag: "div[data-footnote-definition]",
				getContent: (element, schema) => {
					const text = html_attribute_decode((element as HTMLElement).getAttribute("data-footnote-definition") ?? "");
					return text ? Fragment.from(schema.text(text)) : Fragment.empty;
				},
			},
			{ tag: "pre[data-footnote-definition]", preserveWhitespace: "full" },
		];
	},

	renderHTML() {
		return ["pre", { "data-footnote-definition": "" }, 0];
	},

	renderMarkdown(node) {
		return (node.content ?? []).map((child) => child.text ?? "").join("");
	},
});

/**
 * Any other HTML block, like `<div>…</div>`, `<p align="center">…</p>`, or `<center>…</center>`. It shows
 * its text, with its unknown tags as hidden tag nodes, and it is aligned like a leading `<p align>`,
 * `<div align>`, or `<center>` says.
 *
 * `htmlSource` keeps the block's original text, and `htmlSourceContent` keeps the content that the parse
 * made from it (`html_source_set_content`). While the content is the same, save writes the original
 * text exactly. After an edit, save writes the content as new HTML (`html_render_inline`).
 */
const files_html_block_node = Node.create({
	name: "htmlBlock",
	group: "block",
	content: "inline*",

	addAttributes() {
		return {
			align: {
				default: null,
				parseHTML: (element) => {
					const value = element.getAttribute("data-align");
					return value === "left" || value === "center" || value === "right" ? value : null;
				},
				renderHTML: (attributes) => (attributes.align ? { "data-align": attributes.align } : {}),
			},
			htmlSource: {
				default: null,
				rendered: false,
				parseHTML: (element) => {
					const value = element.getAttribute("data-html-source");
					return value === null ? null : html_attribute_decode(value);
				},
			},
			htmlSourceContent: { default: null, rendered: false, parseHTML: () => null },
		};
	},

	parseHTML() {
		return [{ tag: "div[data-html-block]", preserveWhitespace: "full" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", { "data-html-block": "", ...HTMLAttributes }, 0];
	},

	renderMarkdown(node) {
		const content = node.content ?? [];
		if (typeof node.attrs?.htmlSource === "string" && node.attrs.htmlSourceContent === JSON.stringify(content)) {
			return node.attrs.htmlSource;
		}

		// Without its first tag, the block can read back as a Markdown paragraph. Then also escape the Markdown
		// characters, so the text reads back the same.
		return html_render_inline(
			content,
			content[0]?.type === "htmlTag" ? HTML_TEXT_ESCAPE_REGEX : HTML_AND_MARKDOWN_TEXT_ESCAPE_REGEX,
		);
	},
});

/**
 * Store the parsed content of each HTML block, HTML table and details block next to its source, so save can tell
 * if a person changed it.
 */
function html_source_set_content(mut_node: TiptapJSONContent) {
	for (const child of mut_node.content ?? []) {
		// Set the blocks inside first. The stored content then already holds their attributes, so it stays equal
		// to the content while nobody changes it. An edited details block still writes its unchanged inner blocks
		// exactly.
		html_source_set_content(child);
		if (
			(child.type === "htmlBlock" || child.type === "table" || child.type === "details") &&
			typeof child.attrs?.htmlSource === "string"
		) {
			child.attrs.htmlSourceContent = JSON.stringify(child.content ?? []);
		}
	}
}

/**
 * The opening and closing HTML tags of one mark.
 */
function html_mark_tags(mark: NonNullable<TiptapJSONContent["marks"]>[number]): [string, string] {
	const attrs = mark.attrs ?? {};
	switch (mark.type) {
		case "bold":
			return ["<strong>", "</strong>"];
		case "italic":
			return ["<em>", "</em>"];
		case "strike":
			return ["<s>", "</s>"];
		case "code":
			return ["<code>", "</code>"];
		case "underline":
			return ["<u>", "</u>"];
		case "subscript":
			return ["<sub>", "</sub>"];
		case "superscript":
			return ["<sup>", "</sup>"];
		case "kbd":
			return ["<kbd>", "</kbd>"];
		// `html_render_inline` writes the entity itself. HTML has no backslash escapes, so an escaped
		// character is plain text there.
		case "htmlEntity":
		case "markdownEscape":
			return ["", ""];
		case "link": {
			const href = typeof attrs.href === "string" ? attrs.href : "";
			const title =
				typeof attrs.title === "string" && attrs.title ? ` title="${html_escape_attribute(attrs.title)}"` : "";
			return [`<a href="${html_escape_attribute(href)}"${title}>`, "</a>"];
		}
		case "highlight":
			return typeof attrs.color === "string" && attrs.color
				? [`<mark style="background-color: ${html_escape_attribute(attrs.color)}">`, "</mark>"]
				: ["<mark>", "</mark>"];
		case "textStyle":
			return typeof attrs.color === "string" && attrs.color
				? [`<span style="color: ${html_escape_attribute(attrs.color)}">`, "</span>"]
				: ["", ""];
		case files_COMMENT_MARK_TYPE:
			return typeof attrs.threadId === "string" && attrs.threadId
				? [`<span data-type="comment" data-lb-thread-id="${html_escape_attribute(attrs.threadId)}">`, "</span>"]
				: ["", ""];
		default:
			return ["", ""];
	}
}

/**
 * Escape the characters of `text` that `escapeRegex` finds as HTML character references.
 */
function html_escape_text(text: string, escapeRegex: RegExp) {
	return text.replace(escapeRegex, (char) =>
		char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : `&#${char.charCodeAt(0)};`,
	);
}

/**
 * Write inline content as HTML, for an edited HTML block or a cell of an HTML table. CommonMark reads no
 * Markdown inside an HTML block, so Markdown would show there as plain text. `escapeRegex` finds the
 * characters of text to escape. `files.test.ts` checks that every inline node and mark type of the shared
 * schema has a branch here.
 */
function html_render_inline(content: TiptapJSONContent[], escapeRegex: RegExp) {
	let html = "";
	let openMarks: NonNullable<TiptapJSONContent["marks"]> = [];
	// Keep the marks that the next node shares with the open ones, and close and open the rest. The schema
	// keeps marks in a fixed order, so the tags nest correctly.
	const writeMarks = (marks: NonNullable<TiptapJSONContent["marks"]>) => {
		let kept = 0;
		while (
			kept < openMarks.length &&
			kept < marks.length &&
			openMarks[kept].type === marks[kept].type &&
			JSON.stringify(openMarks[kept].attrs) === JSON.stringify(marks[kept].attrs)
		) {
			kept += 1;
		}
		for (let index = openMarks.length - 1; index >= kept; index--) {
			html += html_mark_tags(openMarks[index])[1];
		}
		for (let index = kept; index < marks.length; index++) {
			html += html_mark_tags(marks[index])[0];
		}
		openMarks = marks;
	};

	for (const node of content) {
		writeMarks(node.marks ?? []);
		switch (node.type) {
			case "text": {
				const entity = node.marks?.find((mark) => mark.type === "htmlEntity");
				const entityText = entity ? html_entity_render_text(node.text ?? "", entity.attrs ?? {}) : null;
				html += entityText ?? html_escape_text(node.text ?? "", escapeRegex);
				break;
			}
			case "hardBreak":
				html += "<br>";
				break;
			case "image":
				html += image_html_tag(node);
				break;
			case "htmlTag":
				html += typeof node.attrs?.html === "string" ? node.attrs.html : "";
				break;
		}
	}
	writeMarks([]);

	return html;
}
// #endregion html blocks

export function files_tiptap_markdown_to_json(args: {
	markdown: string;
	extensions?: Extensions;
	replaceNewLineToBr?: boolean;
}) {
	if (!args.markdown) {
		return Result({ _yay: files_tiptap_empty_doc_json() });
	}

	// Go through HTML so extension `parseHTML` handlers can normalize embedded HTML
	// consistently with the rest of the editor pipeline.
	const markdownToHtml = tiptap_markdown_to_html({
		markdown: args.markdown,
		extensions: args.extensions,
		replaceNewLineToBr: args.replaceNewLineToBr,
	});

	if (markdownToHtml._nay) {
		return markdownToHtml;
	}

	const json = files_tiptap_html_to_json({
		html: markdownToHtml._yay,
		extensions: args.extensions,
	});
	html_source_set_content(json);

	return Result({ _yay: json });
}

/**
 * Read a file document's text, per the shape stored on the node. The rich branch returns the
 * document's Markdown. The plain branch returns the `Y.Text` root's string, exactly as stored:
 * no forced trailing newline (that is rich-text-only behavior).
 */
export function files_yjs_doc_get_text(args: { yjsDoc: YDoc; rootKind: files_YjsRootKind }) {
	// Run the shape guard as the first statement, so every call site checks the shape before any
	// offset is computed instead of relying on one hand-placed check a refactor can move.
	const addressable = files_yjs_doc_check_text_addressable({ yjsDoc: args.yjsDoc, rootKind: args.rootKind });
	if (addressable._nay) {
		return addressable;
	}

	if (args.rootKind === "plain_text") {
		return Result({ _yay: files_yjs_doc_get_plain_text({ yjsDoc: args.yjsDoc }) });
	}

	const yjsDoc = args.yjsDoc;
	const fragment = yjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText);
	// A new Yjs document has no blocks yet. The schema requires at least one block.
	if (fragment.length === 0) return Result({ _yay: "" });

	const editor = files_headless_tiptap_editor_create();

	if (editor._nay) {
		return editor;
	}

	try {
		const node = yXmlFragmentToProseMirrorRootNode(fragment, editor._yay.schema);
		headless_editor_replace_doc(editor._yay, node);
		const markdown = files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		// Non-empty file content ends with one `\n` (POSIX shape). The parse side treats a
		// single final `\n` as a line terminator (tiptap_markdown_to_html), so
		// newline-terminated text round-trips byte-exact through the editor doc.
		return Result({ _yay: markdown === "" || markdown.endsWith("\n") ? markdown : markdown + "\n" });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while extracting markdown from Y.Doc",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

/**
 * Write `text` into a file document, per the shape stored on the node. The rich branch parses
 * Markdown through a headless Tiptap editor. The plain branch applies the bounded
 * character-refining diff and refuses visibly when the diff's budget runs out.
 */
export function files_yjs_doc_update_from_text(args: { text: string; mut_yjsDoc: YDoc; rootKind: files_YjsRootKind }) {
	// Run the shape guard as the first statement, same placement rule as the getter.
	const addressable = files_yjs_doc_check_text_addressable({ yjsDoc: args.mut_yjsDoc, rootKind: args.rootKind });
	if (addressable._nay) {
		return addressable;
	}

	if (args.rootKind === "plain_text") {
		return files_yjs_doc_update_plain_text_from_text({ text: args.text, mut_yjsDoc: args.mut_yjsDoc });
	}

	const editor = files_headless_tiptap_editor_create({
		initialContent: { markdown: args.text },
	});

	if (editor._nay) {
		return editor;
	}

	try {
		files_yjs_doc_update_from_tiptap_editor({
			mut_yjsDoc: args.mut_yjsDoc,
			tiptapEditor: editor._yay,
			opKind: "user-edit",
		});

		return Result({ _yay: args.mut_yjsDoc });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while updating Y.Doc from tiptap editor",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

/**
 * Build a fresh file document from text, per shape. The shape guard cannot fail here because
 * this function builds the document itself, so the create direction is protected by `rootKind`
 * alone: a wrong value builds a wrongly shaped document nothing downstream can catch.
 */
export function files_yjs_doc_create_from_text(args: { text: string; rootKind: files_YjsRootKind }) {
	if (args.rootKind === "plain_text") {
		return files_yjs_doc_create_plain_text_from_text({ text: args.text });
	}

	const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: args.text } });
	if (editor._nay) {
		return editor;
	}

	try {
		return files_yjs_doc_create_from_tiptap_editor({ tiptapEditor: editor._yay });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while creating Y.Doc from tiptap editor",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

// #region links
const LINK_URI_SCHEME_REGEX = /^([a-z][a-z0-9+.-]*):/i;
// These schemes run code or hold a whole page, so a click on them must never work.
const LINK_BLOCKED_SCHEMES = new Set(["javascript", "vbscript", "data"]);

/**
 * Decide which link addresses the editor keeps.
 *
 * Tiptap keeps only a short list of schemes (`http`, `mailto`, ...) and turns every other link into plain
 * text. A link to an app file (`bonobo-file://`) or to another app (`obsidian://`) then lost its address
 * on the next save. So keep every scheme except the blocked ones.
 *
 * The scheme must start the address and hold only scheme characters. A browser ignores a tab, a newline,
 * or a control character at the start, so `java<tab>script:` runs as `javascript:`. Any of those
 * characters makes this check fail, so a hidden blocked scheme never passes.
 */
export function files_tiptap_link_is_allowed_uri(url: string, ctx: { defaultValidate: (url: string) => boolean }) {
	if (ctx.defaultValidate(url)) {
		return true;
	}

	const scheme = LINK_URI_SCHEME_REGEX.exec(url)?.[1];
	return scheme !== undefined && !LINK_BLOCKED_SCHEMES.has(scheme.toLowerCase());
}
// #endregion links

// #region tiptap editor
/**
 * Server-safe Tiptap extensions (no DOM, no React).
 *
 * Shared with client and server code.
 */
export const files_get_tiptap_shared_extensions = ((/* iife */) => {
	function value() {
		return {
			starterKit: StarterKit.configure({
				// The Liveblocks extension comes with its own history handling
				undoRedo: false,
				underline: false,
				dropcursor: false, // DOM-only, disabled for server
				gapcursor: false,
				listKeymap: false,

				horizontalRule: false,
				link: { isAllowedUri: files_tiptap_link_is_allowed_uri },
				code: false,
			}),
			// Markdown puts links, bold, and other marks around a code span, like `` [`a`](url) ``. Tiptap's code
			// excludes every other mark, so the link was dropped on load and lost on save.
			//
			// Keep excluding the entity and escape marks. They say how text inside the span was written, and the
			// code mark writes that text itself.
			//
			// Keep excluding `code` too. Yjs stores a mark that can overlap itself as `code--<hash>`, not `code`, so
			// every saved code span would change its stored name.
			code: Code.extend({ excludes: "code htmlEntity markdownEscape" }),
			taskList: TaskList.configure({
				HTMLAttributes: {
					class: "not-prose pl-2",
				},
			}),
			taskItem: TaskItem.configure({
				HTMLAttributes: {
					class: "flex gap-2 items-start my-4",
				},
				nested: true,
			}),
			textAlign: TextAlign,
			typography: Typography,
			markdown: Markdown.extend<Omit<MarkdownExtensionOptions, "marked"> & { marked?: Marked }>({
				onBeforeCreate(event) {
					// Tiptap adds tokenizers during editor creation. Sharing Marked grows those lists
					// for every search chunk and editor, even after the editor is destroyed.
					const instance = new Marked();
					configure_marked(instance);
					this.options.marked = instance;
					this.parent?.(event);
				},
			}),
			highlight: Highlight.extend({
				addAttributes() {
					return {
						...this.parent?.(),
						markdownSyntax: markdownSyntaxAttribute(),
					};
				},

				renderMarkdown: (node: TiptapJSONContent, helpers: MarkdownRendererHelpers, ctx: RenderContext) => {
					const color = node.attrs?.color;

					// Write `==` unless the file wrote a bare `<mark>` tag.
					if (!color) {
						const { open, close } = getMarkDelimiters(node.attrs?.markdownSyntax, "==", ctx.meta);
						return `${open}${helpers.renderChildren(node.content || [])}${close}`;
					}

					const content = helpers.renderChildren(node.content || []);
					return `<mark style="background-color: ${color}">${content}</mark>`;
				},
			}).configure({
				multicolor: true,
			}),
			textStyle: TextStyle.extend({
				renderMarkdown: (node: TiptapJSONContent, helpers: MarkdownRendererHelpers, ctx: RenderContext) => {
					const color = node.attrs?.color;

					if (!color) {
						return helpers.renderChildren(node.content || []);
					}

					const content = helpers.renderChildren(node.content || []);
					return `<span style="color: ${color}">${content}</span>`;
				},
			}),
			color: Color.configure({
				types: ["textStyle"],
			}),
			underline: Underline.extend({
				renderMarkdown: (node, helpers, ctx) => {
					// Return HTML <u> tag to preserve underline formatting
					const content = helpers.renderChildren(node.content || []);
					return `<u>${content}</u>`;
				},
			}),
			// Markdown has no syntax for these, so save writes the HTML tag back, like underline.
			subscript: Subscript.extend({
				renderMarkdown: (node, helpers) => `<sub>${helpers.renderChildren(node.content || [])}</sub>`,
			}),
			superscript: Superscript.extend({
				renderMarkdown: (node, helpers) => `<sup>${helpers.renderChildren(node.content || [])}</sup>`,
			}),
			kbd: files_kbd_mark,
			htmlEntity: files_html_entity_mark,
			markdownEscape: files_markdown_escape_mark,
			htmlTag: files_html_tag_node,
			htmlComment: files_html_comment_node,
			htmlBlock: files_html_block_node,
			footnoteDefinition: files_footnote_definition_node,
			horizontalRule: HorizontalRule.configure({
				HTMLAttributes: {
					class: "mt-4 mb-6 border-t border-muted-foreground",
				},
			}),
			frontmatter: files_frontmatter_node,
			image: files_image_node,
			video: files_video_node,
			// Column widths cannot be written to markdown, so resizing stays off. That also keeps the
			// extension from installing its DOM node view, which the headless Convex editors could not run.
			table: files_table_node.configure({ resizable: false }),
			tableRow: files_table_row_node,
			tableHeader: files_table_header_node,
			tableCell: files_table_cell_node,
			details: files_details_node,
			detailsSummary: files_details_summary_node,
			detailsContent: DetailsContent,
			liveblocksComments: files_CommentsExtension,
		};
	}

	let cache: ReturnType<typeof value>;

	return function files_get_tiptap_shared_extensions() {
		return (cache ??= value());
	};
})();

const get_tiptap_shared_extensions_list = ((/* iife */) => {
	function value() {
		return Object.values(files_get_tiptap_shared_extensions());
	}

	let cache: ReturnType<typeof value>;

	return function files_get_tiptap_shared_extensions() {
		return (cache ??= value());
	};
})();

/**
 * Create a headless Tiptap editor instance.
 *
 * Can be used server-side (no DOM) or client-side (with optional additional extensions).
 *
 * @param args.additionalExtensions - Optional array of additional extensions to include
 *   (e.g., Collaboration extension for client-side Yjs sync)
 * @returns Editor instance
 */
/**
 * Replace a headless editor's whole document by swapping the editor state.
 *
 * `commands.setContent` fits the new blocks into the old document with a ProseMirror
 * replace step, and that fitting appends an empty trailing paragraph when the content ends
 * in an atom block (for example a trailing video embed). The serialization paths here must
 * reproduce the document exactly, so they must not go through that replace step.
 */
function headless_editor_replace_doc(editor: Editor, doc: ProseMirrorNode) {
	editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins }));
}

export function files_headless_tiptap_editor_create(args?: {
	initialContent?: { markdown?: string; json?: TiptapJSONContent };
	additionalExtensions?: Extension[];
}) {
	const baseExtensions = get_tiptap_shared_extensions_list();
	const extensions = args?.additionalExtensions ? [...baseExtensions, ...args.additionalExtensions] : baseExtensions;

	const editor = new Editor({
		element: null, // REQUIRED for headless (no DOM mounting)
		content: { type: "doc", content: [] },
		extensions,
		enableCoreExtensions: false,
		enableInputRules: false,
		enablePasteRules: false,
		coreExtensionOptions: {
			delete: { async: false },
		},
	});

	// In Tiptap's core, extension ProseMirror plugins are normally installed during `createView()`.
	// Headless editors never create a DOM view, so we must explicitly install plugins by
	// reconfiguring the state and updating via the headless `view` proxy.
	editor.view.updateState(
		editor.state.reconfigure({
			plugins: editor.extensionManager.plugins,
		}),
	);

	if (args?.initialContent?.markdown) {
		const result = files_headless_tiptap_editor_set_content_from_markdown({
			markdown: args.initialContent.markdown,
			mut_editor: editor,
		});

		if (result._nay) {
			return result;
		}
	} else if (args?.initialContent?.json) {
		headless_editor_replace_doc(editor, editor.schema.nodeFromJSON(args.initialContent.json));
	}

	return Result({ _yay: editor });
}

/**
 * Set the content of a headless editor from a Markdown string.
 *
 * This is the primary function for parsing snapshot Markdown in Convex.
 *
 * @param markdown - Markdown string
 * @returns A Result containing the Tiptap JSON document or an error
 *
 * @example
 *
 * ```ts
 * const json = files_tiptap_markdown_to_json("# Title\n\nParagraph");
 * // { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, ... }] }
 * ```
 */
export function files_headless_tiptap_editor_set_content_from_markdown(args: { markdown: string; mut_editor: Editor }) {
	const editor = args.mut_editor;
	const json = files_tiptap_markdown_to_json({
		markdown: args.markdown,
		extensions: editor.options.extensions,
	});

	if (json._nay) {
		return json;
	}

	headless_editor_replace_doc(editor, editor.schema.nodeFromJSON(json._yay));
	return Result({ _yay: json._yay });
}

/**
 * Extract plain text from a headless Tiptap editor instance.
 *
 * Uses Tiptap's built-in text serialization and trims leading/trailing whitespace.
 *
 * @param args.mut_editor - Headless editor instance
 * @param args.blockSeparator - Optional separator inserted between block nodes. Defaults to "\n\n".
 * @returns Plain text content
 */
export function files_headless_tiptap_editor_get_plain_text(args: { mut_editor: Editor; blockSeparator?: string }) {
	const editor = args.mut_editor;
	const plainText = editor.getText({
		blockSeparator: args.blockSeparator ?? "\n\n",
	});
	return plainText.trim();
}

/**
 * Convert Markdown to plain text using a headless Tiptap editor.
 *
 * Creates a temporary headless editor, loads Markdown content, extracts plain text,
 * then destroys the editor before returning.
 *
 * @param args.markdown - Markdown string
 * @param args.blockSeparator - Optional separator inserted between block nodes. Defaults to "\n\n".
 * @returns A Result containing plain text or an error
 */
export function files_tiptap_markdown_to_plain_text(args: { markdown: string; blockSeparator?: string }) {
	const editor = files_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdown },
	});
	if (editor._nay) {
		return editor;
	}

	try {
		return Result({
			_yay: files_headless_tiptap_editor_get_plain_text({
				mut_editor: editor._yay,
				blockSeparator: args.blockSeparator,
			}),
		});
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while extracting plain text from editor",
				cause: error,
			},
		});
	} finally {
		editor._yay.destroy();
	}
}

/**
 * Convert many Markdown texts to plain text. Each result is the same as `files_tiptap_markdown_to_plain_text`
 * on that text.
 *
 * Search splits a file into many chunks. A headless editor per chunk cost about 10 ms, so this builds the
 * schema and parser once and parses each chunk straight into a document. It follows the same steps as
 * `files_tiptap_markdown_to_json`, the server `generateJSON` and `Editor.getText`.
 */
export function files_tiptap_markdown_list_to_plain_text(args: { markdownList: string[] }) {
	const schema = getSchema(get_tiptap_shared_extensions_list());
	const parser = ProseMirrorDOMParser.fromSchema(schema);
	const textSerializers = getTextSerializersFromSchema(schema);
	const plainTexts: string[] = [];
	for (const markdown of args.markdownList) {
		const html = tiptap_markdown_to_html({ markdown });
		if (html._nay) {
			return html;
		}

		const normalizedHtml = html._yay.replace(STRUCTURAL_HTML_WHITESPACE_REGEX, "><").trimEnd();
		const body = new LinkedomDOMParser().parseFromString(
			`<!DOCTYPE html><html><body>${normalizedHtml}</body></html>`,
			"text/html",
		).body as unknown as HTMLElement;
		const doc = parser.parse(body, { preserveWhitespace: "full" });
		plainTexts.push(getText(doc, { blockSeparator: "\n\n", textSerializers }).trim());
	}

	return Result({ _yay: plainTexts });
}

/**
 * Set the content of a headless editor from a Tiptap JSON document.
 *
 * Inverse of markdown_to_json, useful for serializing editor state.
 *
 * @param json - Tiptap JSON document
 * @returns A Result containing the Markdown string or an error
 */
export function files_headless_tiptap_editor_get_markdown(args: { mut_editor: Editor }) {
	const editor = args.mut_editor;
	if (!editor.markdown) throw should_never_happen("editor.markdown is not set");
	const markdown = editor.markdown.serialize(editor.getJSON());
	return markdown;
}
// #endregion tiptap editor
