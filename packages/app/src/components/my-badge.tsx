import "./my-badge.css";
import type { ComponentPropsWithRef, Ref } from "react";

import { cn } from "@/lib/utils.ts";

export type MyBadge_ClassNames =
	| "MyBadge"
	| "MyBadge-variant-default"
	| "MyBadge-variant-secondary"
	| "MyBadge-variant-destructive"
	| "MyBadge-variant-outline";

export type MyBadge_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	variant?: "default" | "secondary" | "destructive" | "outline";
};

export function MyBadge(props: MyBadge_Props) {
	const { ref, id, className, variant = "default", children, ...rest } = props;

	return (
		<span
			ref={ref}
			id={id}
			className={cn(
				"MyBadge" satisfies MyBadge_ClassNames,
				variant === "default" && ("MyBadge-variant-default" satisfies MyBadge_ClassNames),
				variant === "secondary" && ("MyBadge-variant-secondary" satisfies MyBadge_ClassNames),
				variant === "destructive" && ("MyBadge-variant-destructive" satisfies MyBadge_ClassNames),
				variant === "outline" && ("MyBadge-variant-outline" satisfies MyBadge_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</span>
	);
}
