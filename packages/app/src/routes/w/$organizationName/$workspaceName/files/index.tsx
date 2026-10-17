import { FileNodeView, type FileNodeView_Props } from "@/components/files/file-node-view/file-node-view.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Doc } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_editor_view_values } from "@/lib/files.ts";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { useConvex } from "convex/react";
import { memo, useEffect } from "react";
import { z } from "zod";
import {
	files_folder_table_query_clean,
	files_folder_table_query_MAX_LENGTH,
} from "../../../../../../shared/files-folder-table-query.ts";

const RouteFiles = memo(function RouteFiles() {
	const router = useRouter();
	const convex = useConvex();
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();

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

	// Start the README query of the opened node as soon as the navigation starts. The new folder view
	// takes about 200ms to render before its own queries start. So the README answer comes only a few
	// frames after the view mounts, and the README area then shows the README or the "No README.md"
	// box directly. For a file the query just answers null.
	useEffect(() => {
		return router.subscribe("onBeforeNavigate", (event) => {
			// The router has not validated this search yet, so read it as unknown.
			const search: Partial<Record<string, unknown>> = event.toLocation.search;
			const nodeId = search.nodeId;
			if (event.pathChanged || typeof nodeId !== "string" || search.pendingNodeId !== undefined) {
				return;
			}

			// Keep the same arg order as the folder view, so both share one subscription.
			// The folder view holds its own subscription once it mounts, so this one ends after 10s.
			// Do not call `watchQuery(...).onUpdate(() => {})` here: the React Compiler turns the empty
			// callback into one shared function, the client keeps it once per query, and the second
			// unsubscribe throws.
			convex.prewarmQuery({
				query: app_convex_api.files_tree.get_folder_readme,
				args: { membershipId, folderId: nodeId as app_convex_Doc<"files_nodes">["parentId"] },
				extendSubscriptionFor: 10_000,
			});
		});
	}, [router, convex, membershipId]);

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
