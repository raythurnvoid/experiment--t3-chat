import { useSyncExternalStore } from "react";

// A phone is a touch screen. Held upright it is at most 640px wide. Turned sideways it is wider,
// but at most 500px tall. A narrow desktop window has a mouse, so it keeps the desktop layout.
// Keep this query in sync with the `@media` phone rules in the CSS files.
const get_mobile_media_query = ((/* iife */) => {
	let cache: MediaQueryList | undefined;

	return function get_mobile_media_query() {
		return (cache ??= window.matchMedia(
			"(pointer: coarse) and (max-width: 640px), (pointer: coarse) and (max-height: 500px)",
		));
	};
})();

function subscribe_mobile_media_query(onChange: () => void) {
	const mediaQuery = get_mobile_media_query();
	mediaQuery.addEventListener("change", onChange);
	return () => mediaQuery.removeEventListener("change", onChange);
}

/**
 * Tell whether the window shows the phone layout, outside React. Use `useIsMobile` in components.
 */
export function is_mobile_layout() {
	return get_mobile_media_query().matches;
}

/**
 * Tell whether the window shows the phone layout. On a phone the app shows only the agent chat.
 *
 * The first render already reads the real size, so a phone never flashes the desktop shell.
 */
export function useIsMobile() {
	return useSyncExternalStore(subscribe_mobile_media_query, is_mobile_layout);
}
