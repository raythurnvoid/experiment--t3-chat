import type { pages_TreeItem } from "../convex/ai_docs_temp.ts";
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
import { Doc as YDoc, encodeStateAsUpdate, applyUpdate, encodeStateVector } from "yjs";
import { Editor, Extension, type Extensions } from "@tiptap/core";
import type { JSONContent as TiptapJSONContent, MarkdownRendererHelpers, RenderContext } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { updateYFragment } from "y-prosemirror";
import { should_never_happen } from "../shared/shared-utils.ts";
import { CommentsExtension } from "@liveblocks/react-tiptap";
import { generateJSON as tiptap_generateJSON_server } from "@tiptap/html/server";
import { generateJSON as tiptap_generateJSON_browser } from "@tiptap/html";
import { Result } from "./errors-as-values-utils.ts";

export const pages_ROOT_ID = "root";
export const pages_FIRST_VERSION = 1;
export const pages_YJS_DOC_KEYS = {
	richText: "default",
	plainText: "markdown",
};

export type { pages_TreeItem };

export function pages_create_tree_root(): pages_TreeItem {
	return {
		type: "root",
		index: pages_ROOT_ID,
		parentId: "",
		title: "",
		isArchived: false,
		updatedAt: 0,
		updatedBy: "",
		_id: null,
	};
}

export function pages_create_tree_placeholder_child(itemId: string): pages_TreeItem {
	return {
		type: "placeholder",
		index: `${itemId}-placeholder`,
		parentId: itemId,
		title: "No files inside",
		isArchived: false,
		updatedAt: 0,
		updatedBy: "",
		_id: null,
	};
}

export function pages_create_room_id(workspaceId: string, projectId: string, pageId: string): string {
	return `pages::${workspaceId}::${projectId}::${pageId}`;
}

/**
 * Shared marked instance configured for pages.
 *
 * Configured with GitHub Flavored Markdown enabled and breaks disabled.
 */
const pages_marked = ((/* iife */) => {
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
		});

		return instance;
	}

	let cache: ReturnType<typeof value>;

	return function pages_marked() {
		return (cache ??= value());
	};
})();

/**
 * Parse markdown string to HTML.
 */
function tiptap_markdown_to_html(args: { markdown: string; extensions?: Extensions }) {
	let html;
	try {
		html = pages_marked().parse(args.markdown, { async: false });
	} catch (error) {
		return Result({
			_nay: {
				name: "nay",
				message: "Error while parsing markdown to HTML",
				cause: error,
			},
		});
	}

	// Preserve trailing empty lines at EOF (Markdown usually ignores them).
	// - every 2 `\n` => 1 empty paragraph
	// - odd counts round up
	const trailing = /\n+$/.exec(args.markdown)?.[0] ?? "";
	const newlineCount = trailing.length > 0 ? trailing.split("\n").length - 1 : 0;
	if (newlineCount === 0) return Result({ _yay: html });

	const paragraphCount = Math.max(1, Math.ceil(newlineCount / 2));
	return Result({
		_yay: html + "<p></p>".repeat(paragraphCount),
	});
}

/**
 * Parse markdown string to HTML.
 */
export const pages_parse_markdown_to_html = ((/* iife */) => {
	function value(markdown: string) {
		return tiptap_markdown_to_html({
			markdown,
		});
	}

	const cache = new Map<Parameters<typeof value>[0], ReturnType<typeof value>>();

	return function pages_parse_markdown_to_html(markdown: string) {
		const cachedValue = cache.get(markdown);
		if (cachedValue) {
			return cachedValue;
		}

		const result = value(markdown);
		cache.set(markdown, result);
		return result;
	};
})();

export function pages_tiptap_html_to_json(args: { html: string; extensions?: Extensions }) {
	const extensions = args.extensions ?? get_tiptap_shared_extensions_list();
	const json =
		typeof window === "undefined"
			? tiptap_generateJSON_server(args.html, extensions)
			: tiptap_generateJSON_browser(args.html, extensions);
	return json;
}

