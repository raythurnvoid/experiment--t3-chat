import "./my-floating-surface.css";
import "./my-combobox.css";
import "./my-input.css";
import { memo, type ComponentPropsWithRef, type PointerEvent, type ReactNode } from "react";
import {
	Combobox,
	ComboboxCancel,
	ComboboxGroup,
	ComboboxGroupLabel,
	ComboboxItem,
	ComboboxLabel,
	ComboboxList,
	ComboboxPopover,
	ComboboxProvider,
	type ComboboxCancelProps,
	type ComboboxGroupLabelProps,
	type ComboboxGroupProps,
	type ComboboxItemProps,
	type ComboboxLabelProps,
	type ComboboxListProps,
	type ComboboxPopoverProps,
	type ComboboxProps,
	type ComboboxProviderProps,
} from "native-popovers/combobox";
import type { AppClassName } from "@/lib/dom-utils.ts";
import type { MyFloatingSurface_ClassNames } from "@/components/my-floating-surface.tsx";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import type {
	MyInputArea_ClassNames,
	MyInputControl_ClassNames,
	MyInputIcon_ClassNames,
	MyInputBackground_ClassNames,
	MyInputBox_ClassNames,
} from "./my-input.tsx";

// #region input
export type MyCombobox_ClassNames = "MyCombobox";

export type MyCombobox_Props = ComboboxProviderProps;

export const MyCombobox = memo(function MyCombobox(props: MyCombobox_Props) {
	const { children, ...rest } = props;

	return <ComboboxProvider {...rest}>{children}</ComboboxProvider>;
});

export type MyComboboxLabel_ClassNames = "MyComboboxLabel";

export type MyComboboxLabel_Props = ComboboxLabelProps;

export const MyComboboxLabel = memo(function MyComboboxLabel(props: MyComboboxLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<ComboboxLabel className={cn("MyComboboxLabel" satisfies MyComboboxLabel_ClassNames, className)} {...rest}>
			{children}
		</ComboboxLabel>
	);
});

export type MyComboboxInput_ClassNames = "MyComboboxInput";

export type MyComboboxInput_Props = ComponentPropsWithRef<"div"> & {
	children?: ReactNode;
};

