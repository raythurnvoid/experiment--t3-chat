import { afterEach, describe, expect, test } from "vitest";
import { page, userEvent } from "@vitest/browser/context";

import {
	MyFocus,
	my_focus_ACTIVE_ROW_CHANGE_EVENT_NAME,
	my_focus_ROW_ACTIVE_CLASS,
	type MyFocus_ActiveRowChangeDetail,
} from "./my-focus.ts";

type FocusFixtureRow = {
	label: string;
	ariaCurrent?: boolean;
	ariaDisabled?: boolean;
	ariaSelected?: boolean;
	dataSelected?: boolean;
	explicitActive?: boolean;
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

	test("Should initialize roving tabIndex from aria-selected=\"true\" without aria-current", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Workspace B", ariaSelected: true },
			{ label: "Workspace C" },
		]);

		fixture.focus.start();

		try {
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should initialize roving tabIndex from data-selected=\"true\" without aria-current", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Workspace B", dataSelected: true },
			{ label: "Workspace C" },
		]);

		fixture.focus.start();

		try {
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should seed roving from semantic selection without requiring a static MyFocus-row-active marker", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Draft workspace", ariaCurrent: true, dataSelected: true },
			{ label: "Workspace C" },
		]);

		const rowsBeforeStart = Array.from(fixture.containerEl.querySelectorAll<HTMLButtonElement>(".MyFocus-row"));
		expect(rowsBeforeStart.filter((row) => row.classList.contains(my_focus_ROW_ACTIVE_CLASS))).toHaveLength(0);

		fixture.focus.start();

		try {
			const rowsAfterStart = Array.from(fixture.containerEl.querySelectorAll<HTMLButtonElement>(".MyFocus-row"));
			const focusableRows = rowsAfterStart.filter((row) => row.tabIndex === 0);
			const activeRows = rowsAfterStart.filter((row) => row.classList.contains(my_focus_ROW_ACTIVE_CLASS));

			expect(focusableRows).toHaveLength(1);
			expect(activeRows).toHaveLength(1);
			expect(focusableRows[0]).toBe(fixture.getRow("Draft workspace"));
			expect(activeRows[0]).toBe(fixture.getRow("Draft workspace"));
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should prefer MyFocus-row-active over aria-current when nothing in the list is focused", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Workspace B", ariaCurrent: true },
			{ label: "Workspace C", explicitActive: true },
		]);

		fixture.focus.start();

		try {
			expect(fixture.getRow("Workspace B").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace C").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(fixture.getRow("Workspace B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should prefer the currently focused row over MyFocus-row-active on start", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Workspace B", explicitActive: true },
			{ label: "Workspace C" },
		]);
		const currentRow = fixture.getRow("Workspace C");
		currentRow.focus();

		fixture.focus.start();

		try {
			expect(document.activeElement).toBe(currentRow);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(-1);
			expect(currentRow.tabIndex).toBe(0);
			expect(currentRow.classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(fixture.getRow("Workspace B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should ignore non-focusable rows marked active and fall back to semantic selection", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A", ariaCurrent: true },
			{ label: "Workspace B", explicitActive: true, hidden: true },
		]);

		fixture.focus.start();

		try {
			expect(fixture.getRow("Workspace A").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(-1);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should treat the first focusable explicit marker as the active row when duplicates exist", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A", explicitActive: true },
			{ label: "Workspace B", explicitActive: true },
		]);

		fixture.focus.start();

		try {
			expect(fixture.getRow("Workspace A").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(fixture.getRow("Workspace B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
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

	test("Should keep one focusable active row after sync() runs post-start", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Draft workspace", ariaCurrent: true, dataSelected: true },
			{ label: "Workspace C" },
		]);

		fixture.focus.start();
		fixture.focus.sync();

		try {
			const rows = Array.from(fixture.containerEl.querySelectorAll<HTMLButtonElement>(".MyFocus-row"));
			const focusableRows = rows.filter((row) => row.tabIndex === 0);
			const activeRows = rows.filter((row) => row.classList.contains(my_focus_ROW_ACTIVE_CLASS));

			expect(focusableRows).toHaveLength(1);
			expect(activeRows).toHaveLength(1);
			expect(focusableRows[0]).toBe(fixture.getRow("Draft workspace"));
			expect(activeRows[0]).toBe(fixture.getRow("Draft workspace"));
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should keep the focused row active when sync() runs with focus already inside the list", async () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A", ariaCurrent: true },
			{ label: "Workspace B" },
			{ label: "Workspace C" },
		]);

		fixture.focus.start();

		try {
			await page.getByRole("button", { name: "Workspace C" }).click();
			expect(document.activeElement).toBe(fixture.getRow("Workspace C"));

			fixture.focus.sync();

			expect(document.activeElement).toBe(fixture.getRow("Workspace C"));
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace C").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should not emit a duplicate start event when sync() re-selects the same row", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A" },
			{ label: "Draft workspace", ariaCurrent: true, dataSelected: true },
			{ label: "Workspace C" },
		]);
		const activeRowChanges = listen_for_active_row_changes(fixture.containerEl);

		fixture.focus.start();
		fixture.focus.sync();

		try {
			expect(activeRowChanges).toHaveLength(1);
			expect(activeRowChanges[0]).toMatchObject({
				container: fixture.containerEl,
				row: fixture.getRow("Draft workspace"),
				reason: "start",
			} satisfies Partial<MyFocus_ActiveRowChangeDetail>);
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
			expect(fixture.getRow("Workspace A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
			expect(fixture.getRow("Workspace B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
			expect(fixture.getRow("Workspace C").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);

			await userEvent.keyboard("{ArrowDown}");
			expect(document.activeElement).toBe(fixture.getRow("Workspace A"));
			expect(fixture.getRow("Workspace A").tabIndex).toBe(0);
			expect(fixture.getRow("Workspace C").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(fixture.getRow("Workspace C").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
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

	test("Should leave an empty container inert and emit no start event", () => {
		const fixture = setup_focus_fixture([]);
		const activeRowChanges = listen_for_active_row_changes(fixture.containerEl);

		fixture.focus.start();

		try {
			expect(fixture.containerEl.querySelectorAll(".MyFocus-row")).toHaveLength(0);
			expect(activeRowChanges).toHaveLength(0);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should leave the container inert when every row is non-focusable", () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A", ariaCurrent: true },
			{ label: "Workspace B", ariaDisabled: true },
		]);
		const activeRowChanges = listen_for_active_row_changes(fixture.containerEl);

		fixture.getRow("Workspace A").setAttribute("disabled", "");

		fixture.focus.start();

		try {
			expect(fixture.getRow("Workspace A").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace B").tabIndex).toBe(-1);
			expect(fixture.getRow("Workspace A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
			expect(fixture.getRow("Workspace B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
			expect(activeRowChanges).toHaveLength(0);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should initialize sibling containers independently under one root", () => {
		const fixture = setup_focus_markup_fixture(`
		<div data-testid="root">
			<ul class="MyFocus-container" data-testid="left-container">
				<li><button type="button" class="MyFocus-row" tabindex="-1">Left A</button></li>
				<li><button type="button" class="MyFocus-row" aria-current="true" tabindex="-1">Left B</button></li>
			</ul>
			<ul class="MyFocus-container" data-testid="right-container">
				<li><button type="button" class="MyFocus-row" tabindex="-1">Right A</button></li>
				<li><button type="button" class="MyFocus-row ${my_focus_ROW_ACTIVE_CLASS}" tabindex="-1">Right B</button></li>
			</ul>
		</div>
	`);
		const leftContainerEl = fixture.getContainer("left-container");
		const rightContainerEl = fixture.getContainer("right-container");

		fixture.focus.start();

		try {
			expect(get_row_from_container(leftContainerEl, "Left A").tabIndex).toBe(-1);
			expect(get_row_from_container(leftContainerEl, "Left B").tabIndex).toBe(0);
			expect(get_row_from_container(rightContainerEl, "Right A").tabIndex).toBe(-1);
			expect(get_row_from_container(rightContainerEl, "Right B").tabIndex).toBe(0);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should keep nested containers isolated during start", () => {
		const fixture = setup_focus_markup_fixture(`
		<div data-testid="root">
			<div class="MyFocus-container" data-testid="outer-container">
				<button type="button" class="MyFocus-row" tabindex="-1">Outer A</button>
				<button type="button" class="MyFocus-row" aria-current="true" tabindex="-1">Outer B</button>
				<div class="MyFocus-container" data-testid="inner-container">
					<button type="button" class="MyFocus-row" tabindex="-1">Inner A</button>
					<button type="button" class="MyFocus-row ${my_focus_ROW_ACTIVE_CLASS}" tabindex="-1">Inner B</button>
				</div>
			</div>
		</div>
	`);
		const outerContainerEl = fixture.getContainer("outer-container");
		const innerContainerEl = fixture.getContainer("inner-container");

		fixture.focus.start();

		try {
			expect(get_row_from_container(outerContainerEl, "Outer A").tabIndex).toBe(-1);
			expect(get_row_from_container(outerContainerEl, "Outer B").tabIndex).toBe(0);
			expect(get_row_from_container(innerContainerEl, "Inner A").tabIndex).toBe(-1);
			expect(get_row_from_container(innerContainerEl, "Inner B").tabIndex).toBe(0);
			expect(get_row_from_container(innerContainerEl, "Inner B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(
				true,
			);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should keep nested containers isolated during arrow navigation", async () => {
		const fixture = setup_focus_markup_fixture(`
		<div data-testid="root">
			<div class="MyFocus-container" data-testid="outer-container">
				<button type="button" class="MyFocus-row" aria-current="true" tabindex="-1">Outer A</button>
				<div class="MyFocus-container" data-testid="inner-container">
					<button type="button" class="MyFocus-row" aria-current="true" tabindex="-1">Inner A</button>
					<button type="button" class="MyFocus-row" tabindex="-1">Inner B</button>
				</div>
				<button type="button" class="MyFocus-row" tabindex="-1">Outer B</button>
			</div>
		</div>
	`);
		const outerContainerEl = fixture.getContainer("outer-container");
		const innerContainerEl = fixture.getContainer("inner-container");

		fixture.focus.start();

		try {
			await page.getByRole("button", { name: "Inner A" }).click();
			await userEvent.keyboard("{ArrowDown}");
			expect(document.activeElement).toBe(get_row_from_container(innerContainerEl, "Inner B"));
			expect(get_row_from_container(innerContainerEl, "Inner B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(get_row_from_container(outerContainerEl, "Outer A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(get_row_from_container(outerContainerEl, "Outer B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);

			await userEvent.keyboard("{ArrowDown}");
			expect(document.activeElement).toBe(get_row_from_container(innerContainerEl, "Inner A"));
			expect(get_row_from_container(innerContainerEl, "Inner A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(get_row_from_container(outerContainerEl, "Outer A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);

			await page.getByRole("button", { name: "Outer A" }).click();
			await userEvent.keyboard("{ArrowDown}");
			expect(document.activeElement).toBe(get_row_from_container(outerContainerEl, "Outer B"));
			expect(get_row_from_container(outerContainerEl, "Outer A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
			expect(get_row_from_container(outerContainerEl, "Outer B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(get_row_from_container(innerContainerEl, "Inner A").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(true);
			expect(get_row_from_container(innerContainerEl, "Inner B").classList.contains(my_focus_ROW_ACTIVE_CLASS)).toBe(false);
		} finally {
			fixture.focus.stop();
		}
	});

	test("Should not move focus when a row keydown handler prevents ArrowDown", async () => {
		const fixture = setup_focus_fixture([
			{ label: "Workspace A", ariaCurrent: true },
			{ label: "Workspace B" },
			{ label: "Workspace C" },
		]);
		const currentRow = fixture.getRow("Workspace A");
		const nextRow = fixture.getRow("Workspace B");
		let didPreventArrowDown = false;

		currentRow.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown") {
				didPreventArrowDown = true;
				event.preventDefault();
			}
		});

		fixture.focus.start();

		try {
			await page.getByRole("button", { name: "Workspace A" }).click();
			await userEvent.keyboard("{ArrowDown}");

			expect(didPreventArrowDown).toBe(true);
			expect(document.activeElement).toBe(currentRow);
			expect(currentRow.tabIndex).toBe(0);
			expect(nextRow.tabIndex).toBe(-1);
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
									class="MyFocus-row${row.explicitActive ? ` ${my_focus_ROW_ACTIVE_CLASS}` : ""}"
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

function setup_focus_markup_fixture(markup: string) {
	document.body.innerHTML = markup;

	const rootEl = document.querySelector<HTMLElement>('[data-testid="root"]');
	if (!rootEl) {
		throw new Error("Expected a MyFocus test root");
	}

	return {
		rootEl,
		focus: new MyFocus(rootEl),
		getContainer(testId: string) {
			const containerEl = rootEl.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
			if (!containerEl) {
				throw new Error(`Expected a MyFocus container for "${testId}"`);
			}

			return containerEl;
		},
	};
}

function get_row_from_container(containerEl: HTMLElement, label: string) {
	const row = Array.from(containerEl.querySelectorAll<HTMLButtonElement>(".MyFocus-row")).find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	if (!row) {
		throw new Error(`Expected a MyFocus row for "${label}"`);
	}

	return row;
}
