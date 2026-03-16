import "./my-sidebar.css";

import { Slot } from "@radix-ui/react-slot";
import { PanelLeftIcon } from "lucide-react";
import { memo, useEffect, useState, type ComponentPropsWithRef } from "react";

import { Separator } from "@/components/ui/separator.tsx";
import { MyPrimaryAction, MyPrimaryActionLink } from "@/components/my-action.tsx";
import { MyHovercardAction } from "@/components/my-hovercard.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { cn } from "@/lib/utils.ts";

type MySidebar_CssVars = {
	"--my-sidebar-width": string;
};

const MySidebar_CssVars_DEFAULTS: Partial<MySidebar_CssVars> = {
	"--my-sidebar-width": "320px",
};

// #region list item
type MySidebarListItem_ClassNames = "MySidebarListItem";

export type MySidebarListItem_Props = ComponentPropsWithRef<"li">;

export const MySidebarListItem = memo(function MySidebarListItem(props: MySidebarListItem_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<li
			ref={ref}
			id={id}
			className={cn("MySidebarListItem" satisfies MySidebarListItem_ClassNames, className)}
			{...rest}
		>
			{children}
		</li>
	);
});
// #endregion list item

// #region list item title
type MySidebarListItemTitle_ClassNames = "MySidebarListItemTitle";

export type MySidebarListItemTitle_Props = ComponentPropsWithRef<"span">;

export const MySidebarListItemTitle = memo(function MySidebarListItemTitle(props: MySidebarListItemTitle_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<span
			ref={ref}
			id={id}
			className={cn("MySidebarListItemTitle" satisfies MySidebarListItemTitle_ClassNames, className)}
			{...rest}
		>
			{children}
		</span>
	);
});
// #endregion list item title

// #region list item icon
type MySidebarListItemIcon_ClassNames = "MySidebarListItemIcon";

export type MySidebarListItemIcon_Props = ComponentPropsWithRef<typeof MyIcon>;

export const MySidebarListItemIcon = memo(function MySidebarListItemIcon(props: MySidebarListItemIcon_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<MyIcon
			ref={ref}
			id={id}
			className={cn("MySidebarListItemIcon" satisfies MySidebarListItemIcon_ClassNames, className)}
			{...rest}
		>
			{children}
		</MyIcon>
	);
});
// #endregion list item icon

// #region list item primary action
type MySidebarListItemPrimaryAction_ClassNames = "MySidebarListItemPrimaryAction";

export type MySidebarListItemPrimaryAction_Props = ComponentPropsWithRef<typeof MyPrimaryAction>;

export const MySidebarListItemPrimaryAction = memo(function MySidebarListItemPrimaryAction(
	props: MySidebarListItemPrimaryAction_Props,
) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<MyPrimaryAction
			ref={ref}
			id={id}
			className={cn("MySidebarListItemPrimaryAction" satisfies MySidebarListItemPrimaryAction_ClassNames, className)}
			{...rest}
		>
			{children}
		</MyPrimaryAction>
	);
});
// #endregion list item primary action

// #region list item primary action link
type MySidebarListItemPrimaryActionLink_ClassNames = "MySidebarListItemPrimaryActionLink";

export type MySidebarListItemPrimaryActionLink_Props = ComponentPropsWithRef<typeof MyPrimaryActionLink>;

export const MySidebarListItemPrimaryActionLink = memo(function MySidebarListItemPrimaryActionLink(
	props: MySidebarListItemPrimaryActionLink_Props,
) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<MyPrimaryActionLink
			ref={ref}
			id={id}
			className={cn(
				"MySidebarListItemPrimaryActionLink" satisfies MySidebarListItemPrimaryActionLink_ClassNames,
				className,
			)}
			{...rest}
		>
			{children}
		</MyPrimaryActionLink>
	);
});
// #endregion list item primary action link

// #region list
type MySidebarList_ClassNames = "MySidebarList";

export type MySidebarList_Props = ComponentPropsWithRef<"ul">;

