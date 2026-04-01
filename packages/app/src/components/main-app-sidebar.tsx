import "./main-app-sidebar.css";
import "@/components/my-action.css";

import { memo } from "react";
import type { ComponentPropsWithRef, Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { FileText, MessageSquare, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Sun, Users } from "lucide-react";
import { Link, useRouterState, type RegisteredRouter } from "@tanstack/react-router";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { url_path_chat, url_path_pages } from "@/lib/urls.ts";

import { cn, compute_fallback_user_name } from "@/lib/utils.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { app_presence_GLOBAL_ROOM_ID } from "../../shared/shared-presence-constants.ts";
import { app_presence_set_enabled, usePresence, usePresenceEnabled, usePresenceList } from "@/hooks/presence-hooks.ts";
import { useThemeContext } from "@/components/theme-provider.tsx";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { Logo } from "@/components/logo.tsx";
import { MainAppSidebarAccountControl } from "@/components/main-app-sidebar-account-control.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyHoverCard, MyHoverCardArrow, MyHoverCardContent } from "@/components/my-hovercard.tsx";
import {
	MySidebar,
	MySidebarFooter,
	MySidebarHeader,
	MySidebarHovercardAction,
	MySidebarList,
	MySidebarListItem,
	MySidebarListItemIcon,
	MySidebarPrimaryAction,
	MySidebarScrollableArea,
	MySidebarSection,
	MySidebarListItemPrimaryAction,
	MySidebarListItemPrimaryActionLink,
	MySidebarListItemTitle,
	type MySidebar_Props,
} from "@/components/my-sidebar.tsx";

// #region theme toggle item
type MainAppSidebarThemeToggleMenuItem_ClassNames =
	| "MainAppSidebarThemeToggleMenuItem"
	| "MainAppSidebarThemeToggleMenuItem-button"
	| "MainAppSidebarThemeToggleMenuItem-icon";

const ThemeToggleMenuItem = memo(function ThemeToggleMenuItem() {
	const { mode, resolved_theme, set_mode } = useThemeContext();

	const get_theme_icon = () => {
		if (mode === "system") {
			return <Monitor />;
		}
		return resolved_theme === "dark" ? <Moon /> : <Sun />;
	};

	const handleCycleTheme = useFn(() => {
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
	});

	return (
		<MySidebarListItem
			className={"MainAppSidebarThemeToggleMenuItem" satisfies MainAppSidebarThemeToggleMenuItem_ClassNames}
		>
			<MySidebarListItemPrimaryAction
				onClick={handleCycleTheme}
				className={"MainAppSidebarThemeToggleMenuItem-button" satisfies MainAppSidebarThemeToggleMenuItem_ClassNames}
			>
				<MySidebarListItemIcon
					className={"MainAppSidebarThemeToggleMenuItem-icon" satisfies MainAppSidebarThemeToggleMenuItem_ClassNames}
				>
					{get_theme_icon()}
				</MySidebarListItemIcon>
				<MySidebarListItemTitle>
					<MainAppSidebarMenuButtonLabel>Theme</MainAppSidebarMenuButtonLabel>
				</MySidebarListItemTitle>
			</MySidebarListItemPrimaryAction>
		</MySidebarListItem>
	);
});
// #endregion theme toggle item

// #region menu button label
type MainAppSidebarMenuButtonLabel_ClassNames = "MainAppSidebarMenuButtonLabel";

type MainAppSidebarMenuButtonLabel_Props = ComponentPropsWithRef<"span"> & {
	ref?: Ref<HTMLSpanElement>;
	id?: string;
	className?: string;
	children?: React.ReactNode;
};

const MainAppSidebarMenuButtonLabel = memo(function MainAppSidebarMenuButtonLabel(
	props: MainAppSidebarMenuButtonLabel_Props,
) {
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
});
// #endregion menu button label

// #region profile section
type MainAppSidebarProfileSection_ClassNames = "MainAppSidebarProfileSection";

const ProfileSection = memo(function ProfileSection() {
	return (
		<div className={"MainAppSidebarProfileSection" satisfies MainAppSidebarProfileSection_ClassNames}>
			<MainAppSidebarAccountControl />
		</div>
	);
});
// #endregion profile section

// #region item
type MainAppSidebarItem_ClassNames = "MainAppSidebarItem" | "MainAppSidebarItem-trigger" | "MainAppSidebarItem-title";

type MainAppSidebarItem_Props = {
	to: string;
	label: string;
	icon: LucideIcon;
	tooltip?: string;
};

const MainAppSidebarItem = memo(function MainAppSidebarItem(props: MainAppSidebarItem_Props) {
	const { to, label, icon: Icon, tooltip } = props;

	const pathname = useRouterState<RegisteredRouter, string>({
		select: (state) => state.location.pathname,
	});

	const isActive = to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);

	return (
		<MySidebarListItem className={"MainAppSidebarItem" satisfies MainAppSidebarItem_ClassNames}>
			<MySidebarListItemPrimaryActionLink
				to={to}
				className={"MainAppSidebarItem-trigger" satisfies MainAppSidebarItem_ClassNames}
				data-selected={isActive ? "true" : undefined}
				tooltip={tooltip}
				tooltipPlacement={tooltip ? "right" : undefined}
			>
				<MySidebarListItemIcon>
					<Icon />
				</MySidebarListItemIcon>
				<MySidebarListItemTitle className={"MainAppSidebarItem-title" satisfies MainAppSidebarItem_ClassNames}>
					{label}
				</MySidebarListItemTitle>
			</MySidebarListItemPrimaryActionLink>
		</MySidebarListItem>
	);
});
// #endregion item

