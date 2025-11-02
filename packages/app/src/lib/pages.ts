import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { pages_get_tiptap_shared_extensions } from "../../shared/pages.ts";

export * from "../../shared/pages.ts";

export const pages_INITIAL_CONTENT = `\
# Welcome

You can start editing your document here.
`;

export const pages_get_rich_text_initial_content = ((/* iife */) => {
	function value(): JSONContent {
		const extensions = pages_get_tiptap_shared_extensions();
		const editor = new Editor({
			element: null, // Headless editor (no DOM)
			content: { type: "doc", content: [] },
			extensions: Object.values(extensions),
			enableInputRules: false,
			enablePasteRules: false,
			coreExtensionOptions: {
				delete: { async: false },
			},
		});

		try {
			if (!editor.markdown) {
				throw new Error("editor.markdown is not set");
			}

			const json = editor.markdown.parse(pages_INITIAL_CONTENT);
			return json;
		} finally {
			editor.destroy();
		}
	}

	let cache: ReturnType<typeof value> | undefined;

	return function pages_get_initial_content(): JSONContent {
		return (cache ??= value());
	};
})();
