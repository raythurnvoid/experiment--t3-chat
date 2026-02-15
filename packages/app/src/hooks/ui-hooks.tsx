import { useEffect, useEffectEvent, useRef, useState } from "react";

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

export function ui_scroll_is_at_bottom(el: HTMLElement, bottomMargin = 1) {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= bottomMargin || el.scrollHeight <= el.clientHeight;
}

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
