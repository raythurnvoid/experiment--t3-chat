import "./my-chip.css";
import { memo, useEffect, type ComponentPropsWithRef, type Ref } from "react";
import * as Ariakit from "@ariakit/react";

import { MyIconButton } from "@/components/my-icon-button.tsx";
import { cn } from "@/lib/utils.ts";

// #region root
export type MyChip_ClassNames = "MyChip" | "MyChip-size-default" | "MyChip-size-compact";

export type MyChip_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	size?: "default" | "compact";
};

/**
 * A small pill with an optional media slot, a truncating label, and an
 * optional remove button. The chip itself is not interactive.
 */
export const MyChip = memo(function MyChip(props: MyChip_Props) {
	const { ref, id, className, size = "default", children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn(
				"MyChip" satisfies MyChip_ClassNames,
				size === "default" && ("MyChip-size-default" satisfies MyChip_ClassNames),
				size === "compact" && ("MyChip-size-compact" satisfies MyChip_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion root

// #region media
export type MyChipMedia_ClassNames = "MyChipMedia";

export type MyChipMedia_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
};

/**
 * Square media slot at the chip's start. The consumer passes the content as
 * children: an `<img>` fills the slot, an icon centers in it.
 */
export const MyChipMedia = memo(function MyChipMedia(props: MyChipMedia_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<span ref={ref} id={id} className={cn("MyChipMedia" satisfies MyChipMedia_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
});
// #endregion media

// #region label
export type MyChipLabel_ClassNames = "MyChipLabel";

export type MyChipLabel_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
};

/**
 * Chip label. Truncates with an ellipsis at the end when it hits the width cap.
 */
export const MyChipLabel = memo(function MyChipLabel(props: MyChipLabel_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<span ref={ref} id={id} className={cn("MyChipLabel" satisfies MyChipLabel_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
});
// #endregion label

// #region remove
export type MyChipRemove_ClassNames = "MyChipRemove";

export type MyChipRemove_CustomAttributes = {
	"data-my-chip-remove": "";
};

export type MyChipRemove_Props = Omit<ComponentPropsWithRef<typeof MyIconButton>, "variant"> & {
	/**
	 * The accessible name of the icon-only remove button, e.g. "Remove shot.png".
	 */
	tooltip: string;
};

/**
 * Full-bleed remove button filling the chip's whole right end (36x36 in the
 * default size, 28x28 in compact). It is the chip's focus target inside a
 * `MyChipRow` composite: one tab stop per row, arrows move between chips.
 */
export const MyChipRemove = memo(function MyChipRemove(props: MyChipRemove_Props) {
	// Keep `id` inside rest: an explicit id={undefined} would clobber the id
	// that CompositeItem generates to register the item in the composite store.
	const { ref, className, children, ...rest } = props;

	return (
		<Ariakit.CompositeItem
			render={
				<MyIconButton
					{...({ "data-my-chip-remove": "" } satisfies Partial<MyChipRemove_CustomAttributes>)}
					ref={ref}
					className={cn("MyChipRemove" satisfies MyChipRemove_ClassNames, className)}
					{...rest}
					variant="ghost-highlightable"
				>
					{children}
				</MyIconButton>
			}
		/>
	);
});
// #endregion remove

// #region row
export type MyChipRow_ClassNames =
	| "MyChipRow"
	| "MyChipRow-overflow-scroll"
	| "MyChipRow-overflow-wrap"
	| "MyChipRow-size-default"
	| "MyChipRow-size-compact";

export type MyChipRow_Props = ComponentPropsWithRef<"ul"> & {
	ref?: Ref<HTMLUListElement>;
	id?: string;
	className?: string;
	/**
	 * "scroll" keeps one fixed-height row that scrolls sideways; "wrap" grows vertically.
	 */
	overflow?: "scroll" | "wrap";
	/**
	 * Must match the size of the chips inside, so a scroll row gets the right fixed height.
	 */
	size?: "default" | "compact";
	/**
	 * Called when a keyboard removal leaves no chip to focus (the consumer usually focuses its text input).
	 */
	onFocusExit?: () => void;
};

/**
 * Layout container for chips. Renders a real `<ul>`; the consumer wraps each
 * chip in a plain `<li>`. The row is an Ariakit composite: one tab stop,
 * Left/Right arrows move between the chips' remove buttons, and a keyboard
 * removal (Delete, Backspace, Enter, or Space on a remove button) moves focus
 * to the next chip, else the previous one, else calls `onFocusExit`.
 */
export const MyChipRow = memo(function MyChipRow(props: MyChipRow_Props) {
	const {
		ref,
		className,
		overflow = "scroll",
		size = "default",
		onFocusExit,
		onKeyDownCapture,
		onWheel,
		children,
		...rest
	} = props;

	// One row = one horizontal composite. Up/Down must not move focus, even
	// when a wrap row renders on several visual lines.
	const store = Ariakit.useCompositeStore({ orientation: "horizontal" });
	// Read renderedItems, not items: item registration lives in a private store
	// and only renderedItems reliably syncs to this public state (and it is
	// also what store.first() reads).
	const renderedItems = Ariakit.useStoreState(store, "renderedItems");
	const activeId = Ariakit.useStoreState(store, "activeId");

	const handleKeyDownCapture: MyChipRow_Props["onKeyDownCapture"] = (event) => {
		onKeyDownCapture?.(event);
		if (event.defaultPrevented) {
			return;
		}
		if (event.key !== "Delete" && event.key !== "Backspace" && event.key !== "Enter" && event.key !== " ") {
			return;
		}
		const target = event.target;
		if (
			!(target instanceof HTMLElement) ||
			!target.hasAttribute("data-my-chip-remove" satisfies keyof MyChipRemove_CustomAttributes)
		) {
			return;
		}

		// Handle every keyboard activation here, so removal and the focus move
		// stay one code path. This runs on the capture phase and preventDefault
		// stops both the native button click and Ariakit's own Enter/Space
		// click. Focus the neighbor chip BEFORE removing, so focus never falls
		// to <body> when the focused button unmounts.
		event.preventDefault();
		const neighborId = store.next() ?? store.previous();
		const neighborElement = neighborId != null ? store.item(neighborId)?.element : null;
		if (neighborElement) {
			neighborElement.focus();
		} else {
			onFocusExit?.();
		}
		target.click();
	};

	const handleWheel: MyChipRow_Props["onWheel"] = (event) => {
		onWheel?.(event);
		// Shift+wheel already scrolls sideways natively; skip the mapping so
		// that scroll does not apply twice.
		if (event.shiftKey) {
			return;
		}
		// Map the plain vertical wheel to the sideways scroll so overflowing
		// chips are reachable without aiming at the scrollbar or knowing
		// shift+wheel. In a wrap row nothing overflows, so the assignment is a
		// no-op there.
		if (!event.deltaX && event.deltaY) {
			// Firefox reports mouse-wheel notches in lines (deltaMode 1), not
			// pixels. Scale those to pixels, or each notch would move ~3px.
			const deltaPixels = event.deltaMode === 1 ? event.deltaY * 32 : event.deltaY;
			event.currentTarget.scrollLeft += deltaPixels;
		}
	};

	// A pointer removal unmounts the active item without moving focus inside
	// the row, and Ariakit then treats every remaining item as tabbable, so the
	// row would expose one tab stop per chip until a chip is focused again.
	// Point activeId back at the first remaining chip to keep one tab stop.
	// (A keyboard removal is unaffected: the handler above moves activeId to a
	// neighbor before the removal click.)
	useEffect(() => {
		if (activeId == null) {
			return;
		}
		if (renderedItems.some((item) => item.id === activeId)) {
			return;
		}
		store.setActiveId(store.first());
	}, [renderedItems, activeId, store]);

	return (
		<Ariakit.Composite
			store={store}
			render={
				<ul
					ref={ref}
					className={cn(
						"MyChipRow" satisfies MyChipRow_ClassNames,
						overflow === "scroll" && ("MyChipRow-overflow-scroll" satisfies MyChipRow_ClassNames),
						overflow === "wrap" && ("MyChipRow-overflow-wrap" satisfies MyChipRow_ClassNames),
						size === "default" && ("MyChipRow-size-default" satisfies MyChipRow_ClassNames),
						size === "compact" && ("MyChipRow-size-compact" satisfies MyChipRow_ClassNames),
						className,
					)}
					onKeyDownCapture={handleKeyDownCapture}
					onWheel={handleWheel}
					{...rest}
				>
					{children}
				</ul>
			}
		/>
	);
});
// #endregion row
