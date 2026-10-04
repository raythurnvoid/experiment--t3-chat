import { describe, expect, test, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { files_CommentsExtension, files_THREADS_PLUGIN_KEY } from "../../shared/files-tiptap-comments.ts";

describe("setCommentThreads", () => {
	test("filters resolved marks without a content write and can show them again", () => {
		const editor = new Editor({
			element: document.createElement("div"),
			injectCSS: false,
			extensions: [Document, Paragraph, Text, files_CommentsExtension],
			content: {
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "Open", marks: [{ type: "liveblocksCommentMark", attrs: { threadId: "open" } }] },
							{
								type: "text",
								text: "Resolved",
								marks: [{ type: "liveblocksCommentMark", attrs: { threadId: "resolved" } }],
							},
						],
					},
				],
			},
		});
		const original = editor.getJSON();
		const update = vi.fn();
		editor.on("update", update);
		editor.commands.setCommentThreads(["open"]);
		expect(editor.getJSON(), "thread filtering must not change the stored document").toEqual(original);
		expect(update, "thread filtering must not send a content update").not.toHaveBeenCalled();
		expect(editor.getHTML(), "a resolved mark must be hidden").toContain(
			'data-lb-thread-id="resolved" class="lb-root lb-tiptap-thread-mark" data-type="comment" data-hidden=""',
		);
		editor.commands.selectThread("resolved");
		expect(files_THREADS_PLUGIN_KEY.getState(editor.state)?.selectedThreadId).toBeNull();
		editor.commands.setCommentThreads(["open", "resolved"]);
		expect(editor.getHTML()).not.toContain("data-hidden");
		expect(editor.getJSON()).toEqual(original);
		expect(update).not.toHaveBeenCalled();
		editor.destroy();
	});
});
