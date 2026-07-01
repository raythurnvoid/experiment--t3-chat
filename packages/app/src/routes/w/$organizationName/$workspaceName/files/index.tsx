import { FileNodeView, type FileNodeView_Props } from "@/components/files/file-node-view/file-node-view.tsx";
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
	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	const handleNavigateSearch = useFn<FileNodeView_Props["onNavigateSearch"]>((search) => {
		navigate({
			to: "/w/$organizationName/$workspaceName/files",
			params: { organizationName, workspaceName },
			search,
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
			view: z.enum(files_editor_view_values).optional().catch(undefined),
		}),
	),
});

export { Route };
