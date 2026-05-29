import "./my-floating-card.css";
import { memo, type ComponentPropsWithRef, type Ref } from "react";
import { cn } from "@/lib/utils.ts";

export type MyFloatingCard_ClassNames = "MyFloatingCard";

export type MyFloatingCard_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	className?: string;
};

export const MyFloatingCard = memo(function MyFloatingCard(props: MyFloatingCard_Props) {
	const { ref, className, children, ...rest } = props;

	return (
		<div ref={ref} className={cn("MyFloatingCard" satisfies MyFloatingCard_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
