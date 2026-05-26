import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { editor as monaco_editor } from "monaco-editor";

/**
 * Convert content wheel events into the signed pixel delta Monaco would apply.
 *
 * Monaco normalizes physical wheel notches through `wheelDelta / 120` and uses
 * a 50px wheel step, so do the same here instead of adding raw `deltaY`.
 */
function get_monaco_scroll_delta(
	event: {
		readonly deltaMode: number;
		readonly deltaX: number;
		readonly deltaY: number;
		readonly wheelDeltaX?: number;
		readonly wheelDeltaY?: number;
	},
	axis: "x" | "y",
	scrollSensitivity: number,
) {
	const wheelDelta = axis === "x" ? event.wheelDeltaX : event.wheelDeltaY;
	const delta = axis === "x" ? event.deltaX : event.deltaY;
	const normalizedDelta = ((/* iife */) => {
		if (typeof wheelDelta === "number" && wheelDelta !== 0) {
			return wheelDelta / 120;
		}

		if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
			return -delta;
		}

		return -delta / 40;
	})();
	const scrollDelta = 50 * scrollSensitivity * normalizedDelta;
	return -(scrollDelta < 0 ? Math.floor(scrollDelta) : Math.ceil(scrollDelta));
}

type FileEditorMonacoTopViewZone_ClassNames = "FileEditorMonacoTopViewZone" | "FileEditorMonacoTopViewZone-spacer";

type FileEditorMonacoTopViewZone_Props = {
	editor: monaco_editor.IStandaloneCodeEditor | null;
	topViewZoneGap: number;
	children?: ReactNode;
};

/**
 * Adds content above Monaco without putting it inside Monaco's text area.
 *
 * The view zone reserves scrollable height. The portaled content spans the
 * gutter while keeping Monaco's scrollbar usable.
 */