export function pages_tiptap_markdown_to_json(args: { markdown: string; extensions?: Extensions }) {
	if (!args.markdown) {
		return Result({ _yay: pages_tiptap_empty_doc_json() });
	}

	// Go through HTML so extension `parseHTML` handlers can normalize embedded HTML
	// consistently with the rest of the editor pipeline.
	const markdownToHtml = tiptap_markdown_to_html({
		markdown: args.markdown,
		extensions: args.extensions,
	});

	if (markdownToHtml._nay) {
		return markdownToHtml;
	}

	return Result({
		_yay: pages_tiptap_html_to_json({
			html: markdownToHtml._yay,
			extensions: args.extensions,
		}),
	});
}

/**
 * Convert a Uint8Array to an ArrayBuffer.
 */
export function pages_u8_to_array_buffer(u8: Uint8Array) {
	// Zero-copy if view covers entire buffer
	if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
		return u8.buffer as ArrayBuffer;
	}
	// Copy only if partial view (handles both cases safely)
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Compare two Uint8Arrays for byte-level equality.
 */
export function pages_u8_equals(a: Uint8Array, b: Uint8Array) {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// #region yjs
export function pages_yjs_create_empty_state_update() {
	return encodeStateAsUpdate(new YDoc());
}

/**
 * Applies incremental Yjs updates to an existing Y.Doc.
 *
 * @param mut_yjsDoc - The Y.Doc instance to apply updates to (mutated in place)
 * @param incrementalUpdates - Array of incremental Yjs updates (ArrayBuffer) to apply
 */
export function pages_yjs_doc_apply_incremental_array_buffer_updates(
	mut_yjsDoc: YDoc,
	incrementalUpdates: Array<ArrayBuffer>,
): void {
	for (const incrementalUpdate of incrementalUpdates) {
		applyUpdate(mut_yjsDoc, new Uint8Array(incrementalUpdate));
	}
}

/**
 * Creates a Y.Doc from a Yjs update.
 *
 * Applies the update to a new Y.Doc instance.
 *
 * Optionally applies additional incremental updates.
 *
 * @param update - The initial Yjs update (ArrayBuffer) to apply to create the Y.Doc
 * @param args - Optional configuration object
 * @param args.additionalIncrementalArrayBufferUpdates - Optional array of incremental Yjs updates (ArrayBuffer)
 * to apply after the initial update
 * @returns A new Y.Doc instance with all updates applied
 */
export function pages_yjs_doc_create_from_array_buffer_update(
	update: ArrayBuffer,
	args?: { additionalIncrementalArrayBufferUpdates?: Array<ArrayBuffer> },
): YDoc {
	const yjsDoc = new YDoc();
	applyUpdate(yjsDoc, new Uint8Array(update));

	if (args?.additionalIncrementalArrayBufferUpdates) {
		pages_yjs_doc_apply_incremental_array_buffer_updates(yjsDoc, args.additionalIncrementalArrayBufferUpdates);
	}

	return yjsDoc;
}

export function pages_yjs_doc_update_from_tiptap_editor(args: {
	mut_yjsDoc: YDoc;
	tiptapEditor: Editor;
	opKind: "snapshot-restore" | "user-edit";
}) {
	const yjsFragment = args.mut_yjsDoc.getXmlFragment(pages_YJS_DOC_KEYS.richText);

	args.mut_yjsDoc.transact(() => {
		updateYFragment(args.mut_yjsDoc, yjsFragment, args.tiptapEditor.state.doc, {
			mapping: new Map(),
			isOMark: new Map(),
		});
	}, args.opKind);
}

export function pages_yjs_doc_create_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = new YDoc();
	pages_yjs_doc_update_from_tiptap_editor({
		mut_yjsDoc: yjsDoc,
		tiptapEditor: args.tiptapEditor,
		opKind: "snapshot-restore",
	});
	return yjsDoc;
}

