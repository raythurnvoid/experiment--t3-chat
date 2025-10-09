import "./my-icon.css";
import type { ComponentPropsWithRef, Ref } from "react";
import { cn } from "@/lib/utils.ts";

type MyIcon_ClassNames = "MyIcon";

export type MyIcon_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	innerHtml?: string;
	children?: React.ReactNode;
};

export function MyIcon(props: MyIcon_Props) {
	const { ref, id, className, innerHtml, children, ...rest } = props;

	if (innerHtml) {
		return (
			<span
				ref={ref}
				id={id}
				className={cn("MyIcon" satisfies MyIcon_ClassNames, className)}
				dangerouslySetInnerHTML={{ __html: innerHtml }}
				{...rest}
			/>
		);
	}

	return (
		<span ref={ref} id={id} className={cn("MyIcon" satisfies MyIcon_ClassNames, className)} {...rest}>
			{children}
		</span>
	);
}