export const FileEditorMonacoTopViewZone = memo(function FileEditorMonacoTopViewZone(
	props: FileEditorMonacoTopViewZone_Props,
) {
	const { editor, topViewZoneGap, children } = props;

	const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
	const zoneRef = useRef<{
		id: string;
		zone: monaco_editor.IViewZone;
		contentNode: HTMLDivElement;
		heightInPx: number;
	} | null>(null);

	const hasChildren = children != null && children !== false;

	useLayoutEffect(() => {
		if (!editor || !hasChildren) {
			return;
		}

		const zoneNode = document.createElement("div");
		zoneNode.classList.add("FileEditorMonacoTopViewZone-spacer" satisfies FileEditorMonacoTopViewZone_ClassNames);

		const contentNode = document.createElement("div");
		contentNode.classList.add("FileEditorMonacoTopViewZone" satisfies FileEditorMonacoTopViewZone_ClassNames);

		// Use the view zone only as the scroll spacer. The content itself is portaled
		// into the editor host so it can span the gutter and leave the scrollbar visible.
		const zone: monaco_editor.IViewZone = {
			afterLineNumber: 0,
			heightInPx: 1,
			domNode: zoneNode,
			suppressMouseDown: false,
		};

		// Register the spacer before rendering portal children
		// so the first measured layout effect has a Monaco zone to resize.
		editor.changeViewZones((accessor) => {
			const id = accessor.addZone(zone);
			zoneRef.current = { id, zone, contentNode, heightInPx: 1 };
		});
		setPortalHost(contentNode);

		let resizeFrame: number | undefined;
		let observedContentElement: Element | null = null;
		let resizeObserver: ResizeObserver | null = null;
		let editorResizeObserver: ResizeObserver | null = null;
		let lastHostTop = -1;
		let lastHostWidth = -1;

		const syncScrollPosition = () => {
			contentNode.style.transform = `translateY(${-editor.getScrollTop()}px)`;
		};

		/**
		 * Forward wheel events from the custom content into Monaco's scroll state.
		 *
		 * Monaco listens for wheel events inside its own text area, but this content is
		 * portaled into a custom host so it can span the line-number gutter and the rest
		 * of the editor layout. Because Monaco cannot receive those events naturally,
		 * convert them to the same scroll delta Monaco would apply over editor text.
		 */
		const handleWheel = (event: WheelEvent) => {
			const scrollSensitivity =
				editor.getOption(monaco_editor.EditorOption.mouseWheelScrollSensitivity) *
				(event.altKey ? editor.getOption(monaco_editor.EditorOption.fastScrollSensitivity) : 1);

			editor.setScrollTop(editor.getScrollTop() + get_monaco_scroll_delta(event, "y", scrollSensitivity));
			editor.setScrollLeft(editor.getScrollLeft() + get_monaco_scroll_delta(event, "x", scrollSensitivity));
			event.preventDefault();
		};

		/**
		 * Keep the portaled content aligned with Monaco's visible editor viewport.
		 *
		 * The content is rendered in a parent editor div instead of Monaco's view-zone
		 * DOM so it can span the line-number gutter. Recompute the content position
		 * and width from Monaco's measured layout whenever content or editor sizing
		 * may have changed.
		 */
		const syncHostLayout = () => {
			const editorDomNode = editor.getDomNode();
			if (!editorDomNode) {
				return;
			}

			// Measure the Monaco viewport the content needs to line up with.
			const overflowGuard = editorDomNode.querySelector<HTMLElement>(".overflow-guard");
			if (!overflowGuard) {
				return;
			}

			// Move the content into the editor wrapper so it can span the gutter.
			const contentHost =
				editorDomNode.closest<HTMLElement>(".FileEditorPlainText-editor, .FileEditorDiff-editor") ?? overflowGuard;
			if (contentNode.parentElement !== contentHost) {
				contentHost.appendChild(contentNode);
			}

			// Measure the wrapper, Monaco viewport, and visible scrollbar in the same coordinate space.
			const contentHostRect = contentHost.getBoundingClientRect();
			const overflowGuardRect = overflowGuard.getBoundingClientRect();
			const verticalScrollbarRect = Array.from(editorDomNode.querySelectorAll<HTMLElement>(".scrollbar.vertical"))
				.map((scrollbarElement) => scrollbarElement.getBoundingClientRect())
				.filter((scrollbarRect) => {
					// Ignore hidden scrollbar nodes and scrollbars outside the content host.
					return (
						scrollbarRect.width > 0 &&
						scrollbarRect.height > 0 &&
						scrollbarRect.left > contentHostRect.left &&
						scrollbarRect.left < contentHostRect.right
					);
				})
				.toSorted((a, b) => b.left - a.left)[0];
			const isVerticalScrollbarVisible =
				verticalScrollbarRect &&
				verticalScrollbarRect.width > 0 &&
				verticalScrollbarRect.left > contentHostRect.left &&
				verticalScrollbarRect.left < contentHostRect.right;
			// Convert Monaco viewport coordinates into content-host-relative CSS values.
			const nextHostTop = Math.round(overflowGuardRect.top - contentHostRect.top);
			const nextHostWidth = Math.ceil(
				(isVerticalScrollbarVisible ? verticalScrollbarRect.left : contentHostRect.right) - contentHostRect.left,
			);
			if (lastHostTop === nextHostTop && lastHostWidth === nextHostWidth) {
				// Keep scroll in sync even when the measured host layout did not change.
				syncScrollPosition();
				return;
			}

			// Apply the measured layout and then align with the current Monaco scroll offset.
			lastHostTop = nextHostTop;
			lastHostWidth = nextHostWidth;
			contentNode.style.top = `${nextHostTop}px`;
			contentNode.style.width = `${nextHostWidth}px`;
			syncScrollPosition();
		};

		/**
		 * Track the current portaled child so size changes in that child update the Monaco spacer.
		 */
		const syncObservedContentElement = () => {
			const contentElement = contentNode.firstElementChild;
			if (observedContentElement === contentElement) {
				return;
			}

			if (observedContentElement) {
				resizeObserver?.unobserve(observedContentElement);
			}
			observedContentElement = contentElement;

			if (observedContentElement) {
				resizeObserver?.observe(observedContentElement);
			}
		};

		/**
		 * Resize Monaco's hidden view zone to match the portaled content height.
		 *
		 * Monaco only knows about the spacer DOM node, not the content we render in
		 * the editor wrapper. Measure the portaled content, write that height back to
		 * the view zone, then ask Monaco to relayout.
		 */
		const updateZoneHeight = () => {
			syncObservedContentElement();

			if (resizeFrame !== undefined) {
				window.cancelAnimationFrame(resizeFrame);
			}

			resizeFrame = window.requestAnimationFrame(() => {
				resizeFrame = undefined;

				const currentZone = zoneRef.current;
				if (!currentZone) {
					return;
				}

				syncHostLayout();

				const contentHeight = currentZone.contentNode.firstElementChild?.getBoundingClientRect().height ?? 0;
				// Use the caller's top safe-area gap so folder README editors do not inherit the route reserve.
				const nextHeight = Math.max(
					1,
					Math.ceil(Math.max(contentHeight, currentZone.contentNode.scrollHeight) + topViewZoneGap),
				);
				if (currentZone.heightInPx === nextHeight) {
					return;
				}

				currentZone.heightInPx = nextHeight;
				currentZone.zone.heightInPx = nextHeight;

				editor.changeViewZones((accessor) => {
					accessor.layoutZone(currentZone.id);
				});
				editor.layout();
				syncScrollPosition();
			});
		};

		resizeObserver = new ResizeObserver(updateZoneHeight);
		resizeObserver.observe(contentNode);
		const editorDomNode = editor.getDomNode();
		if (editorDomNode) {
			editorResizeObserver = new ResizeObserver(updateZoneHeight);
			editorResizeObserver.observe(editorDomNode);
		}
		const layoutDisposable = editor.onDidLayoutChange(updateZoneHeight);
		const scrollDisposable = editor.onDidScrollChange(syncScrollPosition);
		contentNode.addEventListener("wheel", handleWheel, { passive: false });
		const mutationObserver = new MutationObserver(updateZoneHeight);
		mutationObserver.observe(contentNode, { childList: true, subtree: true });
		updateZoneHeight();

		return () => {
			resizeObserver?.disconnect();
			editorResizeObserver?.disconnect();
			layoutDisposable.dispose();
			scrollDisposable.dispose();
			contentNode.removeEventListener("wheel", handleWheel);
			mutationObserver.disconnect();
			if (resizeFrame !== undefined) {
				window.cancelAnimationFrame(resizeFrame);
			}

			setPortalHost(null);

			const currentZone = zoneRef.current;
			zoneRef.current = null;
			if (currentZone) {
				currentZone.contentNode.remove();
				editor.changeViewZones((accessor) => {
					accessor.removeZone(currentZone.id);
				});
			}
		};
	}, [editor, hasChildren, topViewZoneGap]);

	return portalHost && hasChildren ? createPortal(children, portalHost) : null;
});

