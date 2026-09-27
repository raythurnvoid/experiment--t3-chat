import "./my-floating-surface.css";
import "./my-select.css";
import {
	Select,
	SelectGroup,
	SelectGroupLabel,
	SelectItem,
	SelectLabel,
	SelectPopover,
	SelectProvider,
	type SelectGroupLabelProps,
	type SelectGroupProps,
	type SelectItemProps,
	type SelectLabelProps,
	type SelectPopoverProps,
	type SelectProps,
	type SelectProviderProps,
	type SelectValue,
} from "native-popovers/select";
import { memo } from "react";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import { MyIcon, type MyIcon_Props } from "./my-icon.tsx";
import { ChevronDownIcon, Check } from "lucide-react";

// #region items group text
export type MySelectItemsGroupText_ClassNames = "MySelectItemsGroupText";

export type MySelectItemsGroupText_Props = SelectGroupLabelProps;

export const MySelectItemsGroupText = memo(function MySelectItemsGroupText(props: MySelectItemsGroupText_Props) {
	const { className, children, ...rest } = props;

	return (
		<SelectGroupLabel
			className={cn("MySelectItemsGroupText" satisfies MySelectItemsGroupText_ClassNames, className)}
			{...rest}
		>
			{children}
		</SelectGroupLabel>
	);
});
// #endregion items group text

// #region item content primary
export type MySelectItemContentPrimary_ClassNames = "MySelectItemContentPrimary";

