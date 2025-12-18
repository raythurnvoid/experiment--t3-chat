/**
 * Server-side pages functions.
 *
 * This module runs in the Convex runtime and must NOT import from:
 * - src/ (client code)
 * - vendor/ UI libraries (novel, liveblocks, React)
 *
 * Only imports from packages that work server-side.
 */
import { Editor, getSchema } from "@tiptap/core";
import { pages_get_tiptap_shared_extensions } from "../shared/pages.ts";
import { should_never_happen } from "../shared/shared-utils.ts";

export * from "../shared/pages.ts";

/**
 * Default field name for Liveblocks Yjs documents.
 * Matches the client-side Liveblocks extension configuration.
 */
export const page_editor_DEFAULT_FIELD = "default";

/**
 * Get the ProseMirror schema for the server-side editor.
 * This schema is used with Liveblocks `withProsemirrorDocument` to ensure
 * the document structure matches the client-side editor.
 *
 * @returns ProseMirror Schema instance
 */
export function pages_headless_editor_get_schema() {
	const extensions = pages_get_tiptap_shared_extensions();
	return getSchema(Object.values(extensions));
}

/**
 * Create a headless Tiptap editor instance.
 *
 * **Critical:** Pass `element: null` to run server-side without DOM.
 *
 * @returns Editor instance (call `.destroy()` when done to prevent memory leaks)
 */
export function pages_headless_editor_create(): Editor {
	const extensions = pages_get_tiptap_shared_extensions();
	return new Editor({
		element: null, // REQUIRED for server-side (no DOM mounting)
		content: { type: "doc", content: [] },
		extensions: Object.values(extensions),

		// Avoid calls to `setTimeout`
		enableInputRules: false,
		enablePasteRules: false,
		coreExtensionOptions: {
			delete: { async: false },
		},
	});
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
export function pages_headless_editor_set_content_from_markdown(args: { markdown: string; mut_editor: Editor }) {
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
export function pages_headless_editor_get_markdown(args: { mut_editor: Editor }) {
	const editor = args.mut_editor;
	if (!editor.markdown) throw should_never_happen("editor.markdown is not set");
	const markdown = editor.markdown.serialize(editor.getJSON());
	return markdown;
}
