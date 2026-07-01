import "./main-app-header.css";

import { memo, useEffect, useState, type ComponentPropsWithRef } from "react";
import { useQueries, useQuery } from "convex/react";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown } from "lucide-react";

import { AppNotifications } from "@/components/app-notifications.tsx";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MainAppHeaderBillingIndicator } from "@/components/main-app-header-billing-indicator.tsx";
import {
	MainAppHeaderOrganizationSwitcherModal,
	type MainAppHeaderOrganizationSwitcherModal_ListItem,
	type MainAppHeaderOrganizationSwitcherModal_Props,
	type MainAppHeaderOrganizationSwitcherModal_EditTarget,
	type MainAppHeaderOrganizationSwitcherModal_BillingTarget,
} from "@/components/main-app-header-organization-controls-modal.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyModal, MyModalTrigger } from "@/components/my-modal.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_tenant_default_workspace_for_organization, app_tenant_primary_workspace_for_organization } from "@/lib/urls.ts";
import { organizations_switcher_list_secondary_line } from "@/lib/organizations.ts";
import { cn } from "@/lib/utils.ts";
import { quotas } from "../../shared/quotas.ts";

// #region organization controls
type MainAppHeaderOrganizationControls_ClassNames =
	| "MainAppHeaderOrganizationControls"
	| "MainAppHeaderOrganizationControls-button"
	| "MainAppHeaderOrganizationControls-text"
	| "MainAppHeaderOrganizationControls-primary-text"
	| "MainAppHeaderOrganizationControls-secondary-text"
	| "MainAppHeaderOrganizationControls-icon";

type MainAppHeaderOrganizationControls_LocalDraft = {
	organizationId: app_convex_Id<"organizations">;
	workspaceId: app_convex_Id<"organizations_workspaces">;
};

