import "./my-button.css";
import { memo, type ComponentPropsWithRef, type Ref } from "react";

import { cn } from "@/lib/utils.ts";
import { MyIcon } from "@/components/my-icon.tsx";

export type MyButton_ClassNames =
	| "MyButton"
	| "MyButton-state-disabled"
	| "MyButton-variant-default"
	| "MyButton-variant-accent"
	| "MyButton-variant-destructive"
	| "MyButton-variant-outline"
	| "MyButton-variant-secondary"
	| "MyButton-variant-secondary-subtle"
	| "MyButton-variant-ghost"
	| "MyButton-variant-ghost-accent"
	| "MyButton-variant-ghost-highlightable"
	| "MyButton-variant-tertiary"
	| "MyButton-variant-link";

export type MyButton_Props = ComponentPropsWithRef<"button"> & {
	ref?: Ref<HTMLButtonElement>;
	id?: string;
	className?: string;
	type?: ComponentPropsWithRef<"button">["type"];
	variant?:
		| "default"
		| "accent"
		| "destructive"
		| "outline"
		| "secondary"
		| "secondary-subtle"
		| "ghost"
		| "ghost-accent"
		| "ghost-highlightable"
		| "tertiary"
		| "link";

	/**
	 * Whether the button is in loading state.
	 *
	 * @default false
	 */
	"aria-busy"?: boolean;
};

export const MyButton = memo(function MyButton(props: MyButton_Props) {
	const { ref, id, className, type = "button", variant = "default", children, ...rest } = props;

	return (
		<button
			ref={ref}
			id={id}
			type={type}
			className={cn(
				"MyButton" satisfies MyButton_ClassNames,
				variant === "default" && ("MyButton-variant-default" satisfies MyButton_ClassNames),
				variant === "accent" && ("MyButton-variant-accent" satisfies MyButton_ClassNames),
				variant === "destructive" && ("MyButton-variant-destructive" satisfies MyButton_ClassNames),
				variant === "outline" && ("MyButton-variant-outline" satisfies MyButton_ClassNames),
				variant === "secondary" && ("MyButton-variant-secondary" satisfies MyButton_ClassNames),
				variant === "secondary-subtle" && ("MyButton-variant-secondary-subtle" satisfies MyButton_ClassNames),
				variant === "ghost" && ("MyButton-variant-ghost" satisfies MyButton_ClassNames),
				variant === "ghost-accent" && ("MyButton-variant-ghost-accent" satisfies MyButton_ClassNames),
				variant === "ghost-highlightable" && ("MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames),
				variant === "tertiary" && ("MyButton-variant-tertiary" satisfies MyButton_ClassNames),
				variant === "link" && ("MyButton-variant-link" satisfies MyButton_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</button>
	);
});

export type MyButtonIcon_ClassNames = "MyButtonIcon";

export type MyButtonIcon_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	innerHtml?: string;
	children?: React.ReactNode;
};

export const MyButtonIcon = memo(function MyButtonIcon(props: MyButtonIcon_Props) {
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
});
