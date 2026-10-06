import { FileNodeView, type FileNodeView_Props } from "@/components/files/file-node-view/file-node-view.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_editor_view_values } from "@/lib/files.ts";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { memo } from "react";
import { z } from "zod";
import {
	files_folder_table_query_clean,
	files_folder_table_query_MAX_LENGTH,
} from "../../../../../../shared/files-folder-table-query.ts";

const RouteFiles = memo(function RouteFiles() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();
	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	const handleNavigateSearch = useFn<FileNodeView_Props["onNavigateSearch"]>((search, options) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search,
			replace: options?.replace,
		}).catch((error) => {
			console.error("[RouteFiles.handleNavigateSearch] Error navigating to files search", { error, search });
		});
	});

	return <FileNodeView searchParams={searchParams} onNavigateSearch={handleNavigateSearch} />;
});

const Route = createFileRoute("/w/$organizationName/$workspaceName/files/")({
	component: RouteFiles,
	validateSearch: zodValidator(
		z.object({
			nodeId: z.string().optional().catch(undefined),
			pendingNodeId: z.string().optional().catch(undefined),
			view: z.enum(files_editor_view_values).optional().catch(undefined),
			/**
			 * The file view picked in the "View" select, such as `details`, `browser`, or a plugin view.
			 *
			 * The file view checks the value against the views the file really has, and falls back to
			 * the default view when it is unknown. So plugin view ids need no list here.
			 **/
			fileView: z.string().max(200).optional().catch(undefined),
			/**
			 * Seeds the files sidebar search box.
			 *
			 * The path splat route uses it for its not-found recovery link. The length cap keeps a
			 * shared link from filling the box with a very long query.
			 **/
			q: z
				.preprocess(
					// The router reads search params as JSON, so a hand-typed link like `?q=2026` arrives
					// as a number. The box wants the text.
					(value) => (typeof value === "number" || typeof value === "boolean" ? String(value) : value),
					z.string().max(2000),
				)
				.optional()
				.catch(undefined),
			/**
			 * The committed filter and sort tokens of the folder table bar, like `file.name:starts_with:report`
			 * or `sort_by:file.updated:desc`.
			 *
			 * The cleaner drops every token that cannot run, so a hand-edited link still opens. Old links
			 * lose their `contains` and `missing` filters and their extra sorts. A value over the length
			 * cap is ignored. An empty result is the same as no value.
			 **/
			filter: z
				.preprocess(
					(value) => (typeof value === "number" || typeof value === "boolean" ? String(value) : value),
					z.string().max(files_folder_table_query_MAX_LENGTH),
				)
				.transform((value) => files_folder_table_query_clean(value) || undefined)
				.optional()
				.catch(undefined),
			/**
			 * The text the user is still typing in the folder table bar. It is not parsed, so it can hold
			 * a half-typed token. It keeps the text across a refresh.
			 **/
			view_q: z
				.preprocess(
					(value) => (typeof value === "number" || typeof value === "boolean" ? String(value) : value),
					z.string().max(files_folder_table_query_MAX_LENGTH),
				)
				.optional()
				.catch(undefined),
		}),
	),
});

export { Route };
