/**
 * Roving tabindex for `.MyFocus-row` inside `.MyFocus-container`.
 *
 * **Ownership**
 * - **Host / React:** Put semantic **selection** on the row (`aria-current`, `aria-selected`, `data-selected`) to seed the **initial** roving row when focus is outside the list. Do not mirror arrow-key position in React state.
 * - **MyFocus:** After `start()` / `sync()`, owns `tabIndex` and `MyFocus-row-active` (via `focusin` and arrow handling). Do not set `MyFocus-row-active` from React `className` in product UI; it fights imperative updates when roving and selection differ.
 *
 * Optional static `MyFocus-row-active` on a row is for tests or rare non-React seeds, not for ongoing selection styling.
 */
export type MyFocus_ClassNames = "MyFocus-container" | "MyFocus-row" | "MyFocus-row-active";

/**
 * Imperative roving marker (see module comment). Must stay on the **same element as `MyFocus-row`** if you set it in static HTML; MyFocus normalizes it to at most one focusable row per container.
 */
export const my_focus_ROW_ACTIVE_CLASS = "MyFocus-row-active" satisfies MyFocus_ClassNames;

export const my_focus_ACTIVE_ROW_CHANGE_EVENT_NAME = "my-focus-active-row-change";

export type MyFocus_ActiveRowChangeDetail = {
	container: HTMLElement;
	row: HTMLElement;
	previousRow: HTMLElement | null;
	reason: "focus" | "start";
};

export class MyFocus {
	private rootEl: HTMLElement;
	private isStarted = false;

	constructor(rootEl: HTMLElement) {
		this.rootEl = rootEl;
	}

	private handleFocusIn = (event: FocusEvent) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return;
		}

		const row = target.closest<HTMLElement>(".MyFocus-row");
		if (!row || !my_focus_is_row_focusable(row)) {
			return;
		}

		const container = this.getContainerForRow(row);
		if (!container) {
			return;
		}

		this.syncContainerActiveRow({
			container,
			row,
			reason: "focus",
		});
	};

	private handleKeyDown = (event: KeyboardEvent) => {
		if (event.defaultPrevented) {
			return;
		}

		const isArrowUp = event.key === "ArrowUp";
		const isArrowDown = event.key === "ArrowDown";
		if (!isArrowUp && !isArrowDown) {
			return;
		}

		const activeElement = document.activeElement;
		if (!(activeElement instanceof HTMLElement)) {
			return;
		}

		const activeRow = activeElement.closest<HTMLElement>(".MyFocus-row");
		if (!activeRow) {
			return;
		}

		const container = this.getContainerForRow(activeRow);
		if (!container) {
			return;
		}

		const rows = my_focus_get_rows(container);
		if (rows.length === 0) {
			return;
		}

		const currentIndex = rows.indexOf(activeRow);
		if (currentIndex === -1) {
			return;
		}

		const direction = isArrowUp ? -1 : 1;
		const total = rows.length;

		for (let offset = 1; offset <= total; offset += 1) {
			const nextIndex = my_focus_wrap_index(currentIndex + direction * offset, total);
			const nextRow = rows[nextIndex];
			if (!nextRow || !my_focus_is_row_focusable(nextRow)) {
				continue;
			}

			nextRow.focus();
			if (document.activeElement === nextRow) {
				event.preventDefault();
				return;
			}
		}
	};

	private getContainerForRow(row: HTMLElement) {
		const container = row.closest<HTMLElement>(".MyFocus-container");
		if (!container || !this.rootEl.contains(container)) {
			return;
		}

		return container;
	}

	private syncContainerActiveRow(args: {
		container: HTMLElement;
		row: HTMLElement;
		reason: MyFocus_ActiveRowChangeDetail["reason"];
	}) {
		const { container, row, reason } = args;
		const rows = my_focus_get_rows(container);
		const previousRow = rows.find((candidate) => candidate.tabIndex === 0) ?? null;

		for (const candidate of rows) {
			candidate.tabIndex = candidate === row && my_focus_is_row_focusable(candidate) ? 0 : -1;
		}

		my_focus_normalize_row_active_class({ rows, activeRow: row });

		if (previousRow === row) {
			return;
		}

		container.dispatchEvent(
			new CustomEvent<MyFocus_ActiveRowChangeDetail>(my_focus_ACTIVE_ROW_CHANGE_EVENT_NAME, {
				bubbles: true,
				detail: {
					container,
					row,
					previousRow,
					reason,
				},
			}),
		);
	}

	private syncAllContainers() {
		for (const container of my_focus_get_containers(this.rootEl)) {
			const rows = my_focus_get_rows(container);
			const activeRow = my_focus_get_initial_row(rows);
			if (!activeRow) {
				for (const row of rows) {
					row.tabIndex = -1;
					row.classList.remove(my_focus_ROW_ACTIVE_CLASS);
				}
				continue;
			}

			this.syncContainerActiveRow({
				container,
				row: activeRow,
				reason: "start",
			});
		}
	}

	start() {
		if (this.isStarted) {
			return;
		}

		this.syncAllContainers();
		this.rootEl.addEventListener("focusin", this.handleFocusIn, true);
		this.rootEl.addEventListener("keydown", this.handleKeyDown);
		this.isStarted = true;
	}

	stop() {
		if (!this.isStarted) {
			return;
		}

		this.rootEl.removeEventListener("focusin", this.handleFocusIn, true);
		this.rootEl.removeEventListener("keydown", this.handleKeyDown);
		this.isStarted = false;
	}

	/** Re-run container sync after DOM visibility or list membership changes (for example dialog open). */
	sync() {
		if (!this.isStarted) {
			return;
		}

		this.syncAllContainers();
	}
}

