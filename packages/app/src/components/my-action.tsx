import "./my-action.css";

import { Link } from "@tanstack/react-router";
import { memo, type ComponentPropsWithRef } from "react";
import type * as Ariakit from "@ariakit/react";

import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { cn } from "@/lib/utils.ts";

// #region primary action
type MyPrimaryAction_ClassNames = "MyPrimaryAction";

export type MyPrimaryAction_Props = ComponentPropsWithRef<"button"> & {
	selected?: boolean;
	tooltip?: string;
	tooltipTimeout?: Ariakit.TooltipProviderProps["timeout"];
	tooltipDisabled?: boolean;
};

export const MyPrimaryAction = memo(function MyPrimaryAction(props: MyPrimaryAction_Props) {
	const {
		ref,
		id,
		className,
		selected = false,
		tooltip,
		tooltipTimeout,
		tooltipDisabled = false,
		children,
		...rest
	} = props;

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
		<MyTooltip timeout={tooltipTimeout} placement="bottom" open={tooltipDisabled ? false : undefined}>
			<MyTooltipTrigger>{buttonElement}</MyTooltipTrigger>
			<MyTooltipContent unmountOnHide>{tooltip}</MyTooltipContent>
		</MyTooltip>
	);
});
// #endregion primary action

// #region primary action link
type MyPrimaryActionLink_ClassNames = "MyPrimaryActionLink";

export type MyPrimaryActionLink_Props = ComponentPropsWithRef<typeof Link>;

export const MyPrimaryActionLink = memo(function MyPrimaryActionLink(props: MyPrimaryActionLink_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Link
			ref={ref}
			id={id}
			className={cn(
				"MyPrimaryAction" satisfies MyPrimaryAction_ClassNames,
				"MyPrimaryActionLink" satisfies MyPrimaryActionLink_ClassNames,
				className,
			)}
			{...rest}
		>
			{children}
		</Link>
	);
});
// #endregion primary action link
