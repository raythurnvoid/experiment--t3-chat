import "./main-app-header.css";

import type { FunctionArgs } from "convex/server";
import { memo, useState, type ComponentPropsWithRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";

import {
	MainAppHeaderWorkspaceSwitcherModal,
	type MainAppHeaderWorkspaceSwitcherModal_ListItem,
} from "@/components/main-app-header-workspace-controls-modal.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyModal, MyModalTrigger } from "@/components/my-modal.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { app_tenant_default_project_for_workspace } from "@/lib/urls.ts";
import { cn } from "@/lib/utils.ts";

// #region workspace controls
type MainAppHeaderWorkspaceControls_ClassNames =
	| "MainAppHeaderWorkspaceControls"
	| "MainAppHeaderWorkspaceControls-button"
	| "MainAppHeaderWorkspaceControls-text"
	| "MainAppHeaderWorkspaceControls-primary-text"
	| "MainAppHeaderWorkspaceControls-secondary-text"
	| "MainAppHeaderWorkspaceControls-icon";

const MainAppHeaderWorkspaceControls = memo(function MainAppHeaderWorkspaceControls() {
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (s) => s.location.pathname });

	const { workspaceId, workspaceName, projectId, projectName } = AppTenantProvider.useContext();

	const workspaceList = useQuery(app_convex_api.workspaces.list);
	const createWorkspace = useMutation(app_convex_api.workspaces.create_workspace);
	const createProject = useMutation(app_convex_api.workspaces.create_project);

	const [isOpen, setIsOpen] = useState(false);

	const workspaces = workspaceList?.workspaces;
	const projects = workspaceId ? workspaceList?.workspaceIdsProjectsDict[workspaceId] : undefined;

	const lastPathSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
	const tenantRouteSuffix = lastPathSegment === "chat" ? "chat" : "pages";

	const currentWorkspaceName = workspaces?.find((w) => w._id === workspaceId)?.name ?? workspaceName ?? "…";
	const currentProjectName = projects?.find((p) => p._id === projectId)?.name ?? projectName ?? "…";

	const listLoaded = workspaces !== undefined;

	const navigateToWorkspaceProject = (nextWorkspaceName: string, nextProjectName: string) => {
		const to =
			tenantRouteSuffix === "chat"
				? ("/w/$workspaceName/$projectName/chat" as const)
				: ("/w/$workspaceName/$projectName/pages" as const);

		navigate({
			to,
			params: { workspaceName: nextWorkspaceName, projectName: nextProjectName },
		});
		setIsOpen(false);
	};

	const workspaceItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[] =
		workspaces?.map((w) => ({
			id: w._id,
			label: w.name,
			description: w.default ? "Default workspace" : "",
			isCurrent: w._id === workspaceId,
			onSelect: () => {
				if (w._id === workspaceId) {
					setIsOpen(false);
					return;
				}

				if (!workspaceList) {
					console.error("[MainAppHeaderWorkspaceControls] Workspace list not loaded");
					return;
				}

				const defaultProject = app_tenant_default_project_for_workspace({
					workspace: w,
					projects: workspaceList.workspaceIdsProjectsDict[w._id] ?? [],
				});

				if (!defaultProject) {
					console.error("[MainAppHeaderWorkspaceControls] Failed to resolve default project for workspace", {
						workspaceId: w._id,
					});
					return;
				}

				navigateToWorkspaceProject(w.name, defaultProject.name);
			},
		})) ?? [];

	const projectItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[] =
		projects?.map((p) => ({
			id: p._id,
			label: p.name,
			description: p.default ? "Default project" : "",
			isCurrent: p._id === projectId,
			onSelect: () => {
				if (p._id === projectId) {
					setIsOpen(false);
					return;
				}

				navigateToWorkspaceProject(currentWorkspaceName, p.name);
			},
		})) ?? [];

	return (
		<MyModal open={isOpen} setOpen={setIsOpen}>
			<MyModalTrigger>
				<MyButton
					className={"MainAppHeaderWorkspaceControls" satisfies MainAppHeaderWorkspaceControls_ClassNames}
					variant="default"
				>
					<span
						className={cn(
							"MainAppHeaderWorkspaceControls-primary-text" satisfies MainAppHeaderWorkspaceControls_ClassNames,
						)}
					>
						{workspaces === undefined ? "Loading…" : currentWorkspaceName}
					</span>

					<span
						className={cn(
							"MainAppHeaderWorkspaceControls-secondary-text" satisfies MainAppHeaderWorkspaceControls_ClassNames,
						)}
					>
						{projects === undefined ? "…" : currentProjectName}
					</span>

					<ChevronsUpDown
						className={cn("MainAppHeaderWorkspaceControls-icon" satisfies MainAppHeaderWorkspaceControls_ClassNames)}
					/>
				</MyButton>
			</MyModalTrigger>

			<MainAppHeaderWorkspaceSwitcherModal
				createProject={createProject}
				createWorkspace={createWorkspace}
				listLoaded={listLoaded}
				projectItems={projectItems}
				projectName={currentProjectName}
				workspaceId={
					workspaceId as FunctionArgs<typeof app_convex_api.workspaces.create_project>["workspaceId"]
				}
				workspaceItems={workspaceItems}
				workspaceName={currentWorkspaceName}
				onAfterCreateProject={({ projectName: nextProjectName, workspaceName: nextWorkspaceName }) =>
					navigateToWorkspaceProject(nextWorkspaceName, nextProjectName)
				}
				onAfterCreateWorkspace={({ projectName: nextProjectName, workspaceName: nextWorkspaceName }) =>
					navigateToWorkspaceProject(nextWorkspaceName, nextProjectName)
				}
			/>
		</MyModal>
	);
});
// #endregion workspace controls

// #region root
type MainAppHeader_ClassNames = "MainAppHeader" | "MainAppHeader-content";

export type MainAppHeader_Props = ComponentPropsWithRef<"header">;

export const MainAppHeader = memo(function MainAppHeader(props: MainAppHeader_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<header ref={ref} id={id} className={cn("MainAppHeader" satisfies MainAppHeader_ClassNames, className)} {...rest}>
			<MainAppHeaderWorkspaceControls />
			<div
				id={"app_main_header_content" satisfies AppElementId}
				className={cn("MainAppHeader-content" satisfies MainAppHeader_ClassNames)}
			>
				{/* The pages inject content here */}
			</div>
		</header>
	);
});
// #endregion root
