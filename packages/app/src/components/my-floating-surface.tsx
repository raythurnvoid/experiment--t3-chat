import "./my-floating-surface.css";
import { memo, type ComponentPropsWithRef, type Ref } from "react";
import { cn } from "@/lib/utils.ts";

export type MyFloatingSurface_ClassNames = "MyFloatingSurface";

export type MyFloatingSurface_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	className?: string;
};

export const MyFloatingSurface = memo(function MyFloatingSurface(props: MyFloatingSurface_Props) {
	const { ref, className, children, ...rest } = props;

	return (
		<div ref={ref} className={cn("MyFloatingSurface" satisfies MyFloatingSurface_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