// #region presence users
type MainAppSidebarPresenceUsers_ClassNames =
	| "MainAppSidebarPresenceUsers-list"
	| "MainAppSidebarPresenceUsers-item"
	| "MainAppSidebarPresenceUsers-item-label";

type MainAppSidebarPresenceUsers_User = {
	userId: string;
	anagraphic: { avatarUrl?: string; displayName: string };
};

type MainAppSidebarPresenceUsers_Props = {
	users: MainAppSidebarPresenceUsers_User[];
};

const MainAppSidebarPresenceUsers = memo(function MainAppSidebarPresenceUsers(
	props: MainAppSidebarPresenceUsers_Props,
) {
	const { users } = props;

	return (
		<div className={cn("MainAppSidebarPresenceUsers-list" satisfies MainAppSidebarPresenceUsers_ClassNames)}>
			{users.map((user) => (
				<div
					key={user.userId}
					className={cn("MainAppSidebarPresenceUsers-item" satisfies MainAppSidebarPresenceUsers_ClassNames)}
				>
					<MyAvatar size="24px">
						<MyAvatarImage src={user.anagraphic.avatarUrl} alt={user.anagraphic.displayName} />
						<MyAvatarFallback>{compute_fallback_user_name(user.userId)}</MyAvatarFallback>
					</MyAvatar>
					<span
						className={cn("MainAppSidebarPresenceUsers-item-label" satisfies MainAppSidebarPresenceUsers_ClassNames)}
					>
						{user.anagraphic.displayName}
					</span>
				</div>
			))}
		</div>
	);
});
// #endregion presence users

// #region presence control
type MainAppSidebarPresenceControl_ClassNames =
	| "MainAppSidebarPresenceControl"
	| "MainAppSidebarPresenceControl-primary-trigger"
	| "MainAppSidebarPresenceControl-primary-trigger-content"
	| "MainAppSidebarPresenceControl-online-label"
	| "MainAppSidebarPresenceControl-actions"
	| "MainAppSidebarPresenceControl-actions-online-count"
	| "MainAppSidebarPresenceControl-disable"
	| "MainAppSidebarPresenceControl-hovercard";

type MainAppSidebarPresenceControl_Props = {
	sidebarCollapsed: boolean;
};

