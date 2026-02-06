import "./main-app-sidebar.css";

import * as React from "react";
import type { ComponentPropsWithRef, Ref } from "react";
import { FileText, Home, MessageSquare, Monitor, Moon, PanelLeft, Sun } from "lucide-react";
import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from "@clerk/clerk-react";
import { Link } from "@tanstack/react-router";
import { dark } from "@clerk/themes";

import { cn } from "@/lib/utils.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { useThemeContext } from "@/components/theme-provider.tsx";
import { Logo } from "@/components/logo.tsx";
import { OnlinePresenceIndicator } from "@/components/online-presence-indicator.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MySidebar,
	MySidebarContent,
	MySidebarFooter,
	MySidebarGroup,
	MySidebarGroupContent,
	MySidebarHeader,
	MySidebarInset,
	MySidebarMenu,
	MySidebarMenuButton,
	MySidebarMenuItem,
	type MySidebar_Props,
} from "@/components/my-sidebar.tsx";

const main_app_sidebar_COOKIE_NAME = "sidebar_state";
const main_app_sidebar_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const main_app_sidebar_KEYBOARD_SHORTCUT = "b";
const main_app_sidebar_DEFAULT_OPEN = true;

const main_app_sidebar_read_cookie_value = (cookieName: string) => {
	if (typeof document === "undefined") {
		return null;
	}

	const cookieValue = document.cookie
		.split(";")
		.map((cookie) => cookie.trim())
		.find((cookie) => cookie.startsWith(`${cookieName}=`));

	if (!cookieValue) {
		return null;
	}

	return cookieValue.slice(cookieName.length + 1);
};

const main_app_sidebar_get_initial_open = () => {
	const cookieValue = main_app_sidebar_read_cookie_value(main_app_sidebar_COOKIE_NAME);

	if (cookieValue === "true") {
		return true;
	}

	if (cookieValue === "false") {
		return false;
	}

	return main_app_sidebar_DEFAULT_OPEN;
};

// #region context
type MainAppSidebar_Context = {
	toggleSidebar: () => void;
	isMobile: boolean;
};

const MainSidebarContext = React.createContext<MainAppSidebar_Context | null>(null);
// #endregion context

// #region theme toggle item
type MainAppSidebarThemeToggleMenuItem_ClassNames =
	| "MainAppSidebarThemeToggleMenuItem"
	| "MainAppSidebarThemeToggleMenuItem-button"
	| "MainAppSidebarThemeToggleMenuItem-icon";

function ThemeToggleMenuItem() {
	const { mode, resolved_theme, set_mode } = useThemeContext();

	const get_theme_icon = () => {
		if (mode === "system") {
			return <Monitor />;
		}
		return resolved_theme === "dark" ? <Moon /> : <Sun />;
	};

	const cycle_theme = () => {
		switch (mode) {
			case "light":
				set_mode("dark");
				break;
			case "dark":
				set_mode("system");
				break;
			case "system":
				set_mode("light");
				break;
			default:
				set_mode("system");
		}
	};

	return (
		<MySidebarMenuItem
			className={"MainAppSidebarThemeToggleMenuItem" satisfies MainAppSidebarThemeToggleMenuItem_ClassNames}
		>
			<MySidebarMenuButton
				onClick={cycle_theme}
				className={"MainAppSidebarThemeToggleMenuItem-button" satisfies MainAppSidebarThemeToggleMenuItem_ClassNames}
			>
				<MyIcon
					className={"MainAppSidebarThemeToggleMenuItem-icon" satisfies MainAppSidebarThemeToggleMenuItem_ClassNames}
				>
					{get_theme_icon()}
				</MyIcon>
				<MainAppSidebarMenuButtonLabel>Theme</MainAppSidebarMenuButtonLabel>
			</MySidebarMenuButton>
		</MySidebarMenuItem>
	);
}
// #endregion theme toggle item

// #region menu button label
type MainAppSidebarMenuButtonLabel_ClassNames = "MainAppSidebarMenuButtonLabel";

type MainAppSidebarMenuButtonLabel_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	children?: React.ReactNode;
};

function MainAppSidebarMenuButtonLabel(props: MainAppSidebarMenuButtonLabel_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<span
			ref={ref}
			id={id}
			className={cn("MainAppSidebarMenuButtonLabel" satisfies MainAppSidebarMenuButtonLabel_ClassNames, className)}
			{...rest}
		>
			{children}
		</span>
	);
}
// #endregion menu button label