export const MyComboboxInput = memo(function MyComboboxInput(props: MyComboboxInput_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyComboboxInput" satisfies MyComboboxInput_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});

export type MyComboboxInputBackground_ClassNames = "MyComboboxInputBackground";

export type MyComboboxInputBackground_Props = ComponentPropsWithRef<"div">;

export const MyComboboxInputBackground = memo(function MyComboboxInputBackground(
	props: MyComboboxInputBackground_Props,
) {
	const { ref, className, ...rest } = props;

	return (
		<div
			ref={ref}
			className={cn(
				"MyComboboxInputBackground" satisfies MyComboboxInputBackground_ClassNames,
				"MyInputBackground" satisfies MyInputBackground_ClassNames,
				className,
			)}
			{...rest}
		/>
	);
});

export type MyComboboxInputBox_ClassNames = "MyComboboxInputBox";

export type MyComboboxInputBox_Props = ComponentPropsWithRef<"div">;

export const MyComboboxInputBox = memo(function MyComboboxInputBox(props: MyComboboxInputBox_Props) {
	const { ref, className, ...rest } = props;

	return (
		<div
			ref={ref}
			className={cn(
				"MyComboboxInputBox" satisfies MyComboboxInputBox_ClassNames,
				"MyInputBox" satisfies MyInputBox_ClassNames,
				className,
			)}
			{...rest}
		/>
	);
});

export type MyComboboxInputArea_ClassNames = "MyComboboxInputArea";

export type MyComboboxInputArea_Props = ComponentPropsWithRef<"div"> & {
	children?: ReactNode;
	/**
	 * When `true`, clicking anywhere on the input area will focus the combobox input element,
	 * unless the click target is a button or a link.
	 *
	 * @default true
	 */
	focusForwarding?: boolean;
};

export const MyComboboxInputArea = memo(function MyComboboxInputArea(props: MyComboboxInputArea_Props) {
	const { ref, className, style, focusForwarding = true, onPointerDown, children, ...rest } = props;

	const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (focusForwarding) {
			// Don't focus if click target is a button or link or is the input itself
			const target = event.target as HTMLElement;
			const targetIsInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
			const targetIsButton =
				target.tagName === "BUTTON" || Boolean(target.closest("button")) || target.getAttribute("role") === "button";
			const targetIsLink = target.tagName === "A" || Boolean(target.closest("a"));

			if (!targetIsInput && !targetIsButton && !targetIsLink) {
				// Find the combobox input element within this area
				const areaElement = event.currentTarget;
				const comboboxInput =
					(areaElement.querySelector('input[role="combobox"]') as HTMLInputElement | null) ||
					(areaElement.querySelector("input") as HTMLInputElement | null);
				if (comboboxInput) {
					event.preventDefault();
					comboboxInput.focus();
				}
			}
		}

		onPointerDown?.(event);
	};

	return (
		<div
			ref={ref}
			className={cn(
				"MyComboboxInputArea" satisfies MyComboboxInputArea_ClassNames,
				"MyInputArea" satisfies MyInputArea_ClassNames,
				className,
			)}
			style={style}
			onPointerDown={handlePointerDown}
			{...rest}
		>
			{children}
		</div>
	);
});

export type MyComboboxInputIcon_ClassNames = "MyComboboxInputIcon";

export type MyComboboxInputIcon_Props = ComponentPropsWithRef<"span"> & {
	children?: ReactNode;
};

export const MyComboboxInputIcon = memo(function MyComboboxInputIcon(props: MyComboboxInputIcon_Props) {
	const { ref, className, children, ...rest } = props;

	return (
		<span
			ref={ref}
			className={cn(
				"MyComboboxInputIcon" satisfies MyComboboxInputIcon_ClassNames,
				"MyInputIcon" satisfies MyInputIcon_ClassNames,
				className,
			)}
			{...rest}
		>
			{children}
		</span>
	);
});

export type MyComboboxInputControl_ClassNames = "MyComboboxInputControl";

export type MyComboboxInputControl_Props = Omit<ComboboxProps, ExtractStrict<keyof ComboboxProps, "children">>;

export const MyComboboxInputControl = memo(function MyComboboxInputControl(props: MyComboboxInputControl_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<Combobox
			ref={ref}
			id={id}
			className={cn(
				"MyComboboxInputControl" satisfies MyComboboxInputControl_ClassNames,
				"MyInputControl" satisfies MyInputControl_ClassNames,
				className,
			)}
			{...rest}
		/>
	);
});
// #endregion input

// #region popover
export type MyComboboxList_ClassNames = "MyComboboxList";

export type MyComboboxList_Props = ComboboxListProps;

export const MyComboboxList = memo(function MyComboboxList(props: MyComboboxList_Props) {
	const { className, children, ...rest } = props;

	return (
		<ComboboxList
			className={cn(
				"MyComboboxList" satisfies MyComboboxList_ClassNames,
				"app-scrollable" satisfies AppClassName,
				className,
			)}
			{...rest}
		>
			{children}
		</ComboboxList>
	);
});

export type MyComboboxPopover_ClassNames = "MyComboboxPopover";

export type MyComboboxPopover_Props = ComboboxPopoverProps;

/**
 * The popup. It adds no portal: it stays in the DOM where the caller renders it, and the browser shows
 * it in the top layer, so it follows the input when a scroll container moves it.
 */
export const MyComboboxPopover = memo(function MyComboboxPopover(props: MyComboboxPopover_Props) {
	const { className, sameWidth = false, gutter = 4, children, ...rest } = props;

	return (
		<ComboboxPopover
			className={cn(
				"MyComboboxPopover" satisfies MyComboboxPopover_ClassNames,
				"MyFloatingSurface" satisfies MyFloatingSurface_ClassNames,
				className,
			)}
			gutter={gutter}
			sameWidth={sameWidth}
			{...rest}
		>
			{children}
		</ComboboxPopover>
	);
});

export type MyComboboxPopoverScrollableArea_ClassNames = "MyComboboxPopoverScrollableArea";

