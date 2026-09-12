import "./app.css";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { MyButton } from "./components/my-button.tsx";

describe("App focus styles", () => {
	afterEach(() => cleanup());

	test.each(["light", "dark"])("rounds native focus rings and keeps component corners in %s mode", async (theme) => {
		const { container } = render(
			<div className={theme}>
				<a href="https://example.com">Link</a>
				<button type="button">Link button</button>
				<input type="text" aria-label="Name" />
				<MyButton>App button</MyButton>
			</div>,
		);

		for (const control of container.querySelectorAll<HTMLElement>("a, button, input")) {
			await userEvent.keyboard("{Tab}");
			expect(document.activeElement).toBe(control);
			expect(control.matches(":focus-visible")).toBe(true);
			const style = getComputedStyle(control);
			expect.soft(style.borderRadius, control.outerHTML).toBe(control.classList.contains("MyButton") ? "6px" : "4px");
			expect(style.outlineStyle).toBe("solid");
			expect(style.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
		}
	});
});
