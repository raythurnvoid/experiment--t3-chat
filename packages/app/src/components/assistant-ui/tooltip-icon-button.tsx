// Original file at: 263f9e51

import type { ComponentPropsWithoutRef } from "react";
import { forwardRef } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

export type TooltipIconButtonProps = ComponentPropsWithoutRef<typeof Button> & {
	tooltip: string;
	side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
	({ children, tooltip, side = "bottom", className, ...rest }, ref) => {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="icon" {...rest} className={cn("size-6 p-1", className)} ref={ref}>
						{children}
						<span className="sr-only">{tooltip}</span>
					</Button>
				</TooltipTrigger>
				<TooltipContent side={side}>{tooltip}</TooltipContent>
			</Tooltip>
		);
	},
);

TooltipIconButton.displayName = "TooltipIconButton";
