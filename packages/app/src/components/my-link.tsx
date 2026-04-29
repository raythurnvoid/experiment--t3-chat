import { memo, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";
import type * as Ariakit from "@ariakit/react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { ExtractStrict } from "type-fest";

import { MyIcon } from "@/components/my-icon.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { cn } from "@/lib/utils.ts";

import { MyLinkSurface, type MyLinkSurface_Props } from "./my-link-surface.tsx";

export type MyLink_Props = LinkProps &
	Omit<MyLinkSurface_Props, ExtractStrict<keyof MyLinkSurface_Props, "children" | "ref">> & {
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

export type MyLinkIcon_ClassNames = "MyLinkIcon";

export type MyLinkIcon_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	innerHtml?: string;
	children?: ReactNode;
};

export const MyLinkIcon = memo(function MyLinkIcon(props: MyLinkIcon_Props) {
	const { ref, id, className, innerHtml, children, ...rest } = props;

	return (
		<MyIcon
			ref={ref}
			id={id}
			className={cn("MyLinkIcon" satisfies MyLinkIcon_ClassNames, className)}
			innerHtml={innerHtml}
			{...rest}
		>
			{children}
		</MyIcon>
	);
});
