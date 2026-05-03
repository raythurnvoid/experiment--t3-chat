import type { ErrorComponentProps } from "@tanstack/react-router";
import { AppRouteError } from "@/components/app-route-error.tsx";

export type FileEditorError_Props = ErrorComponentProps & {
	title?: string;
	description?: string;
	retryLabel?: string;
};

export function FileEditorError(props: FileEditorError_Props) {
	const { title = "Editor failed to load.", description, retryLabel, ...rest } = props;

	return (
		<AppRouteError
			{...rest}
			layout="embedded"
			technicalDetailsMode="always"
			title={title}
			description={
				description ?? "Try again, or reload the file if the problem persists."
			}
			retryLabel={retryLabel ?? "Try again"}
		/>
	);
}
