import "./my-link-surface.css";
import React from "react";
import { cn } from "@/lib/utils.ts";

type MyLinkSurface_ClassNames =
	| "MyLinkSurface"
	| "MyLinkSurface-variant-default"
	| "MyLinkSurface-variant-button-tertiary"
	| "MyLinkSurface-variant-button-ghost"
	| "MyLinkSurface-variant-button-ghost-secondary"
	| "MyLinkSurface-size-default"
	| "MyLinkSurface-size-sm"
	| "MyLinkSurface-size-lg"
	| "MyLinkSurface-size-icon";

export type MyLinkSurface_Props = React.ComponentProps<"span"> & {
	variant?: "default" | "button-tertiary" | "button-ghost" | "button-ghost-secondary";
	size?: "default" | "sm" | "lg" | "icon";
};

export function MyLinkSurface(props: MyLinkSurface_Props) {
	const { variant = "default", size = "default", className, children, ...rest } = props;

	return (
		<span
			className={cn(
				"MyLinkSurface" satisfies MyLinkSurface_ClassNames,
				variant === "default" && ("MyLinkSurface-variant-default" satisfies MyLinkSurface_ClassNames),
				variant === "button-tertiary" && ("MyLinkSurface-variant-button-tertiary" satisfies MyLinkSurface_ClassNames),
				variant === "button-ghost" && ("MyLinkSurface-variant-button-ghost" satisfies MyLinkSurface_ClassNames),
				variant === "button-ghost-secondary" &&
					("MyLinkSurface-variant-button-ghost-secondary" satisfies MyLinkSurface_ClassNames),
				size === "default" && ("MyLinkSurface-size-default" satisfies MyLinkSurface_ClassNames),
				size === "sm" && ("MyLinkSurface-size-sm" satisfies MyLinkSurface_ClassNames),
				size === "lg" && ("MyLinkSurface-size-lg" satisfies MyLinkSurface_ClassNames),
				size === "icon" && ("MyLinkSurface-size-icon" satisfies MyLinkSurface_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</span>
	);
}
