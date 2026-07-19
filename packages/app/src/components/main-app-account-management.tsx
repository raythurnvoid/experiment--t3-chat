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
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl, MyInputLabel } from "@/components/my-input.tsx";
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

type MainAppAccountManagementDeleteAccount_BlockingOrganization = app_convex_FunctionReturnType<
	typeof app_convex_api.users.list_current_user_account_deletion_blocking_organizations
>[number];

// #region delete account organization resolver
type MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames =
	| "MainAppAccountManagementDeleteAccountOrganizationResolver"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-header-content"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-body"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-list"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-row"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-row-title"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-row-description"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-row-actions"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-row-action-separator"
	| "MainAppAccountManagementDeleteAccountOrganizationResolver-submit-trigger";

type MainAppAccountManagementDeleteAccountOrganizationResolverRow_Props = {
	blockingOrganization: MainAppAccountManagementDeleteAccount_BlockingOrganization;
	deleteConfirmed: boolean;
	resolving: boolean;
	onNavigateToOrganizationUsers: () => void;
	onDeleteConfirmationChange: (organizationId: app_convex_Id<"organizations">, confirmed: boolean) => void;
};

const MainAppAccountManagementDeleteAccountOrganizationResolverRow = memo(
	function MainAppAccountManagementDeleteAccountOrganizationResolverRow(
		props: MainAppAccountManagementDeleteAccountOrganizationResolverRow_Props,
	) {
		const { blockingOrganization, deleteConfirmed, resolving, onNavigateToOrganizationUsers, onDeleteConfirmationChange } =
			props;
		const organizationDescription = blockingOrganization.organization.description.trim()
			? blockingOrganization.organization.description
			: "(No description)";

		return (
			<li
				className={
					"MainAppAccountManagementDeleteAccountOrganizationResolver-row" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
				}
			>
				<h3
					className={
						"MainAppAccountManagementDeleteAccountOrganizationResolver-row-title" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
					}
				>
					{blockingOrganization.organization.name}
				</h3>
				<p
					className={
						"MainAppAccountManagementDeleteAccountOrganizationResolver-row-description" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
					}
				>
					{organizationDescription}
				</p>
				<div
					className={
						"MainAppAccountManagementDeleteAccountOrganizationResolver-row-actions" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
					}
				>
					<MyLink
						variant="button-outline"
						to="/w/$organizationName/$workspaceName/users"
						params={{
							organizationName: blockingOrganization.organization.name,
							workspaceName: blockingOrganization.defaultWorkspace.name,
						}}
						onClick={onNavigateToOrganizationUsers}
					>
						<MyLinkIcon aria-hidden>
							<UserRoundCog />
						</MyLinkIcon>
						Transfer ownership
					</MyLink>
					<span
						className={
							"MainAppAccountManagementDeleteAccountOrganizationResolver-row-action-separator" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
						}
					>
						or
					</span>
					<MyCheckboxButton
						variant="outline_destructive"
						checked={deleteConfirmed}
						disabled={resolving}
						onCheckedChange={(checked) => onDeleteConfirmationChange(blockingOrganization.organization._id, checked)}
					>
						<MyCheckboxButtonIcon aria-hidden>
							<Trash2 />
						</MyCheckboxButtonIcon>
						Delete organization and data
					</MyCheckboxButton>
				</div>
			</li>
		);
	},
);

type MainAppAccountManagementDeleteAccountOrganizationResolver_Props = {
	blockingOrganizations: MainAppAccountManagementDeleteAccount_BlockingOrganization[];
	deleteConfirmationsByOrganizationId: Record<string, boolean | undefined>;
	resolving: boolean;
	canResolve: boolean;
	onClose: () => void;
	onNavigateToOrganizationUsers: () => void;
	onDeleteConfirmationChange: (organizationId: app_convex_Id<"organizations">, confirmed: boolean) => void;
	onResolveAndDelete: () => void;
};

