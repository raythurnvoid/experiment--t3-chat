import "./main-app-account-management.css";

import { CheckoutLink } from "@convex-dev/polar/react";
import { PRODUCTS } from "../../shared/billing_catalog.ts";
import { useClerk, useUser } from "@clerk/clerk-react";
import { useAction, useQuery } from "convex/react";
import { CreditCard, Mail, RefreshCw, Shield, User, UserRound } from "lucide-react";
import { memo, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";

import { AppAuthProvider } from "@/components/app-auth.tsx";
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
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
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
		await onDelete()
			.then((deleted) => {
				if (deleted) {
					setConfirmationText("");
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
	onDeleteAccount: () => Promise<boolean>;
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

// #region billing
type MainAppAccountManagementBilling_ClassNames =
	| "MainAppAccountManagementBilling"
	| "MainAppAccountManagementBilling-header"
	| "MainAppAccountManagementBilling-title"
	| "MainAppAccountManagementBilling-description"
	| "MainAppAccountManagementBilling-description-secondary"
	| "MainAppAccountManagementBilling-body"
	| "MainAppAccountManagementBilling-note"
	| "MainAppAccountManagementBilling-plan"
	| "MainAppAccountManagementBilling-plan-lead"
	| "MainAppAccountManagementBilling-plan-covers"
	| "MainAppAccountManagementBilling-plan-list"
	| "MainAppAccountManagementBilling-plan-list-item"
	| "MainAppAccountManagementBilling-actions"
	| "MainAppAccountManagementBilling-checkout"
	| "MainAppAccountManagementBilling-portal";

type MainAppAccountManagementBilling_Props = {
	isAnonymous: boolean;
};

const MainAppAccountManagementBilling = memo(function MainAppAccountManagementBilling(
	props: MainAppAccountManagementBilling_Props,
) {
	const { isAnonymous } = props;

	const payAsYouGoProduct = useQuery(app_convex_api.billing.getPayAsYouGoProduct, isAnonymous ? "skip" : {});

	const generateCustomerPortalUrl = useAction(app_convex_api.billing.generateCustomerPortalUrl);

	const handleOpenCustomerPortal = useFn(() => {
		void generateCustomerPortalUrl({})
			.then((result) => {
				if (result?.url) {
					window.open(result.url, "_blank", "noopener,noreferrer");
				} else {
					toast.error("Could not open customer portal");
				}
			})
			.catch((error) => {
				toast.error(get_error_message(error));
			});
	});

	const checkoutProductId = payAsYouGoProduct?.setup === "ready" ? payAsYouGoProduct.payAsYouGo.id : undefined;
	const checkoutProductIds = checkoutProductId != null ? [checkoutProductId] : [];

	if (isAnonymous) {
		return (
			<div className={"MainAppAccountManagementBilling" satisfies MainAppAccountManagementBilling_ClassNames}>
				<header
					className={"MainAppAccountManagementBilling-header" satisfies MainAppAccountManagementBilling_ClassNames}
				>
					<h2 className={"MainAppAccountManagementBilling-title" satisfies MainAppAccountManagementBilling_ClassNames}>
						Billing
					</h2>
					<p
						className={
							"MainAppAccountManagementBilling-description" satisfies MainAppAccountManagementBilling_ClassNames
						}
					>
						Sign in with an email account to manage subscriptions and usage-based billing.
					</p>
				</header>
			</div>
		);
	}

	if (payAsYouGoProduct === undefined) {
		return (
			<div className={"MainAppAccountManagementBilling" satisfies MainAppAccountManagementBilling_ClassNames}>
				<div className={"MainAppAccountManagementBilling-note" satisfies MainAppAccountManagementBilling_ClassNames}>
					Loading billing…
				</div>
			</div>
		);
	}

	if (checkoutProductIds.length === 0) {
		const setup = payAsYouGoProduct?.setup;
		const primaryMessage =
			setup === "missing_prefix"
				? "Set POLAR_PRODUCTS_PREFIX in Convex so the app can resolve the pay-as-you-go product name."
				: setup === "duplicate_product_name"
					? "Multiple active Polar products share the expected checkout name. Keep exactly one non-archived product with that name."
					: setup === "product_not_in_catalog"
						? `No matching product found in the synced catalog for name "${payAsYouGoProduct.expectedProductName}". Run pnpm exec convex run internal.billing.sync_products from packages/app after creating the product in Polar.`
						: "Configure billing: set POLAR_PRODUCTS_PREFIX, sync the Polar catalog, and ensure the product name matches the pattern below.";
		return (
			<div className={"MainAppAccountManagementBilling" satisfies MainAppAccountManagementBilling_ClassNames}>
				<header
					className={"MainAppAccountManagementBilling-header" satisfies MainAppAccountManagementBilling_ClassNames}
				>
					<h2 className={"MainAppAccountManagementBilling-title" satisfies MainAppAccountManagementBilling_ClassNames}>
						Billing
					</h2>
					<p
						className={
							"MainAppAccountManagementBilling-description" satisfies MainAppAccountManagementBilling_ClassNames
						}
					>
						{primaryMessage} Expected product name suffix:{" "}
						<code>{PRODUCTS.PAY_AS_YOU_GO}</code> (full name is{" "}
						<code>
							&lt;POLAR_PRODUCTS_PREFIX&gt;-{PRODUCTS.PAY_AS_YOU_GO}
						</code>
						).
					</p>
					{payAsYouGoProduct.warnings.length > 0 ? (
						<p
							className={
								"MainAppAccountManagementBilling-description-secondary" satisfies MainAppAccountManagementBilling_ClassNames
							}
						>
							{payAsYouGoProduct.warnings.join(" ")}
						</p>
					) : (
						<p
							className={
								"MainAppAccountManagementBilling-description-secondary" satisfies MainAppAccountManagementBilling_ClassNames
							}
						>
							Billing products are not configured for this deployment yet. Sync the Polar catalog and confirm the
							checkout product is available before users can subscribe.
						</p>
					)}
				</header>
			</div>
		);
	}

	if (payAsYouGoProduct.setup !== "ready") {
		return null;
	}

	const checkoutProduct = payAsYouGoProduct.payAsYouGo;
	const primaryPrice =
		checkoutProduct?.prices?.find((priceRow) => !priceRow.isArchived) ?? checkoutProduct?.prices?.[0];
	const currencyLabel = (primaryPrice?.priceCurrency ?? "eur").toUpperCase();
	const intervalLabel =
		primaryPrice?.recurringInterval === "month"
			? "monthly"
			: primaryPrice?.recurringInterval === "year"
				? "yearly"
				: primaryPrice?.recurringInterval
					? String(primaryPrice.recurringInterval)
					: "recurring";
	const isMetered = primaryPrice?.amountType === "metered_unit";
	const hasIncludedMeterCredits = checkoutProduct?.benefits?.some((benefit) => benefit.type === "meter_credit");
	const unitAmountRaw = primaryPrice?.unitAmount;
	const unitAmountNumber =
		typeof unitAmountRaw === "string"
			? Number(unitAmountRaw)
			: typeof unitAmountRaw === "number"
				? unitAmountRaw
				: null;
	const formattedUnitPrice =
		unitAmountNumber != null && !Number.isNaN(unitAmountNumber) && primaryPrice?.priceCurrency
			? new Intl.NumberFormat(undefined, {
					style: "currency",
					currency: primaryPrice.priceCurrency.toUpperCase(),
				}).format(unitAmountNumber)
			: null;

	return (
		<div className={"MainAppAccountManagementBilling" satisfies MainAppAccountManagementBilling_ClassNames}>
			<header className={"MainAppAccountManagementBilling-header" satisfies MainAppAccountManagementBilling_ClassNames}>
				<h2 className={"MainAppAccountManagementBilling-title" satisfies MainAppAccountManagementBilling_ClassNames}>
					Billing
				</h2>
				<p className={"MainAppAccountManagementBilling-description" satisfies MainAppAccountManagementBilling_ClassNames}>
					Subscribe to enable {intervalLabel} pay-as-you-go billing in {currencyLabel}. Usage is metered automatically
					as you consume billable units, and you can manage payment methods and invoices from the customer portal.
				</p>
				{payAsYouGoProduct.warnings.length > 0 ? (
					<p
						className={
							"MainAppAccountManagementBilling-description-secondary" satisfies MainAppAccountManagementBilling_ClassNames
						}
					>
						{payAsYouGoProduct.warnings.join(" ")}
					</p>
				) : null}
			</header>
			<div className={"MainAppAccountManagementBilling-plan" satisfies MainAppAccountManagementBilling_ClassNames}>
				<p className={"MainAppAccountManagementBilling-plan-lead" satisfies MainAppAccountManagementBilling_ClassNames}>
					{checkoutProduct?.name ?? "Pay-as-you-go"}
				</p>
				<p
					className={"MainAppAccountManagementBilling-plan-covers" satisfies MainAppAccountManagementBilling_ClassNames}
				>
					{isMetered
						? `Plan includes ${intervalLabel} access, metered usage billing in ${currencyLabel}, and any included credits before paid meter usage applies.`
						: `Plan includes ${intervalLabel} access and usage billing in ${currencyLabel}.`}
				</p>
				<ul className={"MainAppAccountManagementBilling-plan-list" satisfies MainAppAccountManagementBilling_ClassNames}>
					<li
						className={"MainAppAccountManagementBilling-plan-list-item" satisfies MainAppAccountManagementBilling_ClassNames}
					>
						Billed {intervalLabel} in {currencyLabel}
					</li>
					<li
						className={"MainAppAccountManagementBilling-plan-list-item" satisfies MainAppAccountManagementBilling_ClassNames}
					>
						{isMetered
							? formattedUnitPrice
								? `Usage is metered at ${formattedUnitPrice} per billable unit each ${intervalLabel} period`
								: "Usage is charged from billable units recorded on your account"
							: "Pricing follows the product you select at checkout"}
					</li>
					<li
						className={"MainAppAccountManagementBilling-plan-list-item" satisfies MainAppAccountManagementBilling_ClassNames}
					>
						{hasIncludedMeterCredits
							? "Included meter credits apply before paid usage"
							: "Free or promotional credits apply first when your plan includes them"}
					</li>
				</ul>
			</div>
			<div className={"MainAppAccountManagementBilling-body" satisfies MainAppAccountManagementBilling_ClassNames}>
				<div className={"MainAppAccountManagementBilling-actions" satisfies MainAppAccountManagementBilling_ClassNames}>
					<CheckoutLink
						polarApi={app_convex_api.billing}
						productIds={checkoutProductIds}
						embed={false}
						lazy
						className={"MainAppAccountManagementBilling-checkout" satisfies MainAppAccountManagementBilling_ClassNames}
					>
						Checkout
					</CheckoutLink>
					<MyButton
						type="button"
						variant="outline"
						className={"MainAppAccountManagementBilling-portal" satisfies MainAppAccountManagementBilling_ClassNames}
						onClick={handleOpenCustomerPortal}
					>
						Customer portal
					</MyButton>
				</div>
			</div>
		</div>
	);
});
// #endregion billing

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

	const auth = AppAuthProvider.useAuth();
	const clerk = useClerk();
	const { isLoaded, user } = useUser();

	const anagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		auth.isAuthenticated && auth.userId
			? {
					userId: auth.userId as app_convex_Id<"users">,
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

	const handleDeleteAccount = useFn(async () => {
		const result = await app_convex.action(app_convex_api.users.delete_current_user_account, {});
		if (result._nay) {
			toast.error(result._nay.message ?? "Failed to delete account");
			return false;
		}

		toast.success("Account deleted");
		setOpen(false);

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
			<MyModal open={open} setOpen={setOpen}>
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
										<MainAppAccountManagementBilling isAnonymous={auth.isAnonymous} />
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