export function pages_yjs_doc_get_markdown(args: { yjsDoc: YDoc }) {
	const yjsDoc = args.yjsDoc;
	const fragment = yjsDoc.getXmlFragment(pages_YJS_DOC_KEYS.richText);

	const editor = pages_headless_tiptap_editor_create();

	if (editor._nay) {
		return editor;
	}

	try {
		const node = yXmlFragmentToProseMirrorRootNode(fragment, editor._yay.schema);
		const json = node.toJSON();
		editor._yay.commands.setContent(json);
		const markdown = pages_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay });
		return Result({ _yay: markdown });
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

export function pages_yjs_doc_update_from_markdown(args: { markdown: string; mut_yjsDoc: YDoc }) {
	const editor = pages_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdown },
	});

	if (editor._nay) {
		return editor;
	}

	try {
		pages_yjs_doc_update_from_tiptap_editor({
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

export function pages_yjs_doc_create_from_markdown(args: { markdown: string }) {
	const editor = pages_headless_tiptap_editor_create({ initialContent: { markdown: args.markdown } });
	if (editor._nay) {
		return editor;
	}

	try {
		return pages_yjs_doc_create_from_tiptap_editor({ tiptapEditor: editor._yay });
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

export function pages_yjs_doc_clone(args: { yjsDoc: YDoc }) {
	const clonedDoc = new YDoc();
	applyUpdate(clonedDoc, encodeStateAsUpdate(args.yjsDoc));
	return clonedDoc;
}

export function pages_yjs_compute_diff_update_from_state_vector(args: {
	yjsDoc: YDoc;
	yjsBeforeStateVector: Uint8Array;
}) {
	const diffUpdate = encodeStateAsUpdate(args.yjsDoc, args.yjsBeforeStateVector);
	return diffUpdate.byteLength === 0 ? null : diffUpdate;
}

export function pages_yjs_compute_diff_update_from_yjs_doc(args: { yjsDoc: YDoc; yjsBeforeDoc: YDoc }) {
	const yjsBeforeStateVector = encodeStateVector(args.yjsBeforeDoc);
	return pages_yjs_compute_diff_update_from_state_vector({ yjsDoc: args.yjsDoc, yjsBeforeStateVector });
}

// #endregion yjs

// #region tiptap editor
export const pages_tiptap_empty_doc_json = ((/* iife */) => {
	function value(): TiptapJSONContent {
		return { type: "doc", content: [{ type: "paragraph" }] };
	}

	let cache: ReturnType<typeof value>;

	return function pages_tiptap_empty_doc_json() {
		return (cache ??= value());
	};
})();

/**
 * Server-safe Tiptap extensions (no DOM, no React).
 *
 * Shared with client and server code.
 */
export const pages_get_tiptap_shared_extensions = ((/* iife */) => {
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
			markdown: Markdown.configure({ marked: pages_marked() }),
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
			liveblocksComments: CommentsExtension,
		};
	}

	let cache: ReturnType<typeof value>;

	return function pages_get_tiptap_shared_extensions() {
		return (cache ??= value());
	};
})();

const get_tiptap_shared_extensions_list = ((/* iife */) => {
	function value() {
		return Object.values(pages_get_tiptap_shared_extensions());
	}

	let cache: ReturnType<typeof value>;

	return function pages_get_tiptap_shared_extensions() {
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
export function pages_headless_tiptap_editor_create(args?: {
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
		const result = pages_headless_tiptap_editor_set_content_from_markdown({
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
 * const json = server_page_editor_markdown_to_json("# Title\n\nParagraph");
 * // { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, ... }] }
 * ```
 */
export function pages_headless_tiptap_editor_set_content_from_markdown(args: { markdown: string; mut_editor: Editor }) {
	const editor = args.mut_editor;
	const json = pages_tiptap_markdown_to_json({
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
 * Set the content of a headless editor from a Tiptap JSON document.
 *
 * Inverse of markdown_to_json, useful for serializing editor state.
 *
 * @param json - Tiptap JSON document
 * @returns A Result containing the Markdown string or an error
 */
export function pages_headless_tiptap_editor_get_markdown(args: { mut_editor: Editor }) {
	const editor = args.mut_editor;
	if (!editor.markdown) throw should_never_happen("editor.markdown is not set");
	const markdown = editor.markdown.serialize(editor.getJSON());
	return markdown;
}
// #endregion tiptap editor
