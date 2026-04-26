import "./main-app-account-management.css";

import { useClerk, useUser } from "@clerk/clerk-react";
import { useQueries, useQuery } from "convex/react";
import { Crown, CreditCard, Mail, RefreshCw, Shield, User, UserRound } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { BillingAccountManagementPanel } from "@/components/billing/billing-account-management-panel.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputLabel } from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectItemIndicator,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab, MyTabsTabSurface } from "@/components/my-tabs.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { users_create_anonymouse_user_display_name } from "../../shared/users.ts";
import { format_relative_time } from "@/lib/date.ts";
import { compute_fallback_user_name } from "@/lib/utils.ts";

function get_display_name(user: NonNullable<ReturnType<typeof useUser>["user"]>) {
	if (user.fullName?.trim()) {
		return user.fullName.trim();
	}

	if (user.username?.trim()) {
		return user.username.trim();
	}

	if (user.primaryEmailAddress?.emailAddress?.trim()) {
		return user.primaryEmailAddress.emailAddress.trim();
	}

	return "User";
}

function get_error_message(error: unknown) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	if (!error || typeof error !== "object") {
		return "Unexpected error";
	}

	const maybeErrors = "errors" in error ? (error.errors as unknown) : null;
	if (Array.isArray(maybeErrors)) {
		const firstError = maybeErrors[0];
		if (
			firstError &&
			typeof firstError === "object" &&
			"message" in firstError &&
			typeof firstError.message === "string"
		) {
			return firstError.message;
		}
	}

	return "Unexpected error";
}

function get_session_label(
	session: Awaited<ReturnType<NonNullable<ReturnType<typeof useUser>["user"]>["getSessions"]>>[number],
) {
	const browser = session.latestActivity.browserName?.trim();
	const city = session.latestActivity.city?.trim();
	const country = session.latestActivity.country?.trim();

	const device = browser || session.latestActivity.deviceType || "Unknown device";
	const place = [city, country].filter(Boolean).join(", ");
	return place ? `${device} - ${place}` : device;
}

type OwnedWorkspaceAccountDeletionDecision =
	| {
			kind: "transfer";
			workspaceId: app_convex_Id<"workspaces">;
			newOwnerUserId: app_convex_Id<"users">;
		}
	| {
			kind: "delete";
			workspaceId: app_convex_Id<"workspaces">;
			confirmWorkspaceDeletion: boolean;
		};

// #region delete account workspace list
type MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames =
	| "MainAppAccountManagementDeleteAccountWorkspaceList"
	| "MainAppAccountManagementDeleteAccountWorkspaceList-workspace"
	| "MainAppAccountManagementDeleteAccountWorkspaceList-workspace-header"
	| "MainAppAccountManagementDeleteAccountWorkspaceList-workspace-title"
	| "MainAppAccountManagementDeleteAccountWorkspaceList-workspace-meta"
	| "MainAppAccountManagementDeleteAccountWorkspaceList-workspace-controls"
	| "MainAppAccountManagementDeleteAccountWorkspaceList-workspace-select"
	| "MainAppAccountManagementDeleteAccountWorkspaceList-workspace-delete";

type MainAppAccountManagementDeleteAccountWorkspaceList_Props = {
	authUserId: app_convex_Id<"users"> | null;
	ownedExtraWorkspaces: app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list>["workspaces"];
	ownedExtraWorkspaceUsersLoaded: boolean;
	ownedExtraWorkspaceUsersDict: Record<
		app_convex_Id<"workspaces">,
		app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list_workspace_project_users> | undefined | Error
	>;
	decisionsByWorkspaceId: Record<string, OwnedWorkspaceAccountDeletionDecision | undefined>;
	transferTargetAnagraphicDict: Record<
		app_convex_Id<"users">,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error
	>;
	onWorkspaceTransferDecisionChange: (
		workspaceId: app_convex_Id<"workspaces">,
		newOwnerUserId: app_convex_Id<"users">,
	) => void;
	onWorkspaceDeleteDecisionChange: (
		workspaceId: app_convex_Id<"workspaces">,
		confirmWorkspaceDeletion: boolean,
	) => void;
};

