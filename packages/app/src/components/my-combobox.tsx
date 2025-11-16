import "./my-combobox.css";
import "./my-input.css";
import type { ComponentPropsWithRef, PointerEvent, ReactNode } from "react";
import * as Ariakit from "@ariakit/react";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import type {
	MyInputArea_ClassNames,
	MyInputControl_ClassNames,
	MyInputIcon_ClassNames,
	MyInputBox_ClassNames,
} from "./my-input.tsx";

export type MyCombobox_ClassNames = "MyCombobox";

export type MyCombobox_Props = Ariakit.ComboboxProviderProps;

export function MyCombobox(props: MyCombobox_Props) {
	const { children, ...rest } = props;

	return <Ariakit.ComboboxProvider {...rest}>{children}</Ariakit.ComboboxProvider>;
}

export type MyComboboxLabel_ClassNames = "MyComboboxLabel";

export type MyComboboxLabel_Props = Ariakit.ComboboxLabelProps;

export function MyComboboxLabel(props: MyComboboxLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.ComboboxLabel className={cn("MyComboboxLabel" satisfies MyComboboxLabel_ClassNames, className)} {...rest}>
			{children}
		</Ariakit.ComboboxLabel>
	);
}

export type MyComboboxInput_ClassNames = "MyComboboxInput";

export type MyComboboxInput_Props = ComponentPropsWithRef<"div"> & {
	children?: ReactNode;
};

export function MyComboboxInput(props: MyComboboxInput_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyComboboxInput" satisfies MyComboboxInput_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MyComboboxInputBox_ClassNames = "MyComboboxInputBox";

export type MyComboboxInputBox_Props = ComponentPropsWithRef<"div">;

export function MyComboboxInputBox(props: MyComboboxInputBox_Props) {
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
}

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

export function MyComboboxInputArea(props: MyComboboxInputArea_Props) {
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
					(areaElement.querySelector('input[aria-haspopup="listbox"]') as HTMLInputElement | null) ||
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
}

export type MyComboboxInputIcon_ClassNames = "MyComboboxInputIcon";

export type MyComboboxInputIcon_Props = ComponentPropsWithRef<"span"> & {
	children?: ReactNode;
};

export function MyComboboxInputIcon(props: MyComboboxInputIcon_Props) {
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
}

export type MyComboboxInputControl_ClassNames = "MyComboboxInputControl";

export type MyComboboxInputControl_Props = Omit<
	Ariakit.ComboboxProps,
	ExtractStrict<keyof Ariakit.ComboboxProps, "render" | "children">
> & {
	className?: string;
};

export function MyComboboxInputControl(props: MyComboboxInputControl_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<Ariakit.Combobox
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
}

export type MyComboboxList_ClassNames = "MyComboboxList";

export type MyComboboxList_Props = Ariakit.ComboboxListProps;

export function MyComboboxList(props: MyComboboxList_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.ComboboxList className={cn("MyComboboxList" satisfies MyComboboxList_ClassNames, className)} {...rest}>
			{children}
		</Ariakit.ComboboxList>
	);
}

export type MyComboboxPopover_ClassNames = "MyComboboxPopover";

export type MyComboboxPopover_Props = Ariakit.ComboboxPopoverProps;

export function MyComboboxPopover(props: MyComboboxPopover_Props) {
	const { className, portal = true, sameWidth = false, gutter = 4, children, ...rest } = props;

	return (
		<Ariakit.ComboboxPopover
			className={cn("MyComboboxPopover" satisfies MyComboboxPopover_ClassNames, className)}
			gutter={gutter}
			sameWidth={sameWidth}
			portal={portal}
			{...rest}
		>
			{children}
		</Ariakit.ComboboxPopover>
	);
}

export type MyComboboxPopoverScrollableArea_ClassNames = "MyComboboxPopoverScrollableArea";

export type MyComboboxPopoverScrollableArea_Props = {
	children?: ReactNode;
	className?: string;
};

export function MyComboboxPopoverScrollableArea(props: MyComboboxPopoverScrollableArea_Props) {
	const { className, children, ...rest } = props;

	return (
		<div
			className={cn("MyComboboxPopoverScrollableArea" satisfies MyComboboxPopoverScrollableArea_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}

export type MyComboboxPopoverContent_ClassNames = "MyComboboxPopoverContent";

export type MyComboboxPopoverContent_Props = {
	children?: ReactNode;
	className?: string;
};

export function MyComboboxPopoverContent(props: MyComboboxPopoverContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyComboboxPopoverContent" satisfies MyComboboxPopoverContent_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MyComboboxItem_ClassNames = "MyComboboxItem";

export type MyComboboxItem_Props = Ariakit.ComboboxItemProps;

export function MyComboboxItem(props: MyComboboxItem_Props) {
	const { className, value, children, ...rest } = props;

	return (
		<Ariakit.ComboboxItem
			className={cn("MyComboboxItem" satisfies MyComboboxItem_ClassNames, className)}
			value={value}
			focusOnHover
			{...rest}
		>
			{children}
		</Ariakit.ComboboxItem>
	);
}

export type MyComboboxEmpty_ClassNames = "MyComboboxEmpty";

export type MyComboboxEmpty_Props = {
	children?: ReactNode;
	className?: string;
};

export function MyComboboxEmpty(props: MyComboboxEmpty_Props) {
	const { className, children, ...rest } = props;

	return (
		<div className={cn("MyComboboxEmpty" satisfies MyComboboxEmpty_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MyComboboxGroup_ClassNames = "MyComboboxGroup" | "MyComboboxGroup-separator" | "MyComboboxGroupHeading";

export type MyComboboxGroup_Props = {
	children?: ReactNode;
	className?: string;
	separator?: boolean;
	heading?: ReactNode;
} & Omit<Ariakit.ComboboxGroupProps, "children" | "className">;

export function MyComboboxGroup(props: MyComboboxGroup_Props) {
	const { className, children, separator = false, heading, ...rest } = props;

	return (
		<Ariakit.ComboboxGroup
			className={cn(
				"MyComboboxGroup" satisfies MyComboboxGroup_ClassNames,
				separator && ("MyComboboxGroup-separator" satisfies MyComboboxGroup_ClassNames),
				className,
			)}
			{...rest}
		>
			{heading && <MyComboboxGroupHeading>{heading}</MyComboboxGroupHeading>}
			{children}
		</Ariakit.ComboboxGroup>
	);
}

export type MyComboboxGroupHeading_ClassNames = "MyComboboxGroupHeading";

export type MyComboboxGroupHeading_Props = {
	children?: ReactNode;
	className?: string;
} & Omit<Ariakit.ComboboxGroupLabelProps, "children" | "className">;

export function MyComboboxGroupHeading(props: MyComboboxGroupHeading_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.ComboboxGroupLabel
			className={cn("MyComboboxGroupHeading" satisfies MyComboboxGroupHeading_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.ComboboxGroupLabel>
	);
}

export type MyComboboxCancel_ClassNames = "MyComboboxCancel";

export type MyComboboxCancel_Props = Ariakit.ComboboxCancelProps;

export function MyComboboxCancel(props: MyComboboxCancel_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.ComboboxCancel
			className={cn("MyComboboxCancel" satisfies MyComboboxCancel_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.ComboboxCancel>
	);
}
