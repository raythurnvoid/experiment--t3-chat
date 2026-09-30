import "./my-progress-bar.css";
import { memo } from "react";

import { cn, sx } from "@/lib/utils.ts";

// #region root
export type MyProgressBar_ClassNames = "MyProgressBar" | "MyProgressBar-fill" | "MyProgressBar-indeterminate";

type MyProgressBar_CssVars = {
	"--MyProgressBar-value": number;
};

export type MyProgressBar_Props = {
	className?: string;
	"aria-label": string;
	value: number;
	/**
	 * null while the total is not known yet. The bar then shows a moving segment instead of a fill.
	 */
	max: number | null;
};

export const MyProgressBar = memo(function MyProgressBar(props: MyProgressBar_Props) {
	const { className, "aria-label": ariaLabel, value, max } = props;

	const isIndeterminate = max === null;
	const ratio = max === null || max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));

	return (
		<div
			role="progressbar"
			aria-label={ariaLabel}
			aria-valuemin={isIndeterminate ? undefined : 0}
			aria-valuemax={isIndeterminate ? undefined : 100}
			aria-valuenow={isIndeterminate ? undefined : Math.round(ratio * 100)}
			className={cn(
				"MyProgressBar" satisfies MyProgressBar_ClassNames,
				isIndeterminate && ("MyProgressBar-indeterminate" satisfies MyProgressBar_ClassNames),
				className,
			)}
			style={sx({ "--MyProgressBar-value": ratio } satisfies Partial<MyProgressBar_CssVars>)}
		>
			<div className={"MyProgressBar-fill" satisfies MyProgressBar_ClassNames} />
		</div>
	);
});
// #endregion root