if (import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("get_monaco_scroll_delta", () => {
		test("matches Monaco's physical mouse wheel step", () => {
			expect(
				get_monaco_scroll_delta(
					{
						deltaMode: WheelEvent.DOM_DELTA_PIXEL,
						deltaX: 0,
						deltaY: 100,
						wheelDeltaY: -120,
					},
					"y",
					1,
				),
			).toBe(50);
		});

		test("falls back to Monaco's pixel delta normalization", () => {
			expect(
				get_monaco_scroll_delta(
					{
						deltaMode: WheelEvent.DOM_DELTA_PIXEL,
						deltaX: 0,
						deltaY: 100,
					},
					"y",
					1,
				),
			).toBe(125);
		});

		test("applies editor scroll sensitivity", () => {
			expect(
				get_monaco_scroll_delta(
					{
						deltaMode: WheelEvent.DOM_DELTA_PIXEL,
						deltaX: 0,
						deltaY: 100,
						wheelDeltaY: -120,
					},
					"y",
					2,
				),
			).toBe(100);
		});

		test("normalizes line delta events", () => {
			expect(
				get_monaco_scroll_delta(
					{
						deltaMode: WheelEvent.DOM_DELTA_LINE,
						deltaX: 0,
						deltaY: 3,
					},
					"y",
					1,
				),
			).toBe(150);
		});
	});
}
