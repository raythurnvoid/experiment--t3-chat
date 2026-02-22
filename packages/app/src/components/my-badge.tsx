import "./my-badge.css";
import { memo, type ComponentPropsWithRef, type Ref } from "react";

import { cn } from "@/lib/utils.ts";

// #region root
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

export const MyBadge = memo(function MyBadge(props: MyBadge_Props) {
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
});
// #endregion root
