import "./main-app-sidebar-account-control.css";

import { useClerk, useUser } from "@clerk/clerk-react";
import { useQuery } from "convex/react";
import { ChevronsUpDown, LogIn, LogOut, User, UserRound, UserRoundPlus } from "lucide-react";
import { memo, type ComponentPropsWithRef } from "react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyMenu,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuTrigger,
} from "@/components/my-menu.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { cn, compute_fallback_user_name } from "@/lib/utils.ts";
import { users_create_anonymouse_user_display_name } from "../../shared/users.ts";

// #region menu item
type MainSidebarAccountControlMenuItem_Props = {
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
};

const MainSidebarAccountControlMenuItem = memo(function MainSidebarAccountControlMenuItem(
	props: MainSidebarAccountControlMenuItem_Props,
) {
	const { icon, label, onClick } = props;

	return (
		<MyMenuItem onClick={onClick}>
			<MyMenuItemContent>
				<MyMenuItemContentIcon>{icon}</MyMenuItemContentIcon>
				<MyMenuItemContentPrimary>{label}</MyMenuItemContentPrimary>
			</MyMenuItemContent>
		</MyMenuItem>
	);
});
// #endregion menu item

// #region profile data
type MainSidebarAccountControlMenuProfileData_ClassNames =
	| "MainSidebarAccountControlMenuProfileData"
	| "MainSidebarAccountControlMenuProfileData-avatar"
	| "MainSidebarAccountControlMenuProfileData-avatar-icon"
	| "MainSidebarAccountControlMenuProfileData-copy"
	| "MainSidebarAccountControlMenuProfileData-status"
	| "MainSidebarAccountControlMenuProfileData-name";

type MainSidebarAccountControlMenuProfileData_Props = {
	avatarUrl: string | undefined;
	displayName: string;
	accountStatusLabel: string;
	isAnonymous: boolean;
};

const MainSidebarAccountControlMenuProfileData = memo(function MainSidebarAccountControlMenuProfileData(
	props: MainSidebarAccountControlMenuProfileData_Props,
) {
	const { avatarUrl, displayName, accountStatusLabel, isAnonymous } = props;

	const avatarFallback = isAnonymous ? (
		<User
			className={
				"MainSidebarAccountControlMenuProfileData-avatar-icon" satisfies MainSidebarAccountControlMenuProfileData_ClassNames
			}
			aria-hidden
		/>
	) : (
		compute_fallback_user_name(displayName)
	);

	return (
		<div className={"MainSidebarAccountControlMenuProfileData" satisfies MainSidebarAccountControlMenuProfileData_ClassNames}>
			<MyAvatar
				size="32px"
				className={"MainSidebarAccountControlMenuProfileData-avatar" satisfies MainSidebarAccountControlMenuProfileData_ClassNames}
			>
				<MyAvatarImage src={avatarUrl} alt={displayName} />
				<MyAvatarFallback>{avatarFallback}</MyAvatarFallback>
			</MyAvatar>
			<div
				className={"MainSidebarAccountControlMenuProfileData-copy" satisfies MainSidebarAccountControlMenuProfileData_ClassNames}
			>
				<div
					className={"MainSidebarAccountControlMenuProfileData-status" satisfies MainSidebarAccountControlMenuProfileData_ClassNames}
				>
					{accountStatusLabel}
				</div>
				<div
					className={"MainSidebarAccountControlMenuProfileData-name" satisfies MainSidebarAccountControlMenuProfileData_ClassNames}
				>
					{displayName}
				</div>
			</div>
		</div>
	);
});
// #endregion profile data

// #region account control menu
type MainSidebarAccountControlMenu_ClassNames = "MainSidebarAccountControlMenu";

type MainSidebarAccountControlMenu_Props = {
	avatarUrl: string | undefined;
	displayName: string;
	accountStatusLabel: string;
	isAnonymous: boolean;
	onOpenSignIn: () => void;
	onOpenSignUp: () => void;
	onOpenUserProfile: () => void;
	onSignOut: () => void;
};

const MainSidebarAccountControlMenu = memo(function MainSidebarAccountControlMenu(
	props: MainSidebarAccountControlMenu_Props,
) {
	const {
		avatarUrl,
		displayName,
		accountStatusLabel,
		isAnonymous,
		onOpenSignIn,
		onOpenSignUp,
		onOpenUserProfile,
		onSignOut,
	} = props;

	return (
		<MyMenuPopover placement="top-start" gutter={6}>
			<MyMenuPopoverContent className={"MainSidebarAccountControlMenu" satisfies MainSidebarAccountControlMenu_ClassNames}>
				<MainSidebarAccountControlMenuProfileData
					avatarUrl={avatarUrl}
					displayName={displayName}
					accountStatusLabel={accountStatusLabel}
					isAnonymous={isAnonymous}
				/>
				{isAnonymous ? (
					<>
						<MainSidebarAccountControlMenuItem icon={<LogIn />} label="Log in" onClick={onOpenSignIn} />
						<MainSidebarAccountControlMenuItem
							icon={<UserRoundPlus />}
							label="Sign up"
							onClick={onOpenSignUp}
						/>
					</>
				) : (
					<>
						<MainSidebarAccountControlMenuItem
							icon={<UserRound />}
							label="Manage account"
							onClick={onOpenUserProfile}
						/>
						<MainSidebarAccountControlMenuItem icon={<LogOut />} label="Sign out" onClick={onSignOut} />
					</>
				)}
			</MyMenuPopoverContent>
		</MyMenuPopover>
	);
});
// #endregion account control menu

