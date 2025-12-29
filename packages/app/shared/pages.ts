import type { pages_TreeItem } from "../convex/ai_docs_temp.ts";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import { TextStyle } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { Highlight } from "@tiptap/extension-highlight";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { marked } from "marked";
import { Doc as YDoc, encodeStateAsUpdate, applyUpdate } from "yjs";
import { Editor } from "@tiptap/core";
import type { Extension, JSONContent as TiptapJSONContent } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { updateYFragment } from "y-prosemirror";
import { should_never_happen } from "../shared/shared-utils.ts";

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
export const pages_parse_markdown_to_html = ((/* iife */) => {
	function value(markdown: string) {
		const markedInstance = pages_marked();
		const result = markedInstance.parse(markdown, { async: false });
		return result;
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
 * @param mut_yDoc - The Y.Doc instance to apply updates to (mutated in place)
 * @param incrementalUpdates - Array of incremental Yjs updates (ArrayBuffer) to apply
 */
export function pages_yjs_apply_incremental_array_buffer_updates(
	mut_yDoc: YDoc,
	incrementalUpdates: Array<ArrayBuffer>,
): void {
	for (const incrementalUpdate of incrementalUpdates) {
		applyUpdate(mut_yDoc, new Uint8Array(incrementalUpdate));
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
export function pages_yjs_create_doc_from_array_buffer_update(
	update: ArrayBuffer,
	args?: { additionalIncrementalArrayBufferUpdates?: Array<ArrayBuffer> },
): YDoc {
	const yDoc = new YDoc();
	applyUpdate(yDoc, new Uint8Array(update));

	if (args?.additionalIncrementalArrayBufferUpdates) {
		pages_yjs_apply_incremental_array_buffer_updates(yDoc, args.additionalIncrementalArrayBufferUpdates);
	}

	return yDoc;
}

export function pages_yjs_update_from_tiptap_editor(args: {
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

export function pages_yjs_create_doc_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = new YDoc();
	pages_yjs_update_from_tiptap_editor({
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

	try {
		const node = yXmlFragmentToProseMirrorRootNode(fragment, editor.schema);
		const json = node.toJSON();
		editor.commands.setContent(json);
		const markdown = pages_headless_tiptap_editor_get_markdown({ mut_editor: editor });
		return markdown;
	} finally {
		editor.destroy();
	}
}

export function pages_yjs_doc_update_rich_text_from_markdown(args: { markdown: string; mut_yjsDoc: YDoc }) {
	const editor = pages_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdown },
	});

	try {
		pages_yjs_update_from_tiptap_editor({
			mut_yjsDoc: args.mut_yjsDoc,
			tiptapEditor: editor,
			opKind: "user-edit",
		});

		return args.mut_yjsDoc;
	} finally {
		editor.destroy();
	}
}

export function pages_yjs_doc_create_from_markdown(args: { markdown: string }) {
	const editor = pages_headless_tiptap_editor_create({ initialContent: { markdown: args.markdown } });
	try {
		const yjsDoc = pages_yjs_create_doc_from_tiptap_editor({ tiptapEditor: editor });
		return yjsDoc;
	} finally {
		editor.destroy();
	}
}

// #region tiptap editor
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
			markdown: Markdown.configure({
				// Tiptap expects another version of marked but this should do fine
				marked: pages_marked(),
			}),
			highlight: Highlight.extend({
				renderMarkdown: (node, helpers, ctx) => {
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
				renderMarkdown: (node, helpers, ctx) => {
					const color = node.attrs?.color;

					if (!color) {
						return helpers.renderChildren(node.content || []);
					}

					const content = helpers.renderChildren(node.content || []);
					return `<span style="color: ${color}">${content}</span>`;
				},
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
		};
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
}): Editor {
	const sharedExtensions = pages_get_tiptap_shared_extensions();
	const baseExtensions = Object.values(sharedExtensions);
	const extensions = args?.additionalExtensions ? [...baseExtensions, ...args.additionalExtensions] : baseExtensions;

	const editor = new Editor({
		element: null, // REQUIRED for headless (no DOM mounting)
		content: { type: "doc", content: [] },
		extensions,
		enableInputRules: false,
		enablePasteRules: false,
		coreExtensionOptions: {
			delete: { async: false },
		},
	});

	if (args?.initialContent?.markdown) {
		pages_headless_tiptap_editor_set_content_from_markdown({
			markdown: args.initialContent.markdown,
			mut_editor: editor,
		});
	} else if (args?.initialContent?.json) {
		editor.commands.setContent(args.initialContent.json);
	}

	return editor;
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
	if (!editor.markdown) throw should_never_happen("editor.markdown is not set");
	const json = editor.markdown.parse(args.markdown);
	editor.commands.setContent(json);
	return json;
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
