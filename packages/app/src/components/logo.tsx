import "./logo.css";

import { memo, type ComponentPropsWithRef } from "react";
import { cn } from "../lib/utils.ts";

type Logo_ClassNames = "Logo" | "Logo-mark" | "Logo-text";

export type Logo_Props = ComponentPropsWithRef<"div">;

export const Logo = memo(function Logo({ className, ...rest }: Logo_Props) {
	return (
		<div className={cn("Logo" satisfies Logo_ClassNames, className)} {...rest}>
			{/* The mark is decorative. The heading text already names the app. */}
			<img className={"Logo-mark" satisfies Logo_ClassNames} src="/press-logo.svg" alt="" />
			<h1 className={"Logo-text" satisfies Logo_ClassNames}>Press</h1>
		</div>
	);
});
