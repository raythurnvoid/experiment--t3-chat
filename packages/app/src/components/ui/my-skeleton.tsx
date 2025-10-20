import "./my-skeleton.css";
import { cn } from "@/lib/utils.ts";

export type MySkeleton_ClassNames = "MySkeleton";

export type MySkeleton_Props = React.ComponentProps<"div"> & {
	className?: string;
};

export function MySkeleton(props: MySkeleton_Props) {
	const { className, ...rest } = props;

	return <div className={cn("MySkeleton" satisfies MySkeleton_ClassNames, className)} aria-hidden="true" {...rest} />;
}
