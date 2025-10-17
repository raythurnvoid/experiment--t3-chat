import "./my-select.css";
import * as Ariakit from "@ariakit/react";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import { MyIcon, type MyIcon_Props } from "./my-icon.tsx";
import { ChevronDownIcon, Check } from "lucide-react";

export type MySelect_ClassNames = "MySelect";

export type MySelect_Props = Ariakit.SelectProviderProps;

export function MySelect(props: MySelect_Props) {
	const { children, ...rest } = props;

	return <Ariakit.SelectProvider {...rest}>{children}</Ariakit.SelectProvider>;
}

export type MySelectLabel_ClassNames = "MySelectLabel";

export type MySelectLabel_Props = Ariakit.SelectLabelProps;

export function MySelectLabel(props: MySelectLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.SelectLabel className={cn("MySelectLabel" satisfies MySelectLabel_ClassNames, className)} {...rest}>
			{children}
		</Ariakit.SelectLabel>
	);
}

export type MySelectTrigger_ClassNames = "MySelectTrigger";

export type MySelectTrigger_Props = {
	children?: Ariakit.SelectProps["render"];
} & Omit<Ariakit.SelectProps, ExtractStrict<keyof Ariakit.SelectProps, "render" | "children">>;

export function MySelectTrigger(props: MySelectTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.Select
			ref={ref}
			className={cn("MySelectTrigger" satisfies MySelectTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
}

export type MySelectOpenIndicator_ClassNames = "MySelectOpenIndicator";

export type MySelectOpenIndicator_Props = {
	children?: React.ReactNode;
} & Omit<Ariakit.SelectArrowProps, ExtractStrict<keyof Ariakit.SelectArrowProps, "render" | "children">>;

export function MySelectOpenIndicator(props: MySelectOpenIndicator_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.SelectArrow
			className={cn("MySelectOpenIndicator" satisfies MySelectOpenIndicator_ClassNames, className)}
			render={<MyIcon>{children ?? <ChevronDownIcon />}</MyIcon>}
			{...rest}
		></Ariakit.SelectArrow>
	);
}

export type MySelectPopover_ClassNames = "MySelectPopover";

export type MySelectPopover_Props = Ariakit.SelectPopoverProps;

export function MySelectPopover(props: MySelectPopover_Props) {
	const { className, portal = true, sameWidth = false, gutter = 4, children, ...rest } = props;

	return (
		<Ariakit.SelectPopover
			className={cn("MySelectPopover" satisfies MySelectPopover_ClassNames, className)}
			gutter={gutter}
			sameWidth={sameWidth}
			portal={portal}
			{...rest}
		>
			{children}
		</Ariakit.SelectPopover>
	);
}

export type MySelectPopoverScrollableArea_ClassNames = "MySelectPopoverScrollableArea";

export type MySelectPopoverScrollableArea_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MySelectPopoverScrollableArea(props: MySelectPopoverScrollableArea_Props) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MySelectPopoverScrollableArea" satisfies MySelectPopoverScrollableArea_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}

export type MySelectPopoverContent_ClassNames = "MySelectPopoverContent";

export type MySelectPopoverContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MySelectPopoverContent(props: MySelectPopoverContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MySelectPopoverContent" satisfies MySelectPopoverContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySelectItem_ClassNames = "MySelectItem";

export type MySelectItem_Props = Ariakit.SelectItemProps;

export function MySelectItem(props: MySelectItem_Props) {
	const { className, value, children, ...rest } = props;

	return (
		<Ariakit.SelectItem
			className={cn("MySelectItem" satisfies MySelectItem_ClassNames, className)}
			value={value}
			{...rest}
		>
			{children}
		</Ariakit.SelectItem>
	);
}

export type MySelectItemIndicator_ClassNames = "MySelectItemIndicator";

export type MySelectItemIndicator_Props = MyIcon_Props;

export function MySelectItemIndicator(props: MySelectItemIndicator_Props) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon className={cn("MySelectItemIndicator" satisfies MySelectItemIndicator_ClassNames, className)} {...rest}>
			{children ?? <Check />}
		</MyIcon>
	);
}

export type MySelectItemContent_ClassNames = "MySelectItemContent";

export type MySelectItemContent_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MySelectItemContent(props: MySelectItemContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MySelectItemContent" satisfies MySelectItemContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySelectItemContentPrimary_ClassNames = "MySelectItemContentPrimary";

export type MySelectItemContentPrimary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MySelectItemContentPrimary(props: MySelectItemContentPrimary_Props) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MySelectItemContentPrimary" satisfies MySelectItemContentPrimary_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}

export type MySelectItemContentSecondary_ClassNames = "MySelectItemContentSecondary";

export type MySelectItemContentSecondary_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MySelectItemContentSecondary(props: MySelectItemContentSecondary_Props) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MySelectItemContentSecondary" satisfies MySelectItemContentSecondary_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}

export type MySelectItemContentIcon_ClassNames = "MySelectItemContentIcon";

export type MySelectItemContentIcon_Props = {
	children?: React.ReactNode;
	className?: string;
};

export function MySelectItemContentIcon(props: MySelectItemContentIcon_Props) {
	const { className, children, ...rest } = props;

	return (
		<MyIcon className={cn("MySelectItemContentIcon" satisfies MySelectItemContentIcon_ClassNames, className)} {...rest}>
			{children}
		</MyIcon>
	);
}

export type MySelectItemsGroup_ClassNames = "MySelectItemsGroup" | "MySelectItemsGroup-separator";

export type MySelectItemsGroup_Props = {
	children?: React.ReactNode;
	className?: string;
	separator?: boolean;
} & Omit<Ariakit.SelectGroupProps, "children" | "className">;

export function MySelectItemsGroup(props: MySelectItemsGroup_Props) {
	const { className, children, separator = false, ...rest } = props;

	return (
		<Ariakit.SelectGroup
			className={cn(
				"MySelectItemsGroup" satisfies MySelectItemsGroup_ClassNames,
				separator && ("MySelectItemsGroup-separator" satisfies MySelectItemsGroup_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</Ariakit.SelectGroup>
	);
}

export type MySelectItemsGroupText_ClassNames = "MySelectItemsGroupText";

export type MySelectItemsGroupText_Props = {
	children?: React.ReactNode;
	className?: string;
} & Omit<Ariakit.SelectGroupLabelProps, "children" | "className">;

export function MySelectItemsGroupText(props: MySelectItemsGroupText_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.SelectGroupLabel
			className={cn("MySelectItemsGroupText" satisfies MySelectItemsGroupText_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.SelectGroupLabel>
	);
}
