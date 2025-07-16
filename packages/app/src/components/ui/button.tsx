import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";
import "./button.css";

const Button_class_names = {
	root: "Button",
	variants: {
		variant: {
			default: "Button-variant-default",
			destructive: "Button-variant-destructive",
			outline: "Button-variant-outline",
			secondary: "Button-variant-secondary",
			ghost: "Button-variant-ghost",
			link: "Button-variant-link",
		},
		size: {
			default: "Button-size-default",
			sm: "Button-size-sm",
			lg: "Button-size-lg",
			icon: "Button-size-icon",
		},
	},
};

type Variant = keyof typeof Button_class_names.variants.variant | null;
type Size = keyof typeof Button_class_names.variants.size | null;

type Button_Props = React.ComponentProps<"button"> & {
	variant?: Variant;
	size?: Size;
	asChild?: boolean;
};

function Button({ className, variant = "default", size = "default", asChild = false, ...props }: Button_Props) {
	const Comp = asChild ? Slot : "button";

	return (
		<Comp
			className={cn(
				Button_class_names.root,
				variant && Button_class_names.variants.variant[variant],
				size && Button_class_names.variants.size[size],
				className,
			)}
			{...props}
		/>
	);
}

export { Button, Button_class_names as buttonVariants };
export type { Button_Props };
