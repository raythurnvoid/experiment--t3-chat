import "./my-sidebar.css";

import { Slot } from "@radix-ui/react-slot";
import { PanelLeftIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ComponentPropsWithRef } from "react";

import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

const CLASS_NAMES = {
	root: "MySidebar",
	state: {
		expanded: "MySidebar-state-expanded",
		collapsed: "MySidebar-state-collapsed",
		closed: "MySidebar-state-closed",
	},
	mounted: "MySidebar-mounted",

	inner: "MySidebar-inner",
	header: "MySidebar-header",
	footer: "MySidebar-footer",
	content: "MySidebar-content",
	separator: "MySidebar-separator",

	group: "MySidebar-group",
	groupLabel: "MySidebar-group-label",
	groupAction: "MySidebar-group-action",
	groupContent: "MySidebar-group-content",

	menu: "MySidebar-menu",
	menuItem: "MySidebar-menu-item",
	menuButton: "MySidebar-menu-button",
	menuButtonOutline: "MySidebar-menu-button-variant-outline",
	menuButtonSizeSm: "MySidebar-menu-button-size-sm",
	menuButtonSizeLg: "MySidebar-menu-button-size-lg",
	menuAction: "MySidebar-menu-action",
	menuActionShowOnHover: "MySidebar-menu-action-show-on-hover",
	menuBadge: "MySidebar-menu-badge",
	menuSkeleton: "MySidebar-menu-skeleton",
	menuSkeletonIcon: "MySidebar-menu-skeleton-icon",
	menuSkeletonText: "MySidebar-menu-skeleton-text",
	menuSub: "MySidebar-menu-sub",
	menuSubItem: "MySidebar-menu-sub-item",
	menuSubButton: "MySidebar-menu-sub-button",

	trigger: "MySidebar-trigger",
	rail: "MySidebar-rail",
	inset: "MySidebar-inset",
	input: "MySidebar-input",
} as const;

const CSS_VARIABLES = {
	width: "--my-sidebar-width",
	collapsedWidth: "--my-sidebar-width-collapsed",
} as const;

const CSS_VARIABLE_DEFAULTS = {
	[CSS_VARIABLES.width]: "320px",
	[CSS_VARIABLES.collapsedWidth]: "47px",
};

type MySidebarState = "closed" | "collapsed" | "expanded";

export type MySidebar_Props = ComponentPropsWithRef<"aside"> & {
	state: MySidebarState;
};

export const MySidebar = Object.assign(
	function MySidebar(props: MySidebar_Props) {
		const { ref, id, className, state, children, style, ...rest } = props;
		const [isMounted, setIsMounted] = useState(false);

		useEffect(() => {
			setIsMounted(true);
		}, []);
		const stateClassName = CLASS_NAMES.state[state];

		return (
			<aside
				ref={ref}
				id={id}
				className={cn(CLASS_NAMES.root, stateClassName, isMounted && CLASS_NAMES.mounted, className)}
				style={{
					...CSS_VARIABLE_DEFAULTS,
					...style,
				}}
				{...rest}
			>
				<div className={CLASS_NAMES.inner}>{children}</div>
			</aside>
		);
	},
	{
		classNames: CLASS_NAMES,
		cssVars: CSS_VARIABLES,
	},
);

export type MySidebarHeader_Props = ComponentPropsWithRef<"div">;

