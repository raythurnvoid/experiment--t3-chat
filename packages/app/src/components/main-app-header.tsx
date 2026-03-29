import "./main-app-header.css";

import { memo, useEffect, useState, type ComponentPropsWithRef } from "react";
import { useQuery } from "convex/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";

import {
	AppAuthProvider,
} from "@/components/app-auth.tsx";
import {
	MainAppHeaderWorkspaceSwitcherModal,
	type MainAppHeaderWorkspaceSwitcherModal_AfterCreateSelection,
	type MainAppHeaderWorkspaceSwitcherModal_AfterRename,
	type MainAppHeaderWorkspaceSwitcherModal_ListItem,
	type MainAppHeaderWorkspaceSwitcherModal_RenameTarget,
} from "@/components/main-app-header-workspace-controls-modal.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyModal, MyModalTrigger } from "@/components/my-modal.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_tenant_default_project_for_workspace, app_tenant_primary_project_for_workspace } from "@/lib/urls.ts";
import { workspaces_switcher_list_secondary_line } from "@/lib/workspaces.ts";
import { cn } from "@/lib/utils.ts";

// #region workspace controls
type MainAppHeaderWorkspaceControls_ClassNames =
	| "MainAppHeaderWorkspaceControls"
	| "MainAppHeaderWorkspaceControls-button"
	| "MainAppHeaderWorkspaceControls-text"
	| "MainAppHeaderWorkspaceControls-primary-text"
	| "MainAppHeaderWorkspaceControls-secondary-text"
	| "MainAppHeaderWorkspaceControls-icon";

type MainAppHeaderWorkspaceControls_LocalDraft = {
	workspaceId: app_convex_Id<"workspaces">;
	projectId: app_convex_Id<"workspaces_projects">;
};

function main_app_header_workspace_controls_move_list_item_to_front_by_id<T extends { id: string }>(
	items: T[],
	id: string | undefined,
): T[] {
	if (!id) {
		return items;
	}

	const index = items.findIndex((item) => item.id === id);
	if (index <= 0) {
		return items;
	}

	const next = items.slice();
	const picked = next.splice(index, 1)[0];
	return picked ? [picked, ...next] : items;
}