export const MySidebarList = memo(function MySidebarList(props: MySidebarList_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<ul ref={ref} id={id} className={cn("MySidebarList" satisfies MySidebarList_ClassNames, className)} {...rest}>
			{children}
		</ul>
	);
});
// #endregion list

// #region section
type MySidebarSection_ClassNames = "MySidebarSection";

export type MySidebarSection_Props = ComponentPropsWithRef<"div">;

export const MySidebarSection = memo(function MySidebarSection(props: MySidebarSection_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<section
			ref={ref}
			id={id}
			className={cn("MySidebarSection" satisfies MySidebarSection_ClassNames, className)}
			{...rest}
		>
			{children}
		</section>
	);
});
// #endregion section

// #region primary action
type MySidebarPrimaryAction_ClassNames = "MySidebarPrimaryAction";

export type MySidebarPrimaryAction_Props = ComponentPropsWithRef<typeof MyPrimaryAction>;

export const MySidebarPrimaryAction = memo(function MySidebarPrimaryAction(props: MySidebarPrimaryAction_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<MyPrimaryAction
			ref={ref}
			id={id}
			className={cn("MySidebarPrimaryAction" satisfies MySidebarPrimaryAction_ClassNames, className)}
			{...rest}
		>
			{children}
		</MyPrimaryAction>
	);
});
// #endregion primary action

// #region hovercard action
type MySidebarHovercardAction_ClassNames = "MySidebarHovercardAction";

export type MySidebarHovercardAction_Props = ComponentPropsWithRef<"div">;

export const MySidebarHovercardAction = memo(function MySidebarHovercardAction(props: MySidebarHovercardAction_Props) {
	const { ref: _ref, id, className, children, ...rest } = props;

	return (
		<MyHovercardAction
			id={id}
			className={cn("MySidebarHovercardAction" satisfies MySidebarHovercardAction_ClassNames, className)}
			{...(rest as any)}
		>
			{children}
		</MyHovercardAction>
	);
});
// #endregion hovercard action

// #region scrollable area
type MySidebarScrollableArea_ClassNames = "MySidebarScrollableArea";

export type MySidebarScrollableArea_Props = ComponentPropsWithRef<"div">;

