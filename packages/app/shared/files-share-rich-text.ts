// Safe public content for a file shared with "Anyone with the link can view".
//
// Any workspace writer controls the shared text, so this module treats it as hostile. It never loads
// a resource: Markdown goes through the app's Markdown-to-HTML step, a callback-only `htmlparser2`
// pass checks the size and builds a plain visible-text copy, and only a small enough document becomes
// a data-only `linkedom` DOM. That DOM is reduced to a small ProseMirror schema. The browser receives
// that schema's JSON, never HTML or Markdown.
//
// The same schema renders the page in the browser (`files-share-page.tsx`), so preparation and
// rendering agree on every node, mark, and attribute. Only the server prepares content, but the code
// stays here next to the schema it must match. The browser page imports only the schema parts, and the
// build leaves the preparation code and its parsers out of the page.

import { Parser } from "htmlparser2";
import { DOMParser as LinkedomDOMParser } from "linkedom/worker";
import { getSchema, Node as TiptapNode } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser, Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Document } from "@tiptap/extension-document";
import { Text } from "@tiptap/extension-text";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Heading } from "@tiptap/extension-heading";
import { Blockquote } from "@tiptap/extension-blockquote";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { CodeBlock } from "@tiptap/extension-code-block";
import { HardBreak } from "@tiptap/extension-hard-break";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Strike } from "@tiptap/extension-strike";
import { Code } from "@tiptap/extension-code";
import { Underline } from "@tiptap/extension-underline";
import { Highlight } from "@tiptap/extension-highlight";
import { Link } from "@tiptap/extension-link";
import { TextAlign } from "@tiptap/extension-text-align";
import { Result } from "common/errors-as-values-utils.ts";
import { files_frontmatter_node, files_parse_markdown_to_html } from "./files-tiptap.ts";
import { files_media_parse_src } from "./files-media.ts";
import { files_get_utf8_byte_size, files_MAX_TEXT_CONTENT_BYTES, type files_YjsRootKind } from "./files.ts";

/**
 * Most distinct images and videos one shared document can publish. Later ones become placeholders.
 */
export const files_share_rich_text_MAX_MEDIA = 50;

/**
 * Most bytes of the public text, and of the rich JSON string. The same cap as a saved text file.
 */
const MAX_PUBLIC_TEXT_BYTES = files_MAX_TEXT_CONTENT_BYTES;

/**
 * Largest HTML the Markdown step may produce. Entities in code can make it 6 times larger than the text,
 * so a full-size file can reach about 5.4 MB. The parser reads each entity as its own text piece, which
 * costs about 18 ms per MB in local Node.
 */
const MAX_HTML_BYTES = 8 * 1024 * 1024;

/**
 * Most Markdown parser work, in about nanoseconds of local CPU. Marked is slow on some dense formatting,
 * and the public view must finish inside one query. A file past this is refused.
 *
 * The Convex runtime runs this work about 3 times slower than local Node, so this is about 120 ms
 * there. The repo's skill notes need 75 units per byte in the middle and up to about 130, so notes up
 * to about 300 KB pass. Dense tables, links, and lists need up to about 350 per byte, so they pass up to
 * about 110 KB. Every line costs 2,000 units, even a line of code, so a file of short code lines
 * passes up to about 300 KB.
 */
const MAX_MARKDOWN_WORK = 40_000_000;

/**
 * A rich document may hold at most this many DOM allocations and ProseMirror nodes, nested at most
 * this deep. A bigger one is shown as plain text.
 *
 * On the Convex runtime the rich build costs 40 to 75 µs per node, mostly inside linkedom. So this
 * keeps the build under about 150 ms, which leaves room for the view's database reads. Real Markdown
 * has about 1 node per 28 bytes, so about 55 KB of it stays rich.
 */
const MAX_RICH_NODES = 2_000;
const MAX_RICH_DEPTH = 32;

/**
 * Past these the text is refused, because even the plain-text pass would keep too much parser state.
 */
const MAX_PARSER_DEPTH = 256;
const MAX_TAG_ATTRIBUTES = 128;
const MAX_FOREIGN_CONTEXTS = 256;

/**
 * DOM allocations for the `<html><body>` wrapper the rich path adds around the HTML.
 */
const WRAPPER_UNITS = 8;

/**
 * Largest string one text accumulator grows before it starts a new part.
 */
const TEXT_PART_MAX_LENGTH = 64 * 1024;

const FILE_REFERENCE_LABEL = "[file reference]";
const COMMENT_REFERENCE_LABEL = "[comment reference]";
const IMAGE_LABEL = "[image]";
const VIDEO_LABEL = "[video]";

/**
 * Text that replaces a link that a second save merged with a file link or image. It reads as an open
 * Markdown file address, so the visible-text rule hides its whole line.
 */
const MERGED_LINK_TEXT = "(bonobo-file:// ";

/**
 * Visible syntax that names a private file or a comment thread. Group 1 is a file reference, group 2
 * is a literal comment attribute. Values are bounded so an unclosed quote cannot make each match scan
 * the rest of a large paragraph. The `u` flag counts that bound in whole characters. Without it, a match
 * could end in the middle of an emoji, and Convex refuses a string that holds half a character. A value
 * stops before `bonobo-file:`, so a file reference after it still gets its own match and its own rules.
 *
 * Group 3 is `!%5B`, image syntax inside a URL. The editor writes an image right after a typed URL, and
 * when the app reads that text and saves it again, the URL takes in the image as `!%5B` and the start of
 * its name. The file address can end up far away or be lost, so this match does not need one.
 */
