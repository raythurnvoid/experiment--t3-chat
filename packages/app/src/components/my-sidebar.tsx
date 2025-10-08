import "./my-sidebar.css";

import { Slot } from "@radix-ui/react-slot";
import { PanelLeftIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ComponentPropsWithRef } from "react";

import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

type MySidebar_ClassNames =
	| "MySidebar"
	| "MySidebar-state-expanded"
	| "MySidebar-state-collapsed"
	| "MySidebar-state-closed"
	| "MySidebar-mounted"
	| "MySidebar-inner"
	| "MySidebarHeader"
	| "MySidebarFooter"
	| "MySidebarContent"
	| "MySidebarSeparator"
	| "MySidebarGroup"
	| "MySidebarGroupLabel"
	| "MySidebarGroupAction"
	| "MySidebarGroupContent"
	| "MySidebarMenu"
	| "MySidebarMenuItem"
	| "MySidebarMenuButton"
	| "MySidebarMenuButton-variant-outline"
	| "MySidebarMenuButton-size-sm"
	| "MySidebarMenuButton-size-lg"
	| "MySidebarMenuAction"
	| "MySidebarMenuAction-show-on-hover"
	| "MySidebarMenuBadge"
	| "MySidebarMenuSkeleton"
	| "MySidebarMenuSkeleton-icon"
	| "MySidebarMenuSkeleton-text"
	| "MySidebarMenuSub"
	| "MySidebarMenuSubItem"
	| "MySidebarMenuSubButton"
	| "MySidebarTrigger"
	| "MySidebarRail"
	| "MySidebarInset";

type MySidebar_CssVars = {
	"--my-sidebar-width": string;
	"--my-sidebar-width-collapsed": string;
};

const MySidebar_CSS_VARS_DEFAULTS: Partial<MySidebar_CssVars> = {
	"--my-sidebar-width": "320px",
	"--my-sidebar-width-collapsed": "47px",
};

export type MySidebar_Props = ComponentPropsWithRef<"aside"> & {
	state: "closed" | "collapsed" | "expanded";
};

export function MySidebar(props: MySidebar_Props) {
	const { ref, id, className, state, children, style, ...rest } = props;
	const [isMounted, setIsMounted] = useState(false);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	const stateClassName =
		state === "expanded"
			? ("MySidebar-state-expanded" satisfies MySidebar_ClassNames)
			: state === "collapsed"
				? ("MySidebar-state-collapsed" satisfies MySidebar_ClassNames)
				: ("MySidebar-state-closed" satisfies MySidebar_ClassNames);

	return (
		<aside
			ref={ref}
			id={id}
			className={cn(
				"MySidebar" satisfies MySidebar_ClassNames,
				stateClassName,
				isMounted && ("MySidebar-mounted" satisfies MySidebar_ClassNames),
				className,
			)}
			style={{
				...MySidebar_CSS_VARS_DEFAULTS,
				...style,
			}}
			{...rest}
		>
			<div className={cn("MySidebar-inner" satisfies MySidebar_ClassNames)}>{children}</div>
		</aside>
	);
}

export type MySidebarHeader_Props = ComponentPropsWithRef<"div">;

