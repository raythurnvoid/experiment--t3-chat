import { memo } from "react";
import type * as Ariakit from "@ariakit/react";
import { Link, type LinkProps } from "@tanstack/react-router";

import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";

import { MyLinkSurface, type MyLinkSurface_Props } from "./my-link-surface.tsx";

export type MyLink_Props = LinkProps &
	Omit<MyLinkSurface_Props, "children" | "ref"> & {
		tooltip?: string;
		tooltipTimeout?: Ariakit.TooltipProviderProps["timeout"];
		tooltipSide?: "top" | "bottom" | "left" | "right";
	};

export const MyLink = memo(function MyLink(props: MyLink_Props) {
	const {
		className,
		style,
		variant = "default",
		tooltip,
		tooltipTimeout,
		tooltipSide = "bottom",
		children,
		...rest
	} = props;

	const linkElement = (
		<Link {...rest}>
			<MyLinkSurface className={className} style={style} variant={variant}>
				{typeof children === "function" ? children({ isActive: false, isTransitioning: false }) : children}
			</MyLinkSurface>
		</Link>
	);

	if (!tooltip) {
		return linkElement;
	}

	return (
		<MyTooltip timeout={tooltipTimeout} placement={tooltipSide}>
			<MyTooltipTrigger>{linkElement}</MyTooltipTrigger>
			<MyTooltipContent unmountOnHide>
				<>{tooltip}</>
			</MyTooltipContent>
		</MyTooltip>
	);
});
