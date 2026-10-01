import "@/components/my-button.css";
import "./my-checkbox-button.css";

import { Check } from "lucide-react";
import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";

import { MyIcon } from "@/components/my-icon.tsx";
import type { MyButton_ClassNames } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";

// #region icon
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
// #endregion icon

// #region content
export type MyCheckboxButtonContent_ClassNames = "MyCheckboxButtonContent";

export type MyCheckboxButtonContent_Props = ComponentPropsWithRef<"span">;

/**
 * The text column of a checkbox that carries a label and a description. It is the same as the text
 * column inside `MyRadioButton`.
 */
export const MyCheckboxButtonContent = memo(function MyCheckboxButtonContent(props: MyCheckboxButtonContent_Props) {
	const { className, children, ...rest } = props;

	return (
		<span className={cn("MyCheckboxButtonContent" satisfies MyCheckboxButtonContent_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
});
// #endregion content

// #region label
export type MyCheckboxButtonLabel_ClassNames = "MyCheckboxButtonLabel";

export type MyCheckboxButtonLabel_Props = ComponentPropsWithRef<"span">;

export const MyCheckboxButtonLabel = memo(function MyCheckboxButtonLabel(props: MyCheckboxButtonLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<span className={cn("MyCheckboxButtonLabel" satisfies MyCheckboxButtonLabel_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
});
// #endregion label

// #region description
export type MyCheckboxButtonDescription_ClassNames = "MyCheckboxButtonDescription";

export type MyCheckboxButtonDescription_Props = ComponentPropsWithRef<"span">;

export const MyCheckboxButtonDescription = memo(function MyCheckboxButtonDescription(
	props: MyCheckboxButtonDescription_Props,
) {
	const { className, children, ...rest } = props;

	return (
		<span
			className={cn("MyCheckboxButtonDescription" satisfies MyCheckboxButtonDescription_ClassNames, className)}
			{...rest}
		>
			{children}
		</span>
	);
});
// #endregion description

// #region root
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
	"type" | "children" | "className" | "name" | "style"
> & {
	ref?: Ref<HTMLInputElement>;
	/**
	 * Keep the checkbox group name unique across the app, for example by deriving it from React `useId()`.
	 */
	name?: string;
	className?: string;
	style?: ComponentPropsWithRef<"label">["style"];
	inputClassName?: string;
	/**
	 * `outline` is for a checkbox that picks something; the destructive ones remove something.
	 **/
	variant?: "ghost_destructive" | "outline_destructive" | "outline";
	children?: ReactNode;
	onCheckedChange?: (checked: boolean) => void;
};

/**
 * One checkbox drawn as a button. For a label with a description, put `MyCheckboxButtonContent`, `MyCheckboxButtonLabel`
 * and `MyCheckboxButtonDescription` inside, the same way `MyRadioButton` is used.
 *
 * Keep this in sync with `MyRadioButton` in `my-radio-button.tsx`. They sit side by side in the same
 * forms, so they must look the same: same outline button, border, padding, hover, focus, and disabled
 * look. When you change one, change the other.
 */
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
				variant === "ghost_destructive" && ("MyButton-variant-ghost_destructive" satisfies MyButton_ClassNames),
				variant === "outline_destructive" && ("MyButton-variant-outline_destructive" satisfies MyButton_ClassNames),
				variant === "outline" && ("MyButton-variant-outline" satisfies MyButton_ClassNames),
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
// #endregion root
