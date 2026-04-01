import "./main-app-header.css";

import { memo, useEffect, useState, type ComponentPropsWithRef } from "react";
import { useQuery } from "convex/react";
import { useNavigate, useRouterState, type RegisteredRouter } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import {
	MainAppHeaderWorkspaceSwitcherModal,
	type MainAppHeaderWorkspaceSwitcherModal_ListItem,
	type MainAppHeaderWorkspaceSwitcherModal_Props,
	type MainAppHeaderWorkspaceSwitcherModal_EditTarget,
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

function main_app_header_workspace_controls_limit_tooltip(args: {
	kind: "project" | "workspace";
	currentCount: number | undefined;
	maxCount: number | undefined;
}) {
	const { kind, currentCount, maxCount } = args;

	if (currentCount === undefined || maxCount === undefined) {
		return kind === "workspace" ? "Loading workspace limit." : "Loading project limit.";
	}

	const maxTotal = 1 + maxCount;
	const remaining = Math.max(0, maxTotal - currentCount);

	return kind === "workspace"
		? `Using ${currentCount} of ${maxTotal} total workspaces. ${remaining} remaining available.`
		: `Using ${currentCount} of ${maxTotal} total projects in this workspace. ${remaining} remaining available.`;
}

function main_app_header_workspace_controls_create_disabled_tooltip(args: {
	kind: "project" | "workspace";
	createDisabled: boolean;
	createDisabledReason: string | undefined;
	maxCount: number | undefined;
}) {
	const { kind, createDisabled, createDisabledReason, maxCount } = args;

	if (!createDisabled) {
		return undefined;
	}

	if (createDisabledReason) {
		return createDisabledReason;
	}

	if (maxCount === undefined) {
		return kind === "workspace" ? "Loading workspace limit." : "Loading project limit.";
	}

	const maxTotal = 1 + maxCount;

	return kind === "workspace"
		? `All ${maxTotal} available workspace slots are already in use.`
		: `All ${maxTotal} available project slots in this workspace are already in use.`;
}

const MainAppHeaderWorkspaceControls = memo(function MainAppHeaderWorkspaceControls() {
	const navigate = useNavigate();
	const auth = AppAuthProvider.useAuth();

	const { workspaceId, workspaceName, projectId, projectName } = AppTenantProvider.useContext();

	const pathname = useRouterState<RegisteredRouter, string>({
		select: (state) => state.location.pathname,
	});

	const workspaceList = useQuery(app_convex_api.workspaces.list);

	const [isOpen, setIsOpen] = useState(false);
	const [localDraft, setLocalDraft] = useState<MainAppHeaderWorkspaceControls_LocalDraft | null>(null);
	const [editTarget, setEditTarget] = useState<MainAppHeaderWorkspaceSwitcherModal_EditTarget | null>(null);

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
	const createProjectDisabled = !listLoaded || !draftProjectCreateCapability?.allowed;
	const createWorkspaceDisabledReason = main_app_header_workspace_controls_create_disabled_tooltip({
		kind: "workspace",
		createDisabled: createWorkspaceDisabled,
		createDisabledReason: createWorkspaceCapability?.disabledReason ?? undefined,
		maxCount: createWorkspaceCapability?.maxCount,
	});
	const createProjectDisabledReason = main_app_header_workspace_controls_create_disabled_tooltip({
		kind: "project",
		createDisabled: createProjectDisabled,
		createDisabledReason: draftProjectCreateCapability?.disabledReason ?? undefined,
		maxCount: draftProjectCreateCapability?.maxCount,
	});
	const workspaceLimitFraction = auth.userId
		? workspaces && createWorkspaceCapability
			? `${workspaces.length}/${1 + createWorkspaceCapability.maxCount}`
			: "…/…"
		: undefined;
	const projectLimitFraction = auth.userId
		? draftProjects && draftProjectCreateCapability
			? `${draftProjects.length}/${1 + draftProjectCreateCapability.maxCount}`
			: "…/…"
		: undefined;
	const workspaceLimitTooltip = auth.userId
		? main_app_header_workspace_controls_limit_tooltip({
				kind: "workspace",
				currentCount: workspaces?.length,
				maxCount: createWorkspaceCapability?.maxCount,
			})
		: undefined;
	const projectLimitTooltip = auth.userId
		? main_app_header_workspace_controls_limit_tooltip({
				kind: "project",
				currentCount: draftProjects?.length,
				maxCount: draftProjectCreateCapability?.maxCount,
			})
		: undefined;

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
				const primaryProject = workspaceList
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
						w.default || !primaryProject
							? undefined
							: () => {
									setEditTarget({
										kind: "workspace",
										id: w._id,
										initialName: w.name,
										initialDescription: w.description ?? "",
										defaultProjectId: primaryProject._id as app_convex_Id<"workspaces_projects">,
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
		const primaryProject =
			draftWorkspaceRecord && workspaceList
				? app_tenant_primary_project_for_workspace({
						workspace: draftWorkspaceRecord,
						projects: workspaceList.workspaceIdsProjectsDict[draftWorkspaceRecord._id] ?? [],
					})
				: null;
		const projectIsPrimary = primaryProject?._id === p._id;

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
				projectIsPrimary || !primaryProject
					? undefined
					: () => {
							if (!draftWorkspaceRecord) {
								console.error("[MainAppHeaderWorkspaceControls] Missing draft workspace for project edit");
								return;
							}

							setEditTarget({
								kind: "project",
								id: p._id,
								initialName: p.name,
								initialDescription: p.description ?? "",
								workspaceId: draftWorkspaceRecord._id,
								defaultProjectId: primaryProject._id as app_convex_Id<"workspaces_projects">,
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

	const handleWorkspaceSwitcherSwitch = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["onSwitch"]>(() => {
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

	const handleWorkspaceSwitcherAfterCreate = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["onAfterCreateWorkspace"]>(
		(selection) => {
			setLocalDraft({
				workspaceId: selection.workspaceId,
				projectId: selection.projectId,
			});
		},
	);

	const handleWorkspaceSwitcherAfterEdit = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["onAfterEdit"]>((args) => {
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

	const handleWorkspaceSwitcherCancel = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["onCancel"]>(() => {
		setIsOpen(false);
	});

	const handleWorkspaceSwitcherCreateWorkspace = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["createWorkspace"]>(
		(args) => {
			return app_convex.mutation(app_convex_api.workspaces.create_workspace, args);
		},
	);

	const handleWorkspaceSwitcherCreateProject = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["createProject"]>(
		(args) => {
			return app_convex.mutation(app_convex_api.workspaces.create_project, args);
		},
	);

	const handleWorkspaceSwitcherEditWorkspace = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["editWorkspace"]>(
		(args) => {
			return app_convex.mutation(app_convex_api.workspaces.edit_workspace, args);
		},
	);

	const handleWorkspaceSwitcherEditProject = useFn<MainAppHeaderWorkspaceSwitcherModal_Props["editProject"]>((args) => {
		return app_convex.mutation(app_convex_api.workspaces.edit_project, args);
	});

	useEffect(() => {
		if (!isOpen) {
			setEditTarget(null);
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
				listLoaded={listLoaded}
				draftProjectId={draftProjectId}
				draftWorkspaceId={draftWorkspaceId}
				summaryWorkspaceName={currentWorkspaceName}
				summaryProjectName={currentProjectName}
				workspaceName={draftWorkspaceName}
				workspaceItems={workspaceItems}
				projectItems={projectItems}
				createWorkspaceDisabled={createWorkspaceDisabled}
				createWorkspaceDisabledReason={createWorkspaceDisabledReason}
				createProjectDisabled={createProjectDisabled}
				createProjectDisabledReason={createProjectDisabledReason}
				workspaceLimitFraction={workspaceLimitFraction}
				workspaceLimitTooltip={workspaceLimitTooltip}
				projectLimitFraction={projectLimitFraction}
				projectLimitTooltip={projectLimitTooltip}
				switchDisabled={switchDisabled}
				editTarget={editTarget}
				createWorkspace={handleWorkspaceSwitcherCreateWorkspace}
				createProject={handleWorkspaceSwitcherCreateProject}
				editWorkspace={handleWorkspaceSwitcherEditWorkspace}
				editProject={handleWorkspaceSwitcherEditProject}
				setEditTarget={setEditTarget}
				onAfterCreateWorkspace={handleWorkspaceSwitcherAfterCreate}
				onAfterCreateProject={handleWorkspaceSwitcherAfterCreate}
				onAfterEdit={handleWorkspaceSwitcherAfterEdit}
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