const MainAppSidebarPresenceControl = memo(function MainAppSidebarPresenceControl(
	props: MainAppSidebarPresenceControl_Props,
) {
	const { sidebarCollapsed } = props;

	const authenticated = AppAuthProvider.useAuthenticated();
	const presenceEnabled = usePresenceEnabled();
	const presence = usePresence({
		roomId: app_presence_GLOBAL_ROOM_ID,
		userId: authenticated.userId,
		disconnectOnDocumentHidden: false,
	});
	const presenceList = usePresenceList({
		roomToken: presence.roomToken,
		userId: authenticated.userId,
	});

	const onlineUsers = (presenceList?.users ?? []).filter((user) => user.online !== false);
	const onlineCount = onlineUsers.length;

	const handleEnable = useFn(() => {
		app_presence_set_enabled(true);
	});
	const handleDisable = useFn(() => {
		app_presence_set_enabled(false);
	});

	if (!presenceEnabled) {
		return (
			<MySidebarPrimaryAction
				onClick={handleEnable}
				className={"MainAppSidebarPresenceControl" satisfies MainAppSidebarPresenceControl_ClassNames}
				tooltip={sidebarCollapsed ? "Enable presence" : undefined}
				tooltipPlacement={sidebarCollapsed ? "right" : undefined}
			>
				<MySidebarListItemIcon>
					<Users />
				</MySidebarListItemIcon>
				<MySidebarListItemTitle>Enable presence</MySidebarListItemTitle>
			</MySidebarPrimaryAction>
		);
	}

	const disableButton = (
		<MyButton
			variant="ghost-highlightable"
			className={cn("MainAppSidebarPresenceControl-disable" satisfies MainAppSidebarPresenceControl_ClassNames)}
			onClick={handleDisable}
		>
			Disable
		</MyButton>
	);

	return (
		<div className={"MainAppSidebarPresenceControl" satisfies MainAppSidebarPresenceControl_ClassNames}>
			<MyHoverCard showTimeout={0} placement="right-start">
				<MySidebarHovercardAction
					className={cn(
						"MainAppSidebarPresenceControl-primary-trigger" satisfies MainAppSidebarPresenceControl_ClassNames,
					)}
					aria-label={`Show details about ${onlineCount} online users`}
				>
					<div
						className={cn(
							"MainAppSidebarPresenceControl-primary-trigger-content" satisfies MainAppSidebarPresenceControl_ClassNames,
						)}
					>
						<MySidebarListItemIcon>
							<Users />
						</MySidebarListItemIcon>
						<MySidebarListItemTitle
							className={cn(
								"MainAppSidebarPresenceControl-online-label" satisfies MainAppSidebarPresenceControl_ClassNames,
							)}
						>
							{onlineCount} Online
						</MySidebarListItemTitle>
					</div>
				</MySidebarHovercardAction>
				<MyHoverCardContent
					gutter={4}
					aria-label="Presence: online users and options"
					className={cn("MainAppSidebarPresenceControl-hovercard" satisfies MainAppSidebarPresenceControl_ClassNames)}
				>
					<MyHoverCardArrow />
					<div
						hidden={!sidebarCollapsed}
						className={cn("MainAppSidebarPresenceControl-actions" satisfies MainAppSidebarPresenceControl_ClassNames)}
					>
						<span
							className={cn(
								"MainAppSidebarPresenceControl-actions-online-count" satisfies MainAppSidebarPresenceControl_ClassNames,
							)}
						>
							{onlineCount} Online
						</span>
						{disableButton}
					</div>
					<MainAppSidebarPresenceUsers users={onlineUsers} />
				</MyHoverCardContent>
				<div
					hidden={sidebarCollapsed}
					className={cn("MainAppSidebarPresenceControl-actions" satisfies MainAppSidebarPresenceControl_ClassNames)}
				>
					{disableButton}
				</div>
			</MyHoverCard>
		</div>
	);
});
// #endregion presence control

// #region presence section
type MainAppSidebarPresenceSection_ClassNames = "MainAppSidebarPresenceSection";

type MainAppSidebarPresenceSection_Props = {
	sidebarCollapsed: boolean;
};

const MainAppSidebarPresenceSection = memo(function MainAppSidebarPresenceSection(
	props: MainAppSidebarPresenceSection_Props,
) {
	const { sidebarCollapsed } = props;

	return (
		<MySidebarSection
			aria-label="Presence"
			className={"MainAppSidebarPresenceSection" satisfies MainAppSidebarPresenceSection_ClassNames}
		>
			<MainAppSidebarPresenceControl sidebarCollapsed={sidebarCollapsed} />
		</MySidebarSection>
	);
});
// #endregion presence section

