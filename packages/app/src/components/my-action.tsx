import "./my-action.css";

import { Link } from "@tanstack/react-router";
import { memo, type ComponentPropsWithRef, type ReactNode } from "react";
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
	tooltipPlacement?: Ariakit.TooltipProviderProps["placement"];
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
		tooltipPlacement = "bottom",
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
		<MyTooltip timeout={tooltipTimeout} placement={tooltipPlacement} open={tooltipDisabled ? false : undefined}>
			<MyTooltipTrigger>{buttonElement}</MyTooltipTrigger>
			<MyTooltipContent unmountOnHide>{tooltip}</MyTooltipContent>
		</MyTooltip>
	);
});
// #endregion primary action

// #region primary action link
type MyPrimaryActionLink_ClassNames = "MyPrimaryActionLink";

export type MyPrimaryActionLink_Props = Omit<ComponentPropsWithRef<typeof Link>, "children"> & {
	children?: ReactNode;
	tooltip?: string;
	tooltipTimeout?: Ariakit.TooltipProviderProps["timeout"];
	tooltipDisabled?: boolean;
	tooltipPlacement?: Ariakit.TooltipProviderProps["placement"];
};

export const MyPrimaryActionLink = memo(function MyPrimaryActionLink(props: MyPrimaryActionLink_Props) {
	const { ref, id, className, tooltip, tooltipTimeout, tooltipDisabled = false, tooltipPlacement = "bottom", children, ...rest } = props;

	const linkElement = (
		<Link
			ref={ref}
			id={id}
			className={cn(
				"MyPrimaryAction" satisfies MyPrimaryAction_ClassNames,
				"MyPrimaryActionLink" satisfies MyPrimaryActionLink_ClassNames,
				className,
			)}
			aria-label={tooltip}
			{...rest}
		>
			{children}
			{tooltip && <span className={cn("sr-only")}>{tooltip}</span>}
		</Link>
	);

	if (!tooltip) {
		return linkElement;
	}

	return (
		<MyTooltip timeout={tooltipTimeout} placement={tooltipPlacement} open={tooltipDisabled ? false : undefined}>
			<MyTooltipTrigger>{linkElement}</MyTooltipTrigger>
			<MyTooltipContent unmountOnHide>{tooltip}</MyTooltipContent>
		</MyTooltip>
	);
});
// #endregion primary action link