function main_app_header_organization_controls_move_list_item_to_front_by_id<T extends { id: string }>(
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

function main_app_header_organization_controls_quota_tooltip(args: {
	kind: "workspace" | "organization";
	currentCount: number | undefined;
	maxCount: number | undefined;
}) {
	const { kind, currentCount, maxCount } = args;

	if (currentCount === undefined || maxCount === undefined) {
		return kind === "organization" ? "Loading organization quota." : "Loading workspace quota.";
	}

	const maxTotal = 1 + maxCount;
	const remaining = Math.max(0, maxTotal - currentCount);

	return kind === "organization"
		? `Using ${currentCount} of ${maxTotal} total organizations. ${remaining} remaining available.`
		: `Using ${currentCount} of ${maxTotal} total workspaces in this organization. ${remaining} remaining available.`;
}

function main_app_header_organization_controls_create_disabled_tooltip(args: {
	kind: "workspace" | "organization";
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
		return kind === "organization" ? "Loading organization quota." : "Loading workspace quota.";
	}

	const maxTotal = 1 + maxCount;

	return kind === "organization"
		? `All ${maxTotal} available organization slots are already in use.`
		: `All ${maxTotal} available workspace slots in this organization are already in use.`;
}

const MainAppHeaderOrganizationControls = memo(function MainAppHeaderOrganizationControls() {
	const navigate = useNavigate();
	const auth = AppAuthProvider.useAuth();

	const { organizationId, organizationName, workspaceId, workspaceName } = AppTenantProvider.useContext();

	const organizationList = useQuery(app_convex_api.organizations.list);

	const [isOpen, setIsOpen] = useState(false);
	const [localDraft, setLocalDraft] = useState<MainAppHeaderOrganizationControls_LocalDraft | null>(null);
	const [editTarget, setEditTarget] = useState<MainAppHeaderOrganizationSwitcherModal_EditTarget | null>(null);
	const [billingTarget, setBillingTarget] = useState<MainAppHeaderOrganizationSwitcherModal_BillingTarget | null>(null);

	const organizations = organizationList?.organizations;
	const workspaces = organizationId ? organizationList?.organizationIdsWorkspacesDict[organizationId] : undefined;

	const organizationRoleQueryResults = useQueries(
		Object.fromEntries(
			(organizations ?? []).flatMap((w) =>
				w.defaultWorkspaceId
					? [
							[
								w._id,
								{
									query: app_convex_api.access_control.get_current_user_role,
									args: {
										organizationId: w._id,
										workspaceId: w.defaultWorkspaceId,
									},
								},
							] as const,
						]
					: [],
			),
		),
	);

	const draftOrganizationId = localDraft?.organizationId ?? organizationId;
	const draftWorkspaceId = localDraft?.workspaceId ?? workspaceId;
	const createOrganizationQuota = useQuery(
		app_convex_api.quotas.get,
		auth.userId
			? {
					quotaName: "extra_organizations",
					userId: auth.userId,
				}
			: "skip",
	);
	const draftWorkspaceCreateQuota = useQuery(
		app_convex_api.quotas.get,
		draftOrganizationId
			? {
					quotaName: "extra_workspaces",
					organizationId: draftOrganizationId,
				}
			: "skip",
	);

	const draftWorkspaces =
		draftOrganizationId && organizationList ? organizationList.organizationIdsWorkspacesDict[draftOrganizationId] : undefined;

	const currentOrganizationName = organizations?.find((w) => w._id === organizationId)?.name ?? organizationName ?? "…";
	const currentWorkspaceName = workspaces?.find((p) => p._id === workspaceId)?.name ?? workspaceName ?? "…";

	const draftOrganizationRecord = organizations?.find((w) => w._id === draftOrganizationId);
	const draftOrganizationName = draftOrganizationRecord?.name ?? organizationName ?? "…";

	const listLoaded = organizations !== undefined;
	const createOrganizationRemainingCount = createOrganizationQuota
		? Math.max(0, createOrganizationQuota.maxCount - createOrganizationQuota.usedCount)
		: undefined;
	const createWorkspaceRemainingCount = draftWorkspaceCreateQuota
		? Math.max(0, draftWorkspaceCreateQuota.maxCount - draftWorkspaceCreateQuota.usedCount)
		: undefined;
	const createOrganizationDisabled =
		!listLoaded || createOrganizationRemainingCount === undefined || createOrganizationRemainingCount <= 0;
	const createWorkspaceDisabled =
		!listLoaded || createWorkspaceRemainingCount === undefined || createWorkspaceRemainingCount <= 0;
	const createOrganizationDisabledReason = main_app_header_organization_controls_create_disabled_tooltip({
		kind: "organization",
		createDisabled: createOrganizationDisabled,
		createDisabledReason:
			createOrganizationRemainingCount !== undefined && createOrganizationRemainingCount <= 0
				? quotas.extra_organizations.disabledReason
				: undefined,
		maxCount: createOrganizationQuota?.maxCount,
	});
	const createWorkspaceDisabledReason = main_app_header_organization_controls_create_disabled_tooltip({
		kind: "workspace",
		createDisabled: createWorkspaceDisabled,
		createDisabledReason:
			createWorkspaceRemainingCount !== undefined && createWorkspaceRemainingCount <= 0
				? quotas.extra_workspaces.disabledReason
				: undefined,
		maxCount: draftWorkspaceCreateQuota?.maxCount,
	});
	const organizationQuotaFraction = auth.userId
		? organizations && createOrganizationQuota
			? `${organizations.length}/${1 + createOrganizationQuota.maxCount}`
			: "…/…"
		: undefined;
	const workspaceQuotaFraction = auth.userId
		? draftWorkspaces && draftWorkspaceCreateQuota
			? `${draftWorkspaces.length}/${1 + draftWorkspaceCreateQuota.maxCount}`
			: "…/…"
		: undefined;
	const organizationQuotaTooltip = auth.userId
		? main_app_header_organization_controls_quota_tooltip({
				kind: "organization",
				currentCount: organizations?.length,
				maxCount: createOrganizationQuota?.maxCount,
			})
		: undefined;
	const workspaceQuotaTooltip = auth.userId
		? main_app_header_organization_controls_quota_tooltip({
				kind: "workspace",
				currentCount: draftWorkspaces?.length,
				maxCount: draftWorkspaceCreateQuota?.maxCount,
			})
		: undefined;

	const switchDisabled = !listLoaded || (draftOrganizationId === organizationId && draftWorkspaceId === workspaceId);

	const navigateToOrganizationWorkspace = useFn((nextOrganizationName: string, nextWorkspaceName: string) => {
		// Keep the current leaf route and replace only the tenant path params.
		navigate({
			to: ".",
			params: (current) => ({
				...current,
				organizationName: nextOrganizationName,
				workspaceName: nextWorkspaceName,
			}),
		});
		setIsOpen(false);
	});

	const organizationItems: MainAppHeaderOrganizationSwitcherModal_ListItem[] =
		main_app_header_organization_controls_move_list_item_to_front_by_id(
			(organizations ?? []).map((w) => {
				const currentUserOrganizationRoleResult = organizationRoleQueryResults[w._id];
				const currentUserOrganizationRole =
					currentUserOrganizationRoleResult instanceof Error || currentUserOrganizationRoleResult === undefined
						? null
						: currentUserOrganizationRoleResult;
				const ownsOrganization = !w.default && w.ownerUserId === auth.userId;
				const primaryWorkspace = organizationList
					? app_tenant_primary_workspace_for_organization({
							organization: w,
							workspaces: organizationList.organizationIdsWorkspacesDict[w._id] ?? [],
						})
					: null;

				return {
					id: w._id,
					label: w.name,
					description: organizations_switcher_list_secondary_line({
						storedDescription: w.description ?? "",
						isDefaultOrganization: w.default,
						isPrimaryWorkspace: false,
					}),
					isDefault: w.default,
					ownershipBadge: w.default ? "personal" : ownsOrganization ? "owner" : "member",
					billingBadge: w.default
						? undefined
						: w.billingMode === "user"
							? "members_pay"
							: ownsOrganization
								? "my_balance"
								: "owner_pays",
					onManageBilling:
						w.default || currentUserOrganizationRole !== "owner"
							? undefined
							: () => {
									setBillingTarget({
										organizationId: w._id,
										organizationName: w.name,
										billingMode: w.billingMode,
									});
								},
					onEdit:
						w.default || !primaryWorkspace
							? undefined
							: () => {
									setEditTarget({
										kind: "organization",
										id: w._id,
										initialName: w.name,
										initialDescription: w.description ?? "",
										defaultWorkspaceId: primaryWorkspace._id as app_convex_Id<"organizations_workspaces">,
									});
								},
					onDelete:
						w.default || currentUserOrganizationRole !== "owner"
							? undefined
							: () => {
									void (async (/* iife */) => {
										const result = await app_convex.mutation(app_convex_api.organizations.delete_organization, {
											organizationId: w._id,
										});

										if (result == null) {
											return;
										}

										if (result._nay) {
											console.error("[MainAppHeaderOrganizationControls] Failed to delete organization", {
												result,
												organizationId: w._id,
											});
											return;
										}

										await app_convex.query(app_convex_api.organizations.list, {});

										if (w._id === organizationId && organizations && organizationList) {
											const remaining = organizations.filter((row) => row._id !== w._id);
											const fallback = remaining[0];
											if (!fallback) {
												return;
											}

											const defaultWorkspace = app_tenant_default_workspace_for_organization({
												organization: fallback,
												workspaces: organizationList.organizationIdsWorkspacesDict[fallback._id] ?? [],
											});

											if (!defaultWorkspace) {
												console.error(
													"[MainAppHeaderOrganizationControls] Failed to resolve default workspace after organization delete",
													{ organizationId: fallback._id },
												);
												return;
											}

											navigateToOrganizationWorkspace(fallback.name, defaultWorkspace.name);
											return;
										}

										if (w._id === draftOrganizationId && w._id !== organizationId && organizationId && workspaceId) {
											setLocalDraft({ organizationId, workspaceId });
										}
									})().catch((error) => {
										console.error("[MainAppHeaderOrganizationControls] Unexpected delete organization error", {
											error,
											organizationId: w._id,
										});
									});
								},
					onSelect: () => {
						if (w._id === draftOrganizationId) {
							return;
						}

						if (!organizationList) {
							console.error("[MainAppHeaderOrganizationControls] Organization list not loaded");
							return;
						}

						const defaultWorkspace = app_tenant_default_workspace_for_organization({
							organization: w,
							workspaces: organizationList.organizationIdsWorkspacesDict[w._id] ?? [],
						});

						if (!defaultWorkspace) {
							console.error("[MainAppHeaderOrganizationControls] Failed to resolve default workspace for organization", {
								organizationId: w._id,
							});
							return;
						}

						setLocalDraft({
							organizationId: w._id,
							workspaceId: defaultWorkspace._id as app_convex_Id<"organizations_workspaces">,
						});
					},
				};
			}),
			organizationId,
		);

	const workspaceItemsRaw: MainAppHeaderOrganizationSwitcherModal_ListItem[] = (draftWorkspaces ?? []).map((p) => {
		const primaryWorkspace =
			draftOrganizationRecord && organizationList
				? app_tenant_primary_workspace_for_organization({
						organization: draftOrganizationRecord,
						workspaces: organizationList.organizationIdsWorkspacesDict[draftOrganizationRecord._id] ?? [],
					})
				: null;
		const workspaceIsPrimary = primaryWorkspace?._id === p._id;

		return {
			id: p._id,
			label: p.name,
			description: organizations_switcher_list_secondary_line({
				storedDescription: p.description ?? "",
				isDefaultOrganization: false,
				isPrimaryWorkspace: workspaceIsPrimary,
			}),
			isDefault: p.default,
			onEdit:
				workspaceIsPrimary || !primaryWorkspace
					? undefined
					: () => {
							if (!draftOrganizationRecord) {
								console.error("[MainAppHeaderOrganizationControls] Missing draft organization for workspace edit");
								return;
							}

							setEditTarget({
								kind: "workspace",
								id: p._id,
								initialName: p.name,
								initialDescription: p.description ?? "",
								organizationId: draftOrganizationRecord._id,
								defaultWorkspaceId: primaryWorkspace._id as app_convex_Id<"organizations_workspaces">,
							});
						},
			onDelete: p.default
				? undefined
				: () => {
						void (async (/* iife */) => {
							const result = await app_convex.mutation(app_convex_api.organizations.delete_workspace, {
								workspaceId: p._id,
							});

							if (result == null) {
								return;
							}

							if (result._nay) {
								console.error("[MainAppHeaderOrganizationControls] Failed to delete workspace", {
									result,
									workspaceId: p._id,
								});
								return;
							}

							await app_convex.query(app_convex_api.organizations.list, {});

							if (p._id === workspaceId && organizationId && workspaces && organizations) {
								const ws = organizations.find((row) => row._id === organizationId);
								if (!ws) {
									return;
								}

								const remaining = workspaces.filter((row) => row._id !== p._id);
								const fallback = remaining.find((row) => row.default) ?? remaining[0];
								if (!fallback) {
									return;
								}

								navigateToOrganizationWorkspace(ws.name, fallback.name);
								return;
							}

							if (p._id === draftWorkspaceId && draftOrganizationId && organizationList) {
								const nextWorkspaces = organizationList.organizationIdsWorkspacesDict[draftOrganizationId] ?? [];
								const fallback =
									nextWorkspaces.find((row) => row._id !== p._id && row.default) ??
									nextWorkspaces.find((row) => row._id !== p._id);
								if (!fallback) {
									if (organizationId && workspaceId) {
										setLocalDraft({ organizationId, workspaceId });
									}
									return;
								}

								setLocalDraft({
									organizationId: draftOrganizationId,
									workspaceId: fallback._id as app_convex_Id<"organizations_workspaces">,
								});
							}
						})().catch((error) => {
							console.error("[MainAppHeaderOrganizationControls] Unexpected delete workspace error", {
								error,
								workspaceId: p._id,
							});
						});
					},
			onSelect: () => {
				if (p._id === draftWorkspaceId) {
					return;
				}

				setLocalDraft({
					organizationId: draftOrganizationId,
					workspaceId: p._id,
				});
			},
		};
	});

	const workspaceItems =
		draftOrganizationId === organizationId
			? main_app_header_organization_controls_move_list_item_to_front_by_id(workspaceItemsRaw, workspaceId)
			: workspaceItemsRaw;

	const handleOrganizationSwitcherSwitch = useFn<MainAppHeaderOrganizationSwitcherModal_Props["onSwitch"]>(() => {
		if (!organizationList || !organizations) {
			console.error("[MainAppHeaderOrganizationControls] Organization list not loaded");
			return;
		}

		const nextOrganization = organizations.find((w) => w._id === draftOrganizationId);
		const nextWorkspaces = organizationList.organizationIdsWorkspacesDict[draftOrganizationId] ?? [];
		const nextWorkspace = nextWorkspaces.find((p) => p._id === draftWorkspaceId);

		if (!nextOrganization || !nextWorkspace) {
			console.error("[MainAppHeaderOrganizationControls] Failed to resolve draft organization/workspace", {
				draftOrganizationId,
				draftWorkspaceId,
			});
			return;
		}

		navigateToOrganizationWorkspace(nextOrganization.name, nextWorkspace.name);
	});

	const handleOrganizationSwitcherAfterCreate = useFn<MainAppHeaderOrganizationSwitcherModal_Props["onAfterCreateOrganization"]>(
		(selection) => {
			setLocalDraft({
				organizationId: selection.organizationId,
				workspaceId: selection.workspaceId,
			});
		},
	);

	const handleOrganizationSwitcherAfterEdit = useFn<MainAppHeaderOrganizationSwitcherModal_Props["onAfterEdit"]>((args) => {
		if (args.kind === "organization") {
			if (organizationId === args.organizationId && currentOrganizationName === args.oldName) {
				navigateToOrganizationWorkspace(args.newName, currentWorkspaceName);
			}
			return;
		}

		if (args.workspaceId && workspaceId === args.workspaceId && currentWorkspaceName === args.oldName) {
			navigateToOrganizationWorkspace(currentOrganizationName, args.newName);
		}
	});

	const handleOrganizationSwitcherCancel = useFn<MainAppHeaderOrganizationSwitcherModal_Props["onCancel"]>(() => {
		setIsOpen(false);
	});

	const handleOrganizationSwitcherCreateOrganization = useFn<MainAppHeaderOrganizationSwitcherModal_Props["createOrganization"]>(
		(args) => {
			return app_convex.mutation(app_convex_api.organizations.create_organization, args);
		},
	);

	const handleOrganizationSwitcherCreateWorkspace = useFn<MainAppHeaderOrganizationSwitcherModal_Props["createWorkspace"]>(
		(args) => {
			return app_convex.mutation(app_convex_api.organizations.create_workspace, args);
		},
	);

	const handleOrganizationSwitcherEditOrganization = useFn<MainAppHeaderOrganizationSwitcherModal_Props["editOrganization"]>(
		(args) => {
			return app_convex.mutation(app_convex_api.organizations.edit_organization, args);
		},
	);

	const handleOrganizationSwitcherEditWorkspace = useFn<MainAppHeaderOrganizationSwitcherModal_Props["editWorkspace"]>((args) => {
		return app_convex.mutation(app_convex_api.organizations.edit_workspace, args);
	});

	const handleOrganizationSwitcherSetOrganizationBillingMode = useFn<
		MainAppHeaderOrganizationSwitcherModal_Props["setOrganizationBillingMode"]
	>((args) => {
		return app_convex.mutation(app_convex_api.organizations.set_organization_billing_mode, args);
	});
	const organizationControlsButtonLabel =
		organizations === undefined
			? "Open organization and workspace switcher. Current organization and workspace are loading."
			: `Open organization and workspace switcher. Current organization: ${currentOrganizationName}. Current workspace: ${currentWorkspaceName}.`;

	useEffect(() => {
		if (!isOpen) {
			setEditTarget(null);
			setBillingTarget(null);
			return;
		}

		if (!organizationId || !workspaceId) {
			return;
		}

		setLocalDraft({ organizationId, workspaceId });
	}, [isOpen, organizationId, workspaceId]);

	return (
		<MyModal open={isOpen} setOpen={setIsOpen}>
			<MyModalTrigger>
				<MyButton
					className={"MainAppHeaderOrganizationControls" satisfies MainAppHeaderOrganizationControls_ClassNames}
					variant="default"
					aria-label={organizationControlsButtonLabel}
				>
					<span
						className={cn(
							"MainAppHeaderOrganizationControls-primary-text" satisfies MainAppHeaderOrganizationControls_ClassNames,
						)}
					>
						{organizations === undefined ? "Loading…" : currentOrganizationName}
					</span>

					<span
						className={cn(
							"MainAppHeaderOrganizationControls-secondary-text" satisfies MainAppHeaderOrganizationControls_ClassNames,
						)}
					>
						{workspaces === undefined ? "…" : currentWorkspaceName}
					</span>

					<ChevronsUpDown
						className={cn("MainAppHeaderOrganizationControls-icon" satisfies MainAppHeaderOrganizationControls_ClassNames)}
					/>
				</MyButton>
			</MyModalTrigger>

			<MainAppHeaderOrganizationSwitcherModal
				dialogOpen={isOpen}
				listLoaded={listLoaded}
				draftWorkspaceId={draftWorkspaceId}
				draftOrganizationId={draftOrganizationId}
				summaryOrganizationName={currentOrganizationName}
				summaryWorkspaceName={currentWorkspaceName}
				organizationName={draftOrganizationName}
				organizationItems={organizationItems}
				workspaceItems={workspaceItems}
				createOrganizationDisabled={createOrganizationDisabled}
				createOrganizationDisabledReason={createOrganizationDisabledReason}
				createWorkspaceDisabled={createWorkspaceDisabled}
				createWorkspaceDisabledReason={createWorkspaceDisabledReason}
				organizationQuotaFraction={organizationQuotaFraction}
				organizationQuotaTooltip={organizationQuotaTooltip}
				workspaceQuotaFraction={workspaceQuotaFraction}
				workspaceQuotaTooltip={workspaceQuotaTooltip}
				switchDisabled={switchDisabled}
				editTarget={editTarget}
				billingTarget={billingTarget}
				createOrganization={handleOrganizationSwitcherCreateOrganization}
				createWorkspace={handleOrganizationSwitcherCreateWorkspace}
				editOrganization={handleOrganizationSwitcherEditOrganization}
				editWorkspace={handleOrganizationSwitcherEditWorkspace}
				setEditTarget={setEditTarget}
				setBillingTarget={setBillingTarget}
				setOrganizationBillingMode={handleOrganizationSwitcherSetOrganizationBillingMode}
				onAfterCreateOrganization={handleOrganizationSwitcherAfterCreate}
				onAfterCreateWorkspace={handleOrganizationSwitcherAfterCreate}
				onAfterEdit={handleOrganizationSwitcherAfterEdit}
				onCancel={handleOrganizationSwitcherCancel}
				onSwitch={handleOrganizationSwitcherSwitch}
			/>
		</MyModal>
	);
});
// #endregion organization controls

// #region root
type MainAppHeader_ClassNames = "MainAppHeader" | "MainAppHeader-content" | "MainAppHeader-actions";

export type MainAppHeader_Props = ComponentPropsWithRef<"header">;

export const MainAppHeader = memo(function MainAppHeader(props: MainAppHeader_Props) {
	const { ref, id, className, ...rest } = props;

	// Match the generated /files index route instead of parsing the browser path.
	// FileNodeView renders its own inline billing indicator, so suppress the bar-level copy there.
	const isFilesRoute =
		useMatch({
			from: "/w/$organizationName/$workspaceName/files/",
			shouldThrow: false,
			select: () => true,
		}) ?? false;

	return (
		<header ref={ref} id={id} className={cn("MainAppHeader" satisfies MainAppHeader_ClassNames, className)} {...rest}>
			<MainAppHeaderOrganizationControls />
			<div
				id={"app_main_header_content" satisfies AppElementId}
				className={cn("MainAppHeader-content" satisfies MainAppHeader_ClassNames)}
			>
				{/* The files inject content here */}
			</div>
			<div className={"MainAppHeader-actions" satisfies MainAppHeader_ClassNames}>
				<AppNotifications />
				{!isFilesRoute && <MainAppHeaderBillingIndicator />}
			</div>
		</header>
	);
});
// #endregion root
