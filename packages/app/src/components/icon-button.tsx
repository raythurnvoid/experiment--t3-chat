import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type IconButton_Props = React.ComponentProps<typeof Button> & {
	tooltip?: string;
	side?: "top" | "bottom" | "left" | "right";
	ref?: React.RefObject<HTMLButtonElement>;
};

export function IconButton({ children, tooltip, side = "bottom", className, ref, ...props }: IconButton_Props) {
	const buttonElement = (
		<Button ref={ref} className={cn("IconButton", className)} {...props}>
			{children}
			{tooltip && <span className="IconButton-sr-only sr-only">{tooltip}</span>}
		</Button>
	);

	// If no tooltip provided, return button directly
	if (!tooltip) {
		return buttonElement;
	}

	// Wrap with tooltip when tooltip is provided
	return (
		<Tooltip>
			<TooltipTrigger asChild>{buttonElement}</TooltipTrigger>
			<TooltipContent side={side}>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
