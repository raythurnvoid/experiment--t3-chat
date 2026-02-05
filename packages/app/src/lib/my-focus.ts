export type MyFocus_ClassNames = "MyFocus-container" | "MyFocus-row";

export class MyFocus {
	private rootEl: HTMLElement;
	private isStarted = false;
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

		if (!activeElement.classList.contains("MyFocus-row")) {
			return;
		}

		const container = activeElement.closest<HTMLElement>(".MyFocus-container");
		if (!container || !this.rootEl.contains(container)) {
			return;
		}

		const rows = Array.from(container.querySelectorAll<HTMLElement>(".MyFocus-row"));
		if (rows.length === 0) {
			return;
		}

		const currentIndex = rows.indexOf(activeElement);
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

	constructor(rootEl: HTMLElement) {
		this.rootEl = rootEl;
	}

	start() {
		if (this.isStarted) {
			return;
		}

		this.rootEl.addEventListener("keydown", this.handleKeyDown);
		this.isStarted = true;
	}

	stop() {
		if (!this.isStarted) {
			return;
		}

		this.rootEl.removeEventListener("keydown", this.handleKeyDown);
		this.isStarted = false;
	}
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
