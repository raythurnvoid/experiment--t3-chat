import "./main-app-sidebar-account-control.css";

import { useClerk, useUser } from "@clerk/clerk-react";
import { useQuery } from "convex/react";
import { ChevronsUpDown, LogIn, LogOut, UserRound, UserRoundPlus } from "lucide-react";
import { memo } from "react";

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

type MainAppSidebarAccountControl_ClassNames =
	| "MainAppSidebarAccountControl"
	| "MainAppSidebarAccountControl-trigger"
	| "MainAppSidebarAccountControl-avatar"
	| "MainAppSidebarAccountControl-copy"
	| "MainAppSidebarAccountControl-name"
	| "MainAppSidebarAccountControl-chevron"
	| "MainAppSidebarAccountControl-menu";

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
					<MyButton
						type="button"
						variant="ghost-highlightable"
						className={"MainAppSidebarAccountControl-trigger" satisfies MainAppSidebarAccountControl_ClassNames}
						aria-label={triggerAriaLabel}
					>
						<MyAvatar
							size="32px"
							className={"MainAppSidebarAccountControl-avatar" satisfies MainAppSidebarAccountControl_ClassNames}
						>
							<MyAvatarImage src={avatarUrl} alt={displayName} />
							<MyAvatarFallback>{compute_fallback_user_name(displayName)}</MyAvatarFallback>
						</MyAvatar>
						<span className={"MainAppSidebarAccountControl-copy" satisfies MainAppSidebarAccountControl_ClassNames}>
							<span className={"MainAppSidebarAccountControl-name" satisfies MainAppSidebarAccountControl_ClassNames}>
								{displayName}
							</span>
						</span>
						<ChevronsUpDown
							className={cn(
								"MainAppSidebarAccountControl-chevron" satisfies MainAppSidebarAccountControl_ClassNames,
							)}
						/>
					</MyButton>
				</MyMenuTrigger>

				<MyMenuPopover placement="top-start" gutter={6}>
					<MyMenuPopoverContent
						className={"MainAppSidebarAccountControl-menu" satisfies MainAppSidebarAccountControl_ClassNames}
					>
						{auth.isAnonymous ? (
							<>
								<MyMenuItem onClick={handleOpenSignIn}>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<LogIn />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>Log in</MyMenuItemContentPrimary>
									</MyMenuItemContent>
								</MyMenuItem>
								<MyMenuItem onClick={handleOpenSignUp}>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<UserRoundPlus />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>Sign up</MyMenuItemContentPrimary>
									</MyMenuItemContent>
								</MyMenuItem>
							</>
						) : (
							<>
								<MyMenuItem onClick={handleOpenUserProfile}>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<UserRound />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>Manage account</MyMenuItemContentPrimary>
									</MyMenuItemContent>
								</MyMenuItem>
								<MyMenuItem onClick={handleSignOut}>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<LogOut />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>Sign out</MyMenuItemContentPrimary>
									</MyMenuItemContent>
								</MyMenuItem>
							</>
						)}
					</MyMenuPopoverContent>
				</MyMenuPopover>
			</div>
		</MyMenu>
	);
});
