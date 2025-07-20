import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { auth_set_token_manager, useAuth } from "../lib/auth.ts";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";

function Layout() {
	const auth = useAuth();

	useEffect(() => {
		auth_set_token_manager({
			isAuthenticated: () => auth.isAuthenticated ?? false,
			getToken: () => auth.getToken(),
		});
	}, [auth]);

	if (!auth.isLoaded) {
		return null;
	}

	return (
		<>
			<div className="h-screen w-screen overflow-hidden bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
				<SidebarProvider className="h-full w-full">
					<MainAppSidebar />
					<SidebarInset className="flex-1 overflow-hidden">
						<Outlet />
					</SidebarInset>
				</SidebarProvider>
			</div>
			<AppTanStackRouterDevTools />
		</>
	);
}

export const Route = createRootRoute({
	component: Layout,
});
