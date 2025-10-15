import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { auth_set_token_manager, useAuth } from "../lib/auth.ts";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { cn, valorize_scrollbar_width_px_css_var } from "../lib/utils.ts";

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

	useEffect(() => {
		valorize_scrollbar_width_px_css_var();
	}, []);

	if (!auth.isLoaded) {
		return null;
	}

	return (
		<div className={cn("RootLayout", "flex h-full flex-col")}>
			<MainAppSidebar>
				<Outlet />
			</MainAppSidebar>
			<AppTanStackRouterDevTools />
		</div>
	);
}

export const Route = createRootRoute({
	component: Layout,
});
