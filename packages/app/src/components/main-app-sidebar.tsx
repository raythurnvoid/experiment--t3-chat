import * as React from "react";
import { Home, MessageSquare, Settings, PanelLeft } from "lucide-react";
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
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/clerk-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export function MainAppSidebar(props: React.ComponentProps<typeof Sidebar>) {
	return (
		<Sidebar collapsible="icon" {...props}>
			<SidebarHeader>
				<div className={cn("MainAppSidebar-header", "flex items-center justify-start p-2")}>
					<SidebarTrigger />
				</div>

				{/* App Name */}
				<div className={cn("MainAppSidebar-app-name", "px-3 py-2")}>
					<Link
						to="/"
						className={cn(
							"MainAppSidebar-app-link",
							"text-lg font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent hover:from-blue-700 hover:to-purple-700 transition-all duration-200",
						)}
					>
						AI Chat App
					</Link>
				</div>
			</SidebarHeader>

			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupContent>
						<SidebarMenu>
							{/* Home Navigation */}
							<SidebarMenuItem>
								<SidebarMenuButton asChild>
									<Link
										to="/"
										className={cn(
											"MainAppSidebar-nav-home",
											"flex items-center gap-2 w-full px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground rounded-md",
										)}
									>
										<Home className="h-4 w-4" />
										<span>Home</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>

							{/* Chat Navigation */}
							<SidebarMenuItem>
								<SidebarMenuButton asChild>
									<Link
										to="/chat"
										className={cn(
											"MainAppSidebar-nav-chat",
											"flex items-center gap-2 w-full px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground rounded-md",
										)}
									>
										<MessageSquare className="h-4 w-4" />
										<span>Chat</span>
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

			<SidebarRail />
		</Sidebar>
	);
}