const MainAppAccountManagementDeleteAccountWorkspaceList = memo(
	function MainAppAccountManagementDeleteAccountWorkspaceList(
		props: MainAppAccountManagementDeleteAccountWorkspaceList_Props,
	) {
		const {
			authUserId,
			ownedExtraWorkspaces,
			ownedExtraWorkspaceUsersLoaded,
			ownedExtraWorkspaceUsersDict,
			transferTargetAnagraphicDict,
			decisionsByWorkspaceId,
			onWorkspaceTransferDecisionChange,
			onWorkspaceDeleteDecisionChange,
		} = props;

		return !ownedExtraWorkspaceUsersLoaded ? (
			<div
				className={
					"MainAppAccountManagementDeleteAccountWorkspaceList" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
				}
			>
				Loading owned workspaces...
			</div>
		) : ownedExtraWorkspaces.length ? (
			<div
				className={
					"MainAppAccountManagementDeleteAccountWorkspaceList" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
				}
			>
				{ownedExtraWorkspaces.map((workspace) => {
					const decision = decisionsByWorkspaceId[workspace._id];
					const projectUsersQueryResult = ownedExtraWorkspaceUsersDict[workspace._id];
					const transferTargets =
						projectUsersQueryResult === undefined ||
						projectUsersQueryResult === null ||
						projectUsersQueryResult instanceof Error
							? []
							: projectUsersQueryResult.filter((userId: app_convex_Id<"users">) => userId !== authUserId);
					const selectedTransferTarget =
						decision?.kind === "transfer"
							? transferTargets.find((targetUserId) => targetUserId === decision.newOwnerUserId)
							: undefined;
					const selectedTransferTargetAnagraphic = selectedTransferTarget
						? transferTargetAnagraphicDict[selectedTransferTarget]
						: null;
					const selectedTransferTargetDisplayName =
						selectedTransferTargetAnagraphic === undefined ||
						selectedTransferTargetAnagraphic === null ||
						selectedTransferTargetAnagraphic instanceof Error
							? selectedTransferTarget
								? compute_fallback_user_name(selectedTransferTarget)
								: "Transfer ownership"
							: selectedTransferTargetAnagraphic.displayName;

					return (
						<section
							key={workspace._id}
							className={
								"MainAppAccountManagementDeleteAccountWorkspaceList-workspace" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
							}
						>
							<header
								className={
									"MainAppAccountManagementDeleteAccountWorkspaceList-workspace-header" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
								}
							>
								<div>
									<h4
										className={
											"MainAppAccountManagementDeleteAccountWorkspaceList-workspace-title" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
										}
									>
										{workspace.name}
									</h4>
									<p
										className={
											"MainAppAccountManagementDeleteAccountWorkspaceList-workspace-meta" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
										}
									>
										Transfer or deletion required
									</p>
								</div>
								<MyBadge variant="destructive">
									<Crown aria-hidden />
									Owner
								</MyBadge>
							</header>
							<div
								className={
									"MainAppAccountManagementDeleteAccountWorkspaceList-workspace-controls" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
								}
							>
								<MySelect
									value={selectedTransferTarget ?? ""}
									setValue={(value) =>
										onWorkspaceTransferDecisionChange(workspace._id, value as app_convex_Id<"users">)
									}
								>
									<MySelectTrigger>
										<MyButton
											type="button"
											variant="outline"
											disabled={!transferTargets.length}
											className={
												"MainAppAccountManagementDeleteAccountWorkspaceList-workspace-select" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
											}
										>
											<span>{selectedTransferTargetDisplayName}</span>
											<MySelectOpenIndicator />
										</MyButton>
									</MySelectTrigger>
									<MySelectPopover sameWidth>
										<MySelectPopoverScrollableArea>
											<MySelectPopoverContent>
												{transferTargets.map((targetUserId) => {
													const targetUserAnagraphic = transferTargetAnagraphicDict[targetUserId];
													const targetUserDisplayName =
														targetUserAnagraphic === undefined ||
														targetUserAnagraphic === null ||
														targetUserAnagraphic instanceof Error
															? compute_fallback_user_name(targetUserId)
															: targetUserAnagraphic.displayName;

													return (
														<MySelectItem key={targetUserId} value={targetUserId}>
															{targetUserDisplayName}
															{selectedTransferTarget === targetUserId ? <MySelectItemIndicator /> : null}
														</MySelectItem>
													);
												})}
											</MySelectPopoverContent>
										</MySelectPopoverScrollableArea>
									</MySelectPopover>
								</MySelect>
								<label
									className={
										"MainAppAccountManagementDeleteAccountWorkspaceList-workspace-delete" satisfies MainAppAccountManagementDeleteAccountWorkspaceList_ClassNames
									}
								>
									<input
										type="checkbox"
										checked={decision?.kind === "delete" && decision.confirmWorkspaceDeletion}
										onChange={(event) => onWorkspaceDeleteDecisionChange(workspace._id, event.currentTarget.checked)}
									/>
									Delete workspace data
								</label>
							</div>
						</section>
					);
				})}
			</div>
		) : null;
	},
);
// #endregion delete account workspace list

