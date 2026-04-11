import "./main-app-account-management.css";

import { CheckoutLink } from "@convex-dev/polar/react";
import {
	BILLING_PRODUCTS,
	PRODUCTS,
	billing_product_benefit_matches_polar_description,
	billing_product_matches_polar_name,
} from "../../shared/billing.ts";
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
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { users_create_anonymouse_user_display_name } from "../../shared/users.ts";
import { format_relative_time } from "@/lib/date.ts";
import { compute_fallback_user_name } from "@/lib/utils.ts";

type MainAppAccountManagementBillingProductRow =
	app_convex_FunctionReturnType<typeof app_convex_api.billing.list_products>[number];

type MainAppAccountManagementBillingSubscriptionRow =
	app_convex_FunctionReturnType<typeof app_convex_api.billing.list_subscriptions>[number];

type MainAppAccountManagementBillingUsageSnapshot =
	app_convex_FunctionReturnType<typeof app_convex_api.billing.get_usage_snapshot>;

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

function main_app_account_management_billing_interval_label(interval: string | null) {
	if (interval === "month") {
		return "monthly";
	}
	if (interval === "year") {
		return "yearly";
	}
	return interval ? String(interval) : "recurring";
}

function main_app_account_management_billing_format_iso_date(iso: string) {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) {
		return iso;
	}
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(ms);
}

function main_app_account_management_billing_format_minor_currency(amountCents: number, currency: string) {
	const code = currency.trim().toUpperCase();
	if (!code) {
		return String(amountCents / 100);
	}
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: code,
	}).format(amountCents / 100);
}

function main_app_account_management_billing_format_major_currency(amountMajor: number, currency: string) {
	const code = currency.trim().toUpperCase();
	if (!code) {
		return String(amountMajor);
	}
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: code,
	}).format(amountMajor);
}

function main_app_account_management_billing_included_usage_line(args: {
	hasIncludedMeterCredits: boolean;
	includedUsage:
		| (typeof BILLING_PRODUCTS)[keyof typeof BILLING_PRODUCTS]["benefits"][keyof (typeof BILLING_PRODUCTS)[keyof typeof BILLING_PRODUCTS]["benefits"]]["includedUsage"]
		| null
		| undefined;
}) {
	const { hasIncludedMeterCredits, includedUsage } = args;
	if (hasIncludedMeterCredits && includedUsage) {
		return `Included usage: ${main_app_account_management_billing_format_major_currency(includedUsage.amount, includedUsage.currency)}`;
	}
	if (hasIncludedMeterCredits) {
		return "Includes meter credits before paid usage applies";
	}
	return "No included credits are configured on this plan";
}

function main_app_account_management_billing_select_active_subscription(
	subscriptions: MainAppAccountManagementBillingSubscriptionRow[],
) {
	return subscriptions.find((subscription) => {
		return (subscription.status === "active" || subscription.status === "trialing") && !subscription.endedAt;
	});
}

function main_app_account_management_billing_subscription_status_label(
	subscription: MainAppAccountManagementBillingSubscriptionRow,
) {
	if (subscription.status === "trialing") {
		return "In trial";
	}
	if (subscription.cancelAtPeriodEnd) {
		return "Cancels on renewal";
	}
	return "Active";
}

function main_app_account_management_billing_subscription_renewal_line(
	subscription: MainAppAccountManagementBillingSubscriptionRow,
) {
	if (!subscription.currentPeriodEnd) {
		return null;
	}
	const periodEnd = main_app_account_management_billing_format_iso_date(subscription.currentPeriodEnd);
	if (subscription.status === "trialing") {
		return `Trial ends on ${periodEnd}`;
	}
	if (subscription.cancelAtPeriodEnd) {
		return `Cancels on ${periodEnd}`;
	}
	return `Renews on ${periodEnd}`;
}

