"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
	return (
		<LabelPrimitive.Root
			data-slot="label"
			className={cn(
				"flex items-center gap-2 text-sm leading-none font-medium select-none",
				"not-has-[disabled=true]:cursor-pointer group-data-not-disabled:cursor-pointer peer-not-disabled:cursor-pointer peer-disabled:cursor-not-allowed peer-disabled:opacity-50 has-[disabled=true]:cursor-not-allowed",
				"group-data-[disabled=true]:pontier-events-none peer-disabled:pointer-events-none",
				"group-data-[disabled=true]:opacity-50 has-[disabled=true]:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export { Label };
