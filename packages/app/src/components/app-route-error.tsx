import "./app-route-error.css";
import { memo } from "react";
import { cn } from "@/lib/utils.ts";
import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { ChevronRight } from "lucide-react";
import type { ErrorComponentProps } from "@tanstack/react-router";

function format_error_cause_for_technical_details(cause: unknown): string {
	if (cause === undefined || cause === null) {
		return "";
	}

	if (cause instanceof Error) {
		return [cause.message && `Message: ${cause.message}`, cause.stack && `Stack:\n${cause.stack}`]
			.filter(Boolean)
			.join("\n\n");
	}

	try {
		return JSON.stringify(cause, null, 2);
	} catch {
		return String(cause);
	}
}

export type AppRouteError_ClassNames =
	| "AppRouteError"
	| "AppRouteError-layout-embedded"
	| "AppRouteError-layout-fullscreen"
	| "AppRouteError-content"
	| "AppRouteError-title"
	| "AppRouteError-description"
	| "AppRouteError-actions"
	| "AppRouteError-retry-button"
	| "AppRouteError-technical-details"
	| "AppRouteError-technical-details-toggle"
	| "AppRouteError-technical-details-toggle-icon"
	| "AppRouteError-technical-details-pre"
	| "AppRouteError-technical-details-textarea";

export type AppRouteError_Props = ErrorComponentProps & {
	title?: string;
	description?: string;
	retryLabel?: string;
	layout?: "embedded" | "fullscreen";
	technicalDetailsMode?: "always" | "dev_only";
};

export const AppRouteError = memo(function AppRouteError(props: AppRouteError_Props) {
	const {
		error,
		info,
		reset,
		title = "Something went wrong",
		description = "Try again, or reload the page if the problem persists.",
		retryLabel = "Try again",
		layout = "embedded",
		technicalDetailsMode = "dev_only",
	} = props;

	const show_technical_block =
		technicalDetailsMode === "always" || (technicalDetailsMode === "dev_only" && import.meta.env.DEV);

	const technical_parts: string[] = [];

	if (show_technical_block) {
		if (error.message) {
			technical_parts.push(`Error message: ${error.message}`);
		}
		if (error.stack) {
			technical_parts.push(`Stack trace:\n${error.stack}`);
		}
		if (info?.componentStack) {
			technical_parts.push(`Component stack:\n${info.componentStack}`);
		}

		const cause_text = format_error_cause_for_technical_details(error.cause);
		if (cause_text) {
			technical_parts.push(`Cause:\n${cause_text}`);
		}
	}

	const technical_details = technical_parts.filter(Boolean).join("\n\n");

	return (
		<div
			className={cn(
				"AppRouteError" satisfies AppRouteError_ClassNames,
				layout === "embedded" && ("AppRouteError-layout-embedded" satisfies AppRouteError_ClassNames),
				layout === "fullscreen" && ("AppRouteError-layout-fullscreen" satisfies AppRouteError_ClassNames),
			)}
		>
			<div className={cn("AppRouteError-content" satisfies AppRouteError_ClassNames)}>
				<div className={cn("AppRouteError-title" satisfies AppRouteError_ClassNames)}>{title}</div>
				<div className={cn("AppRouteError-description" satisfies AppRouteError_ClassNames)}>{description}</div>
				{reset ? (
					<div className={cn("AppRouteError-actions" satisfies AppRouteError_ClassNames)}>
						<MyButton
							variant="secondary"
							type="button"
							className={cn("AppRouteError-retry-button" satisfies AppRouteError_ClassNames)}
							onClick={() => {
								reset();
							}}
						>
							{retryLabel}
						</MyButton>
					</div>
				) : null}
				{technical_details ? (
					<details className={cn("AppRouteError-technical-details" satisfies AppRouteError_ClassNames)}>
						<summary className={cn("AppRouteError-technical-details-toggle" satisfies AppRouteError_ClassNames)}>
							<span>Technical details</span>
							<MyIcon
								className={cn("AppRouteError-technical-details-toggle-icon" satisfies AppRouteError_ClassNames)}
							>
								<ChevronRight />
							</MyIcon>
						</summary>
						<pre className={cn("AppRouteError-technical-details-pre" satisfies AppRouteError_ClassNames)}>
							<textarea
								className={cn("AppRouteError-technical-details-textarea" satisfies AppRouteError_ClassNames)}
								readOnly
								value={technical_details}
							></textarea>
						</pre>
					</details>
				) : null}
			</div>
		</div>
	);
});
