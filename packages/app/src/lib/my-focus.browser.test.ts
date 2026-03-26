import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "@vitest/browser/context";

import { MyFocus, my_focus_ACTIVE_ROW_CHANGE_EVENT_NAME, type MyFocus_ActiveRowChangeDetail } from "./my-focus.ts";

type FocusFixtureRow = {
	label: string;
	ariaCurrent?: boolean;
	ariaDisabled?: boolean;
	ariaSelected?: boolean;
	dataSelected?: boolean;
	hidden?: boolean;
	tabIndex?: number;
};

describe("MyFocus", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("Should initialize roving tabIndex from the selected row", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Workspace B", ariaCurrent: true },
			{ label: "Workspace C" },
		]);
		const activeRowChanges = listen_for_active_row_changes(fixture.containerEl);

		fixture.focus.start();

		try {
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(-1);

			expect(activeRowChanges).toHaveLength(1);
			expect(activeRowChanges[0]).toMatchObject({
				container: fixture.containerEl,
				row: fixture.getRow("Workspace B"),
				reason: "start",
			} satisfies Partial<MyFocus_ActiveRowChangeDetail>);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should prefer the currently focused row over a selected row on start", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Workspace B", ariaCurrent: true },
			{ label: "Workspace C" },
		]);
		const currentRow = fixture.getRow("Workspace C");
		currentRow.focus();

		fixture.focus.start();

		try {
			expect(document.activeElement).toBe(currentRow);
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(-1);
			expect(currentRow.tabIndex).toBe(0);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should move focus with arrow keys, wrap, and skip aria-disabled rows", async () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A", ariaCurrent: true },
			{ label: "Workspace B", ariaDisabled: true },
			{ label: "Workspace C" },
		]);

		fixture.focus.start();

		try {
			await page.getByRole("button", { name: "Workspace A" }).click();
			expect(document.activeElement).toBe(fixture.getRow("Workspace A"));

			await userEvent.keyboard("{ArrowDown}");
			expect(document.activeElement).toBe(fixture.getRow("Workspace C"));
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(0);

			await userEvent.keyboard("{ArrowDown}");
			expect(document.activeElement).toBe(fixture.getRow("Workspace A"));
			expect(fixture.getRow("Workspace A").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(-1);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should update the active row and emit a focus event when focus enters another row", async () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A", ariaCurrent: true },
			{ label: "Workspace B" },
			{ label: "Workspace C" },
		]);
		const activeRowChanges = listen_for_active_row_changes(fixture.containerEl);

		fixture.focus.start();

		try {
			await page.getByRole("button", { name: "Workspace C" }).click();

			expect(document.activeElement).toBe(fixture.getRow("Workspace C"));
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(0);

			expect(activeRowChanges).toHaveLength(2);
			expect(activeRowChanges[1]).toMatchObject({
				container: fixture.containerEl,
				row: fixture.getRow("Workspace C"),
				previousRow: fixture.getRow("Workspace A"),
				reason: "focus",
			} satisfies Partial<MyFocus_ActiveRowChangeDetail>);
		} finally {
			fixture.focus.stop();
		}
	});
});

function setup_focus_fixture(rows: FocusFixtureRow[]) {
	document.body.innerHTML = `
		<div data-testid="root">
			<ul class="MyFocus-container">
				${rows
					.map((row) => {
						return `
							<li>
								<button
									type="button"
									class="MyFocus-row"
									${row.ariaCurrent ? `aria-current="true"` : ""}
									${row.ariaDisabled ? `aria-disabled="true"` : ""}
									${row.ariaSelected ? `aria-selected="true"` : ""}
									${row.dataSelected ? `data-selected="true"` : ""}
									${row.hidden ? `style="display: none"` : ""}
									tabindex="${row.tabIndex ?? -1}"
								>
									${row.label}
								</button>
							</li>
						`;
					})
					.join("")}
			</ul>
		</div>
	`;

	const rootEl = document.querySelector<HTMLElement>('[data-testid="root"]');
	if (!rootEl) {
		throw new Error("Expected a MyFocus test root");
	}

	const containerEl = rootEl.querySelector<HTMLElement>(".MyFocus-container");
	if (!containerEl) {
		throw new Error("Expected a MyFocus container");
	}

	const rowEls = Array.from(containerEl.querySelectorAll<HTMLButtonElement>(".MyFocus-row"));

	return {
		rootEl,
		containerEl,
		focus: new MyFocus(rootEl),
		getRow(label: string) {
			const row = rowEls.find((candidate) => candidate.textContent?.trim() === label);
			if (!row) {
				throw new Error(`Expected a MyFocus row for "${label}"`);
			}

			return row;
		},
	};
}

function listen_for_active_row_changes(containerEl: HTMLElement) {
	const activeRowChanges: MyFocus_ActiveRowChangeDetail[] = [];

	containerEl.addEventListener(my_focus_ACTIVE_ROW_CHANGE_EVENT_NAME, (event) => {
		const customEvent = event as CustomEvent<MyFocus_ActiveRowChangeDetail>;
		activeRowChanges.push(customEvent.detail);
	});

	return activeRowChanges;
}
