import "./main-app-account-management.css";

import { useClerk, useUser } from "@clerk/clerk-react";
import { Mail, RefreshCw, Shield, UserRound } from "lucide-react";
import { memo, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";

import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
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
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab, MyTabsTabSurface } from "@/components/my-tabs.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
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

// #region delete account
type MainAppAccountManagementDeleteAccount_ClassNames =
	| "MainAppAccountManagementDeleteAccount"
	| "MainAppAccountManagementDeleteAccount-copy"
	| "MainAppAccountManagementDeleteAccount-title"
	| "MainAppAccountManagementDeleteAccount-description"
	| "MainAppAccountManagementDeleteAccount-form";

type MainAppAccountManagementDeleteAccount_Props = {
	onDelete: () => Promise<boolean>;
};

const MainAppAccountManagementDeleteAccount = memo(function MainAppAccountManagementDeleteAccount(
	props: MainAppAccountManagementDeleteAccount_Props,
) {
	const { onDelete } = props;

	const [confirmationText, setConfirmationText] = useState("");
	const [isDeleting, setIsDeleting] = useState(false);

	const handleDelete = useFn(async () => {
		if (confirmationText !== "DELETE") {
			return;
		}

		setIsDeleting(true);
		try {
			const deleted = await onDelete();
			if (deleted) {
				setConfirmationText("");
			}
		} finally {
			setIsDeleting(false);
		}
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
					This permanently deletes your app account, clears memberships, and queues orphan workspace cleanup. Type{" "}
					<code>DELETE</code> to confirm.
				</p>
			</div>
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
				<MyButton variant="destructive" disabled={confirmationText !== "DELETE" || isDeleting} onClick={handleDelete}>
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
	| "MainAppAccountManagementProfile-summary-title"
	| "MainAppAccountManagementProfile-summary-email"
	| "MainAppAccountManagementProfile-connected-list"
	| "MainAppAccountManagementProfile-connected-title"
	| "MainAppAccountManagementProfile-connected-meta";

type MainAppAccountManagementProfile_Props = {
	user: NonNullable<ReturnType<typeof useUser>["user"]>;
	displayName: string;
	avatarUrl?: string;
};

const MainAppAccountManagementProfile = memo(function MainAppAccountManagementProfile(
	props: MainAppAccountManagementProfile_Props,
) {
	const { user, displayName, avatarUrl } = props;

	const connection_type = user.externalAccounts[0]?.providerTitle() ?? "Google";

	return (
		<section className={"MainAppAccountManagementProfile" satisfies MainAppAccountManagementProfile_ClassNames}>
			<header
				className={"MainAppAccountManagementProfile-header" satisfies MainAppAccountManagementProfile_ClassNames}
			>
				<div>
					<h2
						className={
							"MainAppAccountManagementProfile-title" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
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
			<div
				className={"MainAppAccountManagementProfile-body" satisfies MainAppAccountManagementProfile_ClassNames}
			>
				<div
					className={
						"MainAppAccountManagementProfile-summary" satisfies MainAppAccountManagementProfile_ClassNames
					}
				>
					<MyAvatar
						size="56px"
						className={
							"MainAppAccountManagementProfile-summary-avatar" satisfies MainAppAccountManagementProfile_ClassNames
						}
					>
						<MyAvatarImage src={avatarUrl} alt={displayName} />
						<MyAvatarFallback>{compute_fallback_user_name(displayName)}</MyAvatarFallback>
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
						{user.primaryEmailAddress?.emailAddress ?? "No primary email"}
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
						{user.primaryEmailAddress?.emailAddress ?? "No primary email"}
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
						{connection_type}
					</dd>
				</dl>
			</div>
		</section>
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
	sessions: Array<Awaited<ReturnType<NonNullable<ReturnType<typeof useUser>["user"]>["getSessions"]>>[number]>;
	isLoadingSessions: boolean;
	onRefreshSessions: () => Promise<void>;
	onDeleteAccount: () => Promise<boolean>;
};

const MainAppAccountManagementSecurity = memo(function MainAppAccountManagementSecurity(
	props: MainAppAccountManagementSecurity_Props,
) {
	const { sessions, isLoadingSessions, onRefreshSessions, onDeleteAccount } = props;

	const [busySessionId, setBusySessionId] = useState<string | null>(null);

	const handleRevokeSession = useFn(
		async (session: Awaited<ReturnType<NonNullable<ReturnType<typeof useUser>["user"]>["getSessions"]>>[number]) => {
			setBusySessionId(session.id);
			try {
				await session.revoke();
				await onRefreshSessions();
				toast.success("Session revoked");
			} catch (error) {
				toast.error(get_error_message(error));
			} finally {
				setBusySessionId(null);
			}
		},
	);

	return (
		<section className={"MainAppAccountManagementSecurity" satisfies MainAppAccountManagementSecurity_ClassNames}>
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
				</header>
				<div
					className={
						"MainAppAccountManagementSecurity-panel-body" satisfies MainAppAccountManagementSecurity_ClassNames
					}
				>
					{sessions.map((session) => (
						<div
							key={session.id}
							className={"MainAppAccountManagementSecurity-row" satisfies MainAppAccountManagementSecurity_ClassNames}
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
					))}
					{!sessions.length && !isLoadingSessions ? (
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
		</section>
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
	setOpen: Dispatch<SetStateAction<boolean>>;
};

export const MainAppAccountManagement = memo(function MainAppAccountManagement(props: MainAppAccountManagement_Props) {
	const { open, setOpen } = props;

	const clerk = useClerk();
	const { isLoaded, user } = useUser();

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
		try {
			const nextSessions = await user.getSessions();
			setSessions(nextSessions);
		} catch (error) {
			console.error("[MainAppAccountManagement.handleRefreshSessions] Failed to load sessions", { error });
			toast.error(get_error_message(error));
		} finally {
			setIsLoadingSessions(false);
		}
	});

	const handleDeleteAccount = useFn(async () => {
		const result = await app_convex.action(app_convex_api.users.delete_current_user_account, {});
		if (result._nay) {
			toast.error(result._nay.message ?? "Failed to delete account");
			return false;
		}

		toast.success("Account deleted");
		setOpen(false);
		await clerk.signOut().catch((error) => {
			console.error("[MainAppAccountManagement.handleDeleteAccount] Clerk signOut failed", { error });
		});
		return true;
	});

	useEffect(() => {
		if (!open || !user) {
			setSessions([]);
			return;
		}

		void handleRefreshSessions();
	}, [handleRefreshSessions, open, user]);

	const displayName = user ? get_display_name(user) : "Account";
	const avatarUrl = user?.imageUrl ?? undefined;

	return (
		<MyModal open={open} setOpen={setOpen}>
			<MyModalPopover className={"MainAppAccountManagement" satisfies MainAppAccountManagement_ClassNames}>
				<MyModalHeader className={"MainAppAccountManagement-header-copy" satisfies MainAppAccountManagement_ClassNames}>
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
					{!isLoaded || !user ? (
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
									<MainAppAccountManagementProfile user={user} displayName={displayName} avatarUrl={avatarUrl} />
								</MyTabsPanel>
								<MyTabsPanel
									tabId="security"
									className={"MainAppAccountManagement-panel" satisfies MainAppAccountManagement_ClassNames}
								>
									<MainAppAccountManagementSecurity
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
	);
});
// #endregion root
