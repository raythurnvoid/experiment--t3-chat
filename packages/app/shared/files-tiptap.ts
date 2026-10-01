// Tiptap/Markdown helpers for files: the marked pipeline, shared extensions, and headless editors.
//
// Split out of `shared/files.ts` for module-eval weight: the Tiptap suite (and `marked`) must not
// load for consumers that only need the lean helpers in `shared/files.ts` or the Yjs helpers in
// `shared/files-yjs.ts`.

import { StarterKit } from "@tiptap/starter-kit";
import { Markdown, MarkdownManager, type MarkdownExtensionOptions } from "@tiptap/markdown";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { Highlight } from "@tiptap/extension-highlight";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { marked, Marked, Lexer, Renderer, Tokenizer, type Links, type MarkedExtension, type Rules } from "marked";
import type { Doc as YDoc } from "yjs";
import { Editor, Extension, Node, type Extensions } from "@tiptap/core";
import type { JSONContent as TiptapJSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { is_browser, should_never_happen } from "./shared-utils.ts";
import { files_CommentsExtension } from "./files-tiptap-comments.ts";
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
const TRAILING_HARD_BREAKS_REGEX = /(?<!\\\n)(?:\\\n)+$/;
const HARD_BREAK_REGEX = /\\\n/g;
const VIDEO_BLOCK_START_REGEX = /^<video[\s>]/m;
const VIDEO_BLOCK_REGEX = /^(<video\b[^>]*>(?:\s*<\/video>)?)[ \t]*(?:\n|$)/;
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
// The line patterns Tiptap's Markdown tokenizers use for ordered list items and task items.
const ORDERED_LIST_ITEM_LINE_REGEX = /^(\s*)(\d+)\.\s+(.*)$/;
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
				name: "frontmatter",
				level: "block",
				start(src) {
					return src.startsWith("---\n") ? 0 : -1;
				},
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
				name: "taskList",
				renderer(token) {
					const taskListToken = token as {
						items?: Array<{
							checked?: boolean;
							text?: string;
							tokens?: unknown[];
							nestedTokens?: unknown[];
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
							return `<li data-type="taskItem" data-checked="${
								itemToken.checked ? "true" : "false"
							}"><p>${itemTextHtml}</p>${nestedHtml}</li>`;
						})
						.join("");
					return `<ul data-type="taskList">${itemsHtml}</ul>`;
				},
			},
			// Tiptap's inline tokens also need HTML renderers for standalone parsing and search.
			{
				name: "underline",
				renderer(token) {
					return `<u>${this.parser.parseInline(token.tokens as Parameters<typeof this.parser.parseInline>[0])}</u>`;
				},
			},
			{
				name: "highlight",
				renderer(token) {
					return `<mark>${this.parser.parseInline(token.tokens as Parameters<typeof this.parser.parseInline>[0])}</mark>`;
				},
			},
		],
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

				if (!trailingSpaces) {
					return false;
				}

				const depth = headingToken.depth ?? 1;
				const bodyHtml =
					headingToken.tokens && headingToken.tokens.length > 0
						? this.parser.parseInline(headingToken.tokens as Parameters<typeof this.parser.parseInline>[0])
						: (headingToken.text ?? "");

				return `<h${depth}>${bodyHtml}${trailingSpaces}</h${depth}>`;
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

			// Marked stops escaping text after an unclosed `<code>`, `<kbd>`, `<pre>`, or `<script>` tag. Then
			// typed text like `a<b` becomes a tag. It takes in the next link, and the file name shows without its
			// address on a shared page. So always escape text. `WorkCountingTokenizer.escape` already charges for
			// this escaping.
			text(token) {
				return "escaped" in token && token.escaped
					? Renderer.prototype.text.call(this, { ...token, escaped: false })
					: false;
			},

			// Author-typed HTML can still take in a link's tag, for example a line `<div x="`. Then the address
			// is lost in an attribute, and the label shows as plain text. So a public parse writes the hidden
			// text instead of a hidden link's label and title. The file name never gets into its HTML.
			link(token) {
				const hiddenText = markdown_hidden_link_text?.(token.href) ?? null;
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
 * The characters where Marked's inline text step always stops, and `=` and `+`. Taken from Marked's
 * text pattern. The step also stops before `http`, `www.`, an email address, or two spaces at a line
 * end, but those stops read only a few characters or the email characters after them.
 */
const MARKER_START_SEARCH_REGEX = ((/* iife */) => {
	const stopChars = "\\\\<!\\[`*~_";
	const source = Lexer.rules.inline.gfm.text.source;
	if (!source.startsWith("^([`~]+|[^`~])") || !source.includes(`[\\s\\S]*?(?:(?=[${stopChars}]|`)) {
		throw should_never_happen("Marked's inline text pattern changed");
	}

	return new RegExp(`[=+${stopChars}]`, "g");
})();

/**
 * The last answer of `find_marker_starts`. Marked asks the highlight and the underline `start` with the
 * same text, so one search answers both.
 */
let marker_starts: { src: string; highlight: number; underline: number } | null = null;

/**
 * Find where Tiptap's highlight (`==`) and underline (`++`) text can start, for Marked's inline `start`.
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
	let underline = -1;
	let stop = -1;
	let scanned = src.length;
	let candidates = 0;
	MARKER_START_SEARCH_REGEX.lastIndex = index;
	for (let match = MARKER_START_SEARCH_REGEX.exec(src); match; match = MARKER_START_SEARCH_REGEX.exec(src)) {
		const char = match[0];
		if (char !== "=" && char !== "+") {
			stop = match.index;
			scanned = stop;
			break;
		}

		candidates += 1;
		if (src[match.index + 1] === char) {
			if (char === "=" && highlight === -1) {
				highlight = match.index;
			} else if (char === "+" && underline === -1) {
				underline = match.index;
			}
		}
		if (highlight !== -1 && underline !== -1) {
			scanned = match.index;
			break;
		}
	}
	// Each `=` or `+` costs one more search call.
	markdown_work_add(
		scanned * MARKDOWN_WORK_MARKER_SEARCH_PER_CHAR + candidates * MARKDOWN_WORK_MARKER_SEARCH_PER_CANDIDATE,
	);

	// A marker after the stop character counts only inside the email characters that follow it.
	if (stop !== -1 && (highlight === -1 || underline === -1)) {
		EMAIL_CHAR_RUN_REGEX.lastIndex = stop;
		const emailRun = EMAIL_CHAR_RUN_REGEX.exec(src)?.[0] ?? "";
		markdown_work_add(emailRun.length * MARKDOWN_WORK_INLINE_EMAIL_SCAN_PER_CHAR);
		if (highlight === -1) {
			const runIndex = emailRun.indexOf("==");
			highlight = runIndex === -1 ? -1 : stop + runIndex;
		}
		if (underline === -1) {
			const runIndex = emailRun.indexOf("++");
			underline = runIndex === -1 ? -1 : stop + runIndex;
		}
	}

	marker_starts = { src, highlight, underline };
	return marker_starts;
}

/**
 * Wrap Tiptap's tokenizers while Tiptap registers them on Marked. List tokenizers get `cut_list_block`,
 * and the highlight and underline `start` searches use `find_marker_starts`.
 */
function bound_tiptap_tokenizers(extension: MarkedExtension): MarkedExtension {
	return {
		...extension,
		extensions: extension.extensions?.map((tokenizerExtension) => {
			const marker =
				tokenizerExtension.name === "highlight"
					? "highlight"
					: tokenizerExtension.name === "underline"
						? "underline"
						: null;
			if (marker && "start" in tokenizerExtension && tokenizerExtension.start) {
				// `find_marker_starts` gives the same parse only while Tiptap's `start` returns the first
				// `==` or `++`.
				const probe = "a *b ==c ++d";
				if (
					tokenizerExtension.start.call({ lexer: new Lexer() }, probe) !==
					probe.indexOf(marker === "highlight" ? "==" : "++")
				) {
					throw should_never_happen("Tiptap's highlight or underline start changed");
				}

				const markerTokenizer = tokenizerExtension.tokenizer;
				return {
					...tokenizerExtension,
					start: (src) => find_marker_starts(src)[marker],
					tokenizer(src, tokens) {
						const token = markerTokenizer.call(this, src, tokens);
						// Tiptap's `++` and `==` can pair across a link, as in `C++ <p> [Bob C++ x](...)`. A typed
						// block tag inside the pair then splits the line, and the public page would show the start of
						// the hidden name. So a public parse keeps a pair that holds a `<` as plain text.
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
	const normalizedHtml = args.html.replace(STRUCTURAL_HTML_WHITESPACE_REGEX, "><").trimEnd();

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

	renderMarkdown(node) {
		const text = (node.content ?? []).map((child) => child.text ?? "").join("");
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
					const parsed = Number.parseInt(element.getAttribute("width") ?? "", 10);
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
			// Set while an upload runs, so the client can find its own placeholder node again
			// after the upload mutations resolve. `rendered: false` keeps it out of the HTML,
			// and `renderMarkdown` below ignores it, so it never reaches the saved markdown.
			uploadId: { default: null, rendered: false },
		};
	},

	parseHTML() {
		return [{ tag: "img[src]" }];
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

		// A sized or aligned image rides through markdown as a raw `<img>` tag, the same way
		// the video node below always does. Keep the attribute order fixed so the round-trip
		// stays byte-stable.
		if (width !== null || align !== null) {
			const altAttribute = alt ? ` alt="${html_escape_attribute(alt)}"` : "";
			const titleAttribute = title ? ` title="${html_escape_attribute(title)}"` : "";
			const widthAttribute = width !== null ? ` width="${width}"` : "";
			const alignAttribute = align !== null ? ` align="${align}"` : "";
			return `<img src="${html_escape_attribute(src)}"${altAttribute}${titleAttribute}${widthAttribute}${alignAttribute}>`;
		}

		const image = `![${markdown_escape_image_alt(alt)}](${markdown_link_destination(src)}`;
		return title ? `${image} "${title.replace(/([\\"])/g, "\\$1")}")` : `${image})`;
	},
});

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
		const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
		const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
		const width =
			typeof node.attrs?.width === "number" && Number.isFinite(node.attrs.width) && node.attrs.width > 0
				? Math.round(node.attrs.width)
				: null;
		const align = node.attrs?.align === "center" || node.attrs?.align === "right" ? node.attrs.align : null;

		// Keep the attribute order fixed so the round-trip stays byte-stable.
		const titleAttribute = title ? ` title="${html_escape_attribute(title)}"` : "";
		const widthAttribute = width !== null ? ` width="${width}"` : "";
		const alignAttribute = align !== null ? ` align="${align}"` : "";
		return `<video src="${html_escape_attribute(src)}"${titleAttribute}${widthAttribute}${alignAttribute}></video>`;
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

const files_table_cell_node = TableCell.extend({
	// GFM cells hold inline content. Keep multiple paragraphs for pasted HTML, but do not let
	// members create lists, headings, or code blocks that need another save to become stable.
	content: "paragraph+",

	// The explicit `this` annotation is needed because `extend` types its config against a
	// union, which loses the `parent` member from the inferred context.
	addAttributes(this: { parent?: () => Record<string, unknown> }) {
		return { ...this.parent?.(), ...files_table_cell_align_attribute };
	},
});

const files_table_header_node = TableHeader.extend({
	content: "paragraph+",

	addAttributes(this: { parent?: () => Record<string, unknown> }) {
		return { ...this.parent?.(), ...files_table_cell_align_attribute };
	},
});

const BACKSLASH_BEFORE_PIPE_REGEX = /\\\|/;

/**
 * Rewrite a code-marked text node that holds a backslash right before a pipe into an HTML
 * `<code>` element with numeric character references.
 *
 * The backtick spelling cannot store that content in a table cell: marked's row splitter removes
 * one backslash of the escaped pipe while the code span keeps the rest literally, so the escape
 * run would grow on every save. The entity form never shows the row splitter a pipe, so nothing
 * is escaped and nothing grows. Only the copy handed to the serializer changes; the editor
 * document keeps the member's exact text.
 */
function files_table_code_mark_to_html(node: TiptapJSONContent): TiptapJSONContent {
	if (
		node.type === "text" &&
		typeof node.text === "string" &&
		BACKSLASH_BEFORE_PIPE_REGEX.test(node.text) &&
		node.marks?.some((mark) => mark.type === "code")
	) {
		// Escape every character except letters, digits, and spaces. Between the written code tags
		// the text is ordinary inline markdown to marked, so a bare backtick, `**`, `~~`, or a URL
		// would be re-parsed on the next open and the member's code characters would change.
		const escaped = node.text.replace(/[^A-Za-z0-9 ]/gu, (char) => `&#${char.codePointAt(0)};`);

		return {
			...node,
			text: `<code>${escaped}</code>`,
			marks: node.marks.filter((mark) => mark.type !== "code"),
		};
	}

	return node.content ? { ...node, content: node.content.map(files_table_code_mark_to_html) } : node;
}

/**
 * Turn one table cell into the text between two pipes.
 */
function files_render_table_cell_markdown(cell: TiptapJSONContent, helpers: MarkdownRendererHelpers) {
	// Markdown has no way to put a second block inside a table cell, so the blocks are joined
	// with `<br>`. A real newline would end the row and destroy the whole table.
	const rendered = helpers.renderChildren((cell.content ?? []).map(files_table_code_mark_to_html), "<br>");

	// A hard break serializes as spaces plus a newline, never as a backslash. Turn every newline,
	// with the spaces around it, into `<br>` for the same reason.
	const singleLine = rendered.replace(/[ \t]*\n[ \t]*/g, "<br>").trim();

	// A backslash right before an inserted `<br>` would escape the `<` on the next parse and turn
	// the break into literal text. Write those backslashes as numeric references instead.
	const brSafe = singleLine.replace(/\\+(?=<br>)/g, (run) => "&#92;".repeat(run.length));

	// GFM drops the spaces around cell text when it parses, so trim here too, or the next parse
	// would not give the same text back.
	//
	// A `|` must be written as `\|`. The backslashes right in front of it must be doubled too.
	// Without that, cell text `a\|b` would be written as `a\\|b`, and marked would then read one
	// real backslash plus one real pipe, give the row an extra cell, and drop the whole table
	// back to a paragraph.
	return brSafe.replace(/(\\*)\|/g, (_match, backslashes: string) => backslashes + backslashes + "\\|");
}

/**
 * Write a table as a GFM pipe table.
 *
 * The vendored `renderTableToMarkdown` cannot be used: it wraps its output in newlines, pads
 * every column to its widest cell, never escapes `|`, drops the alignment colons, and joins a
 * multi-block cell with a U+001F control character that would end up in the saved file.
 */
function files_render_table_markdown(node: TiptapJSONContent, helpers: MarkdownRendererHelpers) {
	const rows = node.content ?? [];
	const firstRowCells = rows[0]?.content ?? [];

	// Lay every cell out on a grid before writing anything. A `colspan` cell covers several
	// columns in its own row, and a `rowspan` cell keeps covering the same columns in the rows
	// below it. Two things go wrong without this grid. A row wider than the first one loses every
	// cell past the first row's width. And a row that is short because a rowspan covers its left
	// side has its cells written too far left, so the text lands under the wrong heading.
	const grid: Array<Array<TiptapJSONContent | null>> = rows.map(() => []);
	rows.forEach((row, rowIndex) => {
		let column = 0;
		for (const cell of row.content ?? []) {
			// Step over the columns a rowspan from an earlier row already claimed.
			while (grid[rowIndex]![column] !== undefined) {
				column += 1;
			}

			const colspan = Number(cell.attrs?.colspan) || 1;
			const rowspan = Number(cell.attrs?.rowspan) || 1;
			for (let coveredRow = 0; coveredRow < rowspan && rowIndex + coveredRow < rows.length; coveredRow += 1) {
				for (let coveredColumn = 0; coveredColumn < colspan; coveredColumn += 1) {
					// Markdown cannot say "this cell spans N columns or rows". Keep the text in the
					// cell's own top-left column and leave every column it covers empty.
					grid[rowIndex + coveredRow]![column + coveredColumn] = coveredRow === 0 && coveredColumn === 0 ? cell : null;
				}
			}
			column += colspan;
		}
	});

	// marked fixes the column count from the delimiter row, and a row with a different count breaks
	// the table, so every row we write gets exactly this many cells. Take the widest row, not the
	// first one: a caption or an empty leading `<tr>` parses as a narrow first row, and measuring
	// there would throw away the real table below it.
	const columnCount = grid.reduce((widest, gridRow) => Math.max(widest, gridRow.length), 0);
	if (columnCount === 0) {
		return "";
	}

	const renderRow = (rowIndex: number) => {
		const cells: string[] = [];
		for (let column = 0; column < columnCount; column += 1) {
			const cell = grid[rowIndex]![column];
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
	// header was toggled off keeps its columns aligned. Read it off the grid so a colspan cell
	// aligns every column it covers.
	const alignments = (grid[0] ?? []).map((cell) => {
		const align = cell?.attrs?.align;
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

const files_table_node = Table.extend({
	renderMarkdown: files_render_table_markdown,
});
// #endregion tables

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

	return Result({
		_yay: files_tiptap_html_to_json({
			html: markdownToHtml._yay,
			extensions: args.extensions,
		}),
	});
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
			}),
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
				renderMarkdown: (node: TiptapJSONContent, helpers: MarkdownRendererHelpers, ctx: RenderContext) => {
					const color = node.attrs?.color;

					if (!color) {
						// Default to markdown syntax
						return `==${helpers.renderChildren(node.content || [])}==`;
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
			tableRow: TableRow,
			tableHeader: files_table_header_node,
			tableCell: files_table_cell_node,
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
