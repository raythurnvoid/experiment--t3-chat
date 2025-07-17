import * as React from "react";
import { Home, MessageSquare, Moon, Sun, Monitor } from "lucide-react";
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
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";

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
			<SidebarMenuButton onClick={cycle_theme} className={cn("ThemeToggleMenuItem", "flex items-center gap-2")}>
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
				"MainAppSidebarMenuButtonLabel",
				"starting:opacity-0 transition-opacity duration-150 ease-in-out delay-200 transition-discrete group-data-[collapsible=icon]:hidden group-data-[collapsible=icon]:delay-0 group-data-[collapsible=icon]:duration-0",
				className,
			)}
			{...props}
		/>
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
					"MainAppSidebar-app-logo-container",
					"px-2 starting:opacity-0 transition-opacity duration-150 ease-in-out delay-200 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0 group-data-[collapsible=icon]:duration-0",
				)}
			>
				<Link to="/" className={cn("MainAppSidebar-app-link", "contents")}>
					<div className="px-8">
						<Logo className={cn("MainAppSidebarLogo-logo", "flex items-center")} />
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
									<Link to="/" className={cn("MainAppSidebar-nav-home", "flex items-center gap-2")}>
										<Home className="h-4 w-4" />
										<MainAppSidebarMenuButtonLabel>Home</MainAppSidebarMenuButtonLabel>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>

							{/* Chat Navigation */}
							<SidebarMenuItem>
								<SidebarMenuButton asChild>
									<Link to="/chat" className={cn("MainAppSidebar-nav-chat", "flex items-center gap-2")}>
										<MessageSquare className="h-4 w-4" />
										<MainAppSidebarMenuButtonLabel>Chat</MainAppSidebarMenuButtonLabel>
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
				<div className={cn("MainAppSidebar-profile-section", "px-3 py-2 border-t")}>
					<SignedOut>
						<SignInButton>
							<Button variant="outline" className="w-full">
								Sign In
							</Button>
						</SignInButton>
					</SignedOut>
					<SignedIn>
						<div className={cn("MainAppSidebar-user-button", "flex items-center justify-center")}>
							<UserButton
								appearance={{
									elements: {
										avatarBox: "w-8 h-8",
									},
								}}
							/>
						</div>
					</SignedIn>
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}
