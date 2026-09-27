import "./my-search-select.css";

import { SelectItem, SelectList, SelectSearch, type SelectListProps, type SelectSearchProps } from "native-popovers/select";
import { memo } from "react";
import type { ExtractStrict } from "type-fest";

import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	type MyInputControl_ClassNames,
} from "@/components/my-input.tsx";
import {
	MySelect,
	MySelectItem,
	type MySelect_Props,
	type MySelectItem_Props,
	MySelectLabel,
	type MySelectLabel_Props,
	MySelectPopover,
	type MySelectPopover_Props,
	MySelectPopoverContent,
	type MySelectPopoverContent_Props,
	MySelectPopoverScrollableArea,
	type MySelectPopoverScrollableArea_Props,
	MySelectTrigger,
	type MySelectTrigger_Props,
} from "@/components/my-select.tsx";
import { cn } from "@/lib/utils.ts";

// #region item
export type MySearchSelectItem_ClassNames = "MySearchSelectItem";

export type MySearchSelectItem_Props = Omit<MySelectItem_Props, ExtractStrict<keyof MySelectItem_Props, "render">>;

export const MySearchSelectItem = memo(function MySearchSelectItem(props: MySearchSelectItem_Props) {
	const { className, ...rest } = props;

	return <MySelectItem className={cn("MySearchSelectItem" satisfies MySearchSelectItem_ClassNames, className)} {...rest} />;
});
// #endregion item

// #region list
export type MySearchSelectList_ClassNames = "MySearchSelectList";

export type MySearchSelectList_Props = SelectListProps;

export const MySearchSelectList = memo(function MySearchSelectList(props: MySearchSelectList_Props) {
	const { className, ...rest } = props;

	return <SelectList className={cn("MySearchSelectList" satisfies MySearchSelectList_ClassNames, className)} {...rest} />;
});
// #endregion list

// #region search
export type MySearchSelectSearch_ClassNames = "MySearchSelectSearch";

export type MySearchSelectSearch_Props = {
	className?: string;
	inputClassName?: string;
} & Omit<SelectSearchProps, ExtractStrict<keyof SelectSearchProps, "className">>;

/**
 * The search input at the top of the list. The select moves focus here when it opens, so it needs no
 * `autoFocus`. The caller filters the options from its `onChange` or its controlled `value`.
 */
export const MySearchSelectSearch = memo(function MySearchSelectSearch(props: MySearchSelectSearch_Props) {
	const { className, inputClassName, autoSelect = true, ...rest } = props;

	return (
		<div className={cn("MySearchSelectSearch" satisfies MySearchSelectSearch_ClassNames, className)}>
			<MyInput variant="floating">
				<MyInputBackground />
				<MyInputArea>
					<SelectSearch
						className={cn("MyInputControl" satisfies MyInputControl_ClassNames, inputClassName)}
						autoSelect={autoSelect}
						{...rest}
					/>
				</MyInputArea>
				<MyInputBox />
			</MyInput>
		</div>
	);
});
// #endregion search

// #region popover
export type MySearchSelectPopover_ClassNames = "MySearchSelectPopover";

export type MySearchSelectPopover_Props = MySelectPopover_Props;

export const MySearchSelectPopover = memo(function MySearchSelectPopover(props: MySearchSelectPopover_Props) {
	const { className, ...rest } = props;

	return (
		<MySelectPopover
			className={cn("MySearchSelectPopover" satisfies MySearchSelectPopover_ClassNames, className)}
			{...rest}
		/>
	);
});

// #region popover scrollable area
export type MySearchSelectPopoverScrollableArea_ClassNames = "MySearchSelectPopoverScrollableArea";

export type MySearchSelectPopoverScrollableArea_Props = MySelectPopoverScrollableArea_Props;

export const MySearchSelectPopoverScrollableArea = memo(function MySearchSelectPopoverScrollableArea(
	props: MySearchSelectPopoverScrollableArea_Props,
) {
	const { className, ...rest } = props;

	return (
		<MySelectPopoverScrollableArea
			className={cn(
				"MySearchSelectPopoverScrollableArea" satisfies MySearchSelectPopoverScrollableArea_ClassNames,
				className,
			)}
			{...rest}
		/>
	);
});
// #endregion popover scrollable area

// #region popover content
export type MySearchSelectPopoverContent_ClassNames = "MySearchSelectPopoverContent";

export type MySearchSelectPopoverContent_Props = MySelectPopoverContent_Props;

export const MySearchSelectPopoverContent = memo(function MySearchSelectPopoverContent(
	props: MySearchSelectPopoverContent_Props,
) {
	const { className, ...rest } = props;

	return (
		<MySelectPopoverContent
			className={cn("MySearchSelectPopoverContent" satisfies MySearchSelectPopoverContent_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion popover content
// #endregion popover

// #region trigger
export type MySearchSelectTrigger_ClassNames = "MySearchSelectTrigger";

export type MySearchSelectTrigger_Props = MySelectTrigger_Props;

export const MySearchSelectTrigger = memo(function MySearchSelectTrigger(props: MySearchSelectTrigger_Props) {
	const { className, ...rest } = props;

	return (
		<MySelectTrigger
			className={cn("MySearchSelectTrigger" satisfies MySearchSelectTrigger_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion trigger

// #region label
export type MySearchSelectLabel_ClassNames = "MySearchSelectLabel";

export type MySearchSelectLabel_Props = MySelectLabel_Props;

export const MySearchSelectLabel = memo(function MySearchSelectLabel(props: MySearchSelectLabel_Props) {
	const { className, ...rest } = props;

	return (
		<MySelectLabel
			className={cn("MySearchSelectLabel" satisfies MySearchSelectLabel_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion label

// #region root
export type MySearchSelect_ClassNames = "MySearchSelect";

export type MySearchSelect_Props = MySelect_Props<string>;

const MySearchSelect = Object.assign(
	memo(function MySearchSelect(props: MySearchSelect_Props) {
		const { children, ...rest } = props;

		return <MySelect {...rest}>{children}</MySelect>;
	}),
	{
		/**
		 * Whether the option with this value is the active one. Use it inside an option, for example to
		 * keep a row's action buttons out of the Tab order unless the row is active.
		 */
		useSelectItemActive: function useSelectItemActive(value: string) {
			return SelectItem.useActive(value);
		},
	},
);

export { MySearchSelect };
// #endregion root
