import "./main-app-account-management.css";

import { useClerk, useUser } from "@clerk/clerk-react";
import { useQuery } from "convex/react";
import { CreditCard, Mail, RefreshCw, Shield, Trash2, User, UserRound, UserRoundCog } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { BillingAccountManagementPanel } from "@/components/billing/billing-account-management-panel.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyCheckboxButton, MyCheckboxButtonIcon } from "@/components/my-checkbox-button.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputLabel } from "@/components/my-input.tsx";
import { MyLink, MyLinkIcon } from "@/components/my-link.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab, MyTabsTabSurface } from "@/components/my-tabs.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
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

type MainAppAccountManagementDeleteAccount_BlockingWorkspace = app_convex_FunctionReturnType<
	typeof app_convex_api.users.list_current_user_account_deletion_blocking_workspaces
>[number];

// #region delete account workspace resolver
type MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames =
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-header-content"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-body"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-list"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-row"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-row-title"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-row-description"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-row-actions"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-row-action-separator"
	| "MainAppAccountManagementDeleteAccountWorkspaceResolver-submit-trigger";

type MainAppAccountManagementDeleteAccountWorkspaceResolverRow_Props = {
	blockingWorkspace: MainAppAccountManagementDeleteAccount_BlockingWorkspace;
	deleteConfirmed: boolean;
	resolving: boolean;
	onNavigateToWorkspaceUsers: () => void;
	onDeleteConfirmationChange: (workspaceId: app_convex_Id<"workspaces">, confirmed: boolean) => void;
};

const MainAppAccountManagementDeleteAccountWorkspaceResolverRow = memo(
	function MainAppAccountManagementDeleteAccountWorkspaceResolverRow(
		props: MainAppAccountManagementDeleteAccountWorkspaceResolverRow_Props,
	) {
		const { blockingWorkspace, deleteConfirmed, resolving, onNavigateToWorkspaceUsers, onDeleteConfirmationChange } =
			props;
		const workspaceDescription = blockingWorkspace.workspace.description.trim()
			? blockingWorkspace.workspace.description
			: "(No description)";

		return (
			<li
				className={
					"MainAppAccountManagementDeleteAccountWorkspaceResolver-row" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
				}
			>
				<h3
					className={
						"MainAppAccountManagementDeleteAccountWorkspaceResolver-row-title" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
					}
				>
					{blockingWorkspace.workspace.name}
				</h3>
				<p
					className={
						"MainAppAccountManagementDeleteAccountWorkspaceResolver-row-description" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
					}
				>
					{workspaceDescription}
				</p>
				<div
					className={
						"MainAppAccountManagementDeleteAccountWorkspaceResolver-row-actions" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
					}
				>
					<MyLink
						variant="button-outline"
						to="/w/$workspaceName/$projectName/users"
						params={{
							workspaceName: blockingWorkspace.workspace.name,
							projectName: blockingWorkspace.defaultProject.name,
						}}
						onClick={onNavigateToWorkspaceUsers}
					>
						<MyLinkIcon aria-hidden>
							<UserRoundCog />
						</MyLinkIcon>
						Transfer ownership
					</MyLink>
					<span
						className={
							"MainAppAccountManagementDeleteAccountWorkspaceResolver-row-action-separator" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
						}
					>
						or
					</span>
					<MyCheckboxButton
						variant="outline_destructive"
						checked={deleteConfirmed}
						disabled={resolving}
						onCheckedChange={(checked) => onDeleteConfirmationChange(blockingWorkspace.workspace._id, checked)}
					>
						<MyCheckboxButtonIcon aria-hidden>
							<Trash2 />
						</MyCheckboxButtonIcon>
						Delete workspace and data
					</MyCheckboxButton>
				</div>
			</li>
		);
	},
);

type MainAppAccountManagementDeleteAccountWorkspaceResolver_Props = {
	blockingWorkspaces: MainAppAccountManagementDeleteAccount_BlockingWorkspace[];
	deleteConfirmationsByWorkspaceId: Record<string, boolean | undefined>;
	resolving: boolean;
	canResolve: boolean;
	onClose: () => void;
	onNavigateToWorkspaceUsers: () => void;
	onDeleteConfirmationChange: (workspaceId: app_convex_Id<"workspaces">, confirmed: boolean) => void;
	onResolveAndDelete: () => void;
};

