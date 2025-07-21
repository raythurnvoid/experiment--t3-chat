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

	if (!auth.isAuthenticated) {
		return (
			<>
				<Outlet />
				<AppTanStackRouterDevTools />
			</>
		);
	}

	return (
		<SidebarProvider>
			<MainAppSidebar />
			<SidebarInset>
				<Outlet />
			</SidebarInset>
			<AppTanStackRouterDevTools />
		</SidebarProvider>
	);
}

export const Route = createRootRoute({
	component: Layout,
});
