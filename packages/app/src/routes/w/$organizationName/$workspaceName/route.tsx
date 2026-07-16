import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { MainAppHeader } from "@/components/main-app-header.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { cn } from "@/lib/utils.ts";

import type { RootLayout_ClassNames } from "@/routes/__root.tsx";

function RouteTenantOrganizationWorkspaceLayout() {
	const params = Route.useParams();
	const { organizationName, workspaceName } = params;

	const membership = useQuery(app_convex_api.organizations.get_membership_by_organization_workspace_name, {
		organizationName,
		workspaceName,
	});

	if (membership === undefined) {
		return (
			<main role="status" aria-live="polite" aria-label="Organization loading">
				Loading organization
			</main>
		);
	}

	if (membership === null) {
		return (
			<main role="alert" aria-label="Organization access denied">
				You do not have access to this organization/workspace.
			</main>
		);
	}

	const organizationId = membership.organizationId;
	const workspaceId = membership.workspaceId;

	return (
		<AppTenantProvider
			membershipId={membership._id}
			organizationId={organizationId}
			organizationName={organizationName}
			workspaceId={workspaceId}
			workspaceName={workspaceName}
		>
			<div className={cn("RootLayout" satisfies RootLayout_ClassNames)}>
				<MainAppHeader />
				<MainAppSidebar />
				<div className={"RootLayout-content" satisfies RootLayout_ClassNames}>
					<Outlet />
				</div>
			</div>
		</AppTenantProvider>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName")({
	component: RouteTenantOrganizationWorkspaceLayout,
});

export { Route };
