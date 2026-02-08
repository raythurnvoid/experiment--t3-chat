import "@/components/my-button.css";
import "./my-link-surface.css";
import React from "react";
import { cn } from "@/lib/utils.ts";
import type { MyButton_ClassNames } from "@/components/my-button.tsx";

type MyLinkSurface_ClassNames =
	| "MyLinkSurface"
	| "MyLinkSurface-variant-default"
	| "MyLinkSurface-variant-button-tertiary"
	| "MyLinkSurface-variant-button-ghost"
	| "MyLinkSurface-variant-button-ghost-accent"
	| "MyLinkSurface-variant-button-ghost-highlightable";

export type MyLinkSurface_Props = React.ComponentProps<"span"> & {
	variant?: "default" | "button-tertiary" | "button-ghost" | "button-ghost-accent" | "button-ghost-highlightable";
};

export function MyLinkSurface(props: MyLinkSurface_Props) {
	const { variant = "default", className, children, ...rest } = props;

	return (
		<span
			className={cn(
				"MyLinkSurface" satisfies MyLinkSurface_ClassNames,
				variant !== "default" && ("MyButton" satisfies MyButton_ClassNames),
				variant === "default" && ("MyLinkSurface-variant-default" satisfies MyLinkSurface_ClassNames),
				variant === "button-tertiary" && ("MyLinkSurface-variant-button-tertiary" satisfies MyLinkSurface_ClassNames),
				variant === "button-tertiary" && ("MyButton-variant-tertiary" satisfies MyButton_ClassNames),
				variant === "button-ghost" && ("MyLinkSurface-variant-button-ghost" satisfies MyLinkSurface_ClassNames),
				variant === "button-ghost" && ("MyButton-variant-ghost" satisfies MyButton_ClassNames),
				variant === "button-ghost-accent" &&
					("MyLinkSurface-variant-button-ghost-accent" satisfies MyLinkSurface_ClassNames),
				variant === "button-ghost-accent" && ("MyButton-variant-ghost-accent" satisfies MyButton_ClassNames),
				variant === "button-ghost-highlightable" &&
					("MyLinkSurface-variant-button-ghost-highlightable" satisfies MyLinkSurface_ClassNames),
				variant === "button-ghost-highlightable" &&
					("MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</span>
	);
}