// #region user profile button
type MainAppSidebarUserProfileButton_ClassNames =
	| "MainAppSidebarUserProfileButton"
	| "MainAppSidebarUserProfileButton-button"
	| "MainAppSidebarUserProfileButton-avatar"
	| "MainAppSidebarUserProfileButton-avatar-image"
	| "MainAppSidebarUserProfileButton-info"
	| "MainAppSidebarUserProfileButton-name"
	| "MainAppSidebarUserProfileButton-email"
	| "MainAppSidebarUserProfileButton-clerk-wrapper"
	| "MainAppSidebarClerkAvatarBox"
	| "MainAppSidebarClerkPopoverCard"
	| "MainAppSidebarClerkPopoverMain"
	| "MainAppSidebarClerkPopoverActionButton"
	| "MainAppSidebarClerkPopoverActionButtonText"
	| "MainAppSidebarClerkPopoverFooter";

function UserProfileButton() {
	const { user } = useUser();
	const userButtonRef = React.useRef<HTMLDivElement>(null);

	const theme = useThemeContext();

	if (!user) {
		return null;
	}

	const displayName = ((/* iife */) => {
		const firstName = user.firstName ? user.firstName : "";
		const lastName = user.lastName ? user.lastName : "";
		const fullName = `${firstName} ${lastName}`.trim();

		if (fullName !== "") {
			return fullName;
		}

		if (user.username) {
			return user.username;
		}

		return "User";
	})();

	const emailAddress = user.primaryEmailAddress?.emailAddress ? user.primaryEmailAddress.emailAddress : "";

	const handleCustomButtonClick = () => {
		// Trigger the hidden UserButton
		const userButton = userButtonRef.current?.querySelector("button");
		if (userButton) {
			userButton.click();
		}
	};

	const clerkAvatarBoxClassName = "MainAppSidebarClerkAvatarBox" satisfies MainAppSidebarUserProfileButton_ClassNames;
	const clerkPopoverCardClassName =
		"MainAppSidebarClerkPopoverCard" satisfies MainAppSidebarUserProfileButton_ClassNames;
	const clerkPopoverMainClassName =
		"MainAppSidebarClerkPopoverMain" satisfies MainAppSidebarUserProfileButton_ClassNames;
	const clerkPopoverActionButtonClassName =
		"MainAppSidebarClerkPopoverActionButton" satisfies MainAppSidebarUserProfileButton_ClassNames;
	const clerkPopoverActionButtonTextClassName =
		"MainAppSidebarClerkPopoverActionButtonText" satisfies MainAppSidebarUserProfileButton_ClassNames;
	const clerkPopoverFooterClassName =
		"MainAppSidebarClerkPopoverFooter" satisfies MainAppSidebarUserProfileButton_ClassNames;

	return (
		<div className={"MainAppSidebarUserProfileButton" satisfies MainAppSidebarUserProfileButton_ClassNames}>
			{/* Custom display button */}
			<MyButton
				variant="ghost-highlightable"
				onClick={handleCustomButtonClick}
				className={"MainAppSidebarUserProfileButton-button" satisfies MainAppSidebarUserProfileButton_ClassNames}
			>
				<div className={"MainAppSidebarUserProfileButton-avatar" satisfies MainAppSidebarUserProfileButton_ClassNames}>
					<img
						src={user.imageUrl}
						alt={displayName}
						className={
							"MainAppSidebarUserProfileButton-avatar-image" satisfies MainAppSidebarUserProfileButton_ClassNames
						}
					/>
				</div>
				<div className={"MainAppSidebarUserProfileButton-info" satisfies MainAppSidebarUserProfileButton_ClassNames}>
					<span className={"MainAppSidebarUserProfileButton-name" satisfies MainAppSidebarUserProfileButton_ClassNames}>
						{displayName}
					</span>
					{emailAddress && (
						<span
							className={"MainAppSidebarUserProfileButton-email" satisfies MainAppSidebarUserProfileButton_ClassNames}
						>
							{emailAddress}
						</span>
					)}
				</div>
			</MyButton>

			{/* Hidden UserButton for popup functionality */}
			<div
				ref={userButtonRef}
				className={"MainAppSidebarUserProfileButton-clerk-wrapper" satisfies MainAppSidebarUserProfileButton_ClassNames}
			>
				<UserButton
					appearance={{
						baseTheme: theme.resolved_theme === "dark" ? dark : (undefined as any),
						elements: {
							userButtonAvatarBox: clerkAvatarBoxClassName,
							userButtonPopoverCard: clerkPopoverCardClassName,
							userButtonPopoverMain: clerkPopoverMainClassName,
							userButtonPopoverActionButton: clerkPopoverActionButtonClassName,
							userButtonPopoverActionButtonText: clerkPopoverActionButtonTextClassName,
							userButtonPopoverFooter: clerkPopoverFooterClassName,
						},
					}}
					userProfileMode="modal"
				/>
			</div>
		</div>
	);
}
// #endregion user profile button

