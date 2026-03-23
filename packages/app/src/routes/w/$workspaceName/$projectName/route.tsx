import { Outlet } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { memo, useEffect, useRef } from "react";

import { MainAppHeader } from "@/components/main-app-header.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { cn, should_never_happen } from "@/lib/utils.ts";

import type { RootLayout_ClassNames } from "@/routes/__root.tsx";

const TenantWorkspaceProjectLayout = memo(function TenantWorkspaceProjectLayout() {
	const params = Route.useParams();
	const { workspaceName, projectName } = params;

	const membership = useQuery(app_convex_api.workspaces.get_membership_by_workspace_project_name, {
		workspaceName,
		projectName,
	});
	const membershipId = membership?._id ?? "";

	const ensureHomepage = useMutation(app_convex_api.ai_docs_temp.ensure_home_page);
	const canEnsureHomePageRef = useRef(true);

	const pagesHomeIdForMembership = useAppGlobalStore((s) => s.pages_home_id_by_membership_id[membershipId] ?? "");

	useEffect(() => {
		canEnsureHomePageRef.current = true;
	}, [membershipId]);

	useEffect(() => {
		if (membership == null || pagesHomeIdForMembership || !canEnsureHomePageRef.current) {
			return;
		}

		canEnsureHomePageRef.current = false;

		ensureHomepage({ membershipId: membership._id })
			.then((result) => {
				if (result._nay) {
					console.error("[TenantWorkspaceProjectLayout.ensure_home_page] Failed to ensure home page", {
						result,
					});
					return;
				}
				useAppGlobalStore.actions.setPagesHomeIdForMembershipId(membership._id, result._yay.pageId);
			})
			.catch((error: unknown) => {
				should_never_happen("Error while initializing the home page", { error });
			});
	}, [ensureHomepage, membership, pagesHomeIdForMembership]);

	if (membership === undefined) {
		return <div>Loading workspace…</div>;
	}

	if (membership === null) {
		return <div>You do not have access to this workspace/project.</div>;
	}

	if (!pagesHomeIdForMembership) {
		return <div>Preparing workspace…</div>;
	}

	const workspaceId = membership.workspaceId;
	const projectId = membership.projectId;

	return (
		<AppTenantProvider
			membershipId={membership._id}
			workspaceId={workspaceId}
			workspaceName={workspaceName}
			projectId={projectId}
			projectName={projectName}
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
});

const Route = createFileRoute({
	component: TenantWorkspaceProjectLayout,
});

export { Route };
