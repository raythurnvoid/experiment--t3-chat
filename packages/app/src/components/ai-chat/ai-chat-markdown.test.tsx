import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { AiChatMarkdown } from "./ai-chat-markdown.tsx";

describe("AiChatMarkdown", () => {
	afterEach(() => {
		cleanup();
	});

	test("renders code blocks with app-owned classes", () => {
		const { container } = render(<AiChatMarkdown markdown={"```bash\nls -r\n```"} />);

		const block = container.querySelector(".AiChatMarkdown-code-block");
		const language = container.querySelector(".AiChatMarkdown-code-header-language");
		const code = container.querySelector(".AiChatMarkdown-code");
		const copyButton = container.querySelector("button.AiChatMarkdown-code-copy-button");

		expect(block).not.toBeNull();
		expect(language?.textContent).toBe("bash");
		expect(code?.textContent).toBe("ls -r");
		expect(copyButton?.getAttribute("aria-label")).toBe("Copy code");
		expect(container.querySelector("[data-streamdown='code-block']")).toBeNull();
	});

	test("renders inline code with app-owned classes", () => {
		const { container } = render(<AiChatMarkdown markdown={"Use `search` for indexed content lookup."} />);

		const inlineCode = container.querySelector(".AiChatMarkdown-inline-code");

		expect(inlineCode?.textContent).toBe("search");
		expect(container.querySelector("[data-streamdown='inline-code']")).toBeNull();
	});

	test("passes content classes to the Streamdown wrapper", () => {
		const { container } = render(<AiChatMarkdown markdown={"Line 1\nLine 2"} contentClassName="TestMarkdownContent" />);

		const content = container.querySelector(".AiChatMarkdown-content.TestMarkdownContent");

		expect(content?.textContent).toBe("Line 1\nLine 2");
	});
});