const VISIBLE_REFERENCE_REGEX =
	/(bonobo-file:\/\/[^\s"'<>`()[\]{}|\\^]*)|(data-lb-thread-id\s*=\s*(?:"(?:(?!bonobo-file:)[^"]){0,256}"|'(?:(?!bonobo-file:)[^']){0,256}'|(?:(?!bonobo-file:)[^\s"'=<>`]){1,256}))|(!%5B)/giu;

/**
 * Raw HTML between two tags that is only the writer's layout: newlines, each followed by indentation.
 */
const LAYOUT_WHITESPACE_REGEX = /^(?:\n[ \t]*)+$/;
const LAYOUT_WHITESPACE_CHARS_REGEX = /^[\n \t]*$/;

/**
 * Elements whose whole subtree adds no public text, and which the rich path deletes.
 */
const REMOVED_TAGS = new Set([
	"script",
	"style",
	"head",
	"title",
	"meta",
	"base",
	"link",
	"form",
	"input",
	"select",
	"textarea",
	"button",
	"option",
	"optgroup",
	"datalist",
	"object",
	"embed",
	"iframe",
	"frame",
	"frameset",
	"svg",
	"math",
	"template",
	"noscript",
	"canvas",
	"audio",
	"source",
	"track",
	"applet",
	"param",
	// `htmlparser2` reads everything after an unclosed `<xmp>` as raw text, like after `<textarea>`. That
	// text is the page's HTML source, and the visible-text rules cannot hide names in HTML source.
	"xmp",
]);

/**
 * Tags that keep the parser in a separate foreign context in `htmlparser2` 10.1.0. A self-closing one
 * closes its element but keeps its context entry, so they are counted apart from the depth.
 */
const FOREIGN_CONTEXT_TAGS = new Set([
	"svg",
	"math",
	"mi",
	"mo",
	"mn",
	"ms",
	"mtext",
	"annotation-xml",
	"foreignobject",
	"desc",
	"title",
]);

const PROTECTED_TEXT_TAGS = new Set(["pre", "code"]);

const PARAGRAPH_SEPARATOR_TAGS = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"pre",
	"blockquote",
	"ul",
	"ol",
	"table",
	"hr",
	"div",
	"section",
	"article",
	"header",
	"footer",
	"main",
	"nav",
	"aside",
	"figure",
	"figcaption",
	"details",
	"summary",
	"dl",
	"address",
	"center",
]);
const LINE_SEPARATOR_TAGS = new Set(["li", "tr", "dt", "dd", "thead", "tbody", "tfoot", "caption"]);
const CELL_SEPARATOR_TAGS = new Set(["td", "th"]);

const TEXT_ALIGNMENTS = ["left", "center", "right", "justify"];
const CELL_ALIGNMENTS = ["left", "center", "right"];
const ORDERED_LIST_TYPES = ["1", "a", "A", "i", "I"];
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * The URL parser skips any mix of `/` and `\` after an HTTP(S) scheme. The host part ends at the next
 * `/`, `\`, `?`, or `#`.
 */
const PUBLIC_HTTP_URL_AUTHORITY_REGEX = /^https?:[\\/]*([^\\/?#]*)/i;

/**
 * A URL that `public_http_url` returned: printable ASCII only, an HTTP(S) scheme, and a host part with
 * no `@`, so no user name or password.
 */
const PUBLIC_HREF_REGEX = /^(?=[!-~]+$)https?:\/\/[^@/\\?#]+\//i;

/**
 * Longest public link or media URL. A longer one is dropped and its label stays as plain text.
 */
const MAX_PUBLIC_URL_LENGTH = 8 * 1024;

/**
 * Tell which element a public media node came from. Only this module sets it, after it removes every
 * attribute the author wrote.
 */
const MEDIA_MARKER_ATTRIBUTE = "data-share-media";
const MEDIA_INDEX_ATTRIBUTE = "data-share-index";

export type files_share_rich_text_MediaKind = "image" | "video";

/**
 * The public content of a shared text file.
 */
type PublicContent =
	| { kind: "rich_text"; json: string }
	| { kind: "plain_text"; text: string; formattingFallback: boolean };

/**
 * A document between preparation and publication. The server decides which media are available,
 * then `files_share_rich_text_finish` turns it into public content.
 */
export type files_share_rich_text_Prepared = {
	/**
	 * Each distinct app media reference, in index order. Plain text, code, and links never add one.
	 */
	media: Array<{ kind: files_share_rich_text_MediaKind; src: string }>;
	draft:
		| { kind: "rich_text"; doc: ProseMirrorNode; fallbackText: string }
		| { kind: "plain_text"; text: string; formattingFallback: boolean };
};

// #region schema
function validate_nullable_integer(min: number, max: number) {
	return (value: unknown) => {
		if (value !== null && !(Number.isInteger(value) && (value as number) >= min && (value as number) <= max)) {
			throw new Error("Invalid public attribute");
		}
	};
}

function validate_integer(min: number, max: number) {
	return (value: unknown) => {
		if (!(Number.isInteger(value) && (value as number) >= min && (value as number) <= max)) {
			throw new Error("Invalid public attribute");
		}
	};
}

function validate_nullable_enum(values: readonly string[]) {
	return (value: unknown) => {
		if (value !== null && !(typeof value === "string" && values.includes(value))) {
			throw new Error("Invalid public attribute");
		}
	};
}

function validate_nullable_string(value: unknown) {
	if (value !== null && typeof value !== "string") {
		throw new Error("Invalid public attribute");
	}
}

function validate_boolean(value: unknown) {
	if (typeof value !== "boolean") {
		throw new Error("Invalid public attribute");
	}
}

function validate_null(value: unknown) {
	if (value !== null) {
		throw new Error("Invalid public attribute");
	}
}

/**
 * Read a URL like the browser's URL parser does: it removes every tab and line break, then skips leading
 * spaces and control characters.
 */
function url_parser_input(value: string) {
	const parsed = value.replace(/[\t\n\r]/g, "");
	let start = 0;
	while (start < parsed.length && parsed.charCodeAt(start) <= 0x20) {
		start += 1;
	}
	return parsed.slice(start);
}

/**
 * A link or external media destination a visitor may open: an absolute HTTP(S) URL with no user name
 * or password. Returns the normalized URL, or null.
 */
function public_http_url(value: string | null | undefined) {
	// One link mark repeats on every text node it covers, so a long URL would make the rich JSON huge.
	if (!value || value.length > MAX_PUBLIC_URL_LENGTH) {
		return null;
	}

	// `new URL` turns a non-ASCII host into punycode. That is slow for a long host with many different
	// letters: about 0.4 s for 20,000. A real host name has at most 253 characters, so refuse a longer
	// part before the path, and any URL whose start does not look like HTTP(S), before parsing.
	// Read the URL like the parser does. Otherwise `https:/<tab>/` would hide a long host from the check.
	const authority = PUBLIC_HTTP_URL_AUTHORITY_REGEX.exec(url_parser_input(value))?.[1];
	if (authority === undefined || authority.length > 255) {
		return null;
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
		return null;
	}

	// Encoding can make the URL longer. Like the visible text, a URL must also not carry a private file
	// reference, a comment attribute, or `!%5B` image syntax.
	if (
		url.href.length > MAX_PUBLIC_URL_LENGTH ||
		value.search(VISIBLE_REFERENCE_REGEX) !== -1 ||
		url.href.search(VISIBLE_REFERENCE_REGEX) !== -1
	) {
		return null;
	}

	return url.href;
}

/**
 * The text that replaces a link whose address holds a file reference, a comment attribute, or `!%5B`
 * image syntax. Its label is often the private file name, so the label is not shown. Any other link
 * gets `null`.
 *
 * A normal file link has the file address at its start, and only its label is the name. Any other match
 * means a second save merged a file link or image into a typed URL. Then the name can start earlier on
 * the line, in another link's label, and go on after this link. So that link becomes `MERGED_LINK_TEXT`.
 */
function hidden_link_text(href: string) {
	const input = url_parser_input(href);
	if (input.search(VISIBLE_REFERENCE_REGEX) === -1) {
		return null;
	}

	const lowerInput = input.toLowerCase();
	return lowerInput.startsWith("bonobo-file://") && !lowerInput.includes("!%5b")
		? FILE_REFERENCE_LABEL
		: MERGED_LINK_TEXT;
}

/**
 * Check a link on the page. The server already built it with `public_http_url`, so do not parse it again.
 * A browser URL parser can refuse a host that Node accepted: Chrome accepts `http://xn--9hbc.com/`, but
 * the URL standard refuses it. One such link would then break the whole page. So check only the shape of
 * the server's URL: printable ASCII, an HTTP(S) scheme, and no user name or password before the path.
 */
function is_public_href(value: string) {
	return (
		value.length <= MAX_PUBLIC_URL_LENGTH &&
		PUBLIC_HREF_REGEX.test(value) &&
		value.search(VISIBLE_REFERENCE_REGEX) === -1
	);
}

function validate_public_href(value: unknown) {
	if (typeof value !== "string" || !is_public_href(value)) {
		throw new Error("Invalid public attribute");
	}
}

function media_index_from_element(element: HTMLElement) {
	const index = element.getAttribute(MEDIA_INDEX_ATTRIBUTE);
	if (index === null || !/^\d{1,2}$/.test(index)) {
		return null;
	}

	const value = Number(index);
	return value < files_share_rich_text_MAX_MEDIA ? value : null;
}

const public_media_attributes = {
	index: {
		default: null,
		parseHTML: media_index_from_element,
		validate: validate_nullable_integer(0, files_share_rich_text_MAX_MEDIA - 1),
	},
	alt: {
		default: null,
		parseHTML: (element: HTMLElement) => element.getAttribute("alt"),
		validate: validate_nullable_string,
	},
};

/**
 * Public image. It carries only a server index and alt text, never a source. The share page adds its
 * own node view that asks the server for a signed URL by index.
 */
const public_image_node = TiptapNode.create({
	name: "image",
	inline: true,
	group: "inline",
	atom: true,

	addAttributes() {
		return public_media_attributes;
	},

	parseHTML() {
		return [{ tag: `img[${MEDIA_MARKER_ATTRIBUTE}]` }];
	},

	renderHTML() {
		return ["span", { [MEDIA_MARKER_ATTRIBUTE]: "image" }];
	},
});

const public_video_node = TiptapNode.create({
	name: "video",
	group: "block",
	atom: true,

	addAttributes() {
		return public_media_attributes;
	},

	parseHTML() {
		return [{ tag: `video[${MEDIA_MARKER_ATTRIBUTE}]` }];
	},

	renderHTML() {
		return ["div", { [MEDIA_MARKER_ATTRIBUTE]: "video" }];
	},
});

const public_cell_attributes = {
	colspan: {
		default: 1,
		parseHTML: (element: HTMLElement) => Number(element.getAttribute("colspan") ?? "1"),
		validate: validate_integer(1, 32),
	},
	rowspan: {
		default: 1,
		parseHTML: (element: HTMLElement) => Number(element.getAttribute("rowspan") ?? "1"),
		validate: validate_integer(1, 32),
	},
	// Public CSS owns column widths, so author widths never survive.
	colwidth: {
		default: null,
		parseHTML: () => null,
		rendered: false,
		validate: validate_null,
	},
	align: {
		default: null,
		parseHTML: (element: HTMLElement) => {
			const align = element.getAttribute("align");
			return align !== null && CELL_ALIGNMENTS.includes(align) ? align : null;
		},
		renderHTML: (attributes: Record<string, unknown>) => (attributes.align ? { align: attributes.align } : {}),
		validate: validate_nullable_enum(CELL_ALIGNMENTS),
	},
};

/**
 * The public schema's extensions, keyed so the share page can replace the media nodes with its own
 * node views. Do not add the private editor's extensions: StarterKit's Link would keep author
 * `target`, `rel`, and `class`, and other extensions keep colors, fonts, and comment ids.
 */
export const files_share_rich_text_get_extensions = ((/* iife */) => {
	function value() {
		return {
			document: Document,
			text: Text,
			paragraph: Paragraph,
			heading: Heading.extend({
				addAttributes() {
					return { level: { default: 1, rendered: false, validate: validate_integer(1, 6) } };
				},
			}),
			blockquote: Blockquote,
			bulletList: BulletList,
			orderedList: OrderedList.extend({
				addAttributes() {
					return {
						start: {
							default: 1,
							parseHTML: (element: HTMLElement) => Number(element.getAttribute("start") ?? "1"),
							validate: validate_integer(0, 999_999_999),
						},
						type: {
							default: null,
							parseHTML: (element: HTMLElement) => element.getAttribute("type"),
							validate: validate_nullable_enum(ORDERED_LIST_TYPES),
						},
					};
				},
			}),
			listItem: ListItem,
			// The language comes from an author class, so the public code block has none.
			codeBlock: CodeBlock.extend({
				addAttributes() {
					return {};
				},
			}),
			hardBreak: HardBreak,
			horizontalRule: HorizontalRule,
			taskList: TaskList,
			taskItem: TaskItem.extend({
				addAttributes() {
					return {
						checked: {
							default: false,
							parseHTML: (element: HTMLElement) => element.getAttribute("data-checked") === "true",
							renderHTML: (attributes: Record<string, unknown>) => ({ "data-checked": attributes.checked }),
							validate: validate_boolean,
						},
					};
				},
			}).configure({ nested: true }),
			frontmatter: files_frontmatter_node,
			// No editing plugins and no generated `colgroup`: a read-only page needs neither, and the
			// stock Table keeps its editing plugin even when read-only.
			table: Table.extend({
				addProseMirrorPlugins() {
					return [];
				},
				renderHTML() {
					return ["table", {}, ["tbody", 0]];
				},
			}).configure({ resizable: false }),
			tableRow: TableRow,
			tableHeader: TableHeader.extend({
				content: "paragraph+",
				addAttributes() {
					return public_cell_attributes;
				},
			}),
			tableCell: TableCell.extend({
				content: "paragraph+",
				addAttributes() {
					return public_cell_attributes;
				},
			}),
			image: public_image_node,
			video: public_video_node,
			bold: Bold,
			italic: Italic,
			strike: Strike,
			code: Code,
			underline: Underline,
			highlight: Highlight.configure({ multicolor: false }),
			// Autolink and paste linking would add link marks the server never checked. The renderer
			// owns `rel`, `target`, and the referrer policy; the author sets only a checked `href`.
			link: Link.extend({
				addAttributes() {
					return {
						href: {
							default: null,
							parseHTML: (element: HTMLElement) => element.getAttribute("href"),
							validate: validate_public_href,
						},
					};
				},
				renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
					return [
						"a",
						{
							href: HTMLAttributes.href,
							rel: "noopener noreferrer nofollow",
							target: "_blank",
							referrerpolicy: "no-referrer",
						},
						0,
					];
				},
			}).configure({
				autolink: false,
				linkOnPaste: false,
				openOnClick: false,
				isAllowedUri: is_public_href,
			}),
			textAlign: TextAlign.configure({ types: ["paragraph", "heading"], alignments: TEXT_ALIGNMENTS }).extend({
				addGlobalAttributes() {
					return [
						{
							types: ["paragraph", "heading"],
							attributes: {
								textAlign: {
									default: null,
									parseHTML: (element: HTMLElement) => {
										const alignment = element.style.textAlign;
										return TEXT_ALIGNMENTS.includes(alignment) ? alignment : null;
									},
									renderHTML: (attributes: Record<string, unknown>) =>
										attributes.textAlign ? { style: `text-align: ${attributes.textAlign}` } : {},
									validate: validate_nullable_enum(TEXT_ALIGNMENTS),
								},
							},
						},
					];
				},
			}),
		};
	}

	let cache: ReturnType<typeof value> | undefined;

	return function files_share_rich_text_get_extensions() {
		return (cache ??= value());
	};
})();

const get_schema = ((/* iife */) => {
	function value() {
		return getSchema(Object.values(files_share_rich_text_get_extensions()));
	}

	let cache: ReturnType<typeof value> | undefined;

	return function get_schema() {
		return (cache ??= value());
	};
})();
// #endregion schema

// #region redaction
const HTML_MEDIA_TAG_REGEX = /^<(img|video)\s/i;
const HTML_SRC_END_REGEX = /\ssrc\s*=\s*["']?$/i;

/**
 * Find the parts of visible text to replace, each with its label.
 *
 * A file reference can sit in link or image syntax that stayed text: `![name](bonobo-file://x)`,
 * `[name](bonobo-file://x)`, or `<img src="bonobo-file://x" alt="name">`. This happens in code. It also
 * happens when the editor writes an image right after a typed URL, because Marked then reads the image as
 * part of the URL. The label, `alt`, or title is often the private file name, so replace the whole syntax,
 * not only the address.
 *
 * A file name has no length limit, so do not use a fixed window. Look back to the line start, but not past
 * an earlier file reference. The work stays linear in the text length. An image in the line is part of the
 * text as `[image]`, so the look-back goes past it.
 */
function visible_reference_ranges(text: string) {
	const ranges: Array<{ start: number; end: number; label: string }> = [];
	// Do not look back past an earlier file reference, or one range could swallow the text between two.
	let lastFileRangeEnd = 0;
	// Remember the next line break, so a long line with many references is not searched again for each one.
	let nextLineBreak = -1;

	for (const match of text.matchAll(VISIBLE_REFERENCE_REGEX)) {
		let start = match.index;
		let end = match.index + match[0].length;
		let label =
			match[1] !== undefined ? FILE_REFERENCE_LABEL : match[2] !== undefined ? COMMENT_REFERENCE_LABEL : IMAGE_LABEL;
		if (nextLineBreak < end) {
			const index = text.indexOf("\n", end);
			nextLineBreak = index === -1 ? text.length : index;
		}

		// Image syntax inside a URL. The name comes after it, so hide the rest of the line.
		if (match[3] !== undefined) {
			end = nextLineBreak;
		} else if (match[1] !== undefined) {
			let lookStart = start;
			while (lookStart > lastFileRangeEnd && text[lookStart - 1] !== "\n") {
				lookStart -= 1;
			}
			const before = text.slice(lookStart, start);
			// When the app reads the text into an editor again and saves it, the `](` before the address can
			// become `)(` or `%5D(`. So any `(` right before the address counts.
			const markdownOpen = before.endsWith("(") || before.endsWith("(<");

			// A Markdown link or image: `[label](` before the address and `)` after it. The label is often a
			// file name, and a name can hold `[`, `]`, or `)`. Marked may also have removed the editor's `\`
			// escapes, or read part of the syntax as a link. A merged copy can even put a typed `[` after the
			// name. So do not look for the label. Hide from the line start, or from the end of an earlier file
			// reference on the line. This can hide normal text before the syntax, which is better than showing
			// a name.
			if (markdownOpen) {
				const bracket = before.indexOf("[");
				start = lookStart;
				label = bracket > 0 && before[bracket - 1] === "!" ? IMAGE_LABEL : FILE_REFERENCE_LABEL;

				// The editor writes `)` right after the address, or `>)` after `<address`. Anything else is a
				// title or broken syntax. A title can hold `)` and `"`, and broken syntax can run into a later
				// name. So hide the rest of the line.
				const close = text[end] === ")" ? 1 : text.startsWith(">)", end) ? 2 : 0;
				end = close > 0 ? end + close : nextLineBreak;
			}
			// An HTML image or video tag. Its `alt` or `title` comes after `src`, and Marked may have decoded a
			// `&gt;` in it to `>`. So do not stop at `>`, and hide the rest of the line, even when the tag start
			// is not found.
			else if (HTML_SRC_END_REGEX.test(before.slice(-32))) {
				const tagStart = before.lastIndexOf("<");
				const tag = tagStart === -1 ? null : HTML_MEDIA_TAG_REGEX.exec(before.slice(tagStart));
				if (tag && !before.includes(">", tagStart)) {
					start = lookStart + tagStart;
					label = tag[1].toLowerCase() === "img" ? IMAGE_LABEL : VIDEO_LABEL;
				}
				end = nextLineBreak;
			}
		}

		// Merge the ranges that this one now covers. The range that starts first keeps its label.
		while (ranges.length > 0 && ranges[ranges.length - 1].end > start) {
			const previous = ranges.pop()!;
			if (previous.start <= start) {
				start = previous.start;
				label = previous.label;
			}
			end = Math.max(end, previous.end);
		}
		ranges.push({ start, end, label });
		if (match[1] !== undefined) {
			lastFileRangeEnd = end;
		}
	}

	return ranges;
}

/**
 * Replace every visible file reference, literal comment attribute, and `!%5B` image syntax with a fixed
 * label.
 */
function redact_visible_text(text: string) {
	let result = "";
	let cursor = 0;
	for (const range of visible_reference_ranges(text)) {
		result += text.slice(cursor, range.start) + range.label;
		cursor = range.end;
	}
	return result + text.slice(cursor);
}

/**
 * Redact the text of one textblock, across its marks.
 *
 * Formatting can split a reference into several text nodes, for example `bonobo-**file://x**`. So
 * each run of neighbour text nodes is joined once and scanned once. The label goes into the node where
 * a match starts, with that node's marks, and the matched text is removed from the nodes it covers.
 * A hard break ends a run, like it ends a line of visible text. An image stays in the run as `[image]`,
 * like in the fallback text. A name can sit before the image and its file address after it.
 */
function redact_textblock(node: ProseMirrorNode) {
	const schema = get_schema();
	const children: ProseMirrorNode[] = [];
	let changed = false;
	let run: ProseMirrorNode[] = [];

	const leafTextOf = (leaf: ProseMirrorNode) => (leaf.isText ? (leaf.text ?? "") : IMAGE_LABEL);

	const flushRun = () => {
		if (run.length === 0) {
			return;
		}

		const joined = run.map(leafTextOf).join("");
		const matches = visible_reference_ranges(joined);
		if (matches.length === 0) {
			children.push(...run);
			run = [];
			return;
		}

		changed = true;

		// A typed URL can run into image or link syntax, so its link address holds part of the file name.
		// So drop every link whose text a replaced range touches, in the whole run. Its text stays.
		const droppedHrefs = new Set<unknown>();
		let touchIndex = 0;
		let offset = 0;
		for (const leaf of run) {
			const leafEnd = offset + leafTextOf(leaf).length;
			while (touchIndex < matches.length && matches[touchIndex].end <= offset) {
				touchIndex += 1;
			}
			const link = leaf.marks.find((mark) => mark.type.name === "link");
			if (link && touchIndex < matches.length && matches[touchIndex].start < leafEnd) {
				droppedHrefs.add(link.attrs.href);
			}
			offset = leafEnd;
		}

		let matchIndex = 0;
		let leafStart = 0;
		for (const leaf of run) {
			const leafText = leafTextOf(leaf);
			const leafEnd = leafStart + leafText.length;

			// Keep an image that no range touches. A touched image becomes plain text, like its text neighbours.
			if (!leaf.isText && !(matchIndex < matches.length && matches[matchIndex].start < leafEnd)) {
				children.push(leaf);
				leafStart = leafEnd;
				continue;
			}

			let text = "";
			let cursor = leafStart;
			while (cursor < leafEnd) {
				const match = matches[matchIndex];
				if (!match || match.start >= leafEnd) {
					text += leafText.slice(cursor - leafStart);
					break;
				}
				if (match.start > cursor) {
					text += leafText.slice(cursor - leafStart, match.start - leafStart);
					cursor = match.start;
				}
				if (cursor === match.start) {
					text += match.label;
				}

				cursor = Math.min(match.end, leafEnd);
				// A match that ends past this node keeps covering the next one.
				if (match.end > leafEnd) {
					break;
				}
				matchIndex += 1;
			}

			if (text !== "") {
				const marks = leaf.marks.filter((mark) => !(mark.type.name === "link" && droppedHrefs.has(mark.attrs.href)));
				children.push(schema.text(text, marks));
			}
			leafStart = leafEnd;
		}
		run = [];
	};

	node.forEach((child) => {
		if (child.isText || child.type.name === "image") {
			run.push(child);
			return;
		}

		flushRun();
		children.push(child);
	});
	flushRun();

	return changed ? node.copy(Fragment.fromArray(children)) : node;
}

/**
 * Redact every textblock and count the nodes and their strings. Returns null past the node, depth, or
 * size bound.
 */
function redact_document(doc: ProseMirrorNode) {
	let nodeCount = 0;
	// Count the text and the attribute strings the JSON will hold. A mark's attributes repeat on every
	// text node it covers. So check the size here, before `check()` and `JSON.stringify` do that work.
	let stringLength = 0;

	const addStrings = (node: ProseMirrorNode) => {
		stringLength += node.text?.length ?? 0;
		for (const attrs of [node.attrs, ...node.marks.map((mark) => mark.attrs)]) {
			for (const value of Object.values(attrs)) {
				if (typeof value === "string") {
					stringLength += value.length;
				}
			}
		}
		return stringLength <= MAX_PUBLIC_TEXT_BYTES;
	};

	const visit = (node: ProseMirrorNode, depth: number): ProseMirrorNode | null => {
		nodeCount += 1;
		if (nodeCount > MAX_RICH_NODES || depth > MAX_RICH_DEPTH || !addStrings(node)) {
			return null;
		}

		if (node.isTextblock) {
			nodeCount += node.childCount;
			if (nodeCount > MAX_RICH_NODES) {
				return null;
			}

			const redacted = redact_textblock(node);
			let fits = true;
			redacted.forEach((child) => {
				fits &&= addStrings(child);
			});
			return fits ? redacted : null;
		}

		if (node.childCount === 0) {
			return node;
		}

		const children: ProseMirrorNode[] = [];
		let changed = false;
		for (let index = 0; index < node.childCount; index += 1) {
			const child = node.child(index);
			const visited = visit(child, depth + 1);
			if (!visited) {
				return null;
			}
			changed ||= visited !== child;
			children.push(visited);
		}

		return changed ? node.copy(Fragment.fromArray(children)) : node;
	};

	return visit(doc, 0);
}
// #endregion redaction

// #region preflight
/**
 * A string built from many small pieces. It keeps parts of at most 64 KiB instead of one array entry
 * per parser callback.
 */
class TextAccumulator {
	parts: string[] = [];
	current = "";

	append(text: string) {
		this.current += text;
		if (this.current.length >= TEXT_PART_MAX_LENGTH) {
			this.parts.push(this.current);
			this.current = "";
		}
	}

	isEmpty() {
		return this.current === "" && this.parts.length === 0;
	}

	join() {
		return this.parts.length === 0 ? this.current : this.parts.join("") + this.current;
	}
}

/**
 * Thrown from a parser callback to stop at a hard limit. Caught by `preflight_html`.
 */
class PreflightRefusal extends Error {}

/**
 * Check the HTML's size and build its full visible text in one callback-only parse.
 *
 * Nothing here allocates a DOM. It counts what `linkedom` would allocate and refuses before the
 * parser keeps too much state. The visible text is the plain-text fallback: it skips scripts, forms,
 * SVG, and similar subtrees, keeps `pre`/`code`/frontmatter whitespace exactly, uses owned block
 * separators, and shows media only as a fixed label. Its references are redacted per visible run, and
 * a run continues across inline tags, so formatting cannot hide a reference.
 *
 * `layoutRanges` lists the raw newline-only layout between tags that the rich path deletes, like the
 * private editor's HTML step does. It is null when the document is too large for the rich path.
 */
function preflight_html(html: string) {
	let parser: Parser | null = null;
	let depth = 0;
	let units = WRAPPER_UNITS;
	let foreignContexts = 0;
	let tagAttributes = 0;
	let tagTookInTag = false;
	const mediaWithTakenInTag = new Set<string>();
	let skipDepth: number | null = null;
	let protectedDepth = 0;
	let layoutRanges: number[] | null = [];

	// One text segment is the text between two parser events of another kind.
	let segmentStart = -1;
	let segmentEnd = -1;
	let segmentIsLayoutCandidate = true;
	let segmentText = new TextAccumulator();
	// Linkedom never sees layout text, so its text callbacks count only once the segment keeps its text.
	let segmentUnits = 0;

	let run = new TextAccumulator();
	const output = new TextAccumulator();
	let outputBytes = 0;
	let pendingSeparator = "";

	const addUnits = (count: number) => {
		units += count;
		if (units > MAX_RICH_NODES) {
			layoutRanges = null;
		}
	};

	const emitVisible = (text: string) => {
		if (text === "") {
			return;
		}

		const piece = output.isEmpty() ? text : pendingSeparator + text;
		pendingSeparator = "";
		outputBytes += files_get_utf8_byte_size(piece);
		if (outputBytes > MAX_PUBLIC_TEXT_BYTES) {
			throw new PreflightRefusal();
		}
		output.append(piece);
	};

	const flushRun = () => {
		if (run.isEmpty()) {
			return;
		}

		const text = run.join();
		run = new TextAccumulator();
		emitVisible(redact_visible_text(text));
	};

	const setSeparator = (separator: string) => {
		if (separator.length > pendingSeparator.length || (separator === "\n" && pendingSeparator === "\t")) {
			pendingSeparator = separator;
		}
	};

	const endSegment = () => {
		if (segmentStart === -1) {
			return;
		}

		// Newlines between two tags are layout only outside protected text. Protected text never gets
		// here as a candidate, so authored code whitespace always stays.
		const isLayout = segmentIsLayoutCandidate && LAYOUT_WHITESPACE_REGEX.test(html.slice(segmentStart, segmentEnd));
		if (isLayout) {
			layoutRanges?.push(segmentStart, segmentEnd);
		} else if (segmentIsLayoutCandidate) {
			run.append(segmentText.join());
			addUnits(segmentUnits);
		}

		segmentStart = -1;
		segmentIsLayoutCandidate = true;
		segmentText = new TextAccumulator();
		segmentUnits = 0;
	};

	parser = new Parser(
		{
			ontext(data) {
				if (skipDepth !== null) {
					addUnits(1);
					return;
				}

				const start = parser!.startIndex;
				const end = parser!.endIndex + 1;
				if (segmentStart === -1) {
					segmentStart = start;
					segmentIsLayoutCandidate = protectedDepth === 0;
				}
				segmentEnd = end;

				if (segmentIsLayoutCandidate && LAYOUT_WHITESPACE_CHARS_REGEX.test(html.slice(start, end))) {
					segmentText.append(data);
					segmentUnits += 1;
					return;
				}

				if (segmentIsLayoutCandidate) {
					run.append(segmentText.join());
					segmentText = new TextAccumulator();
					segmentIsLayoutCandidate = false;
				}
				addUnits(segmentUnits + 1);
				segmentUnits = 0;
				run.append(data);
			},

			onopentagname(name) {
				endSegment();
				addUnits(1);
				tagAttributes = 0;
				tagTookInTag = false;
				depth += 1;
				if (depth > MAX_PARSER_DEPTH) {
					throw new PreflightRefusal();
				}
				if (depth > MAX_RICH_DEPTH) {
					layoutRanges = null;
				}
				if (FOREIGN_CONTEXT_TAGS.has(name)) {
					foreignContexts += 1;
					if (foreignContexts > MAX_FOREIGN_CONTEXTS) {
						throw new PreflightRefusal();
					}
				}

				if (skipDepth !== null) {
					return;
				}

				// A removed subtree adds no text and does not end the current visible run.
				if (REMOVED_TAGS.has(name)) {
					skipDepth = depth;
					return;
				}

				// An image stays in the run, like in the rich path, so a name before it is still found. A
				// video is a block in the rich path, so it ends the run.
				if (name === "img") {
					run.append(IMAGE_LABEL);
					return;
				}
				if (name === "video") {
					flushRun();
					emitVisible(VIDEO_LABEL);
					skipDepth = depth;
					return;
				}

				if (name === "br") {
					flushRun();
					emitVisible("\n");
					return;
				}

				if (PARAGRAPH_SEPARATOR_TAGS.has(name) || LINE_SEPARATOR_TAGS.has(name) || CELL_SEPARATOR_TAGS.has(name)) {
					flushRun();
					setSeparator(PARAGRAPH_SEPARATOR_TAGS.has(name) ? "\n\n" : LINE_SEPARATOR_TAGS.has(name) ? "\n" : "\t");
				}
				if (PROTECTED_TEXT_TAGS.has(name)) {
					protectedDepth += 1;
				}
			},

			// The attributes are known only here. Hide a link whose address holds a reference, like in the
			// rich path.
			onopentag(name, attribs) {
				if (layoutRanges !== null && tagTookInTag && (name === "img" || name === "video")) {
					mediaWithTakenInTag.add(`${name}\n${attribs.src ?? ""}`);
				}
				const hiddenText = skipDepth === null && name === "a" ? hidden_link_text(attribs.href ?? "") : null;
				if (hiddenText !== null) {
					run.append(hiddenText);
					skipDepth = depth;
				}
			},

			onattribute(name, value) {
				// Check before the HTML parser drops repeated attributes. A dropped value can hold a tag.
				tagTookInTag ||= name.includes("<") || value.includes("<");
				addUnits(1);
				tagAttributes += 1;
				if (tagAttributes > MAX_TAG_ATTRIBUTES) {
					throw new PreflightRefusal();
				}
			},

			onclosetag(name, isImplied) {
				endSegment();
				// Only an explicit close ends a foreign context. An implied or self-closing close keeps
				// the parser's context entry, so it must keep counting too.
				if (FOREIGN_CONTEXT_TAGS.has(name) && !isImplied) {
					foreignContexts -= 1;
				}

				const closedDepth = depth;
				depth -= 1;
				if (skipDepth !== null) {
					if (closedDepth === skipDepth) {
						skipDepth = null;
					}
					return;
				}

				if (PARAGRAPH_SEPARATOR_TAGS.has(name) || LINE_SEPARATOR_TAGS.has(name) || CELL_SEPARATOR_TAGS.has(name)) {
					flushRun();
					setSeparator(PARAGRAPH_SEPARATOR_TAGS.has(name) ? "\n\n" : LINE_SEPARATOR_TAGS.has(name) ? "\n" : "\t");
				}
				if (PROTECTED_TEXT_TAGS.has(name)) {
					protectedDepth -= 1;
				}
			},

			oncomment() {
				endSegment();
				addUnits(1);
			},

			onprocessinginstruction() {
				endSegment();
				addUnits(1);
			},

			onend() {
				endSegment();
				flushRun();
			},
		},
		{
			decodeEntities: true,
			lowerCaseTags: true,
			lowerCaseAttributeNames: true,
			recognizeSelfClosing: false,
		},
	);

	try {
		parser.end(html);
	} catch (error) {
		if (error instanceof PreflightRefusal) {
			return null;
		}
		throw error;
	}

	return { visibleText: output.join(), layoutRanges, mediaWithTakenInTag };
}
// #endregion preflight

// #region rich document
/**
 * Read an element's attributes with lowercase names. The first value of a repeated name wins, like
 * in the HTML parser.
 */
function read_attributes(element: Element) {
	const attributes = new Map<string, string>();
	for (const attribute of Array.from(element.attributes)) {
		const name = attribute.name.toLowerCase();
		if (!attributes.has(name)) {
			attributes.set(name, attribute.value);
		}
	}
	return attributes;
}

function remove_all_attributes(element: Element) {
	for (const attribute of Array.from(element.attributes)) {
		element.removeAttribute(attribute.name);
	}
}

/**
 * Keep only the attributes the public schema reads, with checked values.
 */
function sanitize_attributes(element: HTMLElement, tag: string) {
	const attributes = read_attributes(element);
	remove_all_attributes(element);

	// Keep only an allowed `text-align`, and drop every other style. Split the author's text here instead of
	// using the element's style parser. linkedom splits with a pattern that is slow on a long run of spaces.
	// Like CSS, the last `text-align` wins.
	if (tag === "p" || HEADING_TAGS.has(tag)) {
		let alignment: string | null = null;
		for (const declaration of attributes.get("style")?.split(";") ?? []) {
			const colon = declaration.indexOf(":");
			if (colon !== -1 && declaration.slice(0, colon).trim().toLowerCase() === "text-align") {
				alignment = declaration
					.slice(colon + 1)
					.trim()
					.toLowerCase();
			}
		}
		if (alignment !== null && TEXT_ALIGNMENTS.includes(alignment)) {
			element.setAttribute("style", `text-align: ${alignment}`);
		}
		return;
	}

	if (tag === "ol") {
		const start = attributes.get("start");
		if (start !== undefined && /^\d{1,9}$/.test(start)) {
			element.setAttribute("start", String(Number(start)));
		}
		const type = attributes.get("type");
		if (type !== undefined && ORDERED_LIST_TYPES.includes(type)) {
			element.setAttribute("type", type);
		}
		return;
	}

	if (tag === "ul" && attributes.get("data-type") === "taskList") {
		element.setAttribute("data-type", "taskList");
		return;
	}

	if (tag === "li" && attributes.get("data-type") === "taskItem") {
		element.setAttribute("data-type", "taskItem");
		element.setAttribute("data-checked", attributes.get("data-checked") === "true" ? "true" : "false");
		return;
	}

	if (tag === "td" || tag === "th") {
		for (const name of ["colspan", "rowspan"]) {
			const span = attributes.get(name);
			if (span !== undefined && /^\d{1,2}$/.test(span) && Number(span) >= 1 && Number(span) <= 32) {
				element.setAttribute(name, String(Number(span)));
			}
		}
		const align = attributes.get("align");
		if (align !== undefined && CELL_ALIGNMENTS.includes(align)) {
			element.setAttribute("align", align);
		}
		return;
	}

	if (tag === "pre" && attributes.has("data-frontmatter")) {
		element.setAttribute("data-frontmatter", "");
	}
}

/**
 * Remove active content from the data-only DOM and give each app image/video a server index.
 *
 * Only decoded `src` values of real image and video elements can add a media entry. Text, code, and
 * link destinations never do. The same kind and reference always get the same index. An external
 * image or video becomes a plain link, so the page never loads a third-party resource by itself.
 */
function sanitize_dom(
	body: HTMLElement,
	media: files_share_rich_text_Prepared["media"],
	mediaWithTakenInTag: Set<string>,
) {
	const document = body.ownerDocument;
	const mediaIndexes = new Map<string, number>();

	const makeLink = (url: string) => {
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.appendChild(document.createTextNode(url));
		return link;
	};

	const visit = (parent: Node) => {
		let child = parent.firstChild;
		while (child) {
			const next = child.nextSibling;

			if (child.nodeType === 3) {
				// Join neighbour text nodes. Entities and removed comments split one visible text.
				const previous = child.previousSibling;
				if (previous?.nodeType === 3) {
					(previous as globalThis.Text).data += (child as globalThis.Text).data;
					parent.removeChild(child);
				}
			} else if (child.nodeType !== 1) {
				parent.removeChild(child);
			} else {
				const element = child as HTMLElement;
				const tag = element.localName.toLowerCase();

				if (tag === "img" || tag === "video") {
					const attributes = read_attributes(element);
					const src = attributes.get("src") ?? "";
					const reference = files_media_parse_src(src);
					const externalUrl = reference.kind === "external" ? public_http_url(src) : null;
					if (externalUrl) {
						parent.replaceChild(makeLink(externalUrl), element);
					} else {
						const kind: files_share_rich_text_MediaKind = tag === "img" ? "image" : "video";
						let index: number | null = null;
						if (reference.kind === "file" || reference.kind === "private") {
							const key = `${kind}\n${src}`;
							index = mediaIndexes.get(key) ?? null;
							if (index === null && media.length < files_share_rich_text_MAX_MEDIA) {
								index = media.length;
								media.push({ kind, src });
								mediaIndexes.set(key, index);
							}
						}

						const replacement = document.createElement(tag);
						replacement.setAttribute(MEDIA_MARKER_ATTRIBUTE, "");
						if (index !== null) {
							replacement.setAttribute(MEDIA_INDEX_ATTRIBUTE, String(index));
						}
						// Author-typed HTML with an open quote can take in the next tag. Then this tag can get that
						// tag's `alt`, often a private file name. Check the raw attributes too: a repeated one can
						// hold the `<` and disappear from the DOM. Match by tag and first decoded source.
						const alt = attributes.get("alt");
						const tookInTag =
							mediaWithTakenInTag.has(`${tag}\n${src}`) ||
							Array.from(element.attributes).some(
								(attribute) => attribute.name.includes("<") || attribute.value.includes("<"),
							);
						if (alt !== undefined && !tookInTag) {
							replacement.setAttribute("alt", alt);
						}
						parent.replaceChild(replacement, element);
					}
				} else if (tag === "iframe") {
					const url = public_http_url(read_attributes(element).get("src"));
					if (url) {
						parent.replaceChild(makeLink(url), element);
					} else {
						parent.removeChild(element);
					}
				} else if (REMOVED_TAGS.has(tag)) {
					parent.removeChild(element);
				} else if (tag === "a") {
					const href = read_attributes(element).get("href") ?? "";
					// Check the whole address, not only its start. When the app saves the text again, a file
					// link right after a typed URL becomes one link, `[URL + name](URL%5Bname%5D(bonobo-file://x))`.
					const hiddenText = hidden_link_text(href);
					if (hiddenText !== null) {
						parent.replaceChild(document.createTextNode(hiddenText), element);
					} else {
						const url = public_http_url(href);
						remove_all_attributes(element);
						if (url) {
							element.setAttribute("href", url);
						}
						visit(element);
					}
				} else {
					sanitize_attributes(element, tag);
					visit(element);
				}
			}

			child = next;
		}

		// A replacement or removal can leave two text nodes next to each other. Join them too.
		let current = parent.firstChild;
		while (current) {
			const next = current.nextSibling;
			if (current.nodeType === 3 && next?.nodeType === 3) {
				(current as globalThis.Text).data += (next as globalThis.Text).data;
				parent.removeChild(next);
				continue;
			}
			current = next;
		}
	};

	visit(body);
}

/**
 * Whether the cleaned DOM fits the rich bounds, checked before the recursive schema parse.
 */
function dom_fits(body: Node) {
	let count = 0;
	const stack: Array<{ node: Node; depth: number }> = [{ node: body, depth: 0 }];
	while (stack.length > 0) {
		const { node, depth } = stack.pop()!;
		count += 1;
		if (count > MAX_RICH_NODES || depth > MAX_RICH_DEPTH) {
			return false;
		}
		for (let child = node.firstChild; child; child = child.nextSibling) {
			stack.push({ node: child, depth: depth + 1 });
		}
	}
	return true;
}

/**
 * Build the bounded rich document, or null when it does not fit and the plain text must be shown.
 */
function build_rich_document(
	html: string,
	layoutRanges: number[],
	media: files_share_rich_text_Prepared["media"],
	mediaWithTakenInTag: Set<string>,
) {
	// Delete the writer's layout newlines between tags, like the private editor does, but only the exact
	// ranges the preflight found outside protected text.
	let domHtml = "";
	let copiedUntil = 0;
	for (let index = 0; index < layoutRanges.length; index += 2) {
		domHtml += html.slice(copiedUntil, layoutRanges[index]);
		copiedUntil = layoutRanges[index + 1]!;
	}
	domHtml += html.slice(copiedUntil);

	// linkedom can throw on hostile HTML. For example, a class with very many names overflows the stack.
	// Show the plain text then.
	let body: HTMLElement;
	try {
		body = new LinkedomDOMParser().parseFromString(`<!DOCTYPE html><html><body>${domHtml}</body></html>`, "text/html")
			.body as unknown as HTMLElement;
	} catch {
		return null;
	}

	sanitize_dom(body, media, mediaWithTakenInTag);
	if (!dom_fits(body)) {
		return null;
	}

	const parsed = ProseMirrorDOMParser.fromSchema(get_schema()).parse(body, { preserveWhitespace: "full" });
	const doc = redact_document(parsed);
	if (!doc) {
		return null;
	}

	try {
		doc.check();
	} catch {
		return null;
	}

	return doc;
}
// #endregion rich document

/**
 * Prepare a shared file's saved text for the public page.
 *
 * Plain text is only redacted. Rich text goes through the steps described at the top of this module.
 * A document with too much formatting falls back to its full visible text. A hard limit refuses the
 * whole text: the caller shows the generic unavailable page, never partly processed text.
 */
export function files_share_rich_text_prepare(args: { text: string; textKind: files_YjsRootKind }) {
	if (args.textKind === "plain_text") {
		const text = redact_visible_text(args.text);
		if (files_get_utf8_byte_size(text) > MAX_PUBLIC_TEXT_BYTES) {
			return Result({ _nay: { message: "The text is too large to share" } });
		}

		return Result({
			_yay: {
				media: [],
				draft: { kind: "plain_text", text, formattingFallback: false },
			} satisfies files_share_rich_text_Prepared,
		});
	}

	const html = files_parse_markdown_to_html(args.text, {
		cache: false,
		workLimit: MAX_MARKDOWN_WORK,
		hiddenLinkText: hidden_link_text,
	});
	if (html._nay || files_get_utf8_byte_size(html._yay) > MAX_HTML_BYTES) {
		return Result({ _nay: { message: "The text cannot be shared" } });
	}

	const preflight = preflight_html(html._yay);
	if (!preflight) {
		return Result({ _nay: { message: "The text cannot be shared" } });
	}

	const media: files_share_rich_text_Prepared["media"] = [];
	const doc = preflight.layoutRanges
		? build_rich_document(html._yay, preflight.layoutRanges, media, preflight.mediaWithTakenInTag)
		: null;
	if (!doc) {
		return Result({
			_yay: {
				media: [],
				draft: { kind: "plain_text", text: preflight.visibleText, formattingFallback: true },
			} satisfies files_share_rich_text_Prepared,
		});
	}

	return Result({
		_yay: {
			media,
			draft: { kind: "rich_text", doc, fallbackText: preflight.visibleText },
		} satisfies files_share_rich_text_Prepared,
	});
}

/**
 * Turn a prepared document into public content once the server knows which media are available.
 *
 * Only an available indexed image or video keeps its alt text, redacted. The editor often fills alt
 * with the file's private name, so every other media node loses it before anything is serialized.
 */
export function files_share_rich_text_finish(args: {
	prepared: files_share_rich_text_Prepared;
	isMediaAvailable: (index: number) => boolean;
}): PublicContent {
	const { draft } = args.prepared;
	if (draft.kind === "plain_text") {
		return draft;
	}

	const plainFallback = { kind: "plain_text" as const, text: draft.fallbackText, formattingFallback: true };

	const withMediaAlt = (node: ProseMirrorNode): ProseMirrorNode => {
		if (node.type.name === "image" || node.type.name === "video") {
			const index = node.attrs.index as number | null;
			const alt = node.attrs.alt as string | null;
			const nextAlt = index !== null && alt !== null && args.isMediaAvailable(index) ? redact_visible_text(alt) : null;
			return nextAlt === alt ? node : node.type.create({ ...node.attrs, alt: nextAlt }, null, node.marks);
		}

		if (node.childCount === 0) {
			return node;
		}

		const children: ProseMirrorNode[] = [];
		let changed = false;
		node.forEach((child) => {
			const next = withMediaAlt(child);
			changed ||= next !== child;
			children.push(next);
		});
		return changed ? node.copy(Fragment.fromArray(children)) : node;
	};

	const json = JSON.stringify(withMediaAlt(draft.doc).toJSON());
	if (files_get_utf8_byte_size(json) > MAX_PUBLIC_TEXT_BYTES) {
		return plainFallback;
	}

	return { kind: "rich_text", json };
}

/**
 * Read public rich JSON received from the server, for rendering.
 *
 * Checks the bounded shape first, then builds the document with the public schema and runs its
 * attribute validators and content rules. Returns null for anything else; the page shows its generic message.
 */
export function files_share_rich_text_parse_json(json: string) {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}

	let count = 0;
	const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
	while (stack.length > 0) {
		const { node, depth } = stack.pop()!;
		count += 1;
		if (count > MAX_RICH_NODES || depth > MAX_RICH_DEPTH + 1) {
			return null;
		}
		if (typeof node !== "object" || node === null || Array.isArray(node)) {
			return null;
		}

		const content = (node as { content?: unknown }).content;
		if (content === undefined) {
			continue;
		}
		if (!Array.isArray(content)) {
			return null;
		}
		for (const child of content) {
			stack.push({ node: child, depth: depth + 1 });
		}
	}

	try {
		const doc = get_schema().nodeFromJSON(value);
		doc.check();
		return doc;
	} catch {
		return null;
	}
}
