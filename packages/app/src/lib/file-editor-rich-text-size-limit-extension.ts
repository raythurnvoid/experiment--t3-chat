// Client-side half of the content size cap for the rich text editor. The editor only sends Yjs
// deltas, so the server cannot know the content size until materialization. Once the document is
// over the cap this extension rejects any local change that would grow it further.

import { Extension } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { Plugin } from "@tiptap/pm/state";

import { file_editor_should_block_growth } from "@/lib/file-editor.ts";

export type file_editor_rich_text_SizeLimitExtension_Options = {
	/**
	 * Called on every transaction, so the measurement can keep updating without reconfiguring
	 * the editor. Measuring is expensive, which is why the size is sampled elsewhere and only
	 * read from here.
	 */
	getIsOverCap: () => boolean;
};

export const file_editor_rich_text_SizeLimitExtension =
	Extension.create<file_editor_rich_text_SizeLimitExtension_Options>({
		name: "fileEditorRichTextSizeLimit",

		addOptions() {
			return {
				// The real getter is set in FileEditorRichTextInner via file_editor_rich_text_SizeLimitExtension.configure()
				getIsOverCap: () => false,
			};
		},

		addProseMirrorPlugins() {
			const { getIsOverCap } = this.options;

			return [
				new Plugin({
					// Catches everything that is not a paste or a drop: typing, AI insertions, slash
					// commands, image inserts. Inert while the document is under the cap.
					filterTransaction: (transaction, state) =>
						!file_editor_should_block_growth({
							isOverCap: getIsOverCap(),
							isRemoteChange: isChangeOrigin(transaction),
							docSizeBefore: state.doc.content.size,
							docSizeAfter: transaction.doc.content.size,
						}),
				}),
			];
		},
	});
