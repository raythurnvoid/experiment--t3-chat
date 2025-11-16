import "./my-separator.css";
import type { ComponentPropsWithRef, Ref } from "react";

import { cn } from "@/lib/utils.ts";

// #region MySeparator
export type MySeparator_ClassNames = "MySeparator" | "MySeparator-vertical" | "MySeparator-horizontal";

export type MySeparator_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	orientation?: "horizontal" | "vertical";
};

export function MySeparator(props: MySeparator_Props) {
	const { ref, id, className, orientation = "horizontal", children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn(
				"MySeparator" satisfies MySeparator_ClassNames,
				orientation === "vertical" && ("MySeparator-vertical" satisfies MySeparator_ClassNames),
				orientation === "horizontal" && ("MySeparator-horizontal" satisfies MySeparator_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</div>
	);
}
// #endregion MySeparator

// #region MySeparatorHr
export type MySeparatorHr_ClassNames = MySeparator_ClassNames | "MySeparatorHr";

export type MySeparatorHr_Props = ComponentPropsWithRef<"hr"> & {
	ref?: Ref<HTMLHRElement>;
	id?: string;
	className?: string;
	orientation?: "horizontal" | "vertical";
};

export function MySeparatorHr(props: MySeparatorHr_Props) {
	const { ref, id, className, orientation = "horizontal", children, ...rest } = props;

	return (
		<hr
			ref={ref}
			id={id}
			className={cn(
				"MySeparator" satisfies MySeparatorHr_ClassNames,
				"MySeparatorHr" satisfies MySeparatorHr_ClassNames,
				orientation === "vertical" && ("MySeparator-vertical" satisfies MySeparatorHr_ClassNames),
				orientation === "horizontal" && ("MySeparator-horizontal" satisfies MySeparatorHr_ClassNames),
				className,
			)}
			aria-orientation={orientation}
			{...rest}
		>
			{children}
		</hr>
	);
}
// #endregion MySeparatorHr
