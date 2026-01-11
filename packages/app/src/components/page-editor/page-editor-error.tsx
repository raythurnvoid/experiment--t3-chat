import "./page-editor-error.css";
import { cn } from "@/lib/utils.ts";
import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { ChevronRight } from "lucide-react";
import type { ErrorComponentProps } from "@tanstack/react-router";

export type PageEditorError_ClassNames =
	| "PageEditorError"
	| "PageEditorError-content"
	| "PageEditorError-title"
	| "PageEditorError-description"
	| "PageEditorError-actions"
	| "PageEditorError-retry-button"
	| "PageEditorError-technical-details"
	| "PageEditorError-technical-details-toggle"
	| "PageEditorError-technical-details-toggle-icon"
	| "PageEditorError-technical-details-pre"
	| "PageEditorError-technical-details-textarea";

export type PageEditorError_Props = ErrorComponentProps & {
	title?: string;
	description?: string;
	retryLabel?: string;
};

export function PageEditorError(props: PageEditorError_Props) {
	const {
		error,
		info,
		reset,
		title = "Editor failed to load.",
		description = "Try again, or reload the page if the problem persists.",
		retryLabel = "Try again",
	} = props;

	const technicalDetails = [
		error.message && `Error message: ${error.message}`,
		error.stack && `Stack trace:\n${error.stack}`,
		info?.componentStack && `Component stack:\n${info.componentStack}`,
	]
		.filter(Boolean)
		.join("\n\n");

	return (
		<div className={cn("PageEditorError" satisfies PageEditorError_ClassNames)}>
			<div className={cn("PageEditorError-content" satisfies PageEditorError_ClassNames)}>
				<div className={cn("PageEditorError-title" satisfies PageEditorError_ClassNames)}>{title}</div>
				<div className={cn("PageEditorError-description" satisfies PageEditorError_ClassNames)}>{description}</div>
				{reset && (
					<div className={cn("PageEditorError-actions" satisfies PageEditorError_ClassNames)}>
						<MyButton
							variant="secondary"
							className={cn("PageEditorError-retry-button" satisfies PageEditorError_ClassNames)}
							onClick={reset}
						>
							{retryLabel}
						</MyButton>
					</div>
				)}
				{technicalDetails && (
					<details className={cn("PageEditorError-technical-details" satisfies PageEditorError_ClassNames)}>
						<summary className={cn("PageEditorError-technical-details-toggle" satisfies PageEditorError_ClassNames)}>
							<span>Technical details</span>
							<MyIcon
								className={cn("PageEditorError-technical-details-toggle-icon" satisfies PageEditorError_ClassNames)}
							>
								<ChevronRight />
							</MyIcon>
						</summary>
						<pre className={cn("PageEditorError-technical-details-pre" satisfies PageEditorError_ClassNames)}>
							<textarea
								className={cn("PageEditorError-technical-details-textarea" satisfies PageEditorError_ClassNames)}
								readOnly
								value={technicalDetails}
							></textarea>
						</pre>
					</details>
				)}
			</div>
		</div>
	);
}
