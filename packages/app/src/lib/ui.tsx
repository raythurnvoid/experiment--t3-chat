import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import type { AppElementId } from "./dom-utils.ts";
import { useGlobalEventList } from "./global-event.tsx";
import { check_element_is_in_allowed_areas } from "./utils.ts";

// #region useUiStickToBottom
/**
 * Returns whether a scroll container is effectively at the bottom.
 * Also returns true when content does not overflow the container.
 *
 * @param el Scroll container element to inspect.
 * @param bottomMargin Allowed distance from the bottom in pixels.
 *
 * @returns `true` when at the bottom (or when the content does not overflow).
 */
export function ui_scroll_is_at_bottom(el: HTMLElement, bottomMargin = 1) {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= bottomMargin || el.scrollHeight <= el.clientHeight;
}

type useUiStickToBottom_Props = {
	scrollEl: HTMLElement | null;
	contentEl?: HTMLElement | null;
	contentKey?: string;
	bottomMargin?: number;
	stickOnContentResize?: boolean;
	contentKeyScrollBehavior?: ScrollBehavior;
	contentResizeScrollBehavior?: ScrollBehavior;
	enable?: boolean;
};

/**
 * Keeps a scroll container pinned to the bottom while the user remains at the bottom.
 *
 * It reacts to scroll events, content key changes, and content resizes.
 *
 * @param props.scrollEl Scrollable container element to manage.
 * @param props.contentEl Optional content element observed for resize-driven sticking.
 * @param props.contentKey Optional key; when it changes, the hook can re-stick to bottom.
 * @param props.bottomMargin Allowed distance from bottom for bottom detection.
 * @param props.stickOnContentResize Whether resize events should keep the view stuck to bottom.
 * @param props.contentKeyScrollBehavior Scroll behavior used when `contentKey` changes.
 * @param props.contentResizeScrollBehavior Scroll behavior used for content resize sticking.
 * @param props.enable Enables or disables sticky behavior.
 *
 * @returns Current bottom state and an imperative `scrollToBottom` helper.
 */
export function useUiStickToBottom(props: useUiStickToBottom_Props) {
	const {
		scrollEl,
		contentEl,
		contentKey,
		bottomMargin = 1,
		stickOnContentResize = true,
		contentKeyScrollBehavior = "instant",
		contentResizeScrollBehavior = "instant",
		enable = true,
	} = props;

	const [isAtBottom, setIsAtBottom] = useState(true);
	const isAtBottomRef = useRef(isAtBottom);
	const lastScrollTopRef = useRef(0);
	const scrollingToBottomBehaviorRef = useRef<ScrollBehavior | null>(null);

	useEffect(() => {
		isAtBottomRef.current = isAtBottom;
	}, [isAtBottom]);

	const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
		const el = scrollEl;
		if (!el) {
			return;
		}

		scrollingToBottomBehaviorRef.current = behavior;
		el.scrollTo({ top: el.scrollHeight, behavior });
	};

	const handleScroll = useEffectEvent(() => {
		const el = scrollEl;
		if (!el) {
			return;
		}

		const newIsAtBottom = ui_scroll_is_at_bottom(el, bottomMargin);

		if (!newIsAtBottom && lastScrollTopRef.current < el.scrollTop) {
			// ignore scroll down while a scroll-to-bottom call is still in progress
		} else {
			if (newIsAtBottom) {
				scrollingToBottomBehaviorRef.current = null;
			}

			const shouldUpdate = newIsAtBottom || scrollingToBottomBehaviorRef.current === null;
			if (shouldUpdate) {
				setIsAtBottom(newIsAtBottom);
			}
		}

		lastScrollTopRef.current = el.scrollTop;
	});

	const handleContentResize = useEffectEvent(() => {
		if (!enable || !stickOnContentResize) {
			handleScroll();
			return;
		}

		const scrollBehavior = scrollingToBottomBehaviorRef.current;
		if (scrollBehavior) {
			scrollToBottom(scrollBehavior);
		} else if (isAtBottomRef.current) {
			scrollToBottom(contentResizeScrollBehavior);
		}

		handleScroll();
	});

	useEffect(() => {
		const el = scrollEl;
		if (!el) {
			return;
		}

		lastScrollTopRef.current = el.scrollTop;
		handleScroll();
		el.addEventListener("scroll", handleScroll, { passive: true });

		return () => {
			el.removeEventListener("scroll", handleScroll);
		};
	}, [scrollEl]);

	useEffect(() => {
		if (contentKey === undefined) {
			return;
		}

		const el = scrollEl;
		if (!el) {
			return;
		}

		if (enable && isAtBottomRef.current) {
			scrollToBottom(contentKeyScrollBehavior);
		}

		handleScroll();
	}, [scrollEl, contentKey, contentKeyScrollBehavior, enable]);

	useEffect(() => {
		const el = contentEl;
		if (!el) {
			return;
		}

		const resizeObserver = new ResizeObserver(handleContentResize);
		resizeObserver.observe(el);

		return () => {
			resizeObserver.disconnect();
		};
	}, [contentEl, enable, stickOnContentResize, contentResizeScrollBehavior]);

	return {
		isAtBottom,
		scrollToBottom,
	} as const;
}
// #endregion useUiStickToBottom

// #region useUiInteractedOutside
type useUiInteractedOutside_Options = {
	allowedAreas?: Array<Element | null | undefined>;
	enable?: boolean;
};

/**
 * Calls `callback` when pointer/focus interactions happen outside `container`.
 *
 * Optional `allowedAreas` are treated as inside areas and do not trigger the callback.
 *
 * @param container Container element (or ref) used as the inside boundary.
 * @param callback Handler invoked for outside pointer/focus interactions.
 * @param options.allowedAreas Extra inside areas excluded from outside detection.
 * @param options.enable Enables or disables outside interaction handling.
 */
export function useUiInteractedOutside(
	container: Element | RefObject<Element | null> | null,
	callback: ((event: FocusEvent | PointerEvent) => void) | undefined,
	options?: useUiInteractedOutside_Options,
) {
	const { allowedAreas = [], enable = true } = options ?? {};

	useGlobalEventList(
		["pointerdown", "focusin"],
		(event) => {
			const containerElement =
				container && typeof container === "object" && "current" in container ? container.current : container;
			if (!enable || !containerElement || !callback) {
				return;
			}

			const rootElement = document.getElementById("root" satisfies AppElementId);
			if (
				check_element_is_in_allowed_areas(event.target, {
					allowedAreas: [containerElement, ...allowedAreas],
					restrictionScope: rootElement,
				})
			) {
				return;
			}

			callback(event);
		},
		{ capture: true },
	);
}
// #endregion useUiInteractedOutside
