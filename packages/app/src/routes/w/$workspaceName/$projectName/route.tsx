import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useConvex, useQuery } from "convex/react";
import { useEffect, useRef } from "react";

import { MainAppHeader } from "@/components/main-app-header.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { cn, should_never_happen } from "@/lib/utils.ts";

import type { RootLayout_ClassNames } from "@/routes/__root.tsx";

function RouteTenantWorkspaceProjectLayout() {
	const params = Route.useParams();
	const { workspaceName, projectName } = params;

	const membership = useQuery(app_convex_api.workspaces.get_membership_by_workspace_project_name, {
		workspaceName,
		projectName,
	});
	const membershipId = membership?._id ?? "";
	const convex = useConvex();

	const homeFile = useQuery(
		app_convex_api.files_nodes.get_home_file,
		membership ? { membershipId: membership._id } : "skip",
	);
	const canCreateHomeFileRef = useRef(true);

	const homeFileIdForMembership = useAppGlobalStore((s) => s.files_home_id_by_membership_id[membershipId] ?? "");

	useEffect(() => {
		canCreateHomeFileRef.current = true;
	}, [membershipId]);

	useEffect(() => {
		if (membership == null || homeFile === undefined) {
			return;
		}

		if (homeFile) {
			useAppGlobalStore.actions.setDrivesHomeIdForMembershipId(membership._id, homeFile.file._id);
			return;
		}

		if (!canCreateHomeFileRef.current) {
			return;
		}

		canCreateHomeFileRef.current = false;

		convex
			.action(app_convex_api.files_nodes.create_home_file, { membershipId: membership._id })
			.then((result) => {
				if (result._nay) {
					console.error("[TenantWorkspaceProjectLayout.create_home_file] Failed to create home file", {
						result,
					});
					return;
				}
				useAppGlobalStore.actions.setDrivesHomeIdForMembershipId(membership._id, result._yay.nodeId);
			})
			.catch((error: unknown) => {
				should_never_happen("Error while initializing the home file", { error });
			});
	}, [convex, homeFile, membership]);

	if (membership === undefined) {
		return (
			<main role="status" aria-live="polite" aria-label="Workspace loading">
				Loading workspace
			</main>
		);
	}

	if (membership === null) {
		return (
			<main role="alert" aria-label="Workspace access denied">
				You do not have access to this workspace/project.
			</main>
		);
	}

	if (!homeFileIdForMembership) {
		return (
			<main role="status" aria-live="polite" aria-label="Workspace preparing">
				Preparing workspace
			</main>
		);
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
}

const Route = createFileRoute("/w/$workspaceName/$projectName")({
	component: RouteTenantWorkspaceProjectLayout,
});

export { Route };
