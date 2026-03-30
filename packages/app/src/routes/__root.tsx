import "./__root.css";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useClerk } from "@clerk/clerk-react";
import { MyButton } from "../components/my-button.tsx";
import { Logo } from "../components/logo.tsx";
import { MySpinner } from "../components/my-spinner.tsx";
import { AppAuthProvider } from "../components/app-auth.tsx";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { valorize_scrollbar_width_px_css_var } from "../lib/utils.ts";
import type { AppElementId } from "../lib/dom-utils.ts";
import { useConvexAuth } from "convex/react";

export type RootLayout_ClassNames =
	| "RootLayout"
	| "RootLayout-content"
	| "RootLayoutAuthState"
	| "RootLayoutAuthState-panel"
	| "RootLayoutAuthState-logo"
	| "RootLayoutAuthState-spinner"
	| "RootLayoutAuthState-title"
	| "RootLayoutAuthState-description"
	| "RootLayoutAuthState-actions";

function RootLayoutInner() {
	useEffect(() => {
		valorize_scrollbar_width_px_css_var();
	}, []);

	return (
		<>
			<Outlet />
			<AppTanStackRouterDevTools />
			<div id={"app_hoisting_container" satisfies AppElementId}></div>
			<div id={"app_tiptap_hoisting_container" satisfies AppElementId}></div>
			{/* The monaco hoisting container requires the monaco-editor class to style the widgets */}
			<div id={"app_monaco_hoisting_container" satisfies AppElementId} className="monaco-editor"></div>
		</>
	);
}

function RootLayoutAuthState(props: { kind: "loading" | "unauthenticated" }) {
	const { kind } = props;
	const clerk = useClerk();

	return (
		<div className={"RootLayoutAuthState" satisfies RootLayout_ClassNames}>
			<div className={"RootLayoutAuthState-panel" satisfies RootLayout_ClassNames}>
				<Logo className={"RootLayoutAuthState-logo" satisfies RootLayout_ClassNames} />
				{kind === "loading" ? (
					<>
						<MySpinner
							size="24px"
							color="var(--color-accent-07)"
							className={"RootLayoutAuthState-spinner" satisfies RootLayout_ClassNames}
						/>
						<div className={"RootLayoutAuthState-title" satisfies RootLayout_ClassNames}>Preparing workspace</div>
						<div className={"RootLayoutAuthState-description" satisfies RootLayout_ClassNames}>
							Finish loading authentication and workspace access.
						</div>
					</>
				) : (
					<>
						<div className={"RootLayoutAuthState-title" satisfies RootLayout_ClassNames}>Sign in required</div>
						<div className={"RootLayoutAuthState-description" satisfies RootLayout_ClassNames}>
							Open a Clerk flow to continue into the app.
						</div>
						<div className={"RootLayoutAuthState-actions" satisfies RootLayout_ClassNames}>
							<MyButton variant="outline" onClick={() => void clerk.openSignIn()}>
								Log in
							</MyButton>
							<MyButton variant="secondary" onClick={() => void clerk.openSignUp()}>
								Sign up
							</MyButton>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function RootLayout() {
	const auth = AppAuthProvider.useAuth();
	const convexAuth = useConvexAuth();

	return convexAuth.isLoading || !auth.isLoaded ? (
		<RootLayoutAuthState kind="loading" />
	) : convexAuth.isAuthenticated && auth.isLoaded ? (
		<RootLayoutInner />
	) : (
		<RootLayoutAuthState kind="unauthenticated" />
	);
}

const Route = createRootRoute({
	component: RootLayout,
});

export { Route };