// #region delete account
type MainAppAccountManagementDeleteAccount_ClassNames =
	| "MainAppAccountManagementDeleteAccount"
	| "MainAppAccountManagementDeleteAccount-copy"
	| "MainAppAccountManagementDeleteAccount-title"
	| "MainAppAccountManagementDeleteAccount-description"
	| "MainAppAccountManagementDeleteAccount-form";

type MainAppAccountManagementDeleteAccount_Props = {
	onDelete: (args: {
		ownedWorkspaceTransferDecisions?: Extract<OwnedWorkspaceAccountDeletionDecision, { kind: "transfer" }>[];
	}) => Promise<boolean>;
};

const MainAppAccountManagementDeleteAccount = memo(function MainAppAccountManagementDeleteAccount(
	props: MainAppAccountManagementDeleteAccount_Props,
) {
	const { onDelete } = props;

	const auth = AppAuthProvider.useAuth();
	const workspaceList = useQuery(app_convex_api.workspaces.list);

	const workspaceRoleQueries = Object.fromEntries(
		(workspaceList?.workspaces ?? []).flatMap((workspace) =>
			workspace.default || !workspace.defaultProjectId
				? []
				: [
						[
							workspace._id,
							{
								query: app_convex_api.access_control.get_current_user_role,
								args: {
									workspaceId: workspace._id,
									projectId: workspace.defaultProjectId,
								},
							},
						] as const,
					],
		),
	);
	const workspaceRoleQueryResults = useQueries(workspaceRoleQueries) as Record<
		app_convex_Id<"workspaces">,
		app_convex_FunctionReturnType<typeof app_convex_api.access_control.get_current_user_role> | undefined | Error
	>;
	const workspaceRolesLoaded =
		workspaceList !== undefined &&
		workspaceList.workspaces.every(
			(workspace) =>
				workspace.default || !workspace.defaultProjectId || workspaceRoleQueryResults[workspace._id] !== undefined,
		);

	// The react compiler is unable to memoize code that uses the returned value from a hook
	const ownedExtraWorkspaces = useMemo(
		() =>
			workspaceList === undefined || !workspaceRolesLoaded
				? []
				: workspaceList.workspaces.filter((workspace) => {
						if (workspace.default || !workspace.defaultProjectId) {
							return false;
						}

						const roleQueryResult = workspaceRoleQueryResults[workspace._id];
						return !(roleQueryResult instanceof Error) && roleQueryResult === "owner";
					}),
		[workspaceList, workspaceRoleQueryResults, workspaceRolesLoaded],
	);
	const ownedExtraWorkspaceUsersQueries = Object.fromEntries(
		ownedExtraWorkspaces.flatMap((workspace) =>
			workspace.defaultProjectId
				? [
						[
							workspace._id,
							{
								query: app_convex_api.workspaces.list_workspace_project_users,
								args: {
									workspaceId: workspace._id,
									projectId: workspace.defaultProjectId,
								},
							},
						] as const,
					]
				: [],
		),
	);
	const ownedExtraWorkspaceUsersQueryResults = useQueries(ownedExtraWorkspaceUsersQueries) as Record<
		app_convex_Id<"workspaces">,
		app_convex_FunctionReturnType<typeof app_convex_api.workspaces.list_workspace_project_users> | undefined | Error
	>;
	const ownedExtraWorkspaceUsersLoaded =
		workspaceRolesLoaded &&
		ownedExtraWorkspaces.every((workspace) => ownedExtraWorkspaceUsersQueryResults[workspace._id] !== undefined);

	// The react compiler is unable to memoize code that uses the returned value from a hook
	const transferTargetAnagraphicQueries = useMemo(
		() =>
			Object.fromEntries(
				ownedExtraWorkspaceUsersLoaded
					? ownedExtraWorkspaces.flatMap((workspace) => {
							const projectUsersQueryResult = ownedExtraWorkspaceUsersQueryResults[workspace._id];
							if (
								projectUsersQueryResult === undefined ||
								projectUsersQueryResult === null ||
								projectUsersQueryResult instanceof Error
							) {
								return [];
							}

							return projectUsersQueryResult
								.filter((userId: app_convex_Id<"users">) => userId !== auth.userId)
								.map(
									(userId) =>
										[
											userId,
											{
												query: app_convex_api.users.get_anagraphic,
												args: { userId },
											},
										] as const,
								);
						})
					: [],
			),
		[auth.userId, ownedExtraWorkspaces, ownedExtraWorkspaceUsersLoaded, ownedExtraWorkspaceUsersQueryResults],
	);
	const transferTargetAnagraphicQueryResults = useQueries(transferTargetAnagraphicQueries) as Record<
		app_convex_Id<"users">,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error
	>;

	const [confirmationText, setConfirmationText] = useState("");
	const [isDeleting, setIsDeleting] = useState(false);

	const [decisionsByWorkspaceId, setDecisionsByWorkspaceId] = useState<
		Record<string, OwnedWorkspaceAccountDeletionDecision | undefined>
	>({});
	const ownedWorkspaceDecisions = ownedExtraWorkspaceUsersLoaded
		? ownedExtraWorkspaces.flatMap((workspace) => {
				const decision = decisionsByWorkspaceId[workspace._id];
				return decision == null ? [] : [decision];
			})
		: undefined;
	const ownedWorkspaceTransferDecisions = ownedWorkspaceDecisions?.flatMap((decision) =>
		decision.kind === "transfer" ? [decision] : [],
	);

	const ownedWorkspaceDecisionReady =
		ownedExtraWorkspaceUsersLoaded &&
		ownedExtraWorkspaces.every((workspace) => {
			const decision = decisionsByWorkspaceId[workspace._id];
			if (!decision) {
				return false;
			}

			if (decision.kind === "transfer") {
				const projectUsersQueryResult = ownedExtraWorkspaceUsersQueryResults[workspace._id];
				return (
					decision.newOwnerUserId !== auth.userId &&
					projectUsersQueryResult !== undefined &&
					projectUsersQueryResult !== null &&
					!(projectUsersQueryResult instanceof Error) &&
					projectUsersQueryResult.includes(decision.newOwnerUserId)
				);
			}

			return decision.confirmWorkspaceDeletion;
		});

	const handleWorkspaceTransferDecisionChange = useFn(
		(workspaceId: app_convex_Id<"workspaces">, newOwnerUserId: app_convex_Id<"users">) => {
			setDecisionsByWorkspaceId((current) => ({
				...current,
				[workspaceId]: {
					kind: "transfer",
					workspaceId,
					newOwnerUserId,
				},
			}));
		},
	);

	const handleWorkspaceDeleteDecisionChange = useFn(
		(workspaceId: app_convex_Id<"workspaces">, confirmWorkspaceDeletion: boolean) => {
			setDecisionsByWorkspaceId((current) => ({
				...current,
				[workspaceId]: confirmWorkspaceDeletion
					? {
							kind: "delete",
							workspaceId,
							confirmWorkspaceDeletion: true,
						}
					: undefined,
			}));
		},
	);

	const handleDelete = useFn(async () => {
		if (confirmationText !== "DELETE" || !ownedWorkspaceDecisionReady) {
			return;
		}

		setIsDeleting(true);
		await onDelete({ ownedWorkspaceTransferDecisions })
			.then((deleted) => {
				if (deleted) {
					setConfirmationText("");
					setDecisionsByWorkspaceId({});
				}
			})
			.finally(() => {
				setIsDeleting(false);
			});
	});

	return (
		<div className={"MainAppAccountManagementDeleteAccount" satisfies MainAppAccountManagementDeleteAccount_ClassNames}>
			<div
				className={
					"MainAppAccountManagementDeleteAccount-copy" satisfies MainAppAccountManagementDeleteAccount_ClassNames
				}
			>
				<h3
					className={
						"MainAppAccountManagementDeleteAccount-title" satisfies MainAppAccountManagementDeleteAccount_ClassNames
					}
				>
					Delete account
				</h3>
				<p
					className={
						"MainAppAccountManagementDeleteAccount-description" satisfies MainAppAccountManagementDeleteAccount_ClassNames
					}
				>
					This permanently deletes your app account and clears memberships. Type <code>DELETE</code> to confirm.
				</p>
			</div>
			<MainAppAccountManagementDeleteAccountWorkspaceList
				authUserId={auth.userId}
				ownedExtraWorkspaces={ownedExtraWorkspaces}
				ownedExtraWorkspaceUsersLoaded={ownedExtraWorkspaceUsersLoaded}
				ownedExtraWorkspaceUsersDict={ownedExtraWorkspaceUsersQueryResults}
				transferTargetAnagraphicDict={transferTargetAnagraphicQueryResults}
				decisionsByWorkspaceId={decisionsByWorkspaceId}
				onWorkspaceTransferDecisionChange={handleWorkspaceTransferDecisionChange}
				onWorkspaceDeleteDecisionChange={handleWorkspaceDeleteDecisionChange}
			/>
			<div
				className={
					"MainAppAccountManagementDeleteAccount-form" satisfies MainAppAccountManagementDeleteAccount_ClassNames
				}
			>
				<MyInput variant="surface">
					<MyInputLabel>Confirmation</MyInputLabel>
					<MyInputArea>
						<MyInputBox />
						<MyInputControl
							type="text"
							value={confirmationText}
							placeholder="DELETE"
							disabled={isDeleting}
							onChange={(event) => {
								setConfirmationText(event.currentTarget.value);
							}}
						/>
					</MyInputArea>
				</MyInput>
				<MyButton
					variant="destructive"
					disabled={confirmationText !== "DELETE" || !ownedWorkspaceDecisionReady || isDeleting}
					onClick={handleDelete}
				>
					{isDeleting ? "Deleting..." : "Delete account"}
				</MyButton>
			</div>
		</div>
	);
});
// #endregion delete account

