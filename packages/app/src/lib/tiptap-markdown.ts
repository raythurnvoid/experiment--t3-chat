import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { pages_get_tiptap_shared_extensions } from "../../shared/pages.ts";

/**
 * Converts TipTap JSON content to markdown string.
 *
 * Uses a headless TipTap editor with the shared extensions to serialize
 * the JSON content to markdown format.
 *
 * @param json - TipTap JSON document content
 * @returns Markdown string representation of the content
 */
export function tiptap_json_to_markdown(json: JSONContent): string {
	const extensions = pages_get_tiptap_shared_extensions();
	const editor = new Editor({
		element: null, // Headless editor (no DOM)
		content: json,
		extensions: Object.values(extensions),
		enableInputRules: false,
		enablePasteRules: false,
		coreExtensionOptions: {
			delete: { async: false },
		},
	});

	try {
		if (!editor.markdown) {
			throw new Error("editor.markdown is not set - Markdown extension may not be configured");
		}

		return editor.markdown.serialize(json);
	} finally {
		editor.destroy();
	}
}

/**
 * Converts a TipTap Editor instance's current content to markdown string.
 *
 * @param editor - TipTap Editor instance
 * @returns Markdown string representation of the editor's content
 */
export function tiptap_editor_to_markdown(editor: Editor): string {
	if (!editor.markdown) {
		throw new Error("editor.markdown is not set - Markdown extension may not be configured");
	}

	return editor.markdown.serialize(editor.getJSON());
}

/**
 * Converts plain text to markdown.
 *
 * This is a simple wrapper that treats the input as plain text content.
 * Useful for converting simple text inputs (like comment text) to markdown.
 *
 * @param text - Plain text string
 * @returns Markdown string (in this case, the same text with proper escaping if needed)
 */
export function tiptap_text_to_markdown(text: string): string {
	// For simple text, we create a minimal TipTap document structure
	const json: JSONContent = {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{
						type: "text",
						text: text,
					},
				],
			},
		],
	};

	return tiptap_json_to_markdown(json);
}
