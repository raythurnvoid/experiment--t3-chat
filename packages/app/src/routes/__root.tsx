import "./__root.css";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { MyButton } from "../components/my-button.tsx";
import { Logo } from "../components/logo.tsx";
import { MySpinner } from "../components/my-spinner.tsx";
import { AppAuthProvider } from "../components/app-auth.tsx";
import { AppTanStackRouterDevTools } from "../components/app-tanstack-router-dev-tools.tsx";
import { cn, valorize_scrollbar_width_px_css_var } from "../lib/utils.ts";
import type { AppElementId } from "../lib/dom-utils.ts";
import { useConvexAuth } from "convex/react";

export type RootLayout_ClassNames =
	| "RootLayout"
	| "RootLayout-content"
	| "RootLayoutAuthState"
	| "RootLayoutAuthState-state-bootstrap_error"
	| "RootLayoutAuthState-panel"
	| "RootLayoutAuthState-panel-state-bootstrap_error"
	| "RootLayoutAuthState-logo"
	| "RootLayoutAuthState-spinner"
	| "RootLayoutAuthState-title"
	| "RootLayoutAuthState-title-state-bootstrap_error"
	| "RootLayoutAuthState-description"
	| "RootLayoutAuthState-description-state-bootstrap_error"
	| "RootLayoutAuthState-description-dev"
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

function RootLayoutAuthState(props: { kind: "loading" | "bootstrap_error" }) {
	const { kind } = props;

	return (
		<div
			className={cn(
				"RootLayoutAuthState" satisfies RootLayout_ClassNames,
				kind === "bootstrap_error" && ("RootLayoutAuthState-state-bootstrap_error" satisfies RootLayout_ClassNames),
			)}
		>
			<div
				className={cn(
					"RootLayoutAuthState-panel" satisfies RootLayout_ClassNames,
					kind === "bootstrap_error" &&
						("RootLayoutAuthState-panel-state-bootstrap_error" satisfies RootLayout_ClassNames),
				)}
			>
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
						<div
							className={cn(
								"RootLayoutAuthState-title" satisfies RootLayout_ClassNames,
								"RootLayoutAuthState-title-state-bootstrap_error" satisfies RootLayout_ClassNames,
							)}
						>
							Session failed to start
						</div>
						<div
							className={cn(
								"RootLayoutAuthState-description" satisfies RootLayout_ClassNames,
								"RootLayoutAuthState-description-state-bootstrap_error" satisfies RootLayout_ClassNames,
							)}
						>
							The app could not finish authentication setup. Reload the page to try again.
						</div>
						{import.meta.env.DEV ? (
							<div className={"RootLayoutAuthState-description-dev" satisfies RootLayout_ClassNames}>
								Development tip: this often happens after a Convex backend or HMR reload while the auth client is
								out of sync.
							</div>
						) : null}
						<div className={"RootLayoutAuthState-actions" satisfies RootLayout_ClassNames}>
							<MyButton variant="default" type="button" onClick={() => window.location.reload()}>
								Reload
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

	const isLoading = convexAuth.isLoading || !auth.isLoaded;
	const isHealthy = auth.isLoaded && auth.isAuthenticated && convexAuth.isAuthenticated;
	const isBootstrapError = !isLoading && !isHealthy;

	const bootstrap_error_logged_ref = useRef(false);

	useEffect(() => {
		if (!isBootstrapError) {
			bootstrap_error_logged_ref.current = false;
			return;
		}

		if (bootstrap_error_logged_ref.current) {
			return;
		}

		bootstrap_error_logged_ref.current = true;

		console.error("[RootLayout.bootstrap] Fatal bootstrap invariant violation", {
			auth_isLoaded: auth.isLoaded,
			auth_isAuthenticated: auth.isAuthenticated,
			auth_isAnonymous: auth.isAnonymous,
			auth_userId: auth.userId,
			convex_isLoading: convexAuth.isLoading,
			convex_isAuthenticated: convexAuth.isAuthenticated,
			dev: import.meta.env.DEV,
		});
	}, [
		isBootstrapError,
		auth.isLoaded,
		auth.isAuthenticated,
		auth.isAnonymous,
		auth.userId,
		convexAuth.isLoading,
		convexAuth.isAuthenticated,
	]);

	if (isLoading) {
		return <RootLayoutAuthState kind="loading" />;
	}

	if (isHealthy) {
		return <RootLayoutInner />;
	}

	return <RootLayoutAuthState kind="bootstrap_error" />;
}

const Route = createRootRoute({
	component: RootLayout,
});

export { Route };
