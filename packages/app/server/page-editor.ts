/**
 * Server-side Tiptap editor utilities for headless Markdown ↔ JSON conversion.
 *
 * This module runs in Node.js (Convex runtime) and must NOT import from:
 * - src/ (client code)
 * - vendor/ UI libraries (novel, liveblocks, React)
 *
 * Only imports from @tiptap/* core packages that work server-side.
 */

import { Editor, getSchema } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import { pages_get_tiptap_shared_extensions } from "../shared/pages.ts";

/**
 * Default field name for Liveblocks Yjs documents.
 * Matches the client-side Liveblocks extension configuration.
 */
export const server_page_editor_DEFAULT_FIELD = "default";

/**
 * Get the ProseMirror schema for the server-side editor.
 * This schema is used with Liveblocks `withProsemirrorDocument` to ensure
 * the document structure matches the client-side editor.
 *
 * @returns ProseMirror Schema instance
 */
export function server_page_editor_get_schema() {
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
function server_page_editor_create(): Editor {
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
 * Convert Markdown string to Tiptap JSON document.
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
export function server_page_editor_markdown_to_json(markdown: string): JSONContent {
	const editor = server_page_editor_create();

	try {
		if (!editor.markdown) return Result({ _nay: { message: "editor.markdown is not set" } });

		const json = editor.markdown.parse(markdown);
		editor.commands.setContent(json);
		return Result({ _yay: json });
	} finally {
		// Always destroy editor to free memory
		editor.destroy();
	}
}

/**
 * Convert Tiptap JSON document to Markdown string.
 *
 * Inverse of markdown_to_json, useful for serializing editor state.
 *
 * @param json - Tiptap JSON document
 * @returns A Result containing the Markdown string or an error
 */
export function server_page_editor_json_to_markdown(
	json: JSONContent,
): Result<{ _yay: string } | { _nay: { message: string } }> {
	const editor = server_page_editor_create();

	try {
		if (!editor.markdown) return Result({ _nay: { message: "editor.markdown is not set" } });

		editor.commands.setContent(json);
		const markdown = editor.markdown.serialize(json);
		return Result({ _yay: markdown });
	} finally {
		editor.destroy();
	}
}