// #region profile
type MainAppAccountManagementProfile_ClassNames =
	| "MainAppAccountManagementProfile"
	| "MainAppAccountManagementProfile-header"
	| "MainAppAccountManagementProfile-title"
	| "MainAppAccountManagementProfile-description"
	| "MainAppAccountManagementProfile-body"
	| "MainAppAccountManagementProfile-summary"
	| "MainAppAccountManagementProfile-summary-avatar"
	| "MainAppAccountManagementProfile-summary-avatar-icon"
	| "MainAppAccountManagementProfile-summary-title"
	| "MainAppAccountManagementProfile-summary-email"
	| "MainAppAccountManagementProfile-connected-list"
	| "MainAppAccountManagementProfile-connected-title"
	| "MainAppAccountManagementProfile-connected-meta";

type MainAppAccountManagementProfile_Props = {
	displayName: string;
	avatarUrl?: string;
	isAnonymous: boolean;
	summaryEmailLine: string;
	connectedAccountEmail: string;
	connectedAccountType: string;
};

const MainAppAccountManagementProfile = memo(function MainAppAccountManagementProfile(
	props: MainAppAccountManagementProfile_Props,
) {
	const { displayName, avatarUrl, isAnonymous, summaryEmailLine, connectedAccountEmail, connectedAccountType } = props;

	return (
		<div className={"MainAppAccountManagementProfile" satisfies MainAppAccountManagementProfile_ClassNames}>
			<header className={"MainAppAccountManagementProfile-header" satisfies MainAppAccountManagementProfile_ClassNames}>
				<div>
					<h2 className={"MainAppAccountManagementProfile-title" satisfies MainAppAccountManagementProfile_ClassNames}>
						Profile
					</h2>
					<p
						className={
							"MainAppAccountManagementProfile-description" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						Review your profile details.
					</p>
				</div>
			</header>
			<div className={"MainAppAccountManagementProfile-body" satisfies MainAppAccountManagementProfile_ClassNames}>
				<div className={"MainAppAccountManagementProfile-summary" satisfies MainAppAccountManagementProfile_ClassNames}>
					<MyAvatar
						size="56px"
						className={
							"MainAppAccountManagementProfile-summary-avatar" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						<MyAvatarImage src={avatarUrl} alt={displayName} />
						<MyAvatarFallback>
							{isAnonymous ? (
								<User
									className={
										"MainAppAccountManagementProfile-summary-avatar-icon" satisfies MainAppAccountManagementProfile_ClassNames
									}
									aria-hidden
								/>
							) : (
								compute_fallback_user_name(displayName)
							)}
						</MyAvatarFallback>
					</MyAvatar>
					<h3
						className={
							"MainAppAccountManagementProfile-summary-title" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						{displayName}
					</h3>
					<p
						className={
							"MainAppAccountManagementProfile-summary-email" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						{summaryEmailLine}
					</p>
				</div>

				<dl
					className={
						"MainAppAccountManagementProfile-connected-list" satisfies MainAppAccountManagementProfile_ClassNames
					}
				>
					<dt
						className={
							"MainAppAccountManagementProfile-connected-title" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						Email
					</dt>
					<dd
						className={
							"MainAppAccountManagementProfile-connected-meta" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						{connectedAccountEmail}
					</dd>
					<dt
						className={
							"MainAppAccountManagementProfile-connected-title" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						Connection type
					</dt>
					<dd
						className={
							"MainAppAccountManagementProfile-connected-meta" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						{connectedAccountType}
					</dd>
				</dl>
			</div>
		</div>
	);
});
// #endregion profile

// #region security
type MainAppAccountManagementSecurity_ClassNames =
	| "MainAppAccountManagementSecurity"
	| "MainAppAccountManagementSecurity-panel"
	| "MainAppAccountManagementSecurity-panel-header"
	| "MainAppAccountManagementSecurity-panel-title"
	| "MainAppAccountManagementSecurity-panel-description"
	| "MainAppAccountManagementSecurity-panel-body"
	| "MainAppAccountManagementSecurity-panel-actions"
	| "MainAppAccountManagementSecurity-row"
	| "MainAppAccountManagementSecurity-row-title"
	| "MainAppAccountManagementSecurity-row-meta"
	| "MainAppAccountManagementSecurity-row-actions";

type MainAppAccountManagementSecurity_Props = {
	isAnonymous: boolean;
	sessions: Array<Awaited<ReturnType<NonNullable<ReturnType<typeof useUser>["user"]>["getSessions"]>>[number]>;
	isLoadingSessions: boolean;
	onRefreshSessions: () => Promise<void>;
	onDeleteAccount: MainAppAccountManagementDeleteAccount_Props["onDelete"];
};

const MainAppAccountManagementSecurity = memo(function MainAppAccountManagementSecurity(
	props: MainAppAccountManagementSecurity_Props,
) {
	const { isAnonymous, sessions, isLoadingSessions, onRefreshSessions, onDeleteAccount } = props;

	const [busySessionId, setBusySessionId] = useState<string | null>(null);

	const handleRevokeSession = useFn(
		(session: Awaited<ReturnType<NonNullable<ReturnType<typeof useUser>["user"]>["getSessions"]>>[number]) => {
			setBusySessionId(session.id);
			void session
				.revoke()
				.then(() => onRefreshSessions())
				.then(() => {
					toast.success("Session revoked");
				})
				.catch((error) => {
					toast.error(get_error_message(error));
				})
				.finally(() => {
					setBusySessionId(null);
				});
		},
	);

	return (
		<div className={"MainAppAccountManagementSecurity" satisfies MainAppAccountManagementSecurity_ClassNames}>
			<section
				className={"MainAppAccountManagementSecurity-panel" satisfies MainAppAccountManagementSecurity_ClassNames}
			>
				<header
					className={
						"MainAppAccountManagementSecurity-panel-header" satisfies MainAppAccountManagementSecurity_ClassNames
					}
				>
					<h2
						className={
							"MainAppAccountManagementSecurity-panel-title" satisfies MainAppAccountManagementSecurity_ClassNames
						}
					>
						Sessions
					</h2>
					<p
						className={
							"MainAppAccountManagementSecurity-panel-description" satisfies MainAppAccountManagementSecurity_ClassNames
						}
					>
						Review and revoke active sessions.
					</p>
					{isAnonymous ? null : (
						<MyButton
							variant="ghost"
							className={
								"MainAppAccountManagementSecurity-panel-actions" satisfies MainAppAccountManagementSecurity_ClassNames
							}
							disabled={isLoadingSessions}
							onClick={() => void onRefreshSessions()}
						>
							<RefreshCw aria-hidden />
							Refresh
						</MyButton>
					)}
				</header>
				<div
					className={
						"MainAppAccountManagementSecurity-panel-body" satisfies MainAppAccountManagementSecurity_ClassNames
					}
				>
					{isAnonymous ? (
						<p
							className={
								"MainAppAccountManagementSecurity-row-meta" satisfies MainAppAccountManagementSecurity_ClassNames
							}
						>
							-
						</p>
					) : null}
					{!isAnonymous
						? sessions.map((session) => (
								<div
									key={session.id}
									className={
										"MainAppAccountManagementSecurity-row" satisfies MainAppAccountManagementSecurity_ClassNames
									}
								>
									<h3
										className={
											"MainAppAccountManagementSecurity-row-title" satisfies MainAppAccountManagementSecurity_ClassNames
										}
									>
										{get_session_label(session)}
									</h3>
									<p
										className={
											"MainAppAccountManagementSecurity-row-meta" satisfies MainAppAccountManagementSecurity_ClassNames
										}
									>
										Last active{" "}
										{session.lastActiveAt ? format_relative_time(session.lastActiveAt.getTime()) : "Unknown"}
									</p>
									<MyButton
										variant="ghost"
										className={
											"MainAppAccountManagementSecurity-row-actions" satisfies MainAppAccountManagementSecurity_ClassNames
										}
										disabled={busySessionId === session.id}
										onClick={() => void handleRevokeSession(session)}
									>
										{busySessionId === session.id ? "Revoking..." : "Revoke"}
									</MyButton>
								</div>
							))
						: null}
					{!isAnonymous && !sessions.length && !isLoadingSessions ? (
						<p
							className={
								"MainAppAccountManagementSecurity-row-meta" satisfies MainAppAccountManagementSecurity_ClassNames
							}
						>
							No active sessions found.
						</p>
					) : null}
				</div>
			</section>

			<section
				className={"MainAppAccountManagementSecurity-panel" satisfies MainAppAccountManagementSecurity_ClassNames}
			>
				<header
					className={
						"MainAppAccountManagementSecurity-panel-header" satisfies MainAppAccountManagementSecurity_ClassNames
					}
				>
					<h2
						className={
							"MainAppAccountManagementSecurity-panel-title" satisfies MainAppAccountManagementSecurity_ClassNames
						}
					>
						Danger zone
					</h2>
					<p
						className={
							"MainAppAccountManagementSecurity-panel-description" satisfies MainAppAccountManagementSecurity_ClassNames
						}
					>
						Deleting the account is permanent.
					</p>
				</header>
				<div
					className={
						"MainAppAccountManagementSecurity-panel-body" satisfies MainAppAccountManagementSecurity_ClassNames
					}
				>
					<MainAppAccountManagementDeleteAccount onDelete={onDeleteAccount} />
				</div>
			</section>
		</div>
	);
});
// #endregion security

// #region root
type MainAppAccountManagement_ClassNames =
	| "MainAppAccountManagement"
	| "MainAppAccountManagement-header-copy"
	| "MainAppAccountManagement-header-description"
	| "MainAppAccountManagement-body"
	| "MainAppAccountManagement-side-tab"
	| "MainAppAccountManagement-panels"
	| "MainAppAccountManagement-panel"
	| "MainAppAccountManagement-loading";

export type MainAppAccountManagement_Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export const MainAppAccountManagement = memo(function MainAppAccountManagement(props: MainAppAccountManagement_Props) {
	const { open, onOpenChange } = props;

	const auth = AppAuthProvider.useAuth();
	const clerk = useClerk();
	const { isLoaded, user } = useUser();

	const anagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		auth.isAuthenticated && auth.userId
			? {
					userId: auth.userId,
				}
			: "skip",
	);

	const [sessions, setSessions] = useState<
		Array<Awaited<ReturnType<NonNullable<ReturnType<typeof useUser>["user"]>["getSessions"]>>[number]>
	>([]);
	const [isLoadingSessions, setIsLoadingSessions] = useState(false);

	const handleRefreshSessions = useFn(async () => {
		if (!user) {
			setSessions([]);
			return;
		}

		setIsLoadingSessions(true);
		await user
			.getSessions()
			.then((nextSessions) => {
				setSessions(nextSessions);
			})
			.catch((error) => {
				console.error("[MainAppAccountManagement.handleRefreshSessions] Failed to load sessions", { error });
				toast.error(get_error_message(error));
			})
			.finally(() => {
				setIsLoadingSessions(false);
			});
	});

	const handleDeleteAccount = useFn<MainAppAccountManagementDeleteAccount_Props["onDelete"]>(async (args) => {
		for (const transferDecision of args.ownedWorkspaceTransferDecisions ?? []) {
			const transferResult = await app_convex.mutation(app_convex_api.access_control.transfer_workspace_ownership, {
				workspaceId: transferDecision.workspaceId,
				newOwnerUserId: transferDecision.newOwnerUserId,
			});
			if (transferResult._nay) {
				toast.error(transferResult._nay.message ?? "Failed to transfer workspace ownership");
				return false;
			}
		}

		const result = await app_convex.action(app_convex_api.users.delete_current_user_account, {});
		if (result._nay) {
			toast.error(result._nay.message ?? "Failed to delete account");
			return false;
		}

		toast.success("Account deleted");
		onOpenChange(false);

		if (auth.isAnonymous) {
			await auth.resetAnonymousSession().catch((error) => {
				console.error("[MainAppAccountManagement.handleDeleteAccount] Failed to reset anonymous session", { error });
			});
			return true;
		}

		await clerk.signOut().catch((error) => {
			console.error("[MainAppAccountManagement.handleDeleteAccount] Clerk signOut failed", { error });
		});
		return true;
	});

	useEffect(() => {
		if (!open || !user || auth.isAnonymous) {
			setSessions([]);
			return;
		}

		void handleRefreshSessions();
	}, [handleRefreshSessions, open, user, auth.isAnonymous]);

	const clerkDisplayName = user
		? ((/* iife */) => {
				if (user.fullName?.trim()) {
					return user.fullName.trim();
				}

				if (user.username?.trim()) {
					return user.username.trim();
				}

				if (user.primaryEmailAddress?.emailAddress?.trim()) {
					return user.primaryEmailAddress.emailAddress.trim();
				}

				return null;
			})()
		: null;

	const displayName = auth.isAnonymous
		? (anagraphic?.displayName ??
			(auth.userId ? users_create_anonymouse_user_display_name(auth.userId) : "Anonymous user"))
		: user
			? (anagraphic?.displayName ?? clerkDisplayName ?? get_display_name(user))
			: "Account";

	const avatarUrl = auth.isAnonymous
		? (anagraphic?.avatarUrl ?? undefined)
		: (anagraphic?.avatarUrl ?? user?.imageUrl ?? undefined);

	const profileEmailSummary = auth.isAnonymous ? "-" : (user?.primaryEmailAddress?.emailAddress ?? "No primary email");

	const connectedAccountEmail = auth.isAnonymous
		? "-"
		: (user?.primaryEmailAddress?.emailAddress ?? "No primary email");

	const connectedAccountType = auth.isAnonymous ? "-" : (user?.externalAccounts[0]?.providerTitle() ?? "Unknown");

	const accountUiReady =
		auth.isLoaded &&
		auth.isAuthenticated &&
		Boolean(auth.userId) &&
		(auth.isAnonymous ? true : isLoaded && Boolean(user));

	return (
		auth.isAnonymous != null && (
			<MyModal open={open} setOpen={onOpenChange}>
				<MyModalPopover className={"MainAppAccountManagement" satisfies MainAppAccountManagement_ClassNames}>
					<MyModalHeader
						className={"MainAppAccountManagement-header-copy" satisfies MainAppAccountManagement_ClassNames}
					>
						<MyModalHeading>Manage account</MyModalHeading>
						<MyModalDescription
							className={"MainAppAccountManagement-header-description" satisfies MainAppAccountManagement_ClassNames}
						>
							Manage your profile, security settings, sessions, and account deletion from the app.
						</MyModalDescription>
					</MyModalHeader>

					<MyModalScrollableArea
						className={"MainAppAccountManagement-body" satisfies MainAppAccountManagement_ClassNames}
					>
						{!accountUiReady ? (
							<div className={"MainAppAccountManagement-loading" satisfies MainAppAccountManagement_ClassNames}>
								<UserRound aria-hidden />
								Loading account...
							</div>
						) : (
							<MyTabs defaultSelectedId="profile">
								<MyTabsList aria-label="Account sections">
									<MyTabsTabSurface>
										<MyTabsTab
											id="profile"
											className={"MainAppAccountManagement-side-tab" satisfies MainAppAccountManagement_ClassNames}
										>
											<Mail aria-hidden />
											Profile
										</MyTabsTab>
										<MyTabsTab
											id="billing"
											className={"MainAppAccountManagement-side-tab" satisfies MainAppAccountManagement_ClassNames}
										>
											<CreditCard aria-hidden />
											Billing
										</MyTabsTab>
										<MyTabsTab
											id="security"
											className={"MainAppAccountManagement-side-tab" satisfies MainAppAccountManagement_ClassNames}
										>
											<Shield aria-hidden />
											Security
										</MyTabsTab>
									</MyTabsTabSurface>
								</MyTabsList>

								<MyTabsPanels
									className={"MainAppAccountManagement-panels" satisfies MainAppAccountManagement_ClassNames}
								>
									<MyTabsPanel
										tabId="profile"
										className={"MainAppAccountManagement-panel" satisfies MainAppAccountManagement_ClassNames}
									>
										<MainAppAccountManagementProfile
											displayName={displayName}
											avatarUrl={avatarUrl}
											isAnonymous={auth.isAnonymous}
											summaryEmailLine={profileEmailSummary}
											connectedAccountEmail={connectedAccountEmail}
											connectedAccountType={connectedAccountType}
										/>
									</MyTabsPanel>
									<MyTabsPanel
										tabId="billing"
										className={"MainAppAccountManagement-panel" satisfies MainAppAccountManagement_ClassNames}
									>
										<BillingAccountManagementPanel isAnonymous={auth.isAnonymous} />
									</MyTabsPanel>
									<MyTabsPanel
										tabId="security"
										className={"MainAppAccountManagement-panel" satisfies MainAppAccountManagement_ClassNames}
									>
										<MainAppAccountManagementSecurity
											isAnonymous={auth.isAnonymous}
											sessions={sessions}
											isLoadingSessions={isLoadingSessions}
											onRefreshSessions={handleRefreshSessions}
											onDeleteAccount={handleDeleteAccount}
										/>
									</MyTabsPanel>
								</MyTabsPanels>
							</MyTabs>
						)}
					</MyModalScrollableArea>

					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		)
	);
});
// #endregion root
