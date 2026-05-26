import "./my-radio-surface.css";

import { memo, type ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils.ts";

// #region root
export type MyRadioSurface_ClassNames =
	| "MyRadioSurface"
	| "MyRadioSurface-dot"
	| "MyRadioSurface-state-checked"
	| "MyRadioSurface-state-disabled"
	| "MyRadioSurface-state-focus-visible";

export type MyRadioSurface_Props = Omit<ComponentPropsWithRef<"span">, "children">;

export const MyRadioSurface = memo(function MyRadioSurface(props: MyRadioSurface_Props) {
	const { className, ...rest } = props;

	return (
		<span aria-hidden className={cn("MyRadioSurface" satisfies MyRadioSurface_ClassNames, className)} {...rest}>
			<span className={"MyRadioSurface-dot" satisfies MyRadioSurface_ClassNames} />
		</span>
	);
});
// #endregion root