// #region profile section
type MainAppSidebarProfileSection_ClassNames =
	| "MainAppSidebarProfileSection"
	| "MainAppSidebarProfileSection-signin-button"
	| "MainAppSidebarProfileSection-user";

function ProfileSection() {
	return (
		<div className={"MainAppSidebarProfileSection" satisfies MainAppSidebarProfileSection_ClassNames}>
			<SignedOut>
				<SignInButton>
					<MyButton
						variant="outline"
						className={"MainAppSidebarProfileSection-signin-button" satisfies MainAppSidebarProfileSection_ClassNames}
					>
						Sign In
					</MyButton>
				</SignInButton>
			</SignedOut>
			<SignedIn>
				<div className={"MainAppSidebarProfileSection-user" satisfies MainAppSidebarProfileSection_ClassNames}>
					<UserProfileButton />
				</div>
			</SignedIn>
		</div>
	);
}
// #endregion profile section

// #region inset
type MainAppSidebarInset_ClassNames = "MainAppSidebarInset";

type MainAppSidebarInset_Props = ComponentPropsWithRef<typeof MySidebarInset> & {
	ref?: Ref<HTMLElement>;
	id?: string;
	className?: string;
	children?: React.ReactNode;
};

function MainAppSidebarInset(props: MainAppSidebarInset_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<MySidebarInset
			ref={ref}
			id={id}
			className={cn("MainAppSidebarInset" satisfies MainAppSidebarInset_ClassNames, className)}
			{...rest}
		>
			{children}
		</MySidebarInset>
	);
}
// #endregion inset

// #region root
type MainAppSidebar_ClassNames =
	| "MainAppSidebar"
	| "MainAppSidebar-sidebar"
	| "MainAppSidebar-header"
	| "MainAppSidebar-header-row"
	| "MainAppSidebar-header-spacer"
	| "MainAppSidebar-trigger"
	| "MainAppSidebar-trigger-icon"
	| "MainAppSidebar-presence"
	| "MainAppSidebar-logo-section"
	| "MainAppSidebar-logo-link"
	| "MainAppSidebar-logo"
	| "MainAppSidebar-content"
	| "MainAppSidebar-group"
	| "MainAppSidebar-group-content"
	| "MainAppSidebar-menu"
	| "MainAppSidebar-nav-button"
	| "MainAppSidebar-nav-link"
	| "MainAppSidebar-nav-icon"
	| "MainAppSidebar-footer"
	| "MainAppSidebar-footer-menu";

type MainAppSidebar_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children?: React.ReactNode;
};

