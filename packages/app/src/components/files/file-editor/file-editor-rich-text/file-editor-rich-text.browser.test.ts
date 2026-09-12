import "@/app.css";
import "@/components/my-button.css";
import "./file-editor-rich-text.css";
import { Editor } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { defaultExtensions, nonCollaborativeExtensions } from "./extensions.ts";

describe("Files rich text styles", () => {
	test.each([
		["FileEditorRichText", defaultExtensions],
		["FileEditorRichTextNonCollab", nonCollaborativeExtensions],
	])("keeps task rows aligned and selected code labels visible in %s", async (className, extensions) => {
		const container = document.createElement("div");
		container.className = `${className} ${className}-visible ${className}-editor-content-container`;
		container.style.width = "320px";
		document.body.append(container);
		const editor = new Editor({
			element: container,
			injectCSS: false,
			extensions,
			editorProps: { attributes: { class: `${className}-editor-content app-doc` } },
			content: {
				type: "doc",
				content: [
					{
						type: "codeBlock",
						attrs: { language: "js" },
						content: [{ type: "text", text: "const value = 1;" }],
					},
					{
						type: "taskList",
						content: [
							{
								type: "taskItem",
								attrs: { checked: false },
								content: [{ type: "paragraph", content: [{ type: "text", text: "Not started" }] }],
							},
						],
					},
				],
			},
		});
		const comparisonButton = document.createElement("button");
		comparisonButton.className = "MyButton";
		comparisonButton.textContent = "App button";
		container.append(comparisonButton);
		try {
			// Check mounted node views: their li attributes differ from getHTML() output.
			const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
			const paragraph = container.querySelector("li p")!;
			const checkboxBounds = checkbox.getBoundingClientRect();
			const paragraphBounds = paragraph.getBoundingClientRect();
			expect(paragraphBounds.left).toBeGreaterThan(checkboxBounds.right);
			expect(checkboxBounds.top).toBeGreaterThanOrEqual(paragraphBounds.top);
			expect(checkboxBounds.bottom).toBeLessThanOrEqual(paragraphBounds.bottom);
			expect(checkbox.parentElement!.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);

			await userEvent.keyboard("{Tab}");
			checkbox.focus();
			expect(checkbox.matches(":focus-visible")).toBe(true);
			const focusStyle = getComputedStyle(checkbox.parentElement!);
			expect(focusStyle.borderRadius).toBe("4px");
			expect(focusStyle.outlineStyle).toBe("solid");
			expect(focusStyle.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
			expect(getComputedStyle(checkbox).outlineStyle).toBe("none");
			const checkboxOutlineColor = focusStyle.outlineColor;
			comparisonButton.focus();
			expect(checkboxOutlineColor).toBe(getComputedStyle(comparisonButton).outlineColor);

			const codeBlock = container.querySelector("pre")!;
			const height = codeBlock.getBoundingClientRect().height;
			expect(getComputedStyle(codeBlock, "::before").content).toBe('"js"');
			editor.commands.setNodeSelection(0);
			editor.view.focus();
			expect(codeBlock.classList.contains("ProseMirror-selectednode")).toBe(true);
			expect(getComputedStyle(codeBlock, "::before").content).toBe('"js"');
			expect(codeBlock.getBoundingClientRect().height).toBe(height);
		} finally {
			editor.destroy();
			container.remove();
		}
	});
});
