import "./my-menu.css";
import * as Ariakit from "@ariakit/react";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import { ChevronRight } from "lucide-react";
import { MyIcon, type MyIcon_Props } from "./my-icon.tsx";

// #region MyMenu
export type MyMenu_ClassNames = "MyMenu";

export type MyMenu_Props = Ariakit.MenuProviderProps;

export function MyMenu(props: MyMenu_Props) {
	const { virtualFocus = true, children, ...rest } = props;

	return (
		<Ariakit.MenuProvider virtualFocus={virtualFocus} {...rest}>
			{children}
		</Ariakit.MenuProvider>
	);
}
// #endregion MyMenu

// #region Trigger
export type MyMenuTrigger_ClassNames = "MyMenuTrigger";

export type MyMenuTrigger_Props = {
	children?: Ariakit.MenuButtonProps["render"];
} & Omit<Ariakit.MenuButtonProps, ExtractStrict<keyof Ariakit.MenuButtonProps, "render">>;

export function MyMenuTrigger(props: MyMenuTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.MenuButton
			ref={ref}
			id={id}
			className={cn("MyMenuTrigger" satisfies MyMenuTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
}
// #endregion Trigger

// #region Popover
export type MyMenuPopover_ClassNames = "MyMenuPopover";

export type MyMenuPopover_Props = Ariakit.MenuProps;

export function MyMenuPopover(props: MyMenuPopover_Props) {
	const { ref, id, className, portal = true, children, ...rest } = props;

	return (
		<Ariakit.Menu
			ref={ref}
			id={id}
			className={cn("MyMenuPopover" satisfies MyMenuPopover_ClassNames, className)}
			portal={portal}
			unmountOnHide={true}
			{...rest}
		>
			{children}
		</Ariakit.Menu>
	);
}
// #endregion Popover

// #region PopoverScrollableArea
export type MyMenuPopoverScrollableArea_ClassNames = "MyMenuPopoverScrollableArea";

export type MyMenuPopoverScrollableArea_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MyMenuPopoverScrollableArea(props: MyMenuPopoverScrollableArea_Props) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MyMenuPopoverScrollableArea" satisfies MyMenuPopoverScrollableArea_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}
// #endregion PopoverScrollableArea

// #region PopoverContent
export type MyMenuPopoverContent_ClassNames = "MyMenuPopoverContent";

export type MyMenuPopoverContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MyMenuPopoverContent(props: MyMenuPopoverContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyMenuPopoverContent" satisfies MyMenuPopoverContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}
// #endregion PopoverContent

// #region Item
export type MyMenuItem_ClassNames = "MyMenuItem" | "MyMenuItem-variant-destructive";

export type MyMenuItem_Props = Ariakit.MenuItemProps & {
	variant?: "default" | "destructive";
};

export function MyMenuItem(props: MyMenuItem_Props) {
	const { className, variant = "default", children, ...rest } = props;

	return (
		<Ariakit.MenuItem
			className={cn(
				"MyMenuItem" satisfies MyMenuItem_ClassNames,
				variant === "destructive" && ("MyMenuItem-variant-destructive" satisfies MyMenuItem_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</Ariakit.MenuItem>
	);
}
// #endregion Item

// #region ItemContent
export type MyMenuItemContent_ClassNames = "MyMenuItemContent";

export type MyMenuItemContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MyMenuItemContent(props: MyMenuItemContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyMenuItemContent" satisfies MyMenuItemContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}
// #endregion ItemContent

// #region ItemContentPrimary
export type MyMenuItemContentPrimary_ClassNames = "MyMenuItemContentPrimary";

export type MyMenuItemContentPrimary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MyMenuItemContentPrimary(props: MyMenuItemContentPrimary_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyMenuItemContentPrimary" satisfies MyMenuItemContentPrimary_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}
// #endregion ItemContentPrimary

// #region ItemContentSecondary
export type MyMenuItemContentSecondary_ClassNames = "MyMenuItemContentSecondary";

export type MyMenuItemContentSecondary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MyMenuItemContentSecondary(props: MyMenuItemContentSecondary_Props) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MyMenuItemContentSecondary" satisfies MyMenuItemContentSecondary_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}
// #endregion ItemContentSecondary

// #region ItemContentIcon
export type MyMenuItemContentIcon_ClassNames = "MyMenuItemContentIcon";

export type MyMenuItemContentIcon_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MyMenuItemContentIcon(props: MyMenuItemContentIcon_Props) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon className={cn("MyMenuItemContentIcon" satisfies MyMenuItemContentIcon_ClassNames, className)} {...rest}>
			{children}
		</MyIcon>
	);
}
// #endregion ItemContentIcon

// #region ItemSubMenuIndicator
export type MyMenuItemSubMenuIndicator_ClassNames = "MyMenuItemSubMenuIndicator";

export type MyMenuItemSubMenuIndicator_Props = MyIcon_Props;

export function MyMenuItemSubMenuIndicator(props: MyMenuItemSubMenuIndicator_Props) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon
			className={cn("MyMenuItemSubMenuIndicator" satisfies MyMenuItemSubMenuIndicator_ClassNames, className)}
			{...rest}
		>
			{children ?? <ChevronRight />}
		</MyIcon>
	);
}
// #endregion ItemSubMenuIndicator

// #region ItemsGroup
export type MyMenuItemsGroup_ClassNames = "MyMenuItemsGroup" | "MyMenuItemsGroup-separator";

export type MyMenuItemsGroup_Props = {
	separator?: boolean;
} & Ariakit.MenuGroupProps;

export function MyMenuItemsGroup(props: MyMenuItemsGroup_Props) {
	const { className, children, separator = false, ...rest } = props;

	return (
		<Ariakit.MenuGroup
			className={cn(
				"MyMenuItemsGroup" satisfies MyMenuItemsGroup_ClassNames,
				separator && ("MyMenuItemsGroup-separator" satisfies MyMenuItemsGroup_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</Ariakit.MenuGroup>
	);
}
// #endregion ItemsGroup

// #region ItemsGroupText
export type MyMenuItemsGroupText_ClassNames = "MyMenuItemsGroupText";

export type MyMenuItemsGroupText_Props = Ariakit.MenuGroupLabelProps;

export function MyMenuItemsGroupText(props: MyMenuItemsGroupText_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.MenuGroupLabel
			ref={ref}
			id={id}
			className={cn("MyMenuItemsGroupText" satisfies MyMenuItemsGroupText_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.MenuGroupLabel>
	);
}
// #endregion ItemsGroupText
