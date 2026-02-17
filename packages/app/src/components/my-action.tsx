import "./my-action.css";

import type { ComponentPropsWithRef } from "react";
import type * as Ariakit from "@ariakit/react";

import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { cn } from "@/lib/utils.ts";

// #region primary action
type MyPrimaryAction_ClassNames = "MyPrimaryAction";

export type MyPrimaryAction_Props = ComponentPropsWithRef<"button"> & {
	selected?: boolean;
	tooltip?: string;
	tooltipTimeout?: Ariakit.TooltipProviderProps["timeout"];
};

export function MyPrimaryAction(props: MyPrimaryAction_Props) {
	const { ref, id, className, selected = false, tooltip, tooltipTimeout, children, ...rest } = props;
	const buttonElement = (
		<button
			ref={ref}
			id={id}
			type="button"
			className={cn("MyPrimaryAction" satisfies MyPrimaryAction_ClassNames, className)}
			data-selected={selected || undefined}
			aria-label={tooltip}
			{...rest}
		>
			{children}
			{tooltip && <span className={cn("sr-only")}>{tooltip}</span>}
		</button>
	);

	if (!tooltip) {
		return buttonElement;
	}

	return (
		<MyTooltip timeout={tooltipTimeout} placement="bottom">
			<MyTooltipTrigger>{buttonElement}</MyTooltipTrigger>
			<MyTooltipContent unmountOnHide>{tooltip}</MyTooltipContent>
		</MyTooltip>
	);
}
// #endregion primary action
