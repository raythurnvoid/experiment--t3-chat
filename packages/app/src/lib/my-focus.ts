export type MyFocus_ClassNames = "MyFocus-container" | "MyFocus-row";

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

		const rows = Array.from(container.querySelectorAll<HTMLElement>(".MyFocus-row"));
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
		const rows = Array.from(container.querySelectorAll<HTMLElement>(".MyFocus-row"));
		const previousRow = rows.find((candidate) => candidate.tabIndex === 0) ?? null;

		for (const candidate of rows) {
			candidate.tabIndex = candidate === row && my_focus_is_row_focusable(candidate) ? 0 : -1;
		}

		if (reason !== "start" && previousRow === row) {
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
			const rows = Array.from(container.querySelectorAll<HTMLElement>(".MyFocus-row"));
			const activeRow = my_focus_get_initial_row(rows);
			if (!activeRow) {
				for (const row of rows) {
					row.tabIndex = -1;
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
		this.rootEl.addEventListener("keydown", this.handleKeyDown, true);
		this.isStarted = true;
	}

	stop() {
		if (!this.isStarted) {
			return;
		}

		this.rootEl.removeEventListener("focusin", this.handleFocusIn, true);
		this.rootEl.removeEventListener("keydown", this.handleKeyDown, true);
		this.isStarted = false;
	}
}

function my_focus_get_containers(rootEl: HTMLElement) {
	const containers = rootEl.matches(".MyFocus-container") ? [rootEl] : [];
	containers.push(...rootEl.querySelectorAll<HTMLElement>(".MyFocus-container"));
	return containers;
}

function my_focus_get_initial_row(rows: HTMLElement[]) {
	const activeElement = document.activeElement;
	if (activeElement instanceof HTMLElement) {
		const activeRow = rows.find((row) => row === activeElement || row.contains(activeElement));
		if (activeRow && my_focus_is_row_focusable(activeRow)) {
			return activeRow;
		}
	}

	const selectedRow = rows.find((row) => my_focus_is_row_selected(row) && my_focus_is_row_focusable(row));
	if (selectedRow) {
		return selectedRow;
	}

	return rows.find((row) => my_focus_is_row_focusable(row));
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
