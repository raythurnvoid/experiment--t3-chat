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
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import type { JSONContent } from "@tiptap/core";
import { Result } from "../src/lib/errors-as-values-utils.ts";

/**
 * Server-safe Tiptap extensions (no DOM, no React, no Liveblocks).
 *
 * Mirrors the client-side editor's content model but excludes:
 * - CodeBlockLowlight (requires lowlight DOM)
 * - YouTube, Twitter (DOM embeds)
 * - Mathematics (KaTeX DOM)
 * - Liveblocks collaboration
 * - Novel UI components
 */
const server_page_editor_EXTENSIONS = [
	StarterKit.configure({
		// Disable features we don't need server-side
		undoRedo: false, // No undo/redo needed for parsing
		codeBlock: false, // Use plain code block (no syntax highlighting)
		dropcursor: false, // DOM-only
		gapcursor: false, // DOM-only
	}),
	TaskList,
	TaskItem.configure({
		nested: true,
	}),
	TextAlign.configure({
		types: ["heading", "paragraph"],
	}),
	Typography,
	Markdown.configure({
		// Match client-side indentation
		indentation: { style: "space", size: 2 },
	}),
];

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
	return getSchema(server_page_editor_EXTENSIONS);
}

/**
 * Create a headless Tiptap editor instance.
 *
 * **Critical:** Pass `element: null` to run server-side without DOM.
 *
 * @returns Editor instance (call `.destroy()` when done to prevent memory leaks)
 */
function server_page_editor_create(): Editor {
	return new Editor({
		element: null, // REQUIRED for server-side (no DOM mounting)
		content: { type: "doc", content: [] },
		extensions: server_page_editor_EXTENSIONS,

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
