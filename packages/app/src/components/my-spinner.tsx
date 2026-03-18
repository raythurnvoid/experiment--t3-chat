import "./my-spinner.css";
import { cn } from "@/lib/utils.ts";

export type MySpinner_ClassNames = "MySpinner" | "MySpinner-circle" | "MySpinner-path";

export type MySpinner_Props = React.ComponentProps<"div"> & {
	className?: string;
	/**
	 * Size of the spinner. Can be any CSS length value.
	 * @default "1em"
	 * @example "1em" | "24px" | "2rem"
	 */
	size?: string;
	/**
	 * Color of the spinner. Can be any CSS color value.
	 * @default "currentColor"
	 * @example "currentColor" | "#333" | "var(--color-accent-06)"
	 */
	color?: string;
	"aria-label"?: string;
};

export function MySpinner(props: MySpinner_Props) {
	const {
		className,
		size = "1em",
		color = "currentColor",
		"aria-label": ariaLabel = "Loading",
		style,
		...rest
	} = props;

	return (
		<div
			className={cn("MySpinner" satisfies MySpinner_ClassNames, className)}
			role="progressbar"
			aria-label={ariaLabel}
			style={
				{
					...style,
					"--MySpinner-size": size,
					"--MySpinner-color": color,
				} as React.CSSProperties
			}
			{...rest}
		>
			<svg className={cn("MySpinner-circle" satisfies MySpinner_ClassNames)} viewBox="0 0 50 50">
				<circle
					className={cn("MySpinner-path" satisfies MySpinner_ClassNames)}
					cx="25"
					cy="25"
					r="20"
					fill="none"
					stroke="currentColor"
					strokeWidth="4"
				/>
			</svg>
		</div>
	);
}
