import "./my-button.css";
import type { ComponentPropsWithRef, Ref } from "react";

import { cn } from "@/lib/utils.ts";

export type MyButton_ClassNames =
	| "MyButton"
	| "MyButton-variant-default"
	| "MyButton-variant-destructive"
	| "MyButton-variant-outline"
	| "MyButton-variant-secondary"
	| "MyButton-variant-ghost"
	| "MyButton-variant-ghost-secondary"
	| "MyButton-variant-link"
	| "MyButton-size-default"
	| "MyButton-size-sm"
	| "MyButton-size-lg"
	| "MyButton-size-icon";

export type MyButton_CssVars = {
	"--my-button-height": string;
	"--my-button-padding-x": string;
	"--my-button-padding-y": string;
	"--my-button-gap": string;
	"--my-button-padding-x-with-icon": string;
	"--my-button-radius": string;
	"--my-button-focus-ring-width": string;
};

const MY_BUTTON_CSS_DEFAULTS: Partial<MyButton_CssVars> = {
	"--my-button-height": "2.25rem",
	"--my-button-padding-x": "1rem",
	"--my-button-padding-y": "0.5rem",
	"--my-button-gap": "0.5rem",
	"--my-button-padding-x-with-icon": "0.75rem",
	"--my-button-radius": "0.375rem",
	"--my-button-focus-ring-width": "3px",
};

export type MyButton_Props = ComponentPropsWithRef<"button"> & {
	ref?: Ref<HTMLButtonElement>;
	id?: string;
	className?: string;
	variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "ghost-secondary" | "link";
	size?: "default" | "sm" | "lg" | "icon";
};

export function MyButton(props: MyButton_Props) {
	const { ref, id, className, variant = "default", size = "default", style, children, ...rest } = props;

	return (
		<button
			ref={ref}
			id={id}
			className={cn(
				"MyButton" satisfies MyButton_ClassNames,
				variant === "default" && ("MyButton-variant-default" satisfies MyButton_ClassNames),
				variant === "destructive" && ("MyButton-variant-destructive" satisfies MyButton_ClassNames),
				variant === "outline" && ("MyButton-variant-outline" satisfies MyButton_ClassNames),
				variant === "secondary" && ("MyButton-variant-secondary" satisfies MyButton_ClassNames),
				variant === "ghost" && ("MyButton-variant-ghost" satisfies MyButton_ClassNames),
				variant === "ghost-secondary" && ("MyButton-variant-ghost-secondary" satisfies MyButton_ClassNames),
				variant === "link" && ("MyButton-variant-link" satisfies MyButton_ClassNames),
				size === "default" && ("MyButton-size-default" satisfies MyButton_ClassNames),
				size === "sm" && ("MyButton-size-sm" satisfies MyButton_ClassNames),
				size === "lg" && ("MyButton-size-lg" satisfies MyButton_ClassNames),
				size === "icon" && ("MyButton-size-icon" satisfies MyButton_ClassNames),
				className,
			)}
			style={{
				...MY_BUTTON_CSS_DEFAULTS,
				...style,
			}}
			{...rest}
		>
			{children}
		</button>
	);
}
