import "./app-loading-card.css";
import { memo, type Ref } from "react";

import { Logo } from "./logo.tsx";
import { MySpinner } from "./my-spinner.tsx";
import { cn } from "../lib/utils.ts";

export type AppLoadingCard_ClassNames =
	| "AppLoadingCard"
	| "AppLoadingCard-panel"
	| "AppLoadingCard-logo"
	| "AppLoadingCard-spinner"
	| "AppLoadingCard-title"
	| "AppLoadingCard-description";

export type AppLoadingCard_Props = {
	ref: Ref<HTMLDivElement> | null;
	label: string;
	title: string;
	description: string;
};

export const AppLoadingCard = memo(function AppLoadingCard(props: AppLoadingCard_Props) {
	const { ref, label, title, description } = props;

	return (
		<div
			ref={ref}
			className={cn("AppLoadingCard" satisfies AppLoadingCard_ClassNames)}
			role="status"
			aria-live="polite"
			aria-label={label}
			tabIndex={-1}
		>
			<div className={cn("AppLoadingCard-panel" satisfies AppLoadingCard_ClassNames)}>
				<Logo className={"AppLoadingCard-logo" satisfies AppLoadingCard_ClassNames} />
				<MySpinner
					size="24px"
					color="var(--color-accent-07)"
					className={"AppLoadingCard-spinner" satisfies AppLoadingCard_ClassNames}
				/>
				<div className={"AppLoadingCard-title" satisfies AppLoadingCard_ClassNames}>{title}</div>
				<div className={"AppLoadingCard-description" satisfies AppLoadingCard_ClassNames}>{description}</div>
			</div>
		</div>
	);
});
