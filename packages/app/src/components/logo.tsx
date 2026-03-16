import "./logo.css";

import { memo, type ComponentPropsWithRef } from "react";
import { cn } from "../lib/utils.ts";

type Logo_ClassNames = "Logo" | "Logo-text";

export type Logo_Props = ComponentPropsWithRef<"div">;

export const Logo = memo(function Logo({ className, ...rest }: Logo_Props) {
	return (
		<div className={cn("Logo" satisfies Logo_ClassNames, className)} {...rest}>
			<h1 className={"Logo-text" satisfies Logo_ClassNames}>ChimpPress</h1>
		</div>
	);
});
