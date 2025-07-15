import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useEffect } from "react";
import { auth_set_token_manager, useAuth } from "../lib/auth.ts";

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
			<div className="h-screen w-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 overflow-hidden">
				<Outlet />
			</div>
			<TanStackRouterDevtools />
		</>
	);
}

export const Route = createRootRoute({
	component: Layout,
});
