import "./my-floating-surface.css";
import "./my-menu.css";
import {
	Menu,
	MenuButton,
	MenuGroup,
	MenuGroupLabel,
	MenuItem,
	MenuItemCheckbox,
	MenuProvider,
	type MenuButtonProps,
	type MenuGroupLabelProps,
	type MenuGroupProps,
	type MenuItemCheckboxProps,
	type MenuItemProps,
	type MenuProps,
	type MenuProviderProps,
} from "native-popovers/menu";
import { memo } from "react";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import { Check, ChevronRight } from "lucide-react";
import type { MyButton_ClassNames } from "@/components/my-button.tsx";
import type { MyCheckboxButton_ClassNames } from "@/components/my-checkbox-button.tsx";
import { MyIcon, type MyIcon_Props } from "./my-icon.tsx";

// #region items group text
export type MyMenuItemsGroupText_ClassNames = "MyMenuItemsGroupText";

export type MyMenuItemsGroupText_Props = MenuGroupLabelProps;

export const MyMenuItemsGroupText = memo(function MyMenuItemsGroupText(props: MyMenuItemsGroupText_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<MenuGroupLabel
			ref={ref}
			id={id}
			className={cn("MyMenuItemsGroupText" satisfies MyMenuItemsGroupText_ClassNames, className)}
			{...rest}
		>
			{children}
		</MenuGroupLabel>
	);
});
// #endregion items group text

// #region items group
export type MyMenuItemsGroup_ClassNames = "MyMenuItemsGroup" | "MyMenuItemsGroup-separator";

export type MyMenuItemsGroup_Props = {
	separator?: boolean;
} & MenuGroupProps;

