import "./my-tooltip.css";
import {
	Tooltip,
	TooltipAnchor,
	TooltipArrow,
	TooltipProvider,
	type TooltipAnchorProps,
	type TooltipArrowProps,
	type TooltipProps,
	type TooltipProviderProps,
} from "native-popovers/tooltip";
import { memo } from "react";
import type { ExtractStrict } from "type-fest";
import { cn } from "@/lib/utils.ts";

// #region MyTooltip
export type MyTooltip_Props = TooltipProviderProps;

export const MyTooltip = memo(function MyTooltip(props: MyTooltip_Props) {
	const { children, ...rest } = props;

	return <TooltipProvider {...rest}>{children}</TooltipProvider>;
});
// #endregion MyTooltip

// #region Trigger
export type MyTooltipTrigger_ClassNames = "MyTooltipTrigger";

export type MyTooltipTrigger_Props = {
	children?: TooltipAnchorProps["render"];
} & Omit<TooltipAnchorProps, ExtractStrict<keyof TooltipAnchorProps, "render" | "children">>;

export const MyTooltipTrigger = memo(function MyTooltipTrigger(props: MyTooltipTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<TooltipAnchor
			ref={ref}
			id={id}
			className={cn("MyTooltipTrigger" satisfies MyTooltipTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
});
// #endregion Trigger

// #region Info Trigger
export type MyTooltipInfoTrigger_ClassNames = "MyTooltipInfoTrigger";

export type MyTooltipInfoTrigger_Props = MyTooltipTrigger_Props;

/**
 * Use this for passive inline help inside a tooltip when the trigger is not a real button.
 * It defaults to `tabIndex={0}` so non-button help content stays keyboard focusable.
 * Keep layout, icon rendering, colors, spacing, and any non-default `tabIndex` at the call site.
 * Use `MyTooltipTrigger` or the button wrappers for actual button and icon-button triggers.
 */
export const MyTooltipInfoTrigger = memo(function MyTooltipInfoTrigger(props: MyTooltipInfoTrigger_Props) {
	const { className, tabIndex = 0, ...rest } = props;

	return (
		<MyTooltipTrigger
			className={cn("MyTooltipInfoTrigger" satisfies MyTooltipInfoTrigger_ClassNames, className)}
			tabIndex={tabIndex}
			{...rest}
		/>
	);
});
// #endregion Info Trigger

// #region Content
export type MyTooltipContent_ClassNames = "MyTooltipContent" | "MyTooltipContent-variant-error";

export type MyTooltipContent_Props = TooltipProps & {
	variant?: "default" | "error";
};

export const MyTooltipContent = memo(function MyTooltipContent(props: MyTooltipContent_Props) {
	const { ref, id, className, gutter = 8, interactive = false, variant = "default", children, ...rest } = props;

	return (
		<Tooltip
			ref={ref}
			id={id}
			className={cn(
				"MyTooltipContent" satisfies MyTooltipContent_ClassNames,
				variant === "error" && ("MyTooltipContent-variant-error" satisfies MyTooltipContent_ClassNames),
				className,
			)}
			gutter={gutter}
			// Let the pointer pass through app tooltips, so they never catch clicks meant for the controls
			// under them. A call site that needs a clickable tooltip passes `interactive`.
			interactive={interactive}
			{...rest}
		>
			{children}
		</Tooltip>
	);
});
// #endregion Content

// #region Arrow
export type MyTooltipArrow_ClassNames = "MyTooltipArrow";

export type MyTooltipArrow_Props = TooltipArrowProps;

export const MyTooltipArrow = memo(function MyTooltipArrow(props: MyTooltipArrow_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<TooltipArrow
			ref={ref}
			id={id}
			className={cn("MyTooltipArrow" satisfies MyTooltipArrow_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion Arrow
