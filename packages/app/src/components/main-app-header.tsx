import "./main-app-header.css";

import { memo, useState, type ComponentPropsWithRef } from "react";
import { useQuery } from "convex/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";

import { MyButton } from "@/components/my-button.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
	MyModalTrigger,
} from "@/components/my-modal.tsx";
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

type MainAppHeaderWorkspaceControls_ListItem = {
	description: string;
	id: string;
	isCurrent?: boolean;
	label: string;
	onSelect: () => void;
};

const MainAppHeaderWorkspaceControls = memo(function MainAppHeaderWorkspaceControls() {
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (s) => s.location.pathname });

	const { workspaceId, workspaceName, projectId, projectName } = AppTenantProvider.useContext();

	const workspaceList = useQuery(app_convex_api.workspaces.list);

	const [isOpen, setIsOpen] = useState(false);

	const workspaces = workspaceList?.workspaces;
	const projects = workspaceId ? workspaceList?.workspaceIdsProjectsDict[workspaceId] : undefined;

	const lastPathSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
	const tenantRouteSuffix = lastPathSegment === "chat" ? "chat" : "pages";

	const currentWorkspaceName = workspaces?.find((w) => w._id === workspaceId)?.name ?? workspaceName ?? "…";
	const currentProjectName = projects?.find((p) => p._id === projectId)?.name ?? projectName ?? "…";

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

	const workspaceItems: MainAppHeaderWorkspaceControls_ListItem[] =
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

	const projectItems: MainAppHeaderWorkspaceControls_ListItem[] =
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

			<MainAppHeaderWorkspaceControlsModal
				projectItems={projectItems}
				projectName={currentProjectName}
				workspaceItems={workspaceItems}
				workspaceName={currentWorkspaceName}
			/>
		</MyModal>
	);
});
// #endregion workspace controls

// #region workspace controls modal
type MainAppHeaderWorkspaceControlsModal_ClassNames =
	| "MainAppHeaderWorkspaceControlsModal"
	| "MainAppHeaderWorkspaceControlsModal-header-copy"
	| "MainAppHeaderWorkspaceControlsModal-body"
	| "MainAppHeaderWorkspaceControlsModal-section"
	| "MainAppHeaderWorkspaceControlsModal-section-title"
	| "MainAppHeaderWorkspaceControlsModal-current-selection"
	| "MainAppHeaderWorkspaceControlsModal-current-selection-label"
	| "MainAppHeaderWorkspaceControlsModal-current-selection-workspace"
	| "MainAppHeaderWorkspaceControlsModal-current-selection-project"
	| "MainAppHeaderWorkspaceControlsModal-list"
	| "MainAppHeaderWorkspaceControlsModal-list-item"
	| "MainAppHeaderWorkspaceControlsModal-list-item-current"
	| "MainAppHeaderWorkspaceControlsModal-list-item-label"
	| "MainAppHeaderWorkspaceControlsModal-list-item-description";

type MainAppHeaderWorkspaceControlsModal_Props = {
	projectItems: MainAppHeaderWorkspaceControls_ListItem[];
	projectName: string;
	workspaceItems: MainAppHeaderWorkspaceControls_ListItem[];
	workspaceName: string;
};

const MainAppHeaderWorkspaceControlsModal = memo(function MainAppHeaderWorkspaceControlsModal(
	props: MainAppHeaderWorkspaceControlsModal_Props,
) {
	const { projectItems, projectName, workspaceItems, workspaceName } = props;

	return (
		<MyModalPopover
			className={cn("MainAppHeaderWorkspaceControlsModal" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames)}
		>
			<MyModalHeader>
				<div
					className={cn(
						"MainAppHeaderWorkspaceControlsModal-header-copy" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
					)}
				>
					<MyModalHeading>Workspace and project</MyModalHeading>
					<MyModalDescription>
						Switch workspace or project. Changing workspace opens that workspace’s default project.
					</MyModalDescription>
				</div>
			</MyModalHeader>

			<MyModalScrollableArea
				className={cn(
					"MainAppHeaderWorkspaceControlsModal-body" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
				)}
			>
				<section
					className={cn(
						"MainAppHeaderWorkspaceControlsModal-section" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-section-title" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						Current selection
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-current-selection" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							Workspace
						</div>

						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-workspace" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							{workspaceName}
						</div>

						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							Project
						</div>

						<div
							className={cn(
								"MainAppHeaderWorkspaceControlsModal-current-selection-project" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
							)}
						>
							{projectName}
						</div>
					</div>
				</section>

				<section
					className={cn(
						"MainAppHeaderWorkspaceControlsModal-section" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-section-title" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						Workspaces
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-list" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						{workspaceItems.map((item) => (
							<button
								key={item.id}
								type="button"
								className={cn(
									"MainAppHeaderWorkspaceControlsModal-list-item" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									item.isCurrent &&
										("MainAppHeaderWorkspaceControlsModal-list-item-current" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames),
								)}
								onClick={item.onSelect}
							>
								<div
									className={cn(
										"MainAppHeaderWorkspaceControlsModal-list-item-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									)}
								>
									{item.label}
								</div>

								{item.description ? (
									<div
										className={cn(
											"MainAppHeaderWorkspaceControlsModal-list-item-description" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
										)}
									>
										{item.description}
									</div>
								) : null}
							</button>
						))}
					</div>
				</section>

				<section
					className={cn(
						"MainAppHeaderWorkspaceControlsModal-section" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
					)}
				>
					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-section-title" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						Projects
					</div>

					<div
						className={cn(
							"MainAppHeaderWorkspaceControlsModal-list" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
						)}
					>
						{projectItems.map((item) => (
							<button
								key={item.id}
								type="button"
								className={cn(
									"MainAppHeaderWorkspaceControlsModal-list-item" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									item.isCurrent &&
										("MainAppHeaderWorkspaceControlsModal-list-item-current" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames),
								)}
								onClick={item.onSelect}
							>
								<div
									className={cn(
										"MainAppHeaderWorkspaceControlsModal-list-item-label" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
									)}
								>
									{item.label}
								</div>

								{item.description ? (
									<div
										className={cn(
											"MainAppHeaderWorkspaceControlsModal-list-item-description" satisfies MainAppHeaderWorkspaceControlsModal_ClassNames,
										)}
									>
										{item.description}
									</div>
								) : null}
							</button>
						))}
					</div>
				</section>
			</MyModalScrollableArea>

			<MyModalCloseTrigger />
		</MyModalPopover>
	);
});
// #endregion workspace controls modal

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