export function MySidebarHeader(props: MySidebarHeader_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarHeader" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarFooter_Props = ComponentPropsWithRef<"div">;

export function MySidebarFooter(props: MySidebarFooter_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarFooter" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarContent_Props = ComponentPropsWithRef<"div">;

export function MySidebarContent(props: MySidebarContent_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarContent" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarSeparator_Props = ComponentPropsWithRef<typeof Separator>;

export function MySidebarSeparator(props: MySidebarSeparator_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<Separator
			ref={ref}
			id={id}
			className={cn("MySidebarSeparator" satisfies MySidebar_ClassNames, className)}
			{...rest}
		/>
	);
}

export type MySidebarGroup_Props = ComponentPropsWithRef<"div">;

export function MySidebarGroup(props: MySidebarGroup_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarGroup" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarGroupLabel_Props = ComponentPropsWithRef<"div"> & {
	asChild?: boolean;
};

export function MySidebarGroupLabel(props: MySidebarGroupLabel_Props) {
	const { ref, id, className, asChild = false, children, ...rest } = props;
	const Comp = asChild ? Slot : "div";

	return (
		<Comp ref={ref} id={id} className={cn("MySidebarGroupLabel" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</Comp>
	);
}

export type MySidebarGroupAction_Props = ComponentPropsWithRef<"button"> & {
	asChild?: boolean;
};

export function MySidebarGroupAction(props: MySidebarGroupAction_Props) {
	const { ref, id, className, asChild = false, children, ...rest } = props;
	const Comp = asChild ? Slot : "button";

	return (
		<Comp
			ref={ref}
			id={id}
			type={asChild ? undefined : "button"}
			className={cn("MySidebarGroupAction" satisfies MySidebar_ClassNames, className)}
			{...rest}
		>
			{children}
		</Comp>
	);
}

export type MySidebarGroupContent_Props = ComponentPropsWithRef<"div">;

export function MySidebarGroupContent(props: MySidebarGroupContent_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarGroupContent" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarMenu_Props = ComponentPropsWithRef<"ul">;

export function MySidebarMenu(props: MySidebarMenu_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<ul ref={ref} id={id} className={cn("MySidebarMenu" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</ul>
	);
}

export type MySidebarMenuItem_Props = ComponentPropsWithRef<"li">;

export function MySidebarMenuItem(props: MySidebarMenuItem_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<li ref={ref} id={id} className={cn("MySidebarMenuItem" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</li>
	);
}

type TooltipLikeProps = string | ComponentPropsWithRef<typeof TooltipContent>;

export type MySidebarMenuButton_Props = ComponentPropsWithRef<"button"> & {
	asChild?: boolean;
	isActive?: boolean;
	variant?: "default" | "outline";
	size?: "default" | "sm" | "lg";
	tooltip?: TooltipLikeProps;
};

export function MySidebarMenuButton(props: MySidebarMenuButton_Props) {
	const {
		ref,
		id,
		className,
		children,
		asChild = false,
		isActive = false,
		variant = "default",
		size = "default",
		tooltip,
		...rest
	} = props;
	const Comp = asChild ? Slot : "button";

	const buttonClasses = cn(
		"MySidebarMenuButton" satisfies MySidebar_ClassNames,
		variant === "outline" && ("MySidebarMenuButton-variant-outline" satisfies MySidebar_ClassNames),
		size === "sm" && ("MySidebarMenuButton-size-sm" satisfies MySidebar_ClassNames),
		size === "lg" && ("MySidebarMenuButton-size-lg" satisfies MySidebar_ClassNames),
		className,
	);

	const button = (
		<Comp
			ref={ref}
			id={id}
			data-active={isActive}
			data-variant={variant}
			data-size={size}
			className={buttonClasses}
			{...rest}
		>
			{children}
		</Comp>
	);

	if (!tooltip) {
		return button;
	}

	const tooltipProps: ComponentPropsWithRef<typeof TooltipContent> =
		typeof tooltip === "string" ? { children: tooltip } : tooltip;

	return (
		<Tooltip>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent align="center" side="right" {...tooltipProps} />
		</Tooltip>
	);
}

export type MySidebarMenuAction_Props = ComponentPropsWithRef<"button"> & {
	asChild?: boolean;
	showOnHover?: boolean;
};

export function MySidebarMenuAction(props: MySidebarMenuAction_Props) {
	const { ref, id, className, asChild = false, showOnHover = false, children, ...rest } = props;
	const Comp = asChild ? Slot : "button";

	return (
		<Comp
			ref={ref}
			id={id}
			type={asChild ? undefined : "button"}
			className={cn(
				"MySidebarMenuAction" satisfies MySidebar_ClassNames,
				showOnHover && ("MySidebarMenuAction-show-on-hover" satisfies MySidebar_ClassNames),
				className,
			)}
			{...rest}
		>
			{children}
		</Comp>
	);
}

export type MySidebarMenuBadge_Props = ComponentPropsWithRef<"div">;

export function MySidebarMenuBadge(props: MySidebarMenuBadge_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarMenuBadge" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarMenuSkeleton_Props = ComponentPropsWithRef<"div"> & {
	showIcon?: boolean;
};

export function MySidebarMenuSkeleton(props: MySidebarMenuSkeleton_Props) {
	const { ref, id, className, showIcon = false, ...rest } = props;
	const width = "60%";

	return (
		<div ref={ref} id={id} className={cn("MySidebarMenuSkeleton" satisfies MySidebar_ClassNames, className)} {...rest}>
			{showIcon ? <Skeleton className={cn("MySidebarMenuSkeleton-icon" satisfies MySidebar_ClassNames)} /> : null}
			<Skeleton
				className={cn("MySidebarMenuSkeleton-text" satisfies MySidebar_ClassNames)}
				style={{ "--skeleton-width": width } as CSSProperties}
			/>
		</div>
	);
}

export type MySidebarMenuSub_Props = ComponentPropsWithRef<"ul">;

export function MySidebarMenuSub(props: MySidebarMenuSub_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<ul ref={ref} id={id} className={cn("MySidebarMenuSub" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</ul>
	);
}

export type MySidebarMenuSubItem_Props = ComponentPropsWithRef<"li">;

export function MySidebarMenuSubItem(props: MySidebarMenuSubItem_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<li ref={ref} id={id} className={cn("MySidebarMenuSubItem" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</li>
	);
}

export type MySidebarMenuSubButton_Props = ComponentPropsWithRef<"a"> & {
	asChild?: boolean;
	size?: "sm" | "md";
	isActive?: boolean;
};

export function MySidebarMenuSubButton(props: MySidebarMenuSubButton_Props) {
	const { ref, id, className, asChild = false, size = "md", isActive = false, children, ...rest } = props;
	const Comp = asChild ? Slot : "a";

	return (
		<Comp
			ref={ref}
			id={id}
			data-size={size}
			data-active={isActive}
			className={cn("MySidebarMenuSubButton" satisfies MySidebar_ClassNames, className)}
			{...rest}
		>
			{children}
		</Comp>
	);
}

export type MySidebarTrigger_Props = ComponentPropsWithRef<"button">;

export function MySidebarTrigger(props: MySidebarTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<button
			ref={ref}
			id={id}
			type="button"
			className={cn("MySidebarTrigger" satisfies MySidebar_ClassNames, className)}
			{...rest}
		>
			{children ?? <PanelLeftIcon size={16} />}
		</button>
	);
}

export type MySidebarRail_Props = ComponentPropsWithRef<"button">;

export function MySidebarRail(props: MySidebarRail_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<button
			ref={ref}
			id={id}
			type="button"
			className={cn("MySidebarRail" satisfies MySidebar_ClassNames, className)}
			{...rest}
		>
			{children}
		</button>
	);
}

export type MySidebarInset_Props = ComponentPropsWithRef<"main">;

export function MySidebarInset(props: MySidebarInset_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<main ref={ref} id={id} className={cn("MySidebarInset" satisfies MySidebar_ClassNames, className)} {...rest}>
			{children}
		</main>
	);
}