function my_focus_get_containers(rootEl: HTMLElement) {
	const containers = rootEl.matches(".MyFocus-container") ? [rootEl] : [];
	containers.push(...rootEl.querySelectorAll<HTMLElement>(".MyFocus-container"));
	return containers;
}

function my_focus_get_rows(container: HTMLElement) {
	return Array.from(container.querySelectorAll<HTMLElement>(".MyFocus-row")).filter((row) => {
		return row.closest<HTMLElement>(".MyFocus-container") === container;
	});
}

function my_focus_get_initial_row(rows: HTMLElement[]) {
	const activeElement = document.activeElement;
	if (activeElement instanceof HTMLElement) {
		const activeRow = rows.find((row) => row === activeElement || row.contains(activeElement));
		if (activeRow && my_focus_is_row_focusable(activeRow)) {
			return activeRow;
		}
	}

	const explicitRow = rows.find(
		(row) => my_focus_row_has_explicit_active_marker(row) && my_focus_is_row_focusable(row),
	);
	if (explicitRow) {
		return explicitRow;
	}

	const selectedRow = rows.find((row) => my_focus_is_row_selected(row) && my_focus_is_row_focusable(row));
	if (selectedRow) {
		return selectedRow;
	}

	return rows.find((row) => my_focus_is_row_focusable(row));
}

function my_focus_row_has_explicit_active_marker(row: HTMLElement) {
	return row.classList.contains(my_focus_ROW_ACTIVE_CLASS);
}

function my_focus_normalize_row_active_class(args: { rows: HTMLElement[]; activeRow: HTMLElement }) {
	const { rows, activeRow } = args;

	for (const candidate of rows) {
		if (candidate === activeRow && my_focus_is_row_focusable(candidate)) {
			candidate.classList.add(my_focus_ROW_ACTIVE_CLASS);
		} else {
			candidate.classList.remove(my_focus_ROW_ACTIVE_CLASS);
		}
	}
}

function my_focus_is_row_selected(row: HTMLElement) {
	if (row.getAttribute("aria-current") === "true") {
		return true;
	}

	if (row.getAttribute("aria-selected") === "true") {
		return true;
	}

	if (row.hasAttribute("data-selected") && row.getAttribute("data-selected") !== "false") {
		return true;
	}

	return false;
}

function my_focus_wrap_index(index: number, total: number) {
	if (total <= 0) {
		return 0;
	}

	return ((index % total) + total) % total;
}

function my_focus_is_row_focusable(row: HTMLElement) {
	if (row.hasAttribute("disabled") || row.getAttribute("aria-disabled") === "true") {
		return false;
	}

	if (!row.isConnected) {
		return false;
	}

	return row.offsetParent !== null || row.getClientRects().length > 0;
}
