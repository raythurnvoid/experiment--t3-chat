import "./my-tooltip.css";
import * as Ariakit from "@ariakit/react";
import { memo } from "react";
import type { ExtractStrict } from "type-fest";
import { cn } from "@/lib/utils.ts";

// #region MyTooltip
export type MyTooltip_Props = Ariakit.TooltipProviderProps;

export const MyTooltip = memo(function MyTooltip(props: MyTooltip_Props) {
	const { children, ...rest } = props;

	return <Ariakit.TooltipProvider {...rest}>{children}</Ariakit.TooltipProvider>;
});
// #endregion MyTooltip

// #region Trigger
export type MyTooltipTrigger_ClassNames = "MyTooltipTrigger";

export type MyTooltipTrigger_Props = {
	children?: Ariakit.TooltipAnchorProps["render"];
} & Omit<Ariakit.TooltipAnchorProps, ExtractStrict<keyof Ariakit.TooltipAnchorProps, "render">>;

export const MyTooltipTrigger = memo(function MyTooltipTrigger(props: MyTooltipTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.TooltipAnchor
			ref={ref}
			id={id}
			className={cn("MyTooltipTrigger" satisfies MyTooltipTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
});
// #endregion Trigger

// #region Content
export type MyTooltipContent_ClassNames = "MyTooltipContent";

export type MyTooltipContent_Props = Ariakit.TooltipProps;

export const MyTooltipContent = memo(function MyTooltipContent(props: MyTooltipContent_Props) {
	const { ref, id, className, portal = true, gutter = 8, children, ...rest } = props;

	return (
		<Ariakit.Tooltip
			ref={ref}
			id={id}
			className={cn("MyTooltipContent" satisfies MyTooltipContent_ClassNames, className)}
			portal={portal}
			gutter={gutter}
			{...rest}
		>
			{children}
		</Ariakit.Tooltip>
	);
});
// #endregion Content

// #region Arrow
export type MyTooltipArrow_ClassNames = "MyTooltipArrow";

export type MyTooltipArrow_Props = Ariakit.TooltipArrowProps;

export const MyTooltipArrow = memo(function MyTooltipArrow(props: MyTooltipArrow_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<Ariakit.TooltipArrow
			ref={ref}
			id={id}
			className={cn("MyTooltipArrow" satisfies MyTooltipArrow_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion Arrow