export type MyComboboxPopoverScrollableArea_Props = {
	children?: ReactNode;
	className?: string;
};

export const MyComboboxPopoverScrollableArea = memo(function MyComboboxPopoverScrollableArea(
	props: MyComboboxPopoverScrollableArea_Props,
) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn(
				"MyComboboxPopoverScrollableArea" satisfies MyComboboxPopoverScrollableArea_ClassNames,
				"app-scrollable" satisfies AppClassName,
				className,
			)}
			// Chromium and Firefox make an overflowing scroller a Tab stop. Focus must stay in the input.
			tabIndex={-1}
			{...rest}
		>
			{children}
		</div>
	);
});

export type MyComboboxPopoverContent_ClassNames = "MyComboboxPopoverContent";

export type MyComboboxPopoverContent_Props = {
	children?: ReactNode;
	className?: string;
};

export const MyComboboxPopoverContent = memo(function MyComboboxPopoverContent(props: MyComboboxPopoverContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyComboboxPopoverContent" satisfies MyComboboxPopoverContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});

export type MyComboboxItem_ClassNames = "MyComboboxItem";

export type MyComboboxItem_Props = ComboboxItemProps;

export const MyComboboxItem = memo(function MyComboboxItem(props: MyComboboxItem_Props) {
	const { className, value, children, ...rest } = props;

	return (
		<ComboboxItem className={cn("MyComboboxItem" satisfies MyComboboxItem_ClassNames, className)} value={value} {...rest}>
			{children}
		</ComboboxItem>
	);
});

export type MyComboboxEmpty_ClassNames = "MyComboboxEmpty";

export type MyComboboxEmpty_Props = {
	children?: ReactNode;
	className?: string;
};

export const MyComboboxEmpty = memo(function MyComboboxEmpty(props: MyComboboxEmpty_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyComboboxEmpty" satisfies MyComboboxEmpty_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});

export type MyComboboxGroup_ClassNames = "MyComboboxGroup" | "MyComboboxGroup-separator" | "MyComboboxGroupHeading";

export type MyComboboxGroup_Props = {
	children?: ReactNode;
	className?: string;
	separator?: boolean;
	heading?: ReactNode;
} & Omit<ComboboxGroupProps, ExtractStrict<keyof ComboboxGroupProps, "children" | "className">>;

export const MyComboboxGroup = memo(function MyComboboxGroup(props: MyComboboxGroup_Props) {
	const { className, children, separator = false, heading, ...rest } = props;

	return (
		<ComboboxGroup
			className={cn(
				"MyComboboxGroup" satisfies MyComboboxGroup_ClassNames,
				separator && ("MyComboboxGroup-separator" satisfies MyComboboxGroup_ClassNames),
				className,
			)}
			{...rest}
		>
			{heading && <MyComboboxGroupHeading>{heading}</MyComboboxGroupHeading>}
			{children}
		</ComboboxGroup>
	);
});

export type MyComboboxGroupHeading_ClassNames = "MyComboboxGroupHeading";

export type MyComboboxGroupHeading_Props = {
	children?: ReactNode;
	className?: string;
} & Omit<ComboboxGroupLabelProps, ExtractStrict<keyof ComboboxGroupLabelProps, "children" | "className">>;

export const MyComboboxGroupHeading = memo(function MyComboboxGroupHeading(props: MyComboboxGroupHeading_Props) {
	const { className, children, ...rest } = props;

	return (
		<ComboboxGroupLabel
			className={cn("MyComboboxGroupHeading" satisfies MyComboboxGroupHeading_ClassNames, className)}
			{...rest}
		>
			{children}
		</ComboboxGroupLabel>
	);
});

export type MyComboboxCancel_ClassNames = "MyComboboxCancel";

export type MyComboboxCancel_Props = ComboboxCancelProps;

export const MyComboboxCancel = memo(function MyComboboxCancel(props: MyComboboxCancel_Props) {
	const { className, children, ...rest } = props;

	return (
		<ComboboxCancel className={cn("MyComboboxCancel" satisfies MyComboboxCancel_ClassNames, className)} {...rest}>
			{children}
		</ComboboxCancel>
	);
});
// #endregion popover