// #region trigger
type MainAppSidebarAccountControlTrigger_ClassNames =
	| "MainAppSidebarAccountControlTrigger"
	| "MainAppSidebarAccountControlTrigger-avatar"
	| "MainAppSidebarAccountControlTrigger-avatar-icon"
	| "MainAppSidebarAccountControlTrigger-copy"
	| "MainAppSidebarAccountControlTrigger-name"
	| "MainAppSidebarAccountControlTrigger-chevron";

type MainAppSidebarAccountControlTrigger_Props = {
	avatarUrl: string | undefined;
	displayName: string;
	avatarFallback: React.ReactNode;
} & ComponentPropsWithRef<typeof MyButton>;

const MainAppSidebarAccountControlTrigger = memo(function MainAppSidebarAccountControlTrigger(
	props: MainAppSidebarAccountControlTrigger_Props,
) {
	const { ref, id, className, avatarUrl, displayName, avatarFallback, ...rest } = props;

	return (
		<MyButton
			ref={ref}
			id={id}
			type="button"
			variant="ghost-highlightable"
			className={cn(
				"MainAppSidebarAccountControlTrigger" satisfies MainAppSidebarAccountControlTrigger_ClassNames,
				className,
			)}
			{...rest}
		>
			<MyAvatar
				size="32px"
				className={"MainAppSidebarAccountControlTrigger-avatar" satisfies MainAppSidebarAccountControlTrigger_ClassNames}
			>
				<MyAvatarImage src={avatarUrl} alt={displayName} />
				<MyAvatarFallback>{avatarFallback}</MyAvatarFallback>
			</MyAvatar>
			<span className={"MainAppSidebarAccountControlTrigger-copy" satisfies MainAppSidebarAccountControlTrigger_ClassNames}>
				<span
					className={"MainAppSidebarAccountControlTrigger-name" satisfies MainAppSidebarAccountControlTrigger_ClassNames}
				>
					{displayName}
				</span>
			</span>
			<ChevronsUpDown
				className={cn(
					"MainAppSidebarAccountControlTrigger-chevron" satisfies MainAppSidebarAccountControlTrigger_ClassNames,
				)}
			/>
		</MyButton>
	);
});
// #endregion trigger

// #region root
type MainAppSidebarAccountControl_ClassNames = "MainAppSidebarAccountControl";

export const MainAppSidebarAccountControl = memo(function MainAppSidebarAccountControl() {
	const auth = AppAuthProvider.useAuth();
	const clerk = useClerk();
	const { user } = useUser();

	const anagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		auth.userId
			? {
					userId: auth.userId as app_convex_Id<"users">,
				}
			: "skip",
	);

	const clerkDisplayName = ((/* iife */) => {
		if (!user) {
			return null;
		}

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
	})();

	const displayName =
		anagraphic?.displayName ??
		(auth.isAnonymous
			? auth.userId
				? users_create_anonymouse_user_display_name(auth.userId)
				: "Anonymous user"
			: clerkDisplayName ?? "User");
	const avatarUrl = anagraphic?.avatarUrl ?? user?.imageUrl ?? undefined;
	const triggerAriaLabel = auth.isAnonymous ? `Anonymous account: ${displayName}` : `Account: ${displayName}`;
	const accountStatusLabel = auth.isAnonymous ? "Not logged in" : "Signed in";
	const avatarFallback = auth.isAnonymous ? (
		<User
			className={"MainAppSidebarAccountControlTrigger-avatar-icon" satisfies MainAppSidebarAccountControlTrigger_ClassNames}
			aria-hidden
		/>
	) : (
		compute_fallback_user_name(displayName)
	);

	const handleOpenSignIn = useFn(() => {
		void clerk.openSignIn();
	});
	const handleOpenSignUp = useFn(() => {
		void clerk.openSignUp();
	});
	const handleOpenUserProfile = useFn(() => {
		void clerk.openUserProfile();
	});
	const handleSignOut = useFn(() => {
		void clerk.signOut();
	});

	return (
		<MyMenu>
			<div className={"MainAppSidebarAccountControl" satisfies MainAppSidebarAccountControl_ClassNames}>
				<MyMenuTrigger>
					<MainAppSidebarAccountControlTrigger
						avatarUrl={avatarUrl}
						displayName={displayName}
						avatarFallback={avatarFallback}
						aria-label={triggerAriaLabel}
					/>
				</MyMenuTrigger>

				<MainSidebarAccountControlMenu
					avatarUrl={avatarUrl}
					displayName={displayName}
					accountStatusLabel={accountStatusLabel}
					isAnonymous={Boolean(auth.isAnonymous)}
					onOpenSignIn={handleOpenSignIn}
					onOpenSignUp={handleOpenSignUp}
					onOpenUserProfile={handleOpenUserProfile}
					onSignOut={handleSignOut}
				/>
			</div>
		</MyMenu>
	);
});
// #endregion root
