import "@/app.css";
import "../files/file-editor/file-editor-rich-text/file-editor-rich-text.css";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AiChatMarkdown } from "./ai-chat-markdown.tsx";

describe("AiChatMarkdown styles", () => {
	afterEach(() => cleanup());

	test.each(["light", "dark"])("matches the rich text editor's typography in %s mode", (theme) => {
		const { container } = render(
			<div className={theme}>
				<AiChatMarkdown
					markdown={
						"Intro paragraph.\n\n# Heading 1\n## Heading 2\n### Heading 3\n#### Heading 4\n##### Heading 5\n###### Heading 6\n\n**Bold** and `code`.\n\n> Quoted text.\n\n[OpenAI](https://openai.com)"
					}
				/>
				<div className="FileEditorRichText-editor-content app-doc">
					<p>Intro paragraph.</p>
					<h1>Heading 1</h1>
					<h2>Heading 2</h2>
					<h3>Heading 3</h3>
					<h4>Heading 4</h4>
					<h5>Heading 5</h5>
					<h6>Heading 6</h6>
					<p>
						<strong>Bold</strong> and <code>code</code>.
					</p>
					<blockquote>
						<p>Quoted text.</p>
					</blockquote>
					<a href="https://openai.com">OpenAI</a>
				</div>
			</div>,
		);
		const chat = container.querySelector(".AiChatMarkdown")!;
		const editor = container.querySelector(".FileEditorRichText-editor-content")!;

		// Compare the two real style owners so a library utility cannot silently win.
		for (const selector of ["h1", "h2", "h3", "h4", "h5", "h6", "strong", "code", "blockquote"]) {
			const chatStyle = getComputedStyle(chat.querySelector(selector)!);
			const editorStyle = getComputedStyle(editor.querySelector(selector)!);
			for (const property of [
				"font-size",
				"line-height",
				"font-weight",
				"font-style",
				"color",
				"background-color",
				"border-bottom",
				"margin-top",
				"margin-bottom",
			]) {
				expect(chatStyle.getPropertyValue(property), `${selector} ${property}`).toBe(
					editorStyle.getPropertyValue(property),
				);
			}
		}
		expect(getComputedStyle(chat.querySelector("p")!).lineHeight).toBe(
			getComputedStyle(editor.querySelector("p")!).lineHeight,
		);
		expect(getComputedStyle(chat.querySelector('[data-streamdown="link"]')!).color).toBe(
			getComputedStyle(editor.querySelector("a")!).color,
		);
	});

	test.each(["-", "1."])("keeps ordinary items indented in a mixed %s task list", (marker) => {
		const { container } = render(
			<AiChatMarkdown
				markdown={`${marker} Plain item\n${marker} [ ] Task item\n   - Nested plain item\n${marker} Another plain item`}
			/>,
		);
		const list = container.querySelector<HTMLElement>(".contains-task-list")!;
		const ordinaryItems = list.querySelectorAll<HTMLElement>(":scope > li:not(.task-list-item)");

		expect(ordinaryItems).toHaveLength(2);
		for (const item of ordinaryItems) {
			expect(item.getBoundingClientRect().left - list.getBoundingClientRect().left).toBe(28);
		}
		const nestedItem = list.querySelector<HTMLElement>(".task-list-item li")!;
		const task = list.querySelector<HTMLElement>(".task-list-item")!;
		expect(nestedItem.getBoundingClientRect().left).toBeGreaterThan(task.getBoundingClientRect().left);
	});

	test.each([320, 744])("keeps wrapped tasks and wide tables inside a %spx chat", (width) => {
		const { container } = render(
			<div style={{ width }}>
				<AiChatMarkdown
					markdown={[
						"- [ ] A wrapped task with enough words to fill several lines in a narrow chat panel. " +
							"Keep every line aligned with the task text, without a second bullet or a checkbox overlap.",
						"  A second paragraph in the same task.",
						"- [x] Done",
						"| VeryLongFirstColumnHeading | VeryLongSecondColumnHeading | VeryLongThirdColumnHeading |\n| :--- | :---: | ---: |\n| left | center | right |",
						"```js\nconst value = 1;\n```",
					].join("\n\n")}
				/>
			</div>,
		);
		const chat = container.querySelector<HTMLElement>(".AiChatMarkdown")!;
		const task = chat.querySelector<HTMLElement>(".task-list-item")!;
		const checkbox = task.querySelector<HTMLInputElement>("input")!;
		const paragraph = task.querySelector("p")!;
		const text = Array.from(paragraph.childNodes).find(
			(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("A wrapped task"),
		)!;
		const range = document.createRange();
		range.selectNodeContents(text);
		range.setStart(text, text.textContent!.indexOf("A wrapped task"));
		const lines = range.getClientRects();

		expect(lines.length).toBeGreaterThan(1);
		expect(Math.abs(lines[0]!.left - lines[1]!.left)).toBeLessThan(1);
		expect(checkbox.getBoundingClientRect().right).toBeLessThan(lines[0]!.left);
		expect(getComputedStyle(task).listStyleType).toBe("none");
		expect(checkbox.disabled).toBe(true);
		expect(checkbox.getAttribute("aria-label")).toBe("Task completion");
		expect(chat.scrollWidth).toBeLessThanOrEqual(chat.clientWidth);

		const tableWrapper = chat.querySelector<HTMLElement>(".AiChatMarkdown-table-wrapper")!;
		expect(getComputedStyle(tableWrapper).overflowX).toBe("auto");
		expect(tableWrapper.getBoundingClientRect().width).toBeLessThanOrEqual(width);
		if (width === 320) {
			expect(tableWrapper.scrollWidth).toBeGreaterThan(tableWrapper.clientWidth);
		}
		const cells = chat.querySelectorAll("td");
		expect(getComputedStyle(cells[0]!).textAlign).toBe("left");
		expect(getComputedStyle(cells[1]!).textAlign).toBe("center");
		expect(getComputedStyle(cells[2]!).textAlign).toBe("right");
		expect(chat.querySelector(".AiChatMarkdown-code")!.textContent).toBe("const value = 1;");
		expect(chat.querySelector(".AiChatMarkdown-code-copy-button")!.getAttribute("aria-label")).toBe("Copy code");
	});
});
