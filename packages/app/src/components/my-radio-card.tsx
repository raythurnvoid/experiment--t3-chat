import "./my-radio-card.css";

import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";

import { MyRadioSurface } from "@/components/my-radio-surface.tsx";
import { cn } from "@/lib/utils.ts";

// #region label
export type MyRadioCardLabel_ClassNames = "MyRadioCardLabel";

export type MyRadioCardLabel_Props = ComponentPropsWithRef<"label">;

export const MyRadioCardLabel = memo(function MyRadioCardLabel(props: MyRadioCardLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<label className={cn("MyRadioCardLabel" satisfies MyRadioCardLabel_ClassNames, className)} {...rest}>
			{children}
		</label>
	);
});
// #endregion label

// #region description
export type MyRadioCardDescription_ClassNames = "MyRadioCardDescription";

export type MyRadioCardDescription_Props = ComponentPropsWithRef<"span">;

export const MyRadioCardDescription = memo(function MyRadioCardDescription(props: MyRadioCardDescription_Props) {
	const { className, children, ...rest } = props;

	return (
		<span className={cn("MyRadioCardDescription" satisfies MyRadioCardDescription_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
});
// #endregion description

// #region root
export type MyRadioCard_ClassNames =
	| "MyRadioCard"
	| "MyRadioCard-control"
	| "MyRadioCard-surface"
	| "MyRadioCard-content";

export type MyRadioCard_Props = Omit<
	ComponentPropsWithRef<"input">,
	"children" | "className" | "name" | "style" | "type"
> & {
	ref?: Ref<HTMLInputElement>;
	/**
	 * Keep the radio group name unique across the app, for example by deriving it from React `useId()`.
	 */
	name: string;
	className?: string;
	style?: ComponentPropsWithRef<"div">["style"];
	inputClassName?: string;
	surfaceClassName?: string;
	contentClassName?: string;
	children?: ReactNode;
};

export const MyRadioCard = memo(function MyRadioCard(props: MyRadioCard_Props) {
	const {
		ref,
		className,
		style,
		inputClassName,
		surfaceClassName,
		contentClassName,
		disabled,
		children,
		...rest
	} = props;

	return (
		<div
			className={cn("MyRadioCard" satisfies MyRadioCard_ClassNames, className)}
			style={style}
			aria-disabled={disabled || undefined}
		>
			{/* Keep the native radio stretched across the card so pointer, keyboard, and form behavior stay browser-owned. */}
			<input
				ref={ref}
				className={cn("MyRadioCard-control" satisfies MyRadioCard_ClassNames, inputClassName)}
				type="radio"
				disabled={disabled}
				{...rest}
			/>
			<span className={cn("MyRadioCard-surface" satisfies MyRadioCard_ClassNames, surfaceClassName)}>
				<MyRadioSurface aria-hidden />
				<span className={cn("MyRadioCard-content" satisfies MyRadioCard_ClassNames, contentClassName)}>
					{children}
				</span>
			</span>
		</div>
	);
});
// #endregion root
