import { useQuery } from "convex/react";
import { memo, useEffect } from "react";

import { app_convex_api } from "@/lib/app-convex-client.ts";
import { url_path_pages, app_tenant_defaults_from_workspace_list } from "@/lib/urls.ts";

const Route = createFileRoute({
	component: IndexRedirect,
});

export { Route };

const IndexRedirect = memo(function IndexRedirect() {
	const navigate = Route.useNavigate();
	const list = useQuery(app_convex_api.workspaces.list);

	useEffect(() => {
		if (list === undefined) {
			return;
		}

		const defaults = app_tenant_defaults_from_workspace_list(list);
		if (defaults === null) {
			console.error("[IndexRedirect] Missing default workspace/project for user");
			return;
		}

		const target = url_path_pages({
			workspaceName: defaults.workspaceName,
			projectName: defaults.projectName,
		});

		navigate({ to: target, replace: true }).catch((error: unknown) => {
			console.error("[IndexRedirect] Failed to navigate to default tenant", { error, defaults });
		});
	}, [list, navigate]);

	return <div>Redirecting…</div>;
});
