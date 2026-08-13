import type { AppClassName, AppElementId } from "./dom-utils.ts";
import { global_event_listen } from "./global-event.tsx";

/**
 * Measure how much width a scrollbar takes on this system and publish it as `--app-scrollbar-w`.
 * Systems with overlay scrollbars measure 0. Layouts that must reserve the scrollbar gutter up
 * front, so the bar does not shift them when it appears, read that variable.
 *
 * The measurement needs a real scroll container, so it keeps one hidden probe element on the body
 * and reads how much its scrollbar eats.
 */
export function app_scrollbar_measure_width() {
	const id = "app_scrollbar_width_probe" satisfies AppElementId;

	let probe = document.getElementById(id);

	if (!probe) {
		probe = document.createElement("div");
		probe.id = id;
		probe.style.position = "absolute";
		probe.style.zIndex = "-1";
		probe.style.width = "100px";
		probe.style.height = "0px";
		probe.style.opacity = "0";
		probe.style.overflow = "scroll";
		probe.style.pointerEvents = "none";
		document.body.appendChild(probe);
	}

	document.body.style.setProperty("--app-scrollbar-w", `${probe.offsetWidth - probe.clientWidth}px`);
}

const app_scrollbar_SCROLLABLE_SELECTOR = `.${"app-scrollable" satisfies AppClassName}`;
const app_scrollbar_FITS_CLASS = "app-scrollable-fits" satisfies AppClassName;

/**
 * Mark every tagged scroll container above `target` whose content currently fits, so it has
 * no scrollbar of its own. The hover and focus rules in app.css let the innermost tagged
 * container win, and CSS cannot tell whether a container really overflows. Without this mark,
 * resting the pointer on a bar-less card (for example a small tool result in the chat) would
 * dim the chat panel scrollbar even though that card has no scrollbar to brighten instead.
 *
 * Only a hovered or focused container can take the highlight away from its ancestors, so
 * marking the ancestors of the element the pointer or focus just entered is enough.
 *
 * The class is added outside React on elements React renders. React only writes `className`
 * when the rendered string changes, so the mark survives a normal rerender, and a rerender
 * that does change it drops the mark until the pointer or focus enters the container again.
 */
function app_scrollbar_mark_containers_that_fit(target: EventTarget | null) {
	if (!(target instanceof Element)) return;

	let container = target.closest(app_scrollbar_SCROLLABLE_SELECTOR);
	while (container) {
		// Allow 1px of slack because fractional zoom levels round these sizes.
		const fits =
			container.scrollHeight - container.clientHeight <= 1 && container.scrollWidth - container.clientWidth <= 1;

		container.classList.toggle(app_scrollbar_FITS_CLASS, fits);
		container = container.parentElement?.closest(app_scrollbar_SCROLLABLE_SELECTOR) ?? null;
	}
}

export function app_scrollbar_install() {
	// Both events run before the browser recalculates styles for the new :hover and
	// :focus-within state, so the marks are already correct for that same repaint.
	global_event_listen("pointerover", (event) => app_scrollbar_mark_containers_that_fit(event.target));
	global_event_listen("focusin", (event) => app_scrollbar_mark_containers_that_fit(event.target));
}
