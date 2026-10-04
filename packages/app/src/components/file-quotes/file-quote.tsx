import "./file-quote.css";
import { memo } from "react";
import { useQuery } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { url_path_file_by_node_id } from "@/lib/urls.ts";
import type { file_quotes_Quote } from "../../../shared/file-quotes.ts";

type FileQuote_ClassNames = "FileQuote" | "FileQuote-file" | "FileQuote-text";

export const FileQuote = memo(function FileQuote(props: { quote: file_quotes_Quote }) {
	const { quote } = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const file = useQuery(
		app_convex_api.files_nodes.get_file_node_for_membership,
		quote.fileNodeId === null ? "skip" : { membershipId, fileNodeId: quote.fileNodeId },
	);
	const available = file?.kind === "file" && file.archiveOperationId === null;
	return (
		<span
			className={"FileQuote" satisfies FileQuote_ClassNames}
			data-file-quote-state={
				available ? "available" : quote.fileNodeId !== null && file === undefined ? "loading" : "unavailable"
			}
		>
			{available && (
				<a
					className={"FileQuote-file" satisfies FileQuote_ClassNames}
					href={url_path_file_by_node_id({ organizationName, workspaceName, nodeId: file._id })}
					title={file.path}
				>
					{file.name}
				</a>
			)}
			<span className={"FileQuote-text" satisfies FileQuote_ClassNames}>{quote.text}</span>
		</span>
	);
});