const MainAppAccountManagementDeleteAccountWorkspaceResolver = memo(
	function MainAppAccountManagementDeleteAccountWorkspaceResolver(
		props: MainAppAccountManagementDeleteAccountWorkspaceResolver_Props,
	) {
		const {
			blockingWorkspaces,
			deleteConfirmationsByWorkspaceId,
			resolving,
			canResolve,
			onClose,
			onNavigateToWorkspaceUsers,
			onDeleteConfirmationChange,
			onResolveAndDelete,
		} = props;
		const resolveDisabledTooltip =
			!canResolve && !resolving
				? "Before you can delete your account, transfer ownership of each workspace or confirm deleting the workspace."
				: null;
		const resolveButton = (
			<MyButton variant="destructive" disabled={!canResolve || resolving} onClick={onResolveAndDelete}>
				{resolving ? "Resolving..." : "Confirm account deletion"}
			</MyButton>
		);

		return (
			<MyModal open={blockingWorkspaces.length > 0} setOpen={(open) => !open && onClose()}>
				<MyModalPopover
					className={
						"MainAppAccountManagementDeleteAccountWorkspaceResolver" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
					}
				>
					<MyModalHeader>
						<div
							className={
								"MainAppAccountManagementDeleteAccountWorkspaceResolver-header-content" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
							}
						>
							<MyModalHeading>Resolve owned workspaces</MyModalHeading>
							<MyModalDescription>
								Transfer ownership from a workspace Users page, or confirm workspace deletion here.
							</MyModalDescription>
						</div>
					</MyModalHeader>
					<MyModalScrollableArea
						className={
							"MainAppAccountManagementDeleteAccountWorkspaceResolver-body" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
						}
					>
						<ul
							className={
								"MainAppAccountManagementDeleteAccountWorkspaceResolver-list" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
							}
						>
							{blockingWorkspaces.map((blockingWorkspace) => (
								<MainAppAccountManagementDeleteAccountWorkspaceResolverRow
									key={blockingWorkspace.workspace._id}
									blockingWorkspace={blockingWorkspace}
									deleteConfirmed={deleteConfirmationsByWorkspaceId[blockingWorkspace.workspace._id] === true}
									resolving={resolving}
									onNavigateToWorkspaceUsers={onNavigateToWorkspaceUsers}
									onDeleteConfirmationChange={onDeleteConfirmationChange}
								/>
							))}
						</ul>
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton variant="ghost-highlightable" disabled={resolving} onClick={onClose}>
							Cancel
						</MyButton>
						{resolveDisabledTooltip ? (
							<MyTooltip placement="top">
								<MyTooltipTrigger>
									<span
										className={
											"MainAppAccountManagementDeleteAccountWorkspaceResolver-submit-trigger" satisfies MainAppAccountManagementDeleteAccountWorkspaceResolver_ClassNames
										}
									>
										{resolveButton}
									</span>
								</MyTooltipTrigger>
								<MyTooltipContent unmountOnHide>
									<>{resolveDisabledTooltip}</>
								</MyTooltipContent>
							</MyTooltip>
						) : (
							resolveButton
						)}
					</MyModalFooter>
					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		);
	},
);
// #endregion delete account workspace resolver

// #region delete account
type MainAppAccountManagementDeleteAccount_ClassNames =
	| "MainAppAccountManagementDeleteAccount"
	| "MainAppAccountManagementDeleteAccount-text"
	| "MainAppAccountManagementDeleteAccount-title"
	| "MainAppAccountManagementDeleteAccount-description"
	| "MainAppAccountManagementDeleteAccount-form";

type MainAppAccountManagementDeleteAccount_Props = {
	onDelete: () => Promise<boolean>;
	onNavigateToWorkspaceUsers: () => void;
};

