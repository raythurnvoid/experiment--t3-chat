import "./my-label.css";

import { memo, type ComponentPropsWithRef, type Ref } from "react";

import { cn } from "@/lib/utils.ts";

export type MyLabel_ClassNames = "MyLabel";

export type MyLabel_Props = ComponentPropsWithRef<"label"> & {
	ref?: Ref<HTMLLabelElement>;
	id?: string;
	className?: string;
	children?: React.ReactNode;
};

export const MyLabel = memo(function MyLabel(props: MyLabel_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<label ref={ref} id={id} className={cn("MyLabel" satisfies MyLabel_ClassNames, className)} {...rest}>
			{children}
		</label>
	);
});