export type MySelectItemContentPrimary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MySelectItemContentPrimary = memo(function MySelectItemContentPrimary(
	props: MySelectItemContentPrimary_Props,
) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MySelectItemContentPrimary" satisfies MySelectItemContentPrimary_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion item content primary

// #region item content secondary
export type MySelectItemContentSecondary_ClassNames = "MySelectItemContentSecondary";

export type MySelectItemContentSecondary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MySelectItemContentSecondary = memo(function MySelectItemContentSecondary(
	props: MySelectItemContentSecondary_Props,
) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MySelectItemContentSecondary" satisfies MySelectItemContentSecondary_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion item content secondary

// #region item content icon
export type MySelectItemContentIcon_ClassNames = "MySelectItemContentIcon";

export type MySelectItemContentIcon_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MySelectItemContentIcon = memo(function MySelectItemContentIcon(props: MySelectItemContentIcon_Props) {
	const { className, children, ...rest } = props;

	// The icon is decorative (a sample letter or a lucide icon). Hidden, it stays out of the option's
	// accessible name and out of typeahead, so `p` reaches `Purple`, not the sample `A`.
	return (
		<MyIcon
			className={cn("MySelectItemContentIcon" satisfies MySelectItemContentIcon_ClassNames, className)}
			aria-hidden
			{...rest}
		>
			{children}
		</MyIcon>
	);
});
// #endregion item content icon

// #region item content
export type MySelectItemContent_ClassNames = "MySelectItemContent";

export type MySelectItemContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MySelectItemContent = memo(function MySelectItemContent(props: MySelectItemContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MySelectItemContent" satisfies MySelectItemContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion item content

// #region item indicator
export type MySelectItemIndicator_ClassNames = "MySelectItemIndicator";

export type MySelectItemIndicator_Props = MyIcon_Props;

export const MySelectItemIndicator = memo(function MySelectItemIndicator(props: MySelectItemIndicator_Props) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon className={cn("MySelectItemIndicator" satisfies MySelectItemIndicator_ClassNames, className)} {...rest}>
			{children ?? <Check />}
		</MyIcon>
	);
});
// #endregion item indicator

// #region item
export type MySelectItem_ClassNames = "MySelectItem";

export type MySelectItem_Props = SelectItemProps;

export const MySelectItem = memo(function MySelectItem(props: MySelectItem_Props) {
	const { className, value, children, ...rest } = props;

	return (
		<SelectItem className={cn("MySelectItem" satisfies MySelectItem_ClassNames, className)} value={value} {...rest}>
			{children}
		</SelectItem>
	);
});
// #endregion item

// #region items group
export type MySelectItemsGroup_ClassNames = "MySelectItemsGroup" | "MySelectItemsGroup-separator";

export type MySelectItemsGroup_Props = {
	separator?: boolean;
} & SelectGroupProps;

export const MySelectItemsGroup = memo(function MySelectItemsGroup(props: MySelectItemsGroup_Props) {
	const { className, children, separator = false, ...rest } = props;

	return (
		<SelectGroup
			className={cn(
				"MySelectItemsGroup" satisfies MySelectItemsGroup_ClassNames,
				separator && ("MySelectItemsGroup-separator" satisfies MySelectItemsGroup_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</SelectGroup>
	);
});
// #endregion items group

// #region popover scrollable area
export type MySelectPopoverScrollableArea_ClassNames = "MySelectPopoverScrollableArea";

export type MySelectPopoverScrollableArea_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MySelectPopoverScrollableArea = memo(function MySelectPopoverScrollableArea(
	props: MySelectPopoverScrollableArea_Props,
) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn(
				"MySelectPopoverScrollableArea" satisfies MySelectPopoverScrollableArea_ClassNames,
				"app-scrollable" satisfies AppClassName,
				className,
			)}
			// Chromium and Firefox make an overflowing scroller a Tab stop. Focus must stay on the listbox.
			tabIndex={-1}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion popover scrollable area

// #region popover content
export type MySelectPopoverContent_ClassNames = "MySelectPopoverContent";

export type MySelectPopoverContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export const MySelectPopoverContent = memo(function MySelectPopoverContent(props: MySelectPopoverContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MySelectPopoverContent" satisfies MySelectPopoverContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion popover content

// #region popover
export type MySelectPopover_ClassNames = "MySelectPopover";

export type MySelectPopover_Props = SelectPopoverProps;

/**
 * The list. It adds no portal: it stays in the DOM where the caller renders it, and the browser shows
 * it in the top layer. So inside a `MyModal` it stays inside the dialog, and its key events still reach
 * the DOM parents of its trigger.
 */
export const MySelectPopover = memo(function MySelectPopover(props: MySelectPopover_Props) {
	const { className, sameWidth = false, gutter = 4, children, ...rest } = props;

	return (
		<SelectPopover
			className={cn("MySelectPopover" satisfies MySelectPopover_ClassNames, className)}
			gutter={gutter}
			sameWidth={sameWidth}
			{...rest}
		>
			{children}
		</SelectPopover>
	);
});
// #endregion popover

// #region open indicator
export type MySelectOpenIndicator_ClassNames = "MySelectOpenIndicator";

export type MySelectOpenIndicator_Props = MyIcon_Props;

export const MySelectOpenIndicator = memo(function MySelectOpenIndicator(props: MySelectOpenIndicator_Props) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon
			className={cn("MySelectOpenIndicator" satisfies MySelectOpenIndicator_ClassNames, className)}
			aria-hidden
			{...rest}
		>
			{children ?? <ChevronDownIcon />}
		</MyIcon>
	);
});
// #endregion open indicator

// #region label
export type MySelectLabel_ClassNames = "MySelectLabel";

export type MySelectLabel_Props = SelectLabelProps;

export const MySelectLabel = memo(function MySelectLabel(props: MySelectLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<SelectLabel className={cn("MySelectLabel" satisfies MySelectLabel_ClassNames, className)} {...rest}>
			{children}
		</SelectLabel>
	);
});
// #endregion label

// #region trigger
export type MySelectTrigger_ClassNames = "MySelectTrigger";

export type MySelectTrigger_Props = {
	children?: SelectProps["render"];
} & Omit<SelectProps, ExtractStrict<keyof SelectProps, "render" | "children">>;

export const MySelectTrigger = memo(function MySelectTrigger(props: MySelectTrigger_Props) {
	const { className, children, ...rest } = props;

	return (
		<Select className={cn("MySelectTrigger" satisfies MySelectTrigger_ClassNames, className)} render={children} {...rest} />
	);
});
// #endregion trigger

// #region root
export type MySelect_ClassNames = "MySelect";

export type MySelect_Props<V extends SelectValue = SelectValue> = SelectProviderProps<V>;

export const MySelect = memo(function MySelect(props: MySelect_Props) {
	const { children, ...rest } = props;

	return <SelectProvider {...rest}>{children}</SelectProvider>;
});
// #endregion root
