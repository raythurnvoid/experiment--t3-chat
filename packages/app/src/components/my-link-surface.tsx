import "./my-link-surface.css";
import React from "react";
import { cn } from "@/lib/utils.ts";

type MyLinkSurface_ClassNames =
	| "MyLinkSurface"
	| "MyLinkSurface-variant-default"
	| "MyLinkSurface-variant-button-tertiary"
	| "MyLinkSurface-variant-button-ghost"
	| "MyLinkSurface-variant-button-ghost-secondary";

export type MyLinkSurface_Props = React.ComponentProps<"span"> & {
	variant?: "default" | "button-tertiary" | "button-ghost" | "button-ghost-secondary";
};

export function MyLinkSurface(props: MyLinkSurface_Props) {
	const { variant = "default", className, children, ...rest } = props;

	return (
		<span
			className={cn(
				"MyLinkSurface" satisfies MyLinkSurface_ClassNames,
				variant === "default" && ("MyLinkSurface-variant-default" satisfies MyLinkSurface_ClassNames),
				variant === "button-tertiary" && ("MyLinkSurface-variant-button-tertiary" satisfies MyLinkSurface_ClassNames),
				variant === "button-ghost" && ("MyLinkSurface-variant-button-ghost" satisfies MyLinkSurface_ClassNames),
				variant === "button-ghost-secondary" &&
					("MyLinkSurface-variant-button-ghost-secondary" satisfies MyLinkSurface_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</span>
	);
}
