// Tiptap/Markdown helpers for files: the marked pipeline, shared extensions, and headless editors.
//
// Split out of `shared/files.ts` for module-eval weight: the Tiptap suite (and `marked`) must not
// load for consumers that only need the lean helpers in `shared/files.ts` or the Yjs helpers in
// `shared/files-yjs.ts`.

import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { Highlight } from "@tiptap/extension-highlight";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { marked } from "marked";
import type { Doc as YDoc } from "yjs";
import { Editor, Extension, Node, type Extensions } from "@tiptap/core";
import type { JSONContent as TiptapJSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { is_browser, should_never_happen } from "./shared-utils.ts";
import { files_CommentsExtension } from "./files-tiptap-comments.ts";
import { generateJSON as tiptap_generateJSON_server } from "@tiptap/html/server";
import { generateJSON as tiptap_generateJSON_browser } from "@tiptap/html";
import { Result } from "common/errors-as-values-utils.ts";
import { files_tiptap_empty_doc_json, files_YJS_DOC_KEYS } from "./files.ts";
import { files_yjs_doc_create_from_tiptap_editor, files_yjs_doc_update_from_tiptap_editor } from "./files-yjs.ts";

const TRAILING_SPACES_OR_TABS_REGEX = /[ \t]+$/;
const TRAILING_WHITESPACE_ONLY_LINE_REGEX = /\n([ \t]+)$/;
const TRAILING_NEWLINES_REGEX = /\n+$/;
const STRUCTURAL_HTML_WHITESPACE_REGEX = />\n[ \t]*</g;
const TRAILING_HARD_BREAKS_REGEX = /(?:\\\n)+$/;
const HARD_BREAK_REGEX = /\\\n/g;

/**
 * Shared marked instance configured for Markdown files.
 *
 * Configured with GitHub Flavored Markdown enabled and breaks disabled.
 */
const files_marked = ((/* iife */) => {
	function value() {
		const instance = marked;
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
					const bodyHtml = instance.parseInline(bodyRaw, { async: false });

					return `<p>${bodyHtml}${"<br>".repeat(hardBreakCount)}</p>`;
				},
			},
		});

		return instance;
	}

	let cache: ReturnType<typeof value>;

	return function files_marked() {
		return (cache ??= value());
	};
})();

/**
 * Parse markdown string to HTML.
 */
function tiptap_markdown_to_html(args: { markdown: string; extensions?: Extensions; replaceNewLineToBr?: boolean }) {
	const markdown = args.replaceNewLineToBr ? args.markdown.replaceAll("\n", "<br>") : args.markdown;

	// const markdownWithoutTrailingHardBreaks = markdown.replace(/(?:\\\n)+$/g, "");

	let html;
	try {
		html = files_marked().parse(markdown, { async: false });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while parsing markdown to HTML",
				cause: error,
			},
		});
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
	// counts round up). files_yjs_doc_get_markdown mirrors this by ending non-empty
	// file content with one `\n`, so newline-terminated text round-trips byte-exact.
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
 */
export const files_parse_markdown_to_html = ((/* iife */) => {
	function value(markdown: string) {
		return tiptap_markdown_to_html({
			markdown,
		});
	}

	const cache = new Map<Parameters<typeof value>[0], ReturnType<typeof value>>();

	return function files_parse_markdown_to_html(markdown: string) {
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

export function files_yjs_doc_get_markdown(args: { yjsDoc: YDoc }) {
	const yjsDoc = args.yjsDoc;
	const fragment = yjsDoc.getXmlFragment(files_YJS_DOC_KEYS.richText);

	const editor = files_headless_tiptap_editor_create();

	if (editor._nay) {
		return editor;
	}

	try {
		const node = yXmlFragmentToProseMirrorRootNode(fragment, editor._yay.schema);
		const json = node.toJSON();
		editor._yay.commands.setContent(json);
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

export function files_yjs_doc_update_from_markdown(args: { markdown: string; mut_yjsDoc: YDoc }) {
	const editor = files_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdown },
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

export function files_yjs_doc_create_from_markdown(args: { markdown: string }) {
	const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: args.markdown } });
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
			markdown: Markdown.configure({ marked: files_marked() }),
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
		editor.commands.setContent(args.initialContent.json);
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

	editor.commands.setContent(json._yay);
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