export const MyMenuItemsGroup = memo(function MyMenuItemsGroup(props: MyMenuItemsGroup_Props) {
	const { className, children, separator = false, ...rest } = props;

	return (
		<MenuGroup
			className={cn(
				"MyMenuItemsGroup" satisfies MyMenuItemsGroup_ClassNames,
				separator && ("MyMenuItemsGroup-separator" satisfies MyMenuItemsGroup_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</MenuGroup>
	);
});
// #endregion items group

// #region item content primary
export type MyMenuItemContentPrimary_ClassNames = "MyMenuItemContentPrimary";

export type MyMenuItemContentPrimary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MyMenuItemContentPrimary = memo(function MyMenuItemContentPrimary(props: MyMenuItemContentPrimary_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyMenuItemContentPrimary" satisfies MyMenuItemContentPrimary_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion item content primary

// #region item content secondary
export type MyMenuItemContentSecondary_ClassNames = "MyMenuItemContentSecondary";

export type MyMenuItemContentSecondary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MyMenuItemContentSecondary = memo(function MyMenuItemContentSecondary(
	props: MyMenuItemContentSecondary_Props,
) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MyMenuItemContentSecondary" satisfies MyMenuItemContentSecondary_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion item content secondary

// #region item content icon
export type MyMenuItemContentIcon_ClassNames = "MyMenuItemContentIcon";

export type MyMenuItemContentIcon_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MyMenuItemContentIcon = memo(function MyMenuItemContentIcon(props: MyMenuItemContentIcon_Props) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon className={cn("MyMenuItemContentIcon" satisfies MyMenuItemContentIcon_ClassNames, className)} {...rest}>
			{children}
		</MyIcon>
	);
});
// #endregion item content icon

// #region item content
export type MyMenuItemContent_ClassNames = "MyMenuItemContent";

export type MyMenuItemContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MyMenuItemContent = memo(function MyMenuItemContent(props: MyMenuItemContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyMenuItemContent" satisfies MyMenuItemContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion item content

// #region item sub menu indicator
export type MyMenuItemSubMenuIndicator_ClassNames = "MyMenuItemSubMenuIndicator";

export type MyMenuItemSubMenuIndicator_Props = MyIcon_Props;

export const MyMenuItemSubMenuIndicator = memo(function MyMenuItemSubMenuIndicator(
	props: MyMenuItemSubMenuIndicator_Props,
) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon
			className={cn("MyMenuItemSubMenuIndicator" satisfies MyMenuItemSubMenuIndicator_ClassNames, className)}
			{...rest}
		>
			{children ?? <ChevronRight />}
		</MyIcon>
	);
});
// #endregion item sub menu indicator

// #region item
export type MyMenuItem_ClassNames = "MyMenuItem" | "MyMenuItem-variant-destructive";

export type MyMenuItem_Props = MenuItemProps & {
	variant?: "default" | "destructive";
};

export const MyMenuItem = memo(function MyMenuItem(props: MyMenuItem_Props) {
	const { className, variant = "default", children, ...rest } = props;

	return (
		<MenuItem
			className={cn(
				"MyMenuItem" satisfies MyMenuItem_ClassNames,
				variant === "destructive" && ("MyMenuItem-variant-destructive" satisfies MyMenuItem_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</MenuItem>
	);
});
// #endregion item

// #region checkbox item
export type MyMenuCheckboxItem_ClassNames = "MyMenuCheckboxItem";

export type MyMenuCheckboxItem_Props = MenuItemCheckboxProps;

export const MyMenuCheckboxItem = memo(function MyMenuCheckboxItem(props: MyMenuCheckboxItem_Props) {
	const { className, children, ...rest } = props;

	return (
		<MenuItemCheckbox
			className={cn(
				"MyMenuItem" satisfies MyMenuItem_ClassNames,
				"MyMenuCheckboxItem" satisfies MyMenuCheckboxItem_ClassNames,
				className,
			)}
			{...rest}
		>
			{children}
		</MenuItemCheckbox>
	);
});
// #endregion checkbox item

// #region checkbox item control
export type MyMenuCheckboxItemControl_ClassNames = "MyMenuCheckboxItemControl";

export type MyMenuCheckboxItemControl_Props = {
	className?: string;
	checked: boolean;
	disabled?: boolean;
};

export const MyMenuCheckboxItemControl = memo(function MyMenuCheckboxItemControl(
	props: MyMenuCheckboxItemControl_Props,
) {
	const { className, checked, disabled } = props;

	return (
		<span
			className={cn(
				"MyMenuCheckboxItemControl" satisfies MyMenuCheckboxItemControl_ClassNames,
				"MyCheckboxButton" satisfies MyCheckboxButton_ClassNames,
				"MyButton" satisfies MyButton_ClassNames,
				"MyButton-variant-ghost" satisfies MyButton_ClassNames,
				checked && ("MyCheckboxButton-state-checked" satisfies MyCheckboxButton_ClassNames),
				disabled && ("MyCheckboxButton-state-disabled" satisfies MyCheckboxButton_ClassNames),
				className,
			)}
			aria-hidden
		>
			<span className={"MyCheckboxButton-box" satisfies MyCheckboxButton_ClassNames}>
				<Check className={"MyCheckboxButton-check" satisfies MyCheckboxButton_ClassNames} />
			</span>
		</span>
	);
});
// #endregion checkbox item control

// #region popover content
export type MyMenuPopoverContent_ClassNames = "MyMenuPopoverContent";

export type MyMenuPopoverContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MyMenuPopoverContent = memo(function MyMenuPopoverContent(props: MyMenuPopoverContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyMenuPopoverContent" satisfies MyMenuPopoverContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion popover content

// #region popover
export type MyMenuPopover_ClassNames = "MyMenuPopover";

export type MyMenuPopover_Props = MenuProps;

/**
 * The menu. It adds no portal: it stays in the DOM where the caller renders it, and the browser shows
 * it in the top layer. Its DOM parent still gets its key events, and a pointer over it counts as hover
 * on that parent. So a caller inside a tree, a tablist, an element that reads keys, or a styled button
 * can render it with a React portal. It unmounts while closed unless the caller passes
 * `unmountOnHide={false}`.
 */
export const MyMenuPopover = memo(function MyMenuPopover(props: MyMenuPopover_Props) {
	const { ref, id, className, unmountOnHide = true, children, ...rest } = props;

	return (
		<Menu
			ref={ref}
			id={id}
			className={cn(
				"MyMenuPopover" satisfies MyMenuPopover_ClassNames,
				"app-scrollable" satisfies AppClassName,
				className,
			)}
			unmountOnHide={unmountOnHide}
			{...rest}
		>
			{children}
		</Menu>
	);
});
// #endregion popover

// #region trigger
export type MyMenuTrigger_ClassNames = "MyMenuTrigger";

export type MyMenuTrigger_Props = {
	children?: MenuButtonProps["render"];
} & Omit<MenuButtonProps, ExtractStrict<keyof MenuButtonProps, "render" | "children">>;

export const MyMenuTrigger = memo(function MyMenuTrigger(props: MyMenuTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<MenuButton
			ref={ref}
			id={id}
			className={cn("MyMenuTrigger" satisfies MyMenuTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
});
// #endregion trigger

// #region root
export type MyMenu_ClassNames = "MyMenu";

export type MyMenu_Props = MenuProviderProps;

export const MyMenu = memo(function MyMenu(props: MyMenu_Props) {
	const { children, ...rest } = props;

	return <MenuProvider {...rest}>{children}</MenuProvider>;
});
// #endregion root
