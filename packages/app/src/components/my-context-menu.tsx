import "./my-floating-surface.css";
import * as Ariakit from "@ariakit/react";
import {
	createContext,
	memo,
	useContext,
	useEffect,
	useMemo,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
} from "react";
import type { ExtractStrict } from "type-fest";
import {
	MyMenuPopover,
	MyMenuTrigger,
	type MyMenu_Props,
	type MyMenuPopover_Props,
	type MyMenuTrigger_Props,
} from "./my-menu.tsx";

type MyContextMenuAnchorRect = {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
};

type MyContextMenu_Context = {
	anchorRect: MyContextMenuAnchorRect | null;
	setAnchorRect: (anchorRect: MyContextMenuAnchorRect | null) => void;
};

const MyContextMenuContext = createContext<MyContextMenu_Context | null>(null);

function get_context_menu_anchor_rect(element: HTMLElement | null): MyContextMenuAnchorRect | null {
	if (!element) {
		return null;
	}

	const rect = element.getBoundingClientRect();
	return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function get_context_menu_keyboard_anchor_rect(element: HTMLElement): MyContextMenuAnchorRect | null {
	const activeElement = document.activeElement;
	if (activeElement instanceof HTMLElement && element.contains(activeElement)) {
		return get_context_menu_anchor_rect(activeElement);
	}

	return get_context_menu_anchor_rect(element);
}

function useContextMenuContext() {
	const context = useContext(MyContextMenuContext);
	if (!context) {
		throw new Error("MyContextMenu components must be rendered within MyContextMenu");
	}

	return context;
}

// #region root
const MyContextMenuWindowBlurDismiss = memo(function MyContextMenuWindowBlurDismiss() {
	const menu = Ariakit.useMenuContext();

	useEffect(() => {
		const handleWindowBlur = () => {
			menu?.hide();
		};

		window.addEventListener("blur", handleWindowBlur);
		return () => window.removeEventListener("blur", handleWindowBlur);
	}, [menu]);

	return null;
});

export type MyContextMenu_Props = MyMenu_Props;

export const MyContextMenu = memo(function MyContextMenu(props: MyContextMenu_Props) {
	const { virtualFocus = true, children, ...rest } = props;
	const [anchorRect, setAnchorRect] = useState<MyContextMenuAnchorRect | null>(null);
	const contextValue = useMemo(() => ({ anchorRect, setAnchorRect }), [anchorRect]);

	return (
		<Ariakit.MenuProvider virtualFocus={virtualFocus} {...rest}>
			<MyContextMenuWindowBlurDismiss />
			<MyContextMenuContext.Provider value={contextValue}>{children}</MyContextMenuContext.Provider>
		</Ariakit.MenuProvider>
	);
});
// #endregion root

// #region trigger
export type MyContextMenuTrigger_CustomAttributes = {
	"data-my-context-menu-open": "";
};

export type MyContextMenuTrigger_Props = {
	children?: Ariakit.RoleProps["render"];
} & Omit<Ariakit.RoleProps, ExtractStrict<keyof Ariakit.RoleProps, "render">>;

export const MyContextMenuTrigger = memo(function MyContextMenuTrigger(props: MyContextMenuTrigger_Props) {
	const { ref, id, className, children, onContextMenu, onKeyDown, ...rest } = props;
	const context = useContextMenuContext();
	const menu = Ariakit.useMenuContext();
	const isMenuOpen = Ariakit.useStoreState(menu, "open") ?? false;

	const showMenu = (anchorRect: MyContextMenuAnchorRect | null, element: HTMLElement) => {
		context.setAnchorRect(anchorRect);
		// Mirror Ariakit's MenuButton.showMenu so Escape and keyboard navigation work when the
		// menu is opened from this trigger instead of a MenuButton in the same provider.
		menu?.setDisclosureElement(element);
		menu?.setAutoFocusOnShow(true);
		menu?.setInitialFocus("first");
		menu?.show();
	};

	const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
		onContextMenu?.(event);
		if (event.defaultPrevented || event.shiftKey) {
			return;
		}

		event.preventDefault();
		const anchorRect =
			event.clientX !== 0 || event.clientY !== 0
				? { x: event.clientX, y: event.clientY, width: 0, height: 0 }
				: get_context_menu_keyboard_anchor_rect(event.currentTarget);
		showMenu(anchorRect, event.currentTarget);
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		onKeyDown?.(event);
		if (event.defaultPrevented) {
			return;
		}

		if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
			return;
		}

		event.preventDefault();
		showMenu(get_context_menu_keyboard_anchor_rect(event.currentTarget), event.currentTarget);
	};

	return (
		<Ariakit.Role
			ref={ref}
			id={id}
			className={className}
			render={children}
			onContextMenu={handleContextMenu}
			onKeyDown={handleKeyDown}
			// Expose the open state for styling. The menu can be open while the trigger has no
			// aria-expanded: opening from the keyboard or a sibling MenuButton in the same provider.
			{...(isMenuOpen ? ({ "data-my-context-menu-open": "" } satisfies MyContextMenuTrigger_CustomAttributes) : null)}
			{...rest}
		/>
	);
});
// #endregion trigger

// #region button trigger
export type MyContextMenuButtonTrigger_Props = MyMenuTrigger_Props;

export const MyContextMenuButtonTrigger = memo(function MyContextMenuButtonTrigger(
	props: MyContextMenuButtonTrigger_Props,
) {
	const { onClick, onKeyDown, ...rest } = props;
	const context = useContextMenuContext();

	// Clear the right-click cursor rect so the menu anchors to this button.
	// MenuButton can render as a div or a button, so its handlers take the intersection event type.
	const handleClick = (event: ReactMouseEvent<HTMLDivElement> & ReactMouseEvent<HTMLButtonElement>) => {
		onClick?.(event);
		if (event.defaultPrevented) {
			return;
		}

		context.setAnchorRect(null);
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement> & ReactKeyboardEvent<HTMLButtonElement>) => {
		onKeyDown?.(event);
		if (event.defaultPrevented) {
			return;
		}

		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			context.setAnchorRect(null);
		}
	};

	return <MyMenuTrigger onClick={handleClick} onKeyDown={handleKeyDown} {...rest} />;
});
// #endregion button trigger

// #region popover
export type MyContextMenuPopover_Props = MyMenuPopover_Props;

export const MyContextMenuPopover = memo(function MyContextMenuPopover(props: MyContextMenuPopover_Props) {
	const { getAnchorRect, ...rest } = props;
	const context = useContextMenuContext();

	return (
		<MyMenuPopover
			getAnchorRect={(anchor) => {
				return context.anchorRect ?? getAnchorRect?.(anchor) ?? null;
			}}
			{...rest}
		/>
	);
});
// #endregion popover