export const MySidebarScrollableArea = memo(function MySidebarScrollableArea(props: MySidebarScrollableArea_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MySidebarScrollableArea" satisfies MySidebarScrollableArea_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion scrollable area

// #region group content
type MySidebarGroupContent_ClassNames = "MySidebarGroupContent";

export type MySidebarGroupContent_Props = ComponentPropsWithRef<"div">;

export const MySidebarGroupContent = memo(function MySidebarGroupContent(props: MySidebarGroupContent_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("MySidebarGroupContent" satisfies MySidebarGroupContent_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
});
// #endregion group content

// #region group action
type MySidebarGroupAction_ClassNames = "MySidebarGroupAction";

export type MySidebarGroupAction_Props = ComponentPropsWithRef<"button"> & {
	asChild?: boolean;
};

export const MySidebarGroupAction = memo(function MySidebarGroupAction(props: MySidebarGroupAction_Props) {
	const { ref, id, className, asChild = false, children, ...rest } = props;
	const Comp = asChild ? Slot : "button";

	return (
		<Comp
			ref={ref}
			id={id}
			type={asChild ? undefined : "button"}
			className={cn("MySidebarGroupAction" satisfies MySidebarGroupAction_ClassNames, className)}
			{...rest}
		>
			{children}
		</Comp>
	);
});
// #endregion group action

// #region group label
type MySidebarGroupLabel_ClassNames = "MySidebarGroupLabel";

export type MySidebarGroupLabel_Props = ComponentPropsWithRef<"div"> & {
	asChild?: boolean;
};

export const MySidebarGroupLabel = memo(function MySidebarGroupLabel(props: MySidebarGroupLabel_Props) {
	const { ref, id, className, asChild = false, children, ...rest } = props;
	const Comp = asChild ? Slot : "div";

	return (
		<Comp
			ref={ref}
			id={id}
			className={cn("MySidebarGroupLabel" satisfies MySidebarGroupLabel_ClassNames, className)}
			{...rest}
		>
			{children}
		</Comp>
	);
});
// #endregion group label

// #region group
type MySidebarGroup_ClassNames = "MySidebarGroup";

export type MySidebarGroup_Props = ComponentPropsWithRef<"div">;

export const MySidebarGroup = memo(function MySidebarGroup(props: MySidebarGroup_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarGroup" satisfies MySidebarGroup_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion group

// #region separator
type MySidebarSeparator_ClassNames = "MySidebarSeparator";

export type MySidebarSeparator_Props = ComponentPropsWithRef<typeof Separator>;

export const MySidebarSeparator = memo(function MySidebarSeparator(props: MySidebarSeparator_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<Separator
			ref={ref}
			id={id}
			className={cn("MySidebarSeparator" satisfies MySidebarSeparator_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion separator

// #region footer
type MySidebarFooter_ClassNames = "MySidebarFooter";

export type MySidebarFooter_Props = ComponentPropsWithRef<"div">;

export const MySidebarFooter = memo(function MySidebarFooter(props: MySidebarFooter_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarFooter" satisfies MySidebarFooter_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion footer

// #region header
type MySidebarHeader_ClassNames = "MySidebarHeader";

export type MySidebarHeader_Props = ComponentPropsWithRef<"div">;

export const MySidebarHeader = memo(function MySidebarHeader(props: MySidebarHeader_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div ref={ref} id={id} className={cn("MySidebarHeader" satisfies MySidebarHeader_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion header

// #region trigger
type MySidebarTrigger_ClassNames = "MySidebarTrigger";

export type MySidebarTrigger_Props = ComponentPropsWithRef<"button">;

export const MySidebarTrigger = memo(function MySidebarTrigger(props: MySidebarTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<button
			ref={ref}
			id={id}
			type="button"
			className={cn("MySidebarTrigger" satisfies MySidebarTrigger_ClassNames, className)}
			{...rest}
		>
			{children ?? <PanelLeftIcon size={16} />}
		</button>
	);
});
// #endregion trigger

// #region rail
type MySidebarRail_ClassNames = "MySidebarRail";

export type MySidebarRail_Props = ComponentPropsWithRef<"button">;

export const MySidebarRail = memo(function MySidebarRail(props: MySidebarRail_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<button
			ref={ref}
			id={id}
			type="button"
			className={cn("MySidebarRail" satisfies MySidebarRail_ClassNames, className)}
			{...rest}
		>
			{children}
		</button>
	);
});
// #endregion rail

// #region inset
type MySidebarInset_ClassNames = "MySidebarInset";

export type MySidebarInset_Props = ComponentPropsWithRef<"main">;

export const MySidebarInset = memo(function MySidebarInset(props: MySidebarInset_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<main ref={ref} id={id} className={cn("MySidebarInset" satisfies MySidebarInset_ClassNames, className)} {...rest}>
			{children}
		</main>
	);
});
// #endregion inset

// #region root
type MySidebar_ClassNames = "MySidebar" | "MySidebar-state-expanded" | "MySidebar-state-closed" | "MySidebar-mounted";

export type MySidebar_Props = ComponentPropsWithRef<"aside"> & {
	state: "closed" | "expanded";
};

export const MySidebar = memo(function MySidebar(props: MySidebar_Props) {
	const { ref, id, className, state, children, style, ...rest } = props;
	const [isMounted, setIsMounted] = useState(false);

	useEffect(() => {
		setIsMounted(true);
	}, []);

	const stateClassName =
		state === "expanded"
			? ("MySidebar-state-expanded" satisfies MySidebar_ClassNames)
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
				...MySidebar_CssVars_DEFAULTS,
				...style,
			}}
			{...rest}
		>
			{children}
		</aside>
	);
});
// #endregion root
