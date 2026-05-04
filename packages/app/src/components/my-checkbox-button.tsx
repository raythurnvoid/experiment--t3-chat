import "@/components/my-button.css";
import "./my-checkbox-button.css";

import { Check } from "lucide-react";
import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";

import { MyIcon } from "@/components/my-icon.tsx";
import type { MyButton_ClassNames } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";

export type MyCheckboxButton_ClassNames =
	| "MyCheckboxButton"
	| "MyCheckboxButton-state-checked"
	| "MyCheckboxButton-state-disabled"
	| "MyCheckboxButton-state-focus-visible"
	| "MyCheckboxButton-control"
	| "MyCheckboxButton-box"
	| "MyCheckboxButton-check";

export type MyCheckboxButton_Props = Omit<
	ComponentPropsWithRef<"input">,
	"type" | "children" | "className" | "style"
> & {
	ref?: Ref<HTMLInputElement>;
	className?: string;
	style?: ComponentPropsWithRef<"label">["style"];
	inputClassName?: string;
	variant?: "ghost_destructive" | "outline_destructive";
	children?: ReactNode;
	onCheckedChange?: (checked: boolean) => void;
};

export const MyCheckboxButton = memo(function MyCheckboxButton(props: MyCheckboxButton_Props) {
	const {
		ref,
		className,
		style,
		inputClassName,
		variant = "ghost_destructive",
		disabled,
		onChange,
		onCheckedChange,
		children,
		...rest
	} = props;

	const handleChange: ComponentPropsWithRef<"input">["onChange"] = (event) => {
		onChange?.(event);
		if (!event.defaultPrevented) {
			onCheckedChange?.(event.currentTarget.checked);
		}
	};

	return (
		<label
			className={cn(
				"MyCheckboxButton" satisfies MyCheckboxButton_ClassNames,
				"MyButton" satisfies MyButton_ClassNames,
				disabled && ("MyButton-state-disabled" satisfies MyButton_ClassNames),
				variant === "ghost_destructive" &&
					("MyButton-variant-ghost_destructive" satisfies MyButton_ClassNames),
				variant === "outline_destructive" &&
					("MyButton-variant-outline_destructive" satisfies MyButton_ClassNames),
				className,
			)}
			style={style}
			aria-disabled={disabled || undefined}
		>
			{/* Keep the native checkbox focusable so keyboard and label behavior stay browser-owned. */}
			<input
				ref={ref}
				className={cn("MyCheckboxButton-control" satisfies MyCheckboxButton_ClassNames, inputClassName)}
				type="checkbox"
				disabled={disabled}
				onChange={handleChange}
				{...rest}
			/>
			<span className={"MyCheckboxButton-box" satisfies MyCheckboxButton_ClassNames} aria-hidden>
				<Check className={"MyCheckboxButton-check" satisfies MyCheckboxButton_ClassNames} aria-hidden />
			</span>
			{children}
		</label>
	);
});

export type MyCheckboxButtonIcon_ClassNames = "MyCheckboxButtonIcon";

export type MyCheckboxButtonIcon_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	innerHtml?: string;
	children?: ReactNode;
};

export const MyCheckboxButtonIcon = memo(function MyCheckboxButtonIcon(props: MyCheckboxButtonIcon_Props) {
	const { ref, id, className, innerHtml, children, ...rest } = props;

	return (
		<MyIcon
			ref={ref}
			id={id}
			className={cn("MyCheckboxButtonIcon" satisfies MyCheckboxButtonIcon_ClassNames, className)}
			innerHtml={innerHtml}
			{...rest}
		>
			{children}
		</MyIcon>
	);
});
