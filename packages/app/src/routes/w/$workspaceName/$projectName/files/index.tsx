import { FileNodeView, type FileNodeView_Props } from "@/components/file-node-view/file-node-view.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_editor_view_values } from "@/lib/files.ts";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { memo } from "react";
import { z } from "zod";

const RouteFiles = memo(function RouteFiles() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();
	const { workspaceName, projectName } = AppTenantProvider.useContext();

	const handleNavigateSearch = useFn<FileNodeView_Props["onNavigateSearch"]>((search) => {
		navigate({
			to: "/w/$workspaceName/$projectName/files",
			params: { workspaceName, projectName },
			search,
		}).catch((error) => {
			console.error("[RouteFiles.handleNavigateSearch] Error navigating to files search", { error, search });
		});
	});

	return <FileNodeView searchParams={searchParams} onNavigateSearch={handleNavigateSearch} />;
});

const Route = createFileRoute("/w/$workspaceName/$projectName/files/")({
	component: RouteFiles,
	validateSearch: zodValidator(
		z.object({
			nodeId: z.string().optional().catch(undefined),
			view: z.enum(files_editor_view_values).optional().catch(undefined),
		}),
	),
});

export { Route };