export function MySidebarHeader(props: MySidebarHeader_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn(CLASS_NAMES.header, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarFooter_Props = ComponentPropsWithRef<"div">;

export function MySidebarFooter(props: MySidebarFooter_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn(CLASS_NAMES.footer, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarContent_Props = ComponentPropsWithRef<"div">;

export function MySidebarContent(props: MySidebarContent_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn(CLASS_NAMES.content, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarSeparator_Props = ComponentPropsWithRef<typeof Separator>;

export function MySidebarSeparator(props: MySidebarSeparator_Props) {
	const { ref, id, className, ...rest } = props;

	return <Separator ref={ref} id={id} className={cn(CLASS_NAMES.separator, className)} {...rest} />;
}

export type MySidebarGroup_Props = ComponentPropsWithRef<"div">;

export function MySidebarGroup(props: MySidebarGroup_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn(CLASS_NAMES.group, className)} {...rest}>
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
		<Comp ref={ref} id={id} className={cn(CLASS_NAMES.groupLabel, className)} {...rest}>
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
			className={cn(CLASS_NAMES.groupAction, className)}
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
		<div ref={ref} id={id} className={cn(CLASS_NAMES.groupContent, className)} {...rest}>
			{children}
		</div>
	);
}

export type MySidebarMenu_Props = ComponentPropsWithRef<"ul">;

export function MySidebarMenu(props: MySidebarMenu_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<ul ref={ref} id={id} className={cn(CLASS_NAMES.menu, className)} {...rest}>
			{children}
		</ul>
	);
}

export type MySidebarMenuItem_Props = ComponentPropsWithRef<"li">;

export function MySidebarMenuItem(props: MySidebarMenuItem_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<li ref={ref} id={id} className={cn(CLASS_NAMES.menuItem, className)} {...rest}>
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
		CLASS_NAMES.menuButton,
		variant === "outline" ? CLASS_NAMES.menuButtonOutline : null,
		size === "sm" ? CLASS_NAMES.menuButtonSizeSm : null,
		size === "lg" ? CLASS_NAMES.menuButtonSizeLg : null,
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
			className={cn(CLASS_NAMES.menuAction, showOnHover ? CLASS_NAMES.menuActionShowOnHover : null, className)}
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
		<div ref={ref} id={id} className={cn(CLASS_NAMES.menuBadge, className)} {...rest}>
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
		<div ref={ref} id={id} className={cn(CLASS_NAMES.menuSkeleton, className)} {...rest}>
			{showIcon ? <Skeleton className={CLASS_NAMES.menuSkeletonIcon} /> : null}
			<Skeleton className={CLASS_NAMES.menuSkeletonText} style={{ "--skeleton-width": width } as CSSProperties} />
		</div>
	);
}

export type MySidebarMenuSub_Props = ComponentPropsWithRef<"ul">;

export function MySidebarMenuSub(props: MySidebarMenuSub_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<ul ref={ref} id={id} className={cn(CLASS_NAMES.menuSub, className)} {...rest}>
			{children}
		</ul>
	);
}

export type MySidebarMenuSubItem_Props = ComponentPropsWithRef<"li">;

export function MySidebarMenuSubItem(props: MySidebarMenuSubItem_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<li ref={ref} id={id} className={cn(CLASS_NAMES.menuSubItem, className)} {...rest}>
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
			className={cn(CLASS_NAMES.menuSubButton, className)}
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
		<button ref={ref} id={id} type="button" className={cn(CLASS_NAMES.trigger, className)} {...rest}>
			{children ?? <PanelLeftIcon size={16} />}
		</button>
	);
}

export type MySidebarRail_Props = ComponentPropsWithRef<"button">;

export function MySidebarRail(props: MySidebarRail_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<button ref={ref} id={id} type="button" className={cn(CLASS_NAMES.rail, className)} {...rest}>
			{children}
		</button>
	);
}

export type MySidebarInset_Props = ComponentPropsWithRef<"main">;

export function MySidebarInset(props: MySidebarInset_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<main ref={ref} id={id} className={cn(CLASS_NAMES.inset, className)} {...rest}>
			{children}
		</main>
	);
}

export type MySidebarInput_Props = ComponentPropsWithRef<typeof Input>;

export function MySidebarInput(props: MySidebarInput_Props) {
	const { ref, id, className, ...rest } = props;

	return <Input ref={ref} id={id} className={cn(CLASS_NAMES.input, className)} {...rest} />;
}
