import { Outlet } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { memo, useEffect, useRef } from "react";

import { MainAppHeader } from "@/components/main-app-header.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { app_tenantPaths_scopeKey } from "@/lib/app-tenant-paths.ts";
import { cn, should_never_happen } from "@/lib/utils.ts";

import type { RootLayout_ClassNames } from "@/routes/__root.tsx";

const TenantWorkspaceProjectLayout = memo(function TenantWorkspaceProjectLayout() {
	const params = Route.useParams();
	const { workspaceId, projectId } = params;

	const membership = useQuery(app_convex_api.workspaces.get_membership_for_scope, {
		workspaceId,
		projectId,
	});

	const ensureHomepage = useMutation(app_convex_api.ai_docs_temp.ensure_home_page);
	const canEnsureHomePageRef = useRef(true);
	const scopeKey = app_tenantPaths_scopeKey({ workspaceId, projectId });

	const pagesHomeIdForScope = useAppGlobalStore((s) => s.pages_home_id_by_scope[scopeKey] ?? "");

	useEffect(() => {
		canEnsureHomePageRef.current = true;
	}, [scopeKey]);

	useEffect(() => {
		if (membership == null || pagesHomeIdForScope || !canEnsureHomePageRef.current) {
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
				useAppGlobalStore.actions.setPagesHomeIdForScope(scopeKey, result._yay.pageId);
			})
			.catch((error: unknown) => {
				should_never_happen("Error while initializing the home page", { error });
			});
	}, [ensureHomepage, pagesHomeIdForScope, scopeKey, membership]);

	if (membership === undefined) {
		return <div>Loading workspace…</div>;
	}

	if (membership === null) {
		return <div>You do not have access to this workspace/project.</div>;
	}

	const membershipId = membership._id;

	if (!pagesHomeIdForScope) {
		return <div>Preparing workspace…</div>;
	}

	return (
		<AppTenantProvider membershipId={membershipId} workspaceId={workspaceId} projectId={projectId}>
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