// #region root
type MainAppSidebar_ClassNames =
	| "MainAppSidebar"
	| "MainAppSidebar-state-collapsed"
	| "MainAppSidebar-header"
	| "MainAppSidebar-header-width-toggle"
	| "MainAppSidebar-logo-section"
	| "MainAppSidebar-logo-link"
	| "MainAppSidebar-logo"
	| "MainAppSidebar-nav-list"
	| "MainAppSidebarPresenceSection"
	| "MainAppSidebar-footer"
	| "MainAppSidebar-footer-menu";

type MainAppSidebar_Props = {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

export const MainAppSidebar = memo(function MainAppSidebar(props: MainAppSidebar_Props) {
	const { ref, id, className } = props;

	const { workspaceName, projectName } = AppTenantProvider.useContext();

	const chatPath = url_path_chat({ workspaceName, projectName });
	const pagesPath = url_path_pages({ workspaceName, projectName });

	const [isOpen, setIsOpen] = useAppLocalStorageStateValue("app_state::sidebar::main_app_open");
	const [mainAppSidebarCollapsed, setMainAppSidebarCollapsed] = useAppLocalStorageStateValue(
		"app_state::sidebar::main_app_collapsed",
	);

	const sidebarState: MySidebar_Props["state"] = !isOpen ? "closed" : "expanded";

	const handleSidebarWidthToggleClick = useFn(() => {
		setMainAppSidebarCollapsed((value) => !value);
	});

	AppHotkeysProvider.useHotkey(
		"Mod+B",
		useFn(() => {
			setIsOpen((value) => !value);
		}),
	);

	return (
		<MySidebar
			ref={ref}
			id={id}
			className={cn(
				"MainAppSidebar" satisfies MainAppSidebar_ClassNames,
				mainAppSidebarCollapsed && ("MainAppSidebar-state-collapsed" satisfies MainAppSidebar_ClassNames),
				className,
			)}
			state={sidebarState}
			inert={sidebarState === "closed" ? true : undefined}
			aria-hidden={sidebarState === "closed" ? true : undefined}
		>
			<MySidebarHeader className={"MainAppSidebar-header" satisfies MainAppSidebar_ClassNames}>
				<MyIconButton
					className={cn("MainAppSidebar-header-width-toggle" satisfies MainAppSidebar_ClassNames)}
					variant="ghost-highlightable"
					tooltip={mainAppSidebarCollapsed ? "Expand sidebar" : "Minimize sidebar"}
					onClick={handleSidebarWidthToggleClick}
				>
					<MyIconButtonIcon>{mainAppSidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</MyIconButtonIcon>
				</MyIconButton>
			</MySidebarHeader>

			<div className={"MainAppSidebar-logo-section" satisfies MainAppSidebar_ClassNames}>
				<Link to="/" className={"MainAppSidebar-logo-link" satisfies MainAppSidebar_ClassNames}>
					<Logo className={"MainAppSidebar-logo" satisfies MainAppSidebar_ClassNames} />
				</Link>
			</div>

			<MainAppSidebarPresenceSection sidebarCollapsed={mainAppSidebarCollapsed} />

			<MySidebarScrollableArea>
				<MySidebarList
					className={"MainAppSidebar-nav-list" satisfies MainAppSidebar_ClassNames}
					aria-label="Main navigation"
				>
					<MainAppSidebarItem
						to={chatPath}
						label="Chat"
						icon={MessageSquare}
						tooltip={mainAppSidebarCollapsed ? "AI Chat" : undefined}
					/>
					<MainAppSidebarItem
						to={pagesPath}
						label="Pages"
						icon={FileText}
						tooltip={mainAppSidebarCollapsed ? "Pages" : undefined}
					/>
				</MySidebarList>
			</MySidebarScrollableArea>

			<MySidebarFooter className={"MainAppSidebar-footer" satisfies MainAppSidebar_ClassNames}>
				<MySidebarList className={"MainAppSidebar-footer-menu" satisfies MainAppSidebar_ClassNames}>
					<ThemeToggleMenuItem />
				</MySidebarList>
				<ProfileSection />
			</MySidebarFooter>
		</MySidebar>
	);
});
// #endregion root
