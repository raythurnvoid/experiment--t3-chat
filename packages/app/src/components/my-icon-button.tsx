import "./my-icon-button.css";

import type { ComponentPropsWithRef, Ref } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { cn } from "@/lib/utils.ts";

export type MyIconButton_ClassNames = "MyIconButton";

export type MyIconButton_Props = ComponentPropsWithRef<typeof MyButton> & {
	ref?: Ref<HTMLButtonElement>;
	tooltip?: string;
	side?: "top" | "bottom" | "left" | "right";
};

export function MyIconButton(props: MyIconButton_Props) {
	const { ref, id, className, tooltip, side = "bottom", children, ...rest } = props;
	const buttonElement = (
		<MyButton
			ref={ref}
			id={id}
			className={cn("MyIconButton" satisfies MyIconButton_ClassNames, className)}
			aria-label={tooltip}
			{...rest}
		>
			{children}
			{tooltip && <span className={cn("sr-only")}>{tooltip}</span>}
		</MyButton>
	);

	if (!tooltip) {
		return buttonElement;
	}

	return (
		<MyTooltip placement={side}>
			<MyTooltipTrigger>{buttonElement}</MyTooltipTrigger>
			<MyTooltipContent>{tooltip}</MyTooltipContent>
		</MyTooltip>
	);
}

type MyIconButtonIcon_ClassNames = "MyIconButtonIcon";

export type MyIconButtonIcon_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	innerHtml?: string;
	children?: React.ReactNode;
};

export function MyIconButtonIcon(props: MyIconButtonIcon_Props) {
	const { ref, id, className, innerHtml, children, ...rest } = props;

	return (
		<MyIcon
			ref={ref}
			id={id}
			className={cn("MyIconButtonIcon" satisfies MyIconButtonIcon_ClassNames, className)}
			innerHtml={innerHtml}
			{...rest}
		>
			{children}
		</MyIcon>
	);
}
