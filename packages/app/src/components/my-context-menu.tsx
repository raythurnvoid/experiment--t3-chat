import "./my-floating-surface.css";
import { ContextMenuTrigger, MenuProvider, type ContextMenuTriggerProps } from "native-popovers/menu";
import { memo } from "react";
import type { ExtractStrict } from "type-fest";
import {
	MyMenuPopover,
	MyMenuTrigger,
	type MyMenu_Props,
	type MyMenuPopover_Props,
	type MyMenuTrigger_Props,
} from "./my-menu.tsx";

// #region root
export type MyContextMenu_Props = MyMenu_Props;

/**
 * A menu that opens from a right click or a key on `MyContextMenuTrigger`. The menu closes when the
 * window loses focus.
 */
export const MyContextMenu = memo(function MyContextMenu(props: MyContextMenu_Props) {
	const { children, ...rest } = props;

	return <MenuProvider {...rest}>{children}</MenuProvider>;
});
// #endregion root

// #region trigger
export type MyContextMenuTrigger_Props = {
	children?: ContextMenuTriggerProps["render"];
} & Omit<ContextMenuTriggerProps, ExtractStrict<keyof ContextMenuTriggerProps, "render" | "children">>;

/**
 * A right click opens the menu at the pointer. The ContextMenu key and Shift+F10 open it at the
 * focused element inside the trigger, with the first item active.
 */
export const MyContextMenuTrigger = memo(function MyContextMenuTrigger(props: MyContextMenuTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return <ContextMenuTrigger ref={ref} id={id} className={className} render={children} {...rest} />;
});
// #endregion trigger

// #region button trigger
export type MyContextMenuButtonTrigger_Props = MyMenuTrigger_Props;

/**
 * A button that opens the same menu below itself, for users who do not right click.
 */
export const MyContextMenuButtonTrigger = memo(function MyContextMenuButtonTrigger(
	props: MyContextMenuButtonTrigger_Props,
) {
	return <MyMenuTrigger {...props} />;
});
// #endregion button trigger

// #region popover
export type MyContextMenuPopover_Props = MyMenuPopover_Props;

export const MyContextMenuPopover = memo(function MyContextMenuPopover(props: MyContextMenuPopover_Props) {
	return <MyMenuPopover {...props} />;
});
// #endregion popover