const MainAppAccountManagementDeleteAccount = memo(function MainAppAccountManagementDeleteAccount(
	props: MainAppAccountManagementDeleteAccount_Props,
) {
	const { onDelete, onNavigateToWorkspaceUsers } = props;

	const [confirmationText, setConfirmationText] = useState("");
	const [isDeleting, setIsDeleting] = useState(false);
	const [blockingWorkspaces, setBlockingWorkspaces] = useState<
		MainAppAccountManagementDeleteAccount_BlockingWorkspace[] | null
	>(null);
	const [deleteConfirmationsByWorkspaceId, setDeleteConfirmationsByWorkspaceId] = useState<
		Record<string, boolean | undefined>
	>({});
	const [isResolvingWorkspaces, setIsResolvingWorkspaces] = useState(false);

	const canResolveBlockingWorkspaces =
		blockingWorkspaces !== null &&
		blockingWorkspaces.length > 0 &&
		blockingWorkspaces.every((blockingWorkspace) => {
			return deleteConfirmationsByWorkspaceId[blockingWorkspace.workspace._id] === true;
		});

	const handleDelete = useFn(async () => {
		if (confirmationText !== "delete") {
			return;
		}

		setIsDeleting(true);
		await app_convex
			.query(app_convex_api.users.list_current_user_account_deletion_blocking_workspaces, {})
			.then(async (nextBlockingWorkspaces) => {
				if (nextBlockingWorkspaces.length > 0) {
					setBlockingWorkspaces(nextBlockingWorkspaces);
					setDeleteConfirmationsByWorkspaceId({});
					return;
				}

				setBlockingWorkspaces([]);
				const deleted = await onDelete();
				if (deleted) {
					setConfirmationText("");
					setBlockingWorkspaces(null);
					return;
				}

				const blockingWorkspacesAfterDeleteFailure = await app_convex.query(
					app_convex_api.users.list_current_user_account_deletion_blocking_workspaces,
					{},
				);
				if (blockingWorkspacesAfterDeleteFailure.length > 0) {
					setBlockingWorkspaces(blockingWorkspacesAfterDeleteFailure);
					setDeleteConfirmationsByWorkspaceId({});
				}
			})
			.catch((error) => {
				setBlockingWorkspaces(null);
				console.error("[MainAppAccountManagementDeleteAccount.handleDelete] Failed to prepare account deletion", {
					error,
				});
				toast.error("Failed to delete account");
			})
			.finally(() => {
				setIsDeleting(false);
			});
	});

	const handleCloseWorkspaceResolver = useFn(() => {
		if (isResolvingWorkspaces) {
			return;
		}

		setBlockingWorkspaces(null);
		setDeleteConfirmationsByWorkspaceId({});
	});

	const handleWorkspaceDeleteConfirmationChange = useFn(
		(workspaceId: app_convex_Id<"workspaces">, confirmed: boolean) => {
			setDeleteConfirmationsByWorkspaceId((current) => ({
				...current,
				[workspaceId]: confirmed,
			}));
		},
	);

	const handleResolveWorkspacesAndDelete = useFn(async () => {
		if (!blockingWorkspaces || !canResolveBlockingWorkspaces) {
			return;
		}

		setIsResolvingWorkspaces(true);
		await (async () => {
			for (const blockingWorkspace of blockingWorkspaces) {
				if (deleteConfirmationsByWorkspaceId[blockingWorkspace.workspace._id] !== true) {
					return;
				}

				const deleteResult = await app_convex.mutation(app_convex_api.workspaces.delete_workspace, {
					workspaceId: blockingWorkspace.workspace._id,
				});
				if (deleteResult._nay) {
					console.error(
						"[MainAppAccountManagementDeleteAccount.handleResolveWorkspacesAndDelete] Failed to delete workspace",
						{
							result: deleteResult,
							workspaceId: blockingWorkspace.workspace._id,
						},
					);
					toast.error(deleteResult._nay.message);
					return;
				}
			}

			const refreshedBlockingWorkspaces = await app_convex.query(
				app_convex_api.users.list_current_user_account_deletion_blocking_workspaces,
				{},
			);
			if (refreshedBlockingWorkspaces.length > 0) {
				setBlockingWorkspaces(refreshedBlockingWorkspaces);
				setDeleteConfirmationsByWorkspaceId({});
				toast.error("Resolve owned workspaces before deleting account");
				return;
			}

			const deleted = await onDelete();
			if (deleted) {
				setConfirmationText("");
				setBlockingWorkspaces(null);
				setDeleteConfirmationsByWorkspaceId({});
				return;
			}

			const blockingWorkspacesAfterDeleteFailure = await app_convex.query(
				app_convex_api.users.list_current_user_account_deletion_blocking_workspaces,
				{},
			);
			if (blockingWorkspacesAfterDeleteFailure.length > 0) {
				setBlockingWorkspaces(blockingWorkspacesAfterDeleteFailure);
				setDeleteConfirmationsByWorkspaceId({});
				return;
			}

			setBlockingWorkspaces(null);
			setDeleteConfirmationsByWorkspaceId({});
		})()
			.catch((error) => {
				console.error(
					"[MainAppAccountManagementDeleteAccount.handleResolveWorkspacesAndDelete] Failed to resolve owned workspaces",
					{
						error,
					},
				);
				toast.error("Failed to resolve owned workspaces");
			})
			.finally(() => {
				setIsResolvingWorkspaces(false);
			});
	});

	return (
		<div className={"MainAppAccountManagementDeleteAccount" satisfies MainAppAccountManagementDeleteAccount_ClassNames}>
			<div
				className={
					"MainAppAccountManagementDeleteAccount-text" satisfies MainAppAccountManagementDeleteAccount_ClassNames
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
					This permanently deletes your app account and clears memberships. Type <code>delete</code> to confirm.
				</p>
			</div>
			{blockingWorkspaces && blockingWorkspaces.length > 0 ? (
				<MainAppAccountManagementDeleteAccountWorkspaceResolver
					blockingWorkspaces={blockingWorkspaces}
					deleteConfirmationsByWorkspaceId={deleteConfirmationsByWorkspaceId}
					resolving={isResolvingWorkspaces}
					canResolve={canResolveBlockingWorkspaces}
					onClose={handleCloseWorkspaceResolver}
					onNavigateToWorkspaceUsers={onNavigateToWorkspaceUsers}
					onDeleteConfirmationChange={handleWorkspaceDeleteConfirmationChange}
					onResolveAndDelete={() => void handleResolveWorkspacesAndDelete()}
				/>
			) : null}
			<form
				className={
					"MainAppAccountManagementDeleteAccount-form" satisfies MainAppAccountManagementDeleteAccount_ClassNames
				}
				onSubmit={(event) => {
					event.preventDefault();
					void handleDelete();
				}}
			>
				<MyInput variant="surface">
					<MyInputLabel>Confirmation</MyInputLabel>
					<MyInputArea>
						<MyInputBox />
						<MyInputControl
							type="text"
							value={confirmationText}
							placeholder="delete"
							disabled={isDeleting || isResolvingWorkspaces}
							onChange={(event) => {
								setConfirmationText(event.currentTarget.value);
							}}
						/>
					</MyInputArea>
				</MyInput>
				<MyButton
					type="submit"
					variant="destructive"
					disabled={confirmationText !== "delete" || isDeleting || isResolvingWorkspaces}
				>
					{isDeleting ? "Deleting..." : "Delete account"}
				</MyButton>
			</form>
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
	onNavigateToWorkspaceUsers: MainAppAccountManagementDeleteAccount_Props["onNavigateToWorkspaceUsers"];
};

const MainAppAccountManagementSecurity = memo(function MainAppAccountManagementSecurity(
	props: MainAppAccountManagementSecurity_Props,
) {
	const { isAnonymous, sessions, isLoadingSessions, onRefreshSessions, onDeleteAccount, onNavigateToWorkspaceUsers } =
		props;

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
					<MainAppAccountManagementDeleteAccount
						onDelete={onDeleteAccount}
						onNavigateToWorkspaceUsers={onNavigateToWorkspaceUsers}
					/>
				</div>
			</section>
		</div>
	);
});
// #endregion security

// #region root
type MainAppAccountManagement_ClassNames =
	| "MainAppAccountManagement"
	| "MainAppAccountManagement-header-content"
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

const MainAppAccountManagementContent = memo(function MainAppAccountManagementContent(
	props: MainAppAccountManagement_Props,
) {
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

	const handleDeleteAccount = useFn<MainAppAccountManagementDeleteAccount_Props["onDelete"]>(async () => {
		const result = await app_convex.action(app_convex_api.users.delete_current_user_account, {});
		if (result._nay) {
			console.error("[MainAppAccountManagement.handleDeleteAccount] Failed to delete account:", {
				result,
			});
			toast.error(result._nay.message);
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

	const handleNavigateToWorkspaceUsers = useFn(() => {
		onOpenChange(false);
	});

	return (
		auth.isAnonymous != null && (
			<MyModal open={open} setOpen={onOpenChange}>
				<MyModalPopover className={"MainAppAccountManagement" satisfies MainAppAccountManagement_ClassNames}>
					<MyModalHeader>
						<div className={"MainAppAccountManagement-header-content" satisfies MainAppAccountManagement_ClassNames}>
							<MyModalHeading>Manage account</MyModalHeading>
							<MyModalDescription
								className={"MainAppAccountManagement-header-description" satisfies MainAppAccountManagement_ClassNames}
							>
								Manage your profile, security settings, sessions, and account deletion from the app.
							</MyModalDescription>
						</div>
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
											onNavigateToWorkspaceUsers={handleNavigateToWorkspaceUsers}
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

export const MainAppAccountManagement = memo(function MainAppAccountManagement(props: MainAppAccountManagement_Props) {
	if (!props.open) {
		return null;
	}

	return <MainAppAccountManagementContent {...props} />;
});
// #endregion root
