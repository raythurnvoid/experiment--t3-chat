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
			is_authenticated: () => auth.isAuthenticated ?? false,
			get_token_for_convex: () =>
				auth.getToken({
					template: "convex",
				}),
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