export const MainAppSidebar = ((/* iife */) => {
	function MainAppSidebar(props: MainAppSidebar_Props) {
		const { ref, id, className, children, ...rest } = props;

		const isMobile = useIsMobile();
		const [isOpen, setIsOpen] = React.useState(() => {
			return main_app_sidebar_get_initial_open();
		});

		const sidebarState: MySidebar_Props["state"] = isOpen ? "expanded" : "closed";

		const toggleSidebar = () => {
			setIsOpen((value) => !value);
		};

		React.useEffect(() => {
			if (typeof document === "undefined") {
				return;
			}

			document.cookie = `${main_app_sidebar_COOKIE_NAME}=${isOpen}; path=/; max-age=${main_app_sidebar_COOKIE_MAX_AGE_SECONDS}`;
		}, [isOpen]);

		React.useEffect(() => {
			const handleKeyDown = (event: KeyboardEvent) => {
				if (event.key.toLowerCase() !== main_app_sidebar_KEYBOARD_SHORTCUT) {
					return;
				}

				if (!event.metaKey && !event.ctrlKey) {
					return;
				}

				event.preventDefault();
				toggleSidebar();
			};

			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}, [toggleSidebar]);

		return (
			<MainSidebarContext.Provider value={{ toggleSidebar, isMobile }}>
				<div
					ref={ref}
					id={id}
					className={cn("MainAppSidebar" satisfies MainAppSidebar_ClassNames, className)}
					{...rest}
				>
					<MySidebar
						state={sidebarState}
						aria-hidden={sidebarState === "closed" ? true : undefined}
						inert={sidebarState === "closed" ? true : undefined}
						className={"MainAppSidebar-sidebar" satisfies MainAppSidebar_ClassNames}
					>
						<MySidebarHeader className={"MainAppSidebar-header" satisfies MainAppSidebar_ClassNames}>
							<div className={"MainAppSidebar-header-row" satisfies MainAppSidebar_ClassNames}>
								<MyIconButton
									variant="ghost"
									tooltip="Toggle sidebar"
									onClick={toggleSidebar}
									className={"MainAppSidebar-trigger" satisfies MainAppSidebar_ClassNames}
								>
									<MyIconButtonIcon className={"MainAppSidebar-trigger-icon" satisfies MainAppSidebar_ClassNames}>
										<PanelLeft />
									</MyIconButtonIcon>
								</MyIconButton>
								<div className={"MainAppSidebar-header-spacer" satisfies MainAppSidebar_ClassNames} />
								<div className={"MainAppSidebar-presence" satisfies MainAppSidebar_ClassNames}>
									<OnlinePresenceIndicator />
								</div>
							</div>
						</MySidebarHeader>

						<div className={"MainAppSidebar-logo-section" satisfies MainAppSidebar_ClassNames}>
							<Link to="/" className={"MainAppSidebar-logo-link" satisfies MainAppSidebar_ClassNames}>
								<Logo className={"MainAppSidebar-logo" satisfies MainAppSidebar_ClassNames} />
							</Link>
						</div>

						<MySidebarContent className={"MainAppSidebar-content" satisfies MainAppSidebar_ClassNames}>
							<MySidebarGroup className={"MainAppSidebar-group" satisfies MainAppSidebar_ClassNames}>
								<MySidebarGroupContent className={"MainAppSidebar-group-content" satisfies MainAppSidebar_ClassNames}>
									<MySidebarMenu className={"MainAppSidebar-menu" satisfies MainAppSidebar_ClassNames}>
										<MySidebarMenuItem>
											<MySidebarMenuButton
												asChild
												className={"MainAppSidebar-nav-button" satisfies MainAppSidebar_ClassNames}
											>
												<Link to="/" className={"MainAppSidebar-nav-link" satisfies MainAppSidebar_ClassNames}>
													<MyIcon className={"MainAppSidebar-nav-icon" satisfies MainAppSidebar_ClassNames}>
														<Home />
													</MyIcon>
													<MainAppSidebarMenuButtonLabel>Home</MainAppSidebarMenuButtonLabel>
												</Link>
											</MySidebarMenuButton>
										</MySidebarMenuItem>

										<MySidebarMenuItem>
											<MySidebarMenuButton
												asChild
												className={"MainAppSidebar-nav-button" satisfies MainAppSidebar_ClassNames}
											>
												<Link to="/chat" className={"MainAppSidebar-nav-link" satisfies MainAppSidebar_ClassNames}>
													<MyIcon className={"MainAppSidebar-nav-icon" satisfies MainAppSidebar_ClassNames}>
														<MessageSquare />
													</MyIcon>
													<MainAppSidebarMenuButtonLabel>Chat</MainAppSidebarMenuButtonLabel>
												</Link>
											</MySidebarMenuButton>
										</MySidebarMenuItem>

										<MySidebarMenuItem>
											<MySidebarMenuButton
												asChild
												className={"MainAppSidebar-nav-button" satisfies MainAppSidebar_ClassNames}
											>
												<Link to="/pages" className={"MainAppSidebar-nav-link" satisfies MainAppSidebar_ClassNames}>
													<MyIcon className={"MainAppSidebar-nav-icon" satisfies MainAppSidebar_ClassNames}>
														<FileText />
													</MyIcon>
													<MainAppSidebarMenuButtonLabel>Docs</MainAppSidebarMenuButtonLabel>
												</Link>
											</MySidebarMenuButton>
										</MySidebarMenuItem>
									</MySidebarMenu>
								</MySidebarGroupContent>
							</MySidebarGroup>
						</MySidebarContent>

						<MySidebarFooter className={"MainAppSidebar-footer" satisfies MainAppSidebar_ClassNames}>
							<MySidebarMenu className={"MainAppSidebar-footer-menu" satisfies MainAppSidebar_ClassNames}>
								<ThemeToggleMenuItem />
							</MySidebarMenu>
							<ProfileSection />
						</MySidebarFooter>
					</MySidebar>
					<MainAppSidebarInset>{children}</MainAppSidebarInset>
				</div>
			</MainSidebarContext.Provider>
		);
	}

	return Object.assign(MainAppSidebar, {
		useSidebar() {
			const context = React.use(MainSidebarContext);
			if (!context) {
				throw new Error(`${MainAppSidebar.name}.useSidebar must be used within ${MainAppSidebar.name}}`);
			}
			return context;
		},
	});
})();
// #endregion root
