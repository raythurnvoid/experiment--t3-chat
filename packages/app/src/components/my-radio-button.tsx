import "@/components/my-button.css";
import "./my-radio-button.css";

import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";

import { MyRadioSurface } from "@/components/my-radio-surface.tsx";
import type { MyButton_ClassNames } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";

// #region label
export type MyRadioButtonLabel_ClassNames = "MyRadioButtonLabel";

export type MyRadioButtonLabel_Props = ComponentPropsWithRef<"span">;

export const MyRadioButtonLabel = memo(function MyRadioButtonLabel(props: MyRadioButtonLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<span className={cn("MyRadioButtonLabel" satisfies MyRadioButtonLabel_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
});
// #endregion label

// #region description
export type MyRadioButtonDescription_ClassNames = "MyRadioButtonDescription";

export type MyRadioButtonDescription_Props = ComponentPropsWithRef<"span">;

export const MyRadioButtonDescription = memo(function MyRadioButtonDescription(props: MyRadioButtonDescription_Props) {
	const { className, children, ...rest } = props;

	return (
		<span className={cn("MyRadioButtonDescription" satisfies MyRadioButtonDescription_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
});
// #endregion description

// #region root
export type MyRadioButton_ClassNames =
	| "MyRadioButton"
	| "MyRadioButton-state-checked"
	| "MyRadioButton-state-disabled"
	| "MyRadioButton-state-focus-visible"
	| "MyRadioButton-control"
	| "MyRadioButton-content";

export type MyRadioButton_Props = Omit<
	ComponentPropsWithRef<"input">,
	"type" | "children" | "className" | "name" | "style"
> & {
	ref?: Ref<HTMLInputElement>;
	/**
	 * Keep the radio group name unique across the app, for example by deriving it from React `useId()`.
	 */
	name: string;
	className?: string;
	style?: ComponentPropsWithRef<"label">["style"];
	inputClassName?: string;
	children?: ReactNode;
};

/**
 * One radio choice drawn as an outline button. The whole button is the label, so a click anywhere on it
 * picks the choice. Put `MyRadioButtonLabel` and `MyRadioButtonDescription` inside for the text.
 *
 * Keep this in sync with `MyCheckboxButton` in `my-checkbox-button.tsx`. They sit side by side in the same
 * forms, so they must look the same: same outline button, border, padding, hover, focus, and disabled
 * look. When you change one, change the other.
 */
export const MyRadioButton = memo(function MyRadioButton(props: MyRadioButton_Props) {
	const { ref, className, style, inputClassName, disabled, children, ...rest } = props;

	return (
		<label
			className={cn(
				"MyRadioButton" satisfies MyRadioButton_ClassNames,
				"MyButton" satisfies MyButton_ClassNames,
				"MyButton-variant-outline" satisfies MyButton_ClassNames,
				disabled && ("MyButton-state-disabled" satisfies MyButton_ClassNames),
				className,
			)}
			style={style}
			aria-disabled={disabled || undefined}
		>
			{/* Keep the native radio focusable so keyboard and label behavior stay browser-owned. */}
			<input
				ref={ref}
				className={cn("MyRadioButton-control" satisfies MyRadioButton_ClassNames, inputClassName)}
				type="radio"
				disabled={disabled}
				{...rest}
			/>
			<MyRadioSurface />
			<span className={"MyRadioButton-content" satisfies MyRadioButton_ClassNames}>{children}</span>
		</label>
	);
});
// #endregion root
