import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MyChip, MyChipLabel, MyChipRemove, MyChipRow } from "./my-chip.tsx";

type ChipsHarness_Props = {
	names: string[];
	onFocusExit: () => void;
};

/**
 * Minimal stateful consumer: a row of removable chips, like the composer
 * attachments bar. Removal goes through each chip's remove button click.
 */
function ChipsHarness(props: ChipsHarness_Props) {
	const [names, setNames] = useState(props.names);

	return (
		<MyChipRow aria-label="Test chips" onFocusExit={props.onFocusExit}>
			{names.map((name) => (
				<li key={name}>
					<MyChip>
						<MyChipLabel>{name}</MyChipLabel>
						<MyChipRemove
							tooltip={`Remove ${name}`}
							onClick={() => setNames((current) => current.filter((item) => item !== name))}
						/>
					</MyChip>
				</li>
			))}
		</MyChipRow>
	);
}

async function findRemoveButtons() {
	return await screen.findAllByRole("button", { name: /^Remove / });
}

describe("MyChipRow", () => {
	afterEach(() => {
		cleanup();
	});

	test("keeps one tab stop with a roving tabindex", async () => {
		render(<ChipsHarness names={["one.png", "two.png", "three.png"]} onFocusExit={vi.fn()} />);

		const buttons = await findRemoveButtons();
		await waitFor(() => {
			expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);
		});
	});

	test("moves focus between chips with ArrowRight and ArrowLeft", async () => {
		render(<ChipsHarness names={["one.png", "two.png", "three.png"]} onFocusExit={vi.fn()} />);

		const buttons = await findRemoveButtons();
		buttons[0].focus();

		fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
		await waitFor(() => {
			expect(document.activeElement).toBe(buttons[1]);
		});

		fireEvent.keyDown(buttons[1], { key: "ArrowLeft" });
		await waitFor(() => {
			expect(document.activeElement).toBe(buttons[0]);
		});
	});

	test("Delete removes the focused chip and moves focus to the next chip", async () => {
		render(<ChipsHarness names={["one.png", "two.png", "three.png"]} onFocusExit={vi.fn()} />);

		const buttons = await findRemoveButtons();
		buttons[1].focus();
		fireEvent.keyDown(buttons[1], { key: "Delete" });

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Remove two.png" })).toBeNull();
		});
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove three.png" }));
	});

	test("Backspace on the last chip removes it and moves focus to the previous chip", async () => {
		render(<ChipsHarness names={["one.png", "two.png", "three.png"]} onFocusExit={vi.fn()} />);

		const buttons = await findRemoveButtons();
		buttons[2].focus();
		fireEvent.keyDown(buttons[2], { key: "Backspace" });

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Remove three.png" })).toBeNull();
		});
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove two.png" }));
	});

	test("Enter removes the focused chip through the same focus flow", async () => {
		render(<ChipsHarness names={["one.png", "two.png"]} onFocusExit={vi.fn()} />);

		const buttons = await findRemoveButtons();
		buttons[0].focus();
		fireEvent.keyDown(buttons[0], { key: "Enter" });

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Remove one.png" })).toBeNull();
		});
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove two.png" }));
	});

	test("Space removes the focused chip through the same focus flow", async () => {
		render(<ChipsHarness names={["one.png", "two.png"]} onFocusExit={vi.fn()} />);

		const buttons = await findRemoveButtons();
		buttons[0].focus();
		fireEvent.keyDown(buttons[0], { key: " " });

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Remove one.png" })).toBeNull();
		});
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove two.png" }));
	});

	test("a pointer removal keeps one tab stop in the row", async () => {
		render(<ChipsHarness names={["one.png", "two.png", "three.png"]} onFocusExit={vi.fn()} />);

		const buttons = await findRemoveButtons();
		// A real mouse click focuses the button on mousedown before the click
		// removes the chip, so activeId points at the unmounted item afterwards.
		buttons[0].focus();
		fireEvent.click(buttons[0]);

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Remove one.png" })).toBeNull();
		});
		await waitFor(() => {
			const remaining = screen.getAllByRole("button", { name: /^Remove / });
			expect(remaining.map((button) => button.tabIndex)).toEqual([0, -1]);
		});
	});

	test("removing the only chip calls onFocusExit", async () => {
		const onFocusExit = vi.fn();
		render(<ChipsHarness names={["only.png"]} onFocusExit={onFocusExit} />);

		const buttons = await findRemoveButtons();
		buttons[0].focus();
		fireEvent.keyDown(buttons[0], { key: "Delete" });

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Remove only.png" })).toBeNull();
		});
		expect(onFocusExit).toHaveBeenCalledOnce();
	});
});