const MainAppAccountManagementDeleteAccountOrganizationResolver = memo(
	function MainAppAccountManagementDeleteAccountOrganizationResolver(
		props: MainAppAccountManagementDeleteAccountOrganizationResolver_Props,
	) {
		const {
			blockingOrganizations,
			deleteConfirmationsByOrganizationId,
			resolving,
			canResolve,
			onClose,
			onNavigateToOrganizationUsers,
			onDeleteConfirmationChange,
			onResolveAndDelete,
		} = props;
		const resolveDisabledTooltip =
			!canResolve && !resolving
				? "Before you can delete your account, transfer ownership of each organization or confirm deleting the organization."
				: null;
		const resolveButton = (
			<MyButton variant="destructive" disabled={!canResolve || resolving} onClick={onResolveAndDelete}>
				{resolving ? "Resolving..." : "Confirm account deletion"}
			</MyButton>
		);

		return (
			<MyModal open={blockingOrganizations.length > 0} setOpen={(open) => !open && onClose()}>
				<MyModalPopover
					className={
						"MainAppAccountManagementDeleteAccountOrganizationResolver" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
					}
				>
					<MyModalHeader>
						<div
							className={
								"MainAppAccountManagementDeleteAccountOrganizationResolver-header-content" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
							}
						>
							<MyModalHeading>Resolve owned organizations</MyModalHeading>
							<MyModalDescription>
								Transfer ownership from an organization's Users page, or confirm organization deletion here.
							</MyModalDescription>
						</div>
					</MyModalHeader>
					<MyModalScrollableArea
						className={
							"MainAppAccountManagementDeleteAccountOrganizationResolver-body" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
						}
					>
						<ul
							className={
								"MainAppAccountManagementDeleteAccountOrganizationResolver-list" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
							}
						>
							{blockingOrganizations.map((blockingOrganization) => (
								<MainAppAccountManagementDeleteAccountOrganizationResolverRow
									key={blockingOrganization.organization._id}
									blockingOrganization={blockingOrganization}
									deleteConfirmed={deleteConfirmationsByOrganizationId[blockingOrganization.organization._id] === true}
									resolving={resolving}
									onNavigateToOrganizationUsers={onNavigateToOrganizationUsers}
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
											"MainAppAccountManagementDeleteAccountOrganizationResolver-submit-trigger" satisfies MainAppAccountManagementDeleteAccountOrganizationResolver_ClassNames
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
// #endregion delete account organization resolver

// #region delete account
type MainAppAccountManagementDeleteAccount_ClassNames =
	| "MainAppAccountManagementDeleteAccount"
	| "MainAppAccountManagementDeleteAccount-text"
	| "MainAppAccountManagementDeleteAccount-title"
	| "MainAppAccountManagementDeleteAccount-description"
	| "MainAppAccountManagementDeleteAccount-form";

type MainAppAccountManagementDeleteAccount_Props = {
	onDelete: () => Promise<boolean>;
	onNavigateToOrganizationUsers: () => void;
};

const MainAppAccountManagementDeleteAccount = memo(function MainAppAccountManagementDeleteAccount(
	props: MainAppAccountManagementDeleteAccount_Props,
) {
	const { onDelete, onNavigateToOrganizationUsers } = props;

	const [confirmationText, setConfirmationText] = useState("");
	const [isDeleting, setIsDeleting] = useState(false);
	const [blockingOrganizations, setBlockingOrganizations] = useState<
		MainAppAccountManagementDeleteAccount_BlockingOrganization[] | null
	>(null);
	const [deleteConfirmationsByOrganizationId, setDeleteConfirmationsByOrganizationId] = useState<
		Record<string, boolean | undefined>
	>({});
	const [isResolvingOrganizations, setIsResolvingOrganizations] = useState(false);

	const canResolveBlockingOrganizations =
		blockingOrganizations !== null &&
		blockingOrganizations.length > 0 &&
		blockingOrganizations.every((blockingOrganization) => {
			return deleteConfirmationsByOrganizationId[blockingOrganization.organization._id] === true;
		});

	const handleDelete = useFn(async () => {
		if (confirmationText !== "delete") {
			return;
		}

		setIsDeleting(true);
		await app_convex
			.query(app_convex_api.users.list_current_user_account_deletion_blocking_organizations, {})
			.then(async (nextBlockingOrganizations) => {
				if (nextBlockingOrganizations.length > 0) {
					setBlockingOrganizations(nextBlockingOrganizations);
					setDeleteConfirmationsByOrganizationId({});
					return;
				}

				setBlockingOrganizations([]);
				const deleted = await onDelete();
				if (deleted) {
					setConfirmationText("");
					setBlockingOrganizations(null);
					return;
				}

				const blockingOrganizationsAfterDeleteFailure = await app_convex.query(
					app_convex_api.users.list_current_user_account_deletion_blocking_organizations,
					{},
				);
				if (blockingOrganizationsAfterDeleteFailure.length > 0) {
					setBlockingOrganizations(blockingOrganizationsAfterDeleteFailure);
					setDeleteConfirmationsByOrganizationId({});
				}
			})
			.catch((error) => {
				setBlockingOrganizations(null);
				console.error("[MainAppAccountManagementDeleteAccount.handleDelete] Failed to prepare account deletion", {
					error,
				});
				toast.error("Failed to delete account");
			})
			.finally(() => {
				setIsDeleting(false);
			});
	});

	const handleCloseOrganizationResolver = useFn(() => {
		if (isResolvingOrganizations) {
			return;
		}

		setBlockingOrganizations(null);
		setDeleteConfirmationsByOrganizationId({});
	});

	const handleOrganizationDeleteConfirmationChange = useFn(
		(organizationId: app_convex_Id<"organizations">, confirmed: boolean) => {
			setDeleteConfirmationsByOrganizationId((current) => ({
				...current,
				[organizationId]: confirmed,
			}));
		},
	);

	const handleResolveOrganizationsAndDelete = useFn(async () => {
		if (!blockingOrganizations || !canResolveBlockingOrganizations) {
			return;
		}

		setIsResolvingOrganizations(true);
		await (async () => {
			for (const blockingOrganization of blockingOrganizations) {
				if (deleteConfirmationsByOrganizationId[blockingOrganization.organization._id] !== true) {
					return;
				}

				const deleteResult = await app_convex.mutation(app_convex_api.organizations.delete_organization, {
					organizationId: blockingOrganization.organization._id,
				});
				if (deleteResult._nay) {
					console.error(
						"[MainAppAccountManagementDeleteAccount.handleResolveOrganizationsAndDelete] Failed to delete organization",
						{
							result: deleteResult,
							organizationId: blockingOrganization.organization._id,
						},
					);
					toast.error(deleteResult._nay.message);
					return;
				}
			}

			const refreshedBlockingOrganizations = await app_convex.query(
				app_convex_api.users.list_current_user_account_deletion_blocking_organizations,
				{},
			);
			if (refreshedBlockingOrganizations.length > 0) {
				setBlockingOrganizations(refreshedBlockingOrganizations);
				setDeleteConfirmationsByOrganizationId({});
				toast.error("Resolve owned organizations before deleting account");
				return;
			}

			const deleted = await onDelete();
			if (deleted) {
				setConfirmationText("");
				setBlockingOrganizations(null);
				setDeleteConfirmationsByOrganizationId({});
				return;
			}

			const blockingOrganizationsAfterDeleteFailure = await app_convex.query(
				app_convex_api.users.list_current_user_account_deletion_blocking_organizations,
				{},
			);
			if (blockingOrganizationsAfterDeleteFailure.length > 0) {
				setBlockingOrganizations(blockingOrganizationsAfterDeleteFailure);
				setDeleteConfirmationsByOrganizationId({});
				return;
			}

			setBlockingOrganizations(null);
			setDeleteConfirmationsByOrganizationId({});
		})()
			.catch((error) => {
				console.error(
					"[MainAppAccountManagementDeleteAccount.handleResolveOrganizationsAndDelete] Failed to resolve owned organizations",
					{
						error,
					},
				);
				toast.error("Failed to resolve owned organizations");
			})
			.finally(() => {
				setIsResolvingOrganizations(false);
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
			{blockingOrganizations && blockingOrganizations.length > 0 ? (
				<MainAppAccountManagementDeleteAccountOrganizationResolver
					blockingOrganizations={blockingOrganizations}
					deleteConfirmationsByOrganizationId={deleteConfirmationsByOrganizationId}
					resolving={isResolvingOrganizations}
					canResolve={canResolveBlockingOrganizations}
					onClose={handleCloseOrganizationResolver}
					onNavigateToOrganizationUsers={onNavigateToOrganizationUsers}
					onDeleteConfirmationChange={handleOrganizationDeleteConfirmationChange}
					onResolveAndDelete={() => void handleResolveOrganizationsAndDelete()}
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
				<MyInput layout="stacked">
					<MyInputLabel>Confirmation</MyInputLabel>
					<MyInputBackground />
					<MyInputArea>
						<MyInputControl
							type="text"
							value={confirmationText}
							placeholder="delete"
							disabled={isDeleting || isResolvingOrganizations}
							onChange={(event) => {
								setConfirmationText(event.currentTarget.value);
							}}
						/>
					</MyInputArea>
					<MyInputBox />
				</MyInput>
				<MyButton
					type="submit"
					variant="destructive"
					disabled={confirmationText !== "delete" || isDeleting || isResolvingOrganizations}
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
	onNavigateToOrganizationUsers: MainAppAccountManagementDeleteAccount_Props["onNavigateToOrganizationUsers"];
};

const MainAppAccountManagementSecurity = memo(function MainAppAccountManagementSecurity(
	props: MainAppAccountManagementSecurity_Props,
) {
	const { isAnonymous, sessions, isLoadingSessions, onRefreshSessions, onDeleteAccount, onNavigateToOrganizationUsers } =
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
						onNavigateToOrganizationUsers={onNavigateToOrganizationUsers}
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

	const handleNavigateToOrganizationUsers = useFn(() => {
		onOpenChange(false);
	});

	return (
		auth.isAnonymous != null && (
			<MyModal open={open} setOpen={onOpenChange}>
				<MyModalPopover className={"MainAppAccountManagement" satisfies MainAppAccountManagement_ClassNames}>
					<MyModalHeader>
						<div className={"MainAppAccountManagement-header-content" satisfies MainAppAccountManagement_ClassNames}>
							<MyModalHeading>Manage account</MyModalHeading>
							<MyModalDescription>
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
											onNavigateToOrganizationUsers={handleNavigateToOrganizationUsers}
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
