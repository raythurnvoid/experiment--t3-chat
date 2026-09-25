import "@/app.css";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { MyHoverCard, MyHoverCardContent, MyHovercardAction } from "./my-hovercard.tsx";

afterEach(() => cleanup());

describe("MyHoverCardContent", () => {
	test("Escape closes the card and moves focus back to the disclosure button", async () => {
		render(
			<>
				<button type="button">Before</button>
				<MyHoverCard>
					<MyHovercardAction aria-label="Show details">Details</MyHovercardAction>
					<MyHoverCardContent aria-label="Details card">
						<button type="button">Disable</button>
					</MyHoverCardContent>
				</MyHoverCard>
			</>,
		);

		// The anchor is not focusable, so Tab from Before lands on the sr-only disclosure.
		await userEvent.click(screen.getByRole("button", { name: "Before" }));
		await userEvent.keyboard("{Tab}");
		const disclosure = screen.getByRole("button", { name: "Show details" });
		expect(document.activeElement).toBe(disclosure);

		await userEvent.keyboard("{Enter}");
		const card = await screen.findByRole("dialog", { name: "Details card" });
		await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Details card" })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(disclosure));
	});
});
