import "./my-menu.css";
import * as Ariakit from "@ariakit/react";
import { memo } from "react";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import { ChevronRight } from "lucide-react";
import { MyIcon, type MyIcon_Props } from "./my-icon.tsx";

// #region items group
export type MyMenuItemsGroup_ClassNames = "MyMenuItemsGroup" | "MyMenuItemsGroup-separator";

export type MyMenuItemsGroup_Props = {
	separator?: boolean;
} & Ariakit.MenuGroupProps;

export const MyMenuItemsGroup = memo(function MyMenuItemsGroup(props: MyMenuItemsGroup_Props) {
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
});

// #region items group text
export type MyMenuItemsGroupText_ClassNames = "MyMenuItemsGroupText";

export type MyMenuItemsGroupText_Props = Ariakit.MenuGroupLabelProps;

export const MyMenuItemsGroupText = memo(function MyMenuItemsGroupText(props: MyMenuItemsGroupText_Props) {
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
});
// #endregion items group text
// #endregion items group

// #region item
export type MyMenuItem_ClassNames = "MyMenuItem" | "MyMenuItem-variant-destructive";

export type MyMenuItem_Props = Ariakit.MenuItemProps & {
	variant?: "default" | "destructive";
};

export const MyMenuItem = memo(function MyMenuItem(props: MyMenuItem_Props) {
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
});

// #region item sub menu indicator
export type MyMenuItemSubMenuIndicator_ClassNames = "MyMenuItemSubMenuIndicator";

export type MyMenuItemSubMenuIndicator_Props = MyIcon_Props;

export const MyMenuItemSubMenuIndicator = memo(function MyMenuItemSubMenuIndicator(props: MyMenuItemSubMenuIndicator_Props) {
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

export const MyMenuItemContentSecondary = memo(function MyMenuItemContentSecondary(props: MyMenuItemContentSecondary_Props) {
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
// #endregion item content
// #endregion item

// #region popover
export type MyMenuPopover_ClassNames = "MyMenuPopover";

export type MyMenuPopover_Props = Ariakit.MenuProps;

export const MyMenuPopover = memo(function MyMenuPopover(props: MyMenuPopover_Props) {
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
});

// #region popover scrollable area
export type MyMenuPopoverScrollableArea_ClassNames = "MyMenuPopoverScrollableArea";

export type MyMenuPopoverScrollableArea_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MyMenuPopoverScrollableArea = memo(function MyMenuPopoverScrollableArea(props: MyMenuPopoverScrollableArea_Props) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MyMenuPopoverScrollableArea" satisfies MyMenuPopoverScrollableArea_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion popover scrollable area

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
// #endregion popover

// #region trigger
export type MyMenuTrigger_ClassNames = "MyMenuTrigger";

export type MyMenuTrigger_Props = {
	children?: Ariakit.MenuButtonProps["render"];
} & Omit<Ariakit.MenuButtonProps, ExtractStrict<keyof Ariakit.MenuButtonProps, "render">>;

export const MyMenuTrigger = memo(function MyMenuTrigger(props: MyMenuTrigger_Props) {
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
});
// #endregion trigger

// #region root
export type MyMenu_ClassNames = "MyMenu";

export type MyMenu_Props = Ariakit.MenuProviderProps;

export const MyMenu = memo(function MyMenu(props: MyMenu_Props) {
	const { virtualFocus = true, children, ...rest } = props;

	return (
		<Ariakit.MenuProvider virtualFocus={virtualFocus} {...rest}>
			{children}
		</Ariakit.MenuProvider>
	);
});
// #endregion root