function main_app_account_management_billing_benefit_descriptions(
	product: (typeof BILLING_PRODUCTS)[keyof typeof BILLING_PRODUCTS],
	benefits: MainAppAccountManagementBillingProductRow["benefits"] | null | undefined,
) {
	return (benefits ?? [])
		.map((benefit) => {
			const matchingBenefit = Object.values(product.benefits).find((productBenefit) => {
				return billing_product_benefit_matches_polar_description(benefit.description, productBenefit);
			});
			return matchingBenefit?.displayDescription.trim() ?? null;
		})
		.filter((description): description is string => description != null);
}

function main_app_account_management_billing_find_benefit(
	product: (typeof BILLING_PRODUCTS)[keyof typeof BILLING_PRODUCTS],
	benefits: MainAppAccountManagementBillingProductRow["benefits"] | null | undefined,
	benefit: (typeof BILLING_PRODUCTS)[keyof typeof BILLING_PRODUCTS]["benefits"][keyof (typeof BILLING_PRODUCTS)[keyof typeof BILLING_PRODUCTS]["benefits"]],
) {
	return (benefits ?? []).find((productBenefit) => {
		return billing_product_benefit_matches_polar_description(productBenefit.description, benefit);
	});
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

// #region billing active plan skeleton
type MainAppAccountManagementBillingActivePlanSkeleton_ClassNames =
	| "MainAppAccountManagementBillingActivePlanSkeleton"
	| "MainAppAccountManagementBillingActivePlanSkeleton-badge"
	| "MainAppAccountManagementBillingActivePlanSkeleton-title"
	| "MainAppAccountManagementBillingActivePlanSkeleton-usage"
	| "MainAppAccountManagementBillingActivePlanSkeleton-renewal"
	| "MainAppAccountManagementBillingActivePlanSkeleton-started"
	| "MainAppAccountManagementBillingActivePlanSkeleton-details"
	| "MainAppAccountManagementBillingActivePlanSkeleton-covers"
	| "MainAppAccountManagementBillingActivePlanSkeleton-list"
	| "MainAppAccountManagementBillingActivePlanSkeleton-list-item";

const MainAppAccountManagementBillingActivePlanSkeleton = memo(
	function MainAppAccountManagementBillingActivePlanSkeleton() {
		return (
			<div
				className={
					"MainAppAccountManagementBillingActivePlanSkeleton" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
				}
				aria-busy="true"
				aria-label="Loading active plan"
			>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-badge" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-title" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-usage" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-renewal" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-started" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				/>
				<div
					className={
						"MainAppAccountManagementBillingActivePlanSkeleton-details" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
					}
					aria-hidden
				>
					<div
						className={
							"MainAppAccountManagementBillingActivePlanSkeleton-covers" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
						}
					/>
					<ul
						className={
							"MainAppAccountManagementBillingActivePlanSkeleton-list" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
						}
					>
						<li
							className={
								"MainAppAccountManagementBillingActivePlanSkeleton-list-item" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
							}
						/>
						<li
							className={
								"MainAppAccountManagementBillingActivePlanSkeleton-list-item" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
							}
						/>
						<li
							className={
								"MainAppAccountManagementBillingActivePlanSkeleton-list-item" satisfies MainAppAccountManagementBillingActivePlanSkeleton_ClassNames
							}
						/>
					</ul>
				</div>
			</div>
		);
	},
);
// #endregion billing active plan skeleton

// #region billing active plan
type MainAppAccountManagementBillingActivePlanUsage_ClassNames =
	| "MainAppAccountManagementBillingActivePlanUsage"
	| "MainAppAccountManagementBillingActivePlanUsage-line"
	| "MainAppAccountManagementBillingActivePlanUsage-sep"
	| "MainAppAccountManagementBillingActivePlanUsage-label"
	| "MainAppAccountManagementBillingActivePlanUsage-value"
	| "MainAppAccountManagementBillingActivePlanUsage-meta";

type MainAppAccountManagementBillingActivePlanUsage_MeteredLine =
	| { kind: "loading" }
	| {
			kind: "ready";
			due: string;
			creditsLeft: string;
	  };

type MainAppAccountManagementBillingActivePlanUsage_Props = {
	meteredLine: MainAppAccountManagementBillingActivePlanUsage_MeteredLine | null;
};

const MainAppAccountManagementBillingActivePlanUsage = memo(function MainAppAccountManagementBillingActivePlanUsage(
	props: MainAppAccountManagementBillingActivePlanUsage_Props,
) {
	const { meteredLine } = props;

	if (!meteredLine) {
		return null;
	}

	if (meteredLine.kind === "loading") {
		return (
			<div
				className={
					"MainAppAccountManagementBillingActivePlanUsage" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
				}
			>
				<p
					className={
						"MainAppAccountManagementBillingActivePlanUsage-meta" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					Syncing usage…
				</p>
			</div>
		);
	}

	return (
		<div
			className={
				"MainAppAccountManagementBillingActivePlanUsage" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
			}
		>
			<p
				className={
					"MainAppAccountManagementBillingActivePlanUsage-line" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
				}
			>
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-label" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					Due
				</span>{" "}
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-value" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					{meteredLine.due}
				</span>
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-sep" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					{" "}
					·{" "}
				</span>
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-label" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					Remaining credits
				</span>{" "}
				<span
					className={
						"MainAppAccountManagementBillingActivePlanUsage-value" satisfies MainAppAccountManagementBillingActivePlanUsage_ClassNames
					}
				>
					{meteredLine.creditsLeft}
				</span>
			</p>
		</div>
	);
});

type MainAppAccountManagementBillingActivePlan_ClassNames =
	| "MainAppAccountManagementBillingActivePlan"
	| "MainAppAccountManagementBillingActivePlan-badge"
	| "MainAppAccountManagementBillingActivePlan-title"
	| "MainAppAccountManagementBillingActivePlan-renewal"
	| "MainAppAccountManagementBillingActivePlan-started"
	| "MainAppAccountManagementBillingActivePlan-details"
	| "MainAppAccountManagementBillingActivePlan-covers"
	| "MainAppAccountManagementBillingActivePlan-list"
	| "MainAppAccountManagementBillingActivePlan-list-item";

type MainAppAccountManagementBillingActivePlan_Subscription = MainAppAccountManagementBillingSubscriptionRow;

type MainAppAccountManagementBillingActivePlan_Props = {
	catalog: MainAppAccountManagementBillingProductRow;
	subscription: MainAppAccountManagementBillingActivePlan_Subscription;
	usage: MainAppAccountManagementBillingUsageSnapshot;
};

const MainAppAccountManagementBillingActivePlan = memo(function MainAppAccountManagementBillingActivePlan(
	props: MainAppAccountManagementBillingActivePlan_Props,
) {
	const { catalog, subscription, usage } = props;
	const billingProduct = BILLING_PRODUCTS["Pay As You Go"];
	const primaryPrice = catalog.prices?.find((priceRow) => !priceRow.isArchived) ?? catalog.prices?.[0];
	const benefitDescriptions = main_app_account_management_billing_benefit_descriptions(billingProduct, catalog.benefits);
	const intervalLabel = main_app_account_management_billing_interval_label(
		primaryPrice?.recurringInterval ?? catalog.recurringInterval ?? null,
	);
	const isMetered = primaryPrice?.amountType === "metered_unit";
	const meterName = primaryPrice?.meter?.name ?? null;
	const freeUsageBenefit = main_app_account_management_billing_find_benefit(
		billingProduct,
		catalog.benefits,
		billingProduct.benefits["Free usage"],
	);
	const includedUsage = freeUsageBenefit ? billingProduct.benefits["Free usage"].includedUsage : null;
	const freeUsageBenefitDescription = billingProduct.benefits["Free usage"].displayDescription;
	const includedUsageValue = includedUsage
		? main_app_account_management_billing_format_major_currency(includedUsage.amount, includedUsage.currency)
		: null;
	const benefitDescriptionsLine = benefitDescriptions
		.map((description) => {
			if (description === freeUsageBenefitDescription && includedUsageValue) {
				return `${description} ${includedUsageValue}`;
			}

			return description;
		})
		.join(" · ");
	const unitPriceAmount =
		billingProduct.meter.unitPrice?.amount ??
		(primaryPrice?.unitAmount === undefined || primaryPrice?.unitAmount === null
			? null
			: typeof primaryPrice.unitAmount === "number"
				? primaryPrice.unitAmount
				: Number(primaryPrice.unitAmount));

	const subscriptionRenewalLine = main_app_account_management_billing_subscription_renewal_line(subscription);
	const subscriptionStartedLine = subscription.startedAt
		? `Started ${main_app_account_management_billing_format_iso_date(subscription.startedAt)}`
		: null;
	const showStandaloneIncludedUsageValue =
		includedUsageValue != null && !benefitDescriptions.includes(freeUsageBenefitDescription);

	const showMeteredSummaryInActivePlan = isMetered;

	const meteredDueAndCreditsLine =
		showMeteredSummaryInActivePlan
			? usage?.meter == null || usage.subscription == null
				? { kind: "loading" as const }
				: {
						kind: "ready" as const,
						due: main_app_account_management_billing_format_minor_currency(
							usage.meter.amountDueCents,
							usage.subscription.currency,
						),
						creditsLeft:
							unitPriceAmount != null
								? main_app_account_management_billing_format_major_currency(
										Math.max(0, usage.meter.balance) * unitPriceAmount,
										usage.subscription.currency,
									)
								: `${usage.meter.balance} units`,
					}
			: null;

	return (
		<div
			className={
				"MainAppAccountManagementBillingActivePlan" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
			}
		>
			<div
				className={
					"MainAppAccountManagementBillingActivePlan-badge" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
				}
			>
				Active plan
			</div>
			<div
				className={
					"MainAppAccountManagementBillingActivePlan-title" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
				}
			>
				{billingProduct.displayName}
			</div>
			<MainAppAccountManagementBillingActivePlanUsage meteredLine={meteredDueAndCreditsLine} />
			{subscriptionRenewalLine ? (
				<p
					className={
						"MainAppAccountManagementBillingActivePlan-renewal" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
					}
				>
					{subscriptionRenewalLine}
				</p>
			) : null}
			{subscriptionStartedLine ? (
				<p
					className={
						"MainAppAccountManagementBillingActivePlan-started" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
					}
				>
					{subscriptionStartedLine}
				</p>
			) : null}
			<div
				className={
					"MainAppAccountManagementBillingActivePlan-details" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
				}
			>
				<ul
					className={
						"MainAppAccountManagementBillingActivePlan-list" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
					}
				>
					{benefitDescriptions.length ? (
						<li
							className={
								"MainAppAccountManagementBillingActivePlan-list-item" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
							}
						>
							{benefitDescriptionsLine}
						</li>
					) : null}
					<li
						className={
							"MainAppAccountManagementBillingActivePlan-list-item" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
						}
					>
						Billed {intervalLabel}
						{meterName ? ` · ${meterName}` : ""}
					</li>
					{showStandaloneIncludedUsageValue ? (
						<li
							className={
								"MainAppAccountManagementBillingActivePlan-list-item" satisfies MainAppAccountManagementBillingActivePlan_ClassNames
							}
						>
							{includedUsageValue}
						</li>
					) : null}
				</ul>
			</div>
		</div>
	);
});
// #endregion billing active plan

// #region billing
// Keep CheckoutLink's camelCase prop while the Convex export stays snake_case.
const main_app_account_management_billing_checkout_api = {
	generateCheckoutLink: app_convex_api.billing.generate_checkout_link,
};

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
	| "MainAppAccountManagementBilling-manage-subscription"
	| "MainAppAccountManagementBilling-warning";

type MainAppAccountManagementBilling_Props = {
	isAnonymous: boolean;
};

const MainAppAccountManagementBilling = memo(function MainAppAccountManagementBilling(
	props: MainAppAccountManagementBilling_Props,
) {
	const { isAnonymous } = props;

	const billingProducts = useQuery(app_convex_api.billing.list_products, isAnonymous ? "skip" : {});
	const billingSubscriptions = useQuery(app_convex_api.billing.list_subscriptions, isAnonymous ? "skip" : {});
	const billingUsage = useQuery(app_convex_api.billing.get_usage_snapshot, isAnonymous ? "skip" : {});

	const generateCustomerPortalUrl = useAction(app_convex_api.billing.generate_customer_portal_url);

	const handleManageSubscription = useFn(() => {
		void generateCustomerPortalUrl({})
			.then((result) => {
				if (result?.url) {
					window.open(result.url, "_blank", "noopener,noreferrer");
				} else {
					toast.error("Could not open subscription management");
				}
			})
			.catch((error) => {
				toast.error(get_error_message(error));
			});
	});

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
						Sign in to manage your plan, billing, and invoices.
					</p>
				</header>
			</div>
		);
	}

	if (billingProducts === undefined || billingSubscriptions === undefined || billingUsage === undefined) {
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
						Loading your billing details…
					</p>
				</header>
				<MainAppAccountManagementBillingActivePlanSkeleton />
			</div>
		);
	}

	const activeSubscription = main_app_account_management_billing_select_active_subscription(billingSubscriptions) ?? null;
	const billingProduct = BILLING_PRODUCTS["Pay As You Go"];
	const checkoutProductId =
		activeSubscription == null
			? (billingProducts.find((product) => billing_product_matches_polar_name(product.name, billingProduct) && !product.isArchived)?.id ??
				undefined)
			: undefined;
	const checkoutProductIds = checkoutProductId != null && activeSubscription == null ? [checkoutProductId] : [];
	const activeProduct = activeSubscription ? (billingProducts.find((product) => product.id === activeSubscription.productId) ?? null) : null;
	const paygProduct =
		billingProducts.find((product) => billing_product_matches_polar_name(product.name, billingProduct) && !product.isArchived) ?? null;
	const checkoutProduct = activeSubscription ? activeProduct : paygProduct;
	const catalogReady = checkoutProduct !== null;
	const checkoutReady = catalogReady && checkoutProductIds.length > 0;

	if (!checkoutProduct) {
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
						Billing isn’t ready yet. Expected product name <code>{PRODUCTS.PAY_AS_YOU_GO}</code>.
					</p>
					<p
						className={
							"MainAppAccountManagementBilling-description-secondary" satisfies MainAppAccountManagementBilling_ClassNames
						}
					>
						Create the pay-as-you-go product in Polar, then sync the catalog so Convex can see it.
					</p>
				</header>
			</div>
		);
	}

	const subscription = activeSubscription;
	const usage: MainAppAccountManagementBillingUsageSnapshot = billingUsage;
	const primaryPrice =
		checkoutProduct?.prices?.find((priceRow) => !priceRow.isArchived) ?? checkoutProduct?.prices?.[0];
	const benefitDescriptions = main_app_account_management_billing_benefit_descriptions(billingProduct, checkoutProduct.benefits);
	const intervalLabel = main_app_account_management_billing_interval_label(
		primaryPrice?.recurringInterval ?? checkoutProduct?.recurringInterval ?? null,
	);
	const meterName = primaryPrice?.meter?.name ?? null;
	const freeUsageBenefit = main_app_account_management_billing_find_benefit(
		billingProduct,
		checkoutProduct.benefits,
		billingProduct.benefits["Free usage"],
	);
	const hasIncludedMeterCredits = freeUsageBenefit != null;
	const includedUsage = freeUsageBenefit ? billingProduct.benefits["Free usage"].includedUsage : null;

	const subscriptionStatusBadge =
		subscription != null ? main_app_account_management_billing_subscription_status_label(subscription) : null;

	const headerDescription = ((/* iife */) => {
		if (subscription != null) {
			return "Your subscription is active. Check the plan information below or click Manage subscription to review the details.";
		}
		return "Read the information about the available plan below and click Checkout to proceed with your subscription.";
	})();

	const showActivePlanCard = subscription != null && subscriptionStatusBadge != null;

	return (
		<div className={"MainAppAccountManagementBilling" satisfies MainAppAccountManagementBilling_ClassNames}>
			<header className={"MainAppAccountManagementBilling-header" satisfies MainAppAccountManagementBilling_ClassNames}>
				<h2 className={"MainAppAccountManagementBilling-title" satisfies MainAppAccountManagementBilling_ClassNames}>
					Billing
				</h2>
				<p
					className={"MainAppAccountManagementBilling-description" satisfies MainAppAccountManagementBilling_ClassNames}
				>
					{headerDescription}
				</p>
			</header>
			{showActivePlanCard ? (
				<MainAppAccountManagementBillingActivePlan
					catalog={checkoutProduct}
					subscription={subscription}
					usage={usage}
				/>
			) : null}
			{!showActivePlanCard ? (
				<div className={"MainAppAccountManagementBilling-plan" satisfies MainAppAccountManagementBilling_ClassNames}>
					<p className={"MainAppAccountManagementBilling-plan-lead" satisfies MainAppAccountManagementBilling_ClassNames}>
						{billingProduct.displayName}
					</p>
					{benefitDescriptions.length ? (
						<p
							className={
								"MainAppAccountManagementBilling-description-secondary" satisfies MainAppAccountManagementBilling_ClassNames
							}
						>
							{benefitDescriptions.join(" · ")}
						</p>
					) : null}
					<ul
						className={"MainAppAccountManagementBilling-plan-list" satisfies MainAppAccountManagementBilling_ClassNames}
					>
						<li
							className={
								"MainAppAccountManagementBilling-plan-list-item" satisfies MainAppAccountManagementBilling_ClassNames
							}
						>
							Billed {intervalLabel}
						</li>
						{meterName ? (
							<li
								className={
									"MainAppAccountManagementBilling-plan-list-item" satisfies MainAppAccountManagementBilling_ClassNames
								}
							>
								Meter: {meterName}
							</li>
						) : null}
						<li
							className={
								"MainAppAccountManagementBilling-plan-list-item" satisfies MainAppAccountManagementBilling_ClassNames
							}
						>
							{main_app_account_management_billing_included_usage_line({
								hasIncludedMeterCredits,
								includedUsage,
							})}
						</li>
					</ul>
				</div>
			) : null}
			<div className={"MainAppAccountManagementBilling-body" satisfies MainAppAccountManagementBilling_ClassNames}>
				<div className={"MainAppAccountManagementBilling-actions" satisfies MainAppAccountManagementBilling_ClassNames}>
					{checkoutReady ? (
						<CheckoutLink
							polarApi={main_app_account_management_billing_checkout_api}
							productIds={checkoutProductIds}
							embed={false}
							lazy
							className={
								"MainAppAccountManagementBilling-checkout" satisfies MainAppAccountManagementBilling_ClassNames
							}
						>
							Checkout
						</CheckoutLink>
					) : null}
					{subscription != null ? (
						<MyButton
							type="button"
							variant="outline"
							className={
								"MainAppAccountManagementBilling-manage-subscription" satisfies MainAppAccountManagementBilling_ClassNames
							}
							onClick={handleManageSubscription}
						>
							Manage subscription
						</MyButton>
					) : null}
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
