import * as React from "react";
import { Home, MessageSquare, FileText, Moon, Sun, Monitor } from "lucide-react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useThemeContext } from "@/components/theme-provider";
import { SignedIn, SignedOut, SignInButton, UserButton, useUser } from "@clerk/clerk-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { dark } from "@clerk/themes";

function ThemeToggleMenuItem() {
	const { mode, resolved_theme, set_mode } = useThemeContext();

	const get_theme_icon = () => {
		if (mode === "system") {
			return <Monitor className="h-4 w-4" />;
		}
		return resolved_theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />;
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
		<SidebarMenuItem>
			<SidebarMenuButton
				onClick={cycle_theme}
				className={cn("main-app-sidebar-theme-toggle-menu-item", "flex items-center gap-2")}
			>
				{get_theme_icon()}
				<MainAppSidebarMenuButtonLabel>Theme</MainAppSidebarMenuButtonLabel>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function MainAppSidebarMenuButtonLabel({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="sidebar-menu-button-label"
			data-sidebar="menu-button-label"
			className={cn(
				"main-app-sidebar-menu-button-label",
				"transition-opacity transition-discrete delay-200 duration-150 ease-in-out group-data-[collapsible=icon]:hidden group-data-[collapsible=icon]:delay-0 group-data-[collapsible=icon]:duration-0 starting:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

function UserProfileButton() {
	const { user } = useUser();
	const userButtonRef = React.useRef<HTMLDivElement>(null);

	const theme = useThemeContext();

	if (!user) {
		return null;
	}

	const display_name = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.username || "User";
	const email_address = user.primaryEmailAddress?.emailAddress || "";

	const handleCustomButtonClick = () => {
		// Trigger the hidden UserButton
		const userButton = userButtonRef.current?.querySelector("button");
		if (userButton) {
			userButton.click();
		}
	};

	return (
		<div className={cn("main-app-sidebar-user-profile-button", "relative w-full")}>
			{/* Custom display button */}
			<Button
				variant="ghost"
				onClick={handleCustomButtonClick}
				className={cn(
					"flex h-auto w-full items-center justify-start gap-3 p-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
				)}
			>
				<div className={cn("main-app-sidebar-user-profile-avatar", "flex-shrink-0")}>
					<img
						src={user.imageUrl}
						alt={display_name}
						className={cn("main-app-sidebar-user-profile-avatar-image", "h-8 w-8 rounded-full")}
					/>
				</div>
				<div className={cn("main-app-sidebar-user-profile-info", "flex min-w-0 flex-1 flex-col items-start")}>
					<span
						className={cn(
							"main-app-sidebar-user-profile-name",
							"w-full truncate text-left text-sm font-medium text-sidebar-foreground",
						)}
					>
						{display_name}
					</span>
					{email_address && (
						<span
							className={cn(
								"main-app-sidebar-user-profile-email",
								"w-full truncate text-left text-xs text-sidebar-foreground/70",
							)}
						>
							{email_address}
						</span>
					)}
				</div>
			</Button>

			{/* Hidden UserButton for popup functionality */}
			<div
				ref={userButtonRef}
				className={cn("main-app-sidebar-user-profile-clerk-wrapper", "sr-only absolute right-[-30px] bottom-0 h-0 w-0")}
			>
				<UserButton
					appearance={{
						baseTheme: theme.resolved_theme === "dark" ? dark : (undefined as any),
						elements: {
							userButtonAvatarBox: "w-8 h-8",
							userButtonPopoverCard: "bg-sidebar-background border-sidebar-border",
							userButtonPopoverMain: "bg-sidebar-background",
							userButtonPopoverActionButton:
								"text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
							userButtonPopoverActionButtonText: "text-sidebar-foreground",
							userButtonPopoverFooter: "bg-sidebar-background border-sidebar-border",
						},
					}}
					userProfileMode="modal"
				/>
			</div>
		</div>
	);
}

function ProfileSection() {
	return (
		<div className={cn("main-app-sidebar-profile-section", "border-t px-2 py-2")}>
			<SignedOut>
				<SignInButton>
					<Button variant="outline" className="w-full">
						Sign In
					</Button>
				</SignInButton>
			</SignedOut>
			<SignedIn>
				<div className={cn("main-app-sidebar-user-section", "w-full")}>
					<UserProfileButton />
				</div>
			</SignedIn>
		</div>
	);
}

export function MainAppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader>
				<SidebarTrigger />
			</SidebarHeader>

			{/* App Name */}
			<div
				className={cn(
					"main-app-sidebar-app-logo-container",
					"px-2 transition-opacity delay-200 duration-150 ease-in-out group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0 group-data-[collapsible=icon]:duration-0 starting:opacity-0",
				)}
			>
				<Link to="/" className={cn("main-app-sidebar-app-link", "contents")}>
					<div className="px-8">
						<Logo className={cn("main-app-sidebar-logo", "flex items-center")} />
					</div>
				</Link>
			</div>

			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							{/* Home Navigation */}
							<SidebarMenuItem>
								<SidebarMenuButton asChild>
									<Link to="/" className={cn("main-app-sidebar-nav-home", "flex items-center gap-2")}>
										<Home className="h-4 w-4" />
										<MainAppSidebarMenuButtonLabel>Home</MainAppSidebarMenuButtonLabel>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>

							{/* Chat Navigation */}
							<SidebarMenuItem>
								<SidebarMenuButton asChild>
									<Link to="/chat" className={cn("main-app-sidebar-nav-chat", "flex items-center gap-2")}>
										<MessageSquare className="h-4 w-4" />
										<MainAppSidebarMenuButtonLabel>Chat</MainAppSidebarMenuButtonLabel>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>

							{/* Docs Navigation */}
							<SidebarMenuItem>
								<SidebarMenuButton asChild>
									<Link to="/docs" className={cn("main-app-sidebar-nav-docs", "flex items-center gap-2")}>
										<FileText className="h-4 w-4" />
										<MainAppSidebarMenuButtonLabel>Docs</MainAppSidebarMenuButtonLabel>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			<SidebarFooter>
				{/* Theme Toggle */}
				<SidebarMenu>
					<ThemeToggleMenuItem />
				</SidebarMenu>

				{/* Profile Section */}
				<ProfileSection />
			</SidebarFooter>
		</Sidebar>
	);
}
