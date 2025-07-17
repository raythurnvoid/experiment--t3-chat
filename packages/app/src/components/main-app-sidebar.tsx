import * as React from "react";
import { Home, MessageSquare } from "lucide-react";
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
import { ThemeToggle } from "@/components/theme-toggle";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";

interface MainAppSidebarLogo_Props extends React.ComponentProps<"div"> {}

function MainAppSidebarMenuButtonLabel({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="sidebar-menu-button-label"
			data-sidebar="menu-button-label"
			className={cn(className, "group-data-[collapsible=icon]:hidden")}
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
			<div className={cn("MainAppSidebar-app-logo-container", "px-2 group-data-[collapsible=icon]:invisible")}>
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
				<div className={cn("MainAppSidebar-theme-section", "px-3 py-2")}>
					<div className={cn("MainAppSidebar-theme-toggle", "flex items-center justify-between")}>
						<span className="text-sm font-medium text-muted-foreground">Theme</span>
						<ThemeToggle />
					</div>
				</div>

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
