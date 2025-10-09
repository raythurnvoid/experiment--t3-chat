import "./my-button.css";
import type { ComponentPropsWithRef, Ref } from "react";

import { cn } from "@/lib/utils.ts";
import { MyIcon } from "@/components/my-icon.tsx";

export type MyButton_ClassNames =
	| "MyButton"
	| "MyButton-variant-default"
	| "MyButton-variant-destructive"
	| "MyButton-variant-outline"
	| "MyButton-variant-secondary"
	| "MyButton-variant-ghost"
	| "MyButton-variant-ghost-secondary"
	| "MyButton-variant-tertiary"
	| "MyButton-variant-link";

export type MyButton_Props = ComponentPropsWithRef<"button"> & {
	ref?: Ref<HTMLButtonElement>;
	id?: string;
	className?: string;
	variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "ghost-secondary" | "tertiary" | "link";
};

export function MyButton(props: MyButton_Props) {
	const { ref, id, className, variant = "default", children, ...rest } = props;

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
				variant === "tertiary" && ("MyButton-variant-tertiary" satisfies MyButton_ClassNames),
				variant === "link" && ("MyButton-variant-link" satisfies MyButton_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
}

type MyButtonIcon_ClassNames = "MyButtonIcon";

export type MyButtonIcon_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	innerHtml?: string;
	children?: React.ReactNode;
};

export function MyButtonIcon(props: MyButtonIcon_Props) {
	const { ref, id, className, innerHtml, children, ...rest } = props;

	return (
		<MyIcon
			ref={ref}
			id={id}
			className={cn("MyButtonIcon" satisfies MyButtonIcon_ClassNames, className)}
			innerHtml={innerHtml}
			{...rest}
		>
			{children}
		</MyIcon>
	);
}