const MainAppHeaderWorkspaceControls = memo(function MainAppHeaderWorkspaceControls() {
	const navigate = useNavigate();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const auth = AppAuthProvider.useAuth();

	const { workspaceId, workspaceName, projectId, projectName } = AppTenantProvider.useContext();

	const workspaceList = useQuery(app_convex_api.workspaces.list);

	const [isOpen, setIsOpen] = useState(false);
	const [localDraft, setLocalDraft] = useState<MainAppHeaderWorkspaceControls_LocalDraft | null>(null);
	const [renameTarget, setRenameTarget] = useState<MainAppHeaderWorkspaceSwitcherModal_RenameTarget | null>(null);

	const workspaces = workspaceList?.workspaces;
	const projects = workspaceId ? workspaceList?.workspaceIdsProjectsDict[workspaceId] : undefined;

	const draftWorkspaceId = localDraft?.workspaceId ?? workspaceId;
	const draftProjectId = localDraft?.projectId ?? projectId;
	const createWorkspaceCapability = useQuery(
		app_convex_api.limits.get_user_limit,
		auth.userId
			? {
					userId: auth.userId as app_convex_Id<"users">,
					limitName: "extra_workspaces",
				}
			: "skip",
	);
	const draftProjectCreateCapability = useQuery(
		app_convex_api.limits.get_workspace_limit,
		draftWorkspaceId
			? {
					workspaceId: draftWorkspaceId,
					limitName: "extra_projects",
				}
			: "skip",
	);

	const draftProjects =
		draftWorkspaceId && workspaceList ? workspaceList.workspaceIdsProjectsDict[draftWorkspaceId] : undefined;

	const lastPathSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
	const tenantRouteSuffix = lastPathSegment === "chat" ? "chat" : "pages";

	const currentWorkspaceName = workspaces?.find((w) => w._id === workspaceId)?.name ?? workspaceName ?? "…";
	const currentProjectName = projects?.find((p) => p._id === projectId)?.name ?? projectName ?? "…";

	const draftWorkspaceRecord = workspaces?.find((w) => w._id === draftWorkspaceId);
	const draftWorkspaceName = draftWorkspaceRecord?.name ?? workspaceName ?? "…";

	const listLoaded = workspaces !== undefined;
	const createWorkspaceDisabled = !listLoaded || !createWorkspaceCapability?.allowed;
	const createWorkspaceDisabledReason =
		listLoaded && createWorkspaceCapability?.disabledReason ? createWorkspaceCapability.disabledReason : undefined;
	const createProjectDisabled = !listLoaded || !draftProjectCreateCapability?.allowed;
	const createProjectDisabledReason =
		listLoaded && draftProjectCreateCapability?.disabledReason ? draftProjectCreateCapability.disabledReason : undefined;

	const switchDisabled = !listLoaded || (draftWorkspaceId === workspaceId && draftProjectId === projectId);

	const navigateToWorkspaceProject = useFn((nextWorkspaceName: string, nextProjectName: string) => {
		const to =
			tenantRouteSuffix === "chat"
				? ("/w/$workspaceName/$projectName/chat" as const)
				: ("/w/$workspaceName/$projectName/pages" as const);

		navigate({
			to,
			params: { workspaceName: nextWorkspaceName, projectName: nextProjectName },
		});
		setIsOpen(false);
	});

	const workspaceItems: MainAppHeaderWorkspaceSwitcherModal_ListItem[] =
		main_app_header_workspace_controls_move_list_item_to_front_by_id(
			(workspaces ?? []).map((w) => {
				const renamePrimaryProject = workspaceList
					? app_tenant_primary_project_for_workspace({
							workspace: w,
							projects: workspaceList.workspaceIdsProjectsDict[w._id] ?? [],
						})
					: null;

				return {
					id: w._id,
					label: w.name,
					description: workspaces_switcher_list_secondary_line({
						storedDescription: w.description ?? "",
						isDefaultWorkspace: w.default,
						isPrimaryProject: false,
					}),
					isDefault: w.default,
					onEdit:
						w.default || !renamePrimaryProject
							? undefined
							: () => {
									setRenameTarget({
										kind: "workspace",
										id: w._id,
										initialName: w.name,
										defaultProjectId: renamePrimaryProject._id as app_convex_Id<"workspaces_projects">,
									});
								},
					onDelete: w.default
						? undefined
						: () => {
								void (async (/* iife */) => {
									const result = await app_convex.mutation(app_convex_api.workspaces.delete_workspace, {
										workspaceId: w._id,
									});

									if (result == null) {
										return;
									}

									if (result._nay) {
										console.error("[MainAppHeaderWorkspaceControls] Failed to delete workspace", {
											result,
											workspaceId: w._id,
										});
										return;
									}

									await app_convex.query(app_convex_api.workspaces.list, {});

									if (w._id === workspaceId && workspaces && workspaceList) {
										const remaining = workspaces.filter((row) => row._id !== w._id);
										const fallback = remaining[0];
										if (!fallback) {
											return;
										}

										const defaultProject = app_tenant_default_project_for_workspace({
											workspace: fallback,
											projects: workspaceList.workspaceIdsProjectsDict[fallback._id] ?? [],
										});

										if (!defaultProject) {
											console.error(
												"[MainAppHeaderWorkspaceControls] Failed to resolve default project after workspace delete",
												{ workspaceId: fallback._id },
											);
											return;
										}

										navigateToWorkspaceProject(fallback.name, defaultProject.name);
										return;
									}

									if (w._id === draftWorkspaceId && w._id !== workspaceId && workspaceId && projectId) {
										setLocalDraft({ workspaceId, projectId });
									}
								})().catch((error) => {
									console.error("[MainAppHeaderWorkspaceControls] Unexpected delete workspace error", {
										error,
										workspaceId: w._id,
									});
								});
							},
					onSelect: () => {
						if (w._id === draftWorkspaceId) {
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

						setLocalDraft({
							workspaceId: w._id,
							projectId: defaultProject._id as app_convex_Id<"workspaces_projects">,
						});
					},
				};
			}),
			workspaceId,
		);

	const projectItemsRaw: MainAppHeaderWorkspaceSwitcherModal_ListItem[] = (draftProjects ?? []).map((p) => {
		const renamePrimaryProject =
			draftWorkspaceRecord && workspaceList
				? app_tenant_primary_project_for_workspace({
						workspace: draftWorkspaceRecord,
						projects: workspaceList.workspaceIdsProjectsDict[draftWorkspaceRecord._id] ?? [],
					})
				: null;
		const projectIsPrimary = renamePrimaryProject?._id === p._id;

		return {
			id: p._id,
			label: p.name,
			description: workspaces_switcher_list_secondary_line({
				storedDescription: p.description ?? "",
				isDefaultWorkspace: false,
				isPrimaryProject: projectIsPrimary,
			}),
			isDefault: p.default,
			onEdit:
				projectIsPrimary || !renamePrimaryProject
					? undefined
					: () => {
							if (!draftWorkspaceRecord) {
								console.error("[MainAppHeaderWorkspaceControls] Missing draft workspace for project rename");
								return;
							}

							setRenameTarget({
								kind: "project",
								id: p._id,
								initialName: p.name,
								workspaceId: draftWorkspaceRecord._id,
								defaultProjectId: renamePrimaryProject._id as app_convex_Id<"workspaces_projects">,
							});
						},
			onDelete: p.default
				? undefined
				: () => {
						void (async (/* iife */) => {
							const result = await app_convex.mutation(app_convex_api.workspaces.delete_project, {
								projectId: p._id,
							});

							if (result == null) {
								return;
							}

							if (result._nay) {
								console.error("[MainAppHeaderWorkspaceControls] Failed to delete project", {
									result,
									projectId: p._id,
								});
								return;
							}

							await app_convex.query(app_convex_api.workspaces.list, {});

							if (p._id === projectId && workspaceId && projects && workspaces) {
								const ws = workspaces.find((row) => row._id === workspaceId);
								if (!ws) {
									return;
								}

								const remaining = projects.filter((row) => row._id !== p._id);
								const fallback = remaining.find((row) => row.default) ?? remaining[0];
								if (!fallback) {
									return;
								}

								navigateToWorkspaceProject(ws.name, fallback.name);
								return;
							}

							if (p._id === draftProjectId && draftWorkspaceId && workspaceList) {
								const projs = workspaceList.workspaceIdsProjectsDict[draftWorkspaceId] ?? [];
								const fallback =
									projs.find((row) => row._id !== p._id && row.default) ?? projs.find((row) => row._id !== p._id);
								if (!fallback) {
									if (workspaceId && projectId) {
										setLocalDraft({ workspaceId, projectId });
									}
									return;
								}

								setLocalDraft({
									workspaceId: draftWorkspaceId,
									projectId: fallback._id as app_convex_Id<"workspaces_projects">,
								});
							}
						})().catch((error) => {
							console.error("[MainAppHeaderWorkspaceControls] Unexpected delete project error", {
								error,
								projectId: p._id,
							});
						});
					},
			onSelect: () => {
				if (p._id === draftProjectId) {
					return;
				}

				setLocalDraft({
					workspaceId: draftWorkspaceId,
					projectId: p._id,
				});
			},
		};
	});

	const projectItems =
		draftWorkspaceId === workspaceId
			? main_app_header_workspace_controls_move_list_item_to_front_by_id(projectItemsRaw, projectId)
			: projectItemsRaw;

	const handleWorkspaceSwitcherSwitch = useFn(() => {
		if (!workspaceList || !workspaces) {
			console.error("[MainAppHeaderWorkspaceControls] Workspace list not loaded");
			return;
		}

		const nextWorkspace = workspaces.find((w) => w._id === draftWorkspaceId);
		const nextProjects = workspaceList.workspaceIdsProjectsDict[draftWorkspaceId] ?? [];
		const nextProject = nextProjects.find((p) => p._id === draftProjectId);

		if (!nextWorkspace || !nextProject) {
			console.error("[MainAppHeaderWorkspaceControls] Failed to resolve draft workspace/project", {
				draftWorkspaceId,
				draftProjectId,
			});
			return;
		}

		navigateToWorkspaceProject(nextWorkspace.name, nextProject.name);
	});

	const handleWorkspaceSwitcherAfterCreate = useFn(
		(selection: MainAppHeaderWorkspaceSwitcherModal_AfterCreateSelection) => {
			setLocalDraft({
				workspaceId: selection.workspaceId,
				projectId: selection.projectId,
			});
		},
	);

	const handleWorkspaceSwitcherAfterRename = useFn((args: MainAppHeaderWorkspaceSwitcherModal_AfterRename) => {
		if (args.kind === "workspace") {
			if (workspaceId === args.workspaceId && currentWorkspaceName === args.oldName) {
				navigateToWorkspaceProject(args.newName, currentProjectName);
			}
			return;
		}

		if (args.projectId && projectId === args.projectId && currentProjectName === args.oldName) {
			navigateToWorkspaceProject(currentWorkspaceName, args.newName);
		}
	});

	const handleWorkspaceSwitcherCancel = useFn(() => {
		setIsOpen(false);
	});

	useEffect(() => {
		if (!isOpen) {
			setRenameTarget(null);
			return;
		}

		if (!workspaceId || !projectId) {
			return;
		}

		setLocalDraft({ workspaceId, projectId });
	}, [isOpen, workspaceId, projectId]);

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
				dialogOpen={isOpen}
				createProject={(args) => app_convex.mutation(app_convex_api.workspaces.create_project, args)}
				createWorkspace={(args) => app_convex.mutation(app_convex_api.workspaces.create_workspace, args)}
				createProjectDisabled={createProjectDisabled}
				createProjectDisabledReason={createProjectDisabledReason}
				createWorkspaceDisabled={createWorkspaceDisabled}
				createWorkspaceDisabledReason={createWorkspaceDisabledReason}
				listLoaded={listLoaded}
				draftProjectId={draftProjectId}
				draftWorkspaceId={draftWorkspaceId}
				projectItems={projectItems}
				renameProject={(args) => app_convex.mutation(app_convex_api.workspaces.rename_project, args)}
				renameTarget={renameTarget}
				renameWorkspace={(args) => app_convex.mutation(app_convex_api.workspaces.rename_workspace, args)}
				setRenameTarget={setRenameTarget}
				switchDisabled={switchDisabled}
				summaryProjectName={currentProjectName}
				summaryWorkspaceName={currentWorkspaceName}
				workspaceItems={workspaceItems}
				workspaceName={draftWorkspaceName}
				onAfterCreateProject={handleWorkspaceSwitcherAfterCreate}
				onAfterCreateWorkspace={handleWorkspaceSwitcherAfterCreate}
				onAfterRename={handleWorkspaceSwitcherAfterRename}
				onCancel={handleWorkspaceSwitcherCancel}
				onSwitch={handleWorkspaceSwitcherSwitch}
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
