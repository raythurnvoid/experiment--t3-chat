import "./my-action.css";

import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils.ts";

// #region primary action
type MyPrimaryAction_ClassNames = "MyPrimaryAction";

export type MyPrimaryAction_Props = ComponentPropsWithRef<"button"> & {
	selected?: boolean;
};

export function MyPrimaryAction(props: MyPrimaryAction_Props) {
	const { ref, id, className, selected = false, children, ...rest } = props;

	return (
		<button
			ref={ref}
			id={id}
			type="button"
			className={cn("MyPrimaryAction" satisfies MyPrimaryAction_ClassNames, className)}
			data-selected={selected || undefined}
			{...rest}
		>
			{children}
		</button>
	);
}
// #endregion primary action
