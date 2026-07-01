import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { memo, useEffect } from "react";

import { app_convex_api } from "@/lib/app-convex-client.ts";
import { url_path_files, app_tenant_defaults_from_organization_list } from "@/lib/urls.ts";

const IndexRedirect = memo(function IndexRedirect() {
	const navigate = Route.useNavigate();
	const list = useQuery(app_convex_api.organizations.list);

	useEffect(() => {
		if (list === undefined) {
			return;
		}

		const defaults = app_tenant_defaults_from_organization_list(list);
		if (defaults === null) {
			console.error("[IndexRedirect] Missing default organization/workspace for user");
			return;
		}

		const target = url_path_files({
			organizationName: defaults.organizationName,
			workspaceName: defaults.workspaceName,
		});

		navigate({ to: target, replace: true }).catch((error: unknown) => {
			console.error("[IndexRedirect] Failed to navigate to default tenant", { error, defaults });
		});
	}, [list, navigate]);

	return (
		<main role="status" aria-live="polite" aria-label="Organization redirect">
			Redirecting to organization
		</main>
	);
});

const Route = createFileRoute("/")({
	component: IndexRedirect,
});

export { Route };
