import "./__root.css";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppAuthProvider } from "../components/app-auth.tsx";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import {
	ai_chat_HARDCODED_ORG_ID,
	ai_chat_HARDCODED_PROJECT_ID,
	cn,
	should_never_happen,
	valorize_scrollbar_width_px_css_var,
} from "../lib/utils.ts";
import type { AppElementId } from "../lib/dom-utils.ts";
import { useConvexAuth, useMutation } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";

export type RootLayout_ClassNames = "RootLayout";

function LayoutInner() {
	const ensureHomepage = useMutation(app_convex_api.ai_docs_temp.ensure_home_page);
	const pagesHomeId = useAppGlobalStore((state) => state.pages_home_id);
	const canEnsureHomePageRef = useRef(true);

	const [criticalError, setCriticalError] = useState<string | null>(null);

	useEffect(() => {
		valorize_scrollbar_width_px_css_var();
	}, []);

	useEffect(() => {
		if (pagesHomeId || !canEnsureHomePageRef.current) {
			return;
		}

		canEnsureHomePageRef.current = false;

		ensureHomepage({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
		})
			.then((result) => {
				useAppGlobalStore.actions.setPagesHomeId(result.pageClientGeneratedId);
			})
			.catch((error) => {
				should_never_happen("Error while initializing the home page", { error });
				setCriticalError("Error while initializing the home page");
			});
	}, [ensureHomepage, pagesHomeId]);

	if (!pagesHomeId) {
		return <div>App Loading...</div>;
	}

	if (criticalError) {
		return <div>{criticalError}</div>;
	}

	return (
		<div className={cn("RootLayout" satisfies RootLayout_ClassNames)}>
			<MainAppSidebar>
				<Outlet />
			</MainAppSidebar>
			<AppTanStackRouterDevTools />
			<div id={"app_tiptap_hoisting_container" satisfies AppElementId}></div>
			{/* The monaco hoisting container requires the monaco-editor class to style the widgets */}
			<div id={"app_monaco_hoisting_container" satisfies AppElementId} className="monaco-editor"></div>
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
