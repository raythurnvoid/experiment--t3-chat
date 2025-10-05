import "./my-icon-button.css";

import type { ComponentPropsWithRef, Ref } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";

type MyIconButton_ClassNames = "MyIconButton";

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
		<Tooltip>
			<TooltipTrigger asChild>{buttonElement}</TooltipTrigger>
			<TooltipContent side={side}>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
