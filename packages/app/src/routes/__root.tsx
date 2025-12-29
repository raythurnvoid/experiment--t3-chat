import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppAuthProvider } from "../components/app-auth.tsx";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { cn, valorize_scrollbar_width_px_css_var, type AppElementId } from "../lib/utils.ts";
import { useConvexAuth } from "convex/react";

export type RootLayout_ClassNames = "RootLayout";

function LayoutInner() {
	useEffect(() => {
		valorize_scrollbar_width_px_css_var();
	}, []);

	return (
		<div className={cn("RootLayout" satisfies RootLayout_ClassNames)}>
			<MainAppSidebar>
				<Outlet />
			</MainAppSidebar>
			<AppTanStackRouterDevTools />
			<div id={"app_tiptap_hoisting_container" satisfies AppElementId}></div>
		</div>
	);
}

function Layout() {
	const auth = AppAuthProvider.useAuth();
	const convexAuth = useConvexAuth();

	return convexAuth.isLoading || !auth.isLoaded ? (
		<div>Auth Loading...</div>
	) : convexAuth.isAuthenticated && auth.isLoaded ? (
		<LayoutInner />
	) : (
		<div>Unauthenticated</div>
	);
}

export const Route = createRootRoute({
	component: Layout,
});
