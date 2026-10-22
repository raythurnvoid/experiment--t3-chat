import "./route.css";

import { useClerk } from "@clerk/clerk-react";
import { createFileRoute, Outlet, useMatch } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { LogIn } from "lucide-react";
import { memo, useLayoutEffect, useRef, type Ref } from "react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { Logo } from "@/components/logo.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MainAppHeader } from "@/components/main-app-header.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { cn } from "@/lib/utils.ts";
import { AppLoadingCard } from "@/components/app-loading-card.tsx";
import { PluginsPublishSessionProvider } from "@/components/plugins-publish-session.tsx";

import type { RootLayout_ClassNames } from "@/routes/__root.tsx";

type RouteTenantOrganizationWorkspaceLogin_ClassNames =
	| "RouteTenantOrganizationWorkspaceLogin"
	| "RouteTenantOrganizationWorkspaceLogin-panel"
	| "RouteTenantOrganizationWorkspaceLogin-title"
	| "RouteTenantOrganizationWorkspaceLogin-description";

type RouteTenantOrganizationWorkspaceLogin_Props = {
	ref: Ref<HTMLElement>;
	organizationName: string;
	workspaceName: string;
};

const RouteTenantOrganizationWorkspaceLogin = memo(function RouteTenantOrganizationWorkspaceLogin(
	props: RouteTenantOrganizationWorkspaceLogin_Props,
) {
	const { ref, organizationName, workspaceName } = props;
	const clerk = useClerk();

	const handleOpenSignIn = useFn(() => {
		// Without a redirect URL, Clerk sends the user to "/" after sign-in, and "/" opens the
		// default workspace. Pass the current URL so the user comes back to this page.
		// Drop the hash. If only the hash changes, the browser does not reload, and Clerk waits
		// for that reload to finish the sign-in. App routes do not use the hash.
		const url = new URL(window.location.href);
		url.hash = "";
		void clerk.openSignIn({ forceRedirectUrl: url.href, signUpForceRedirectUrl: url.href });
	});

	return (
		<main
			ref={ref}
			className={"RouteTenantOrganizationWorkspaceLogin" satisfies RouteTenantOrganizationWorkspaceLogin_ClassNames}
			aria-label="Workspace log in"
			tabIndex={-1}
		>
			<div
				className={
					"RouteTenantOrganizationWorkspaceLogin-panel" satisfies RouteTenantOrganizationWorkspaceLogin_ClassNames
				}
			>
				<Logo />
				<h1
					className={
						"RouteTenantOrganizationWorkspaceLogin-title" satisfies RouteTenantOrganizationWorkspaceLogin_ClassNames
					}
				>
					Log in to continue
				</h1>
				<p
					className={
						"RouteTenantOrganizationWorkspaceLogin-description" satisfies RouteTenantOrganizationWorkspaceLogin_ClassNames
					}
				>
					You are logged out. Log in to open {organizationName}/{workspaceName}.
				</p>
				<MyButton onClick={handleOpenSignIn}>
					<LogIn aria-hidden />
					Log in
				</MyButton>
			</div>
		</main>
	);
});

function RouteTenantOrganizationWorkspaceLayout() {
	const params = Route.useParams();
	const { organizationName, workspaceName } = params;
	const auth = AppAuthProvider.useAuth();
	const isMobile = useIsMobile();
	const isChatRoute =
		useMatch({
			from: "/w/$organizationName/$workspaceName/chat/",
			shouldThrow: false,
			select: () => true,
		}) ?? false;
	const isPhoneChat = isMobile && isChatRoute;
	const publishSessionManager = PluginsPublishSessionProvider.useContext();
	const focusTargetRef = useRef<HTMLElement>(null);
	const focusScopeRef = useRef<HTMLElement>(null);
	const focusTargetWasFocusedRef = useRef(false);
	const workspaceKey = `${organizationName}/${workspaceName}`;
	const setWorkspaceFocusTarget = useFn(publishSessionManager.setWorkspaceFocusTarget);
	const handleFocusTargetRef = useFn((target: HTMLElement | null) => {
		focusTargetRef.current = target;
		setWorkspaceFocusTarget(target, workspaceKey);
		// Transfer only focus that fell because React replaced the registered target.
		if (target && focusTargetWasFocusedRef.current && document.activeElement === document.body) {
			target.focus();
		}
	});
	const handleFocusScopeRef = useFn((target: HTMLElement | null) => {
		focusScopeRef.current = target;
	});
	const handleStandaloneFocusTargetRef = useFn((target: HTMLElement | null) => {
		handleFocusScopeRef(target);
		handleFocusTargetRef(target);
	});
	const handleWorkspaceFocusCapture = useFn(() => {
		// React focus follows the component tree, so this also owns workspace menus and dialogs
		// that render into the app portal outside the RootLayout DOM node.
		focusTargetWasFocusedRef.current = true;
	});

	useLayoutEffect(() => {
		setWorkspaceFocusTarget(focusTargetRef.current, workspaceKey);
		return () => setWorkspaceFocusTarget(null, workspaceKey);
	}, [setWorkspaceFocusTarget, workspaceKey]);

	useLayoutEffect(() => {
		// Record focus anywhere in the loaded workspace before React removes that whole subtree.
		const handleFocusIn = (event: FocusEvent) => {
			focusTargetWasFocusedRef.current =
				event.target instanceof Node &&
				(focusScopeRef.current?.contains(event.target) === true ||
					focusTargetRef.current?.contains(event.target) === true);
		};
		document.addEventListener("focusin", handleFocusIn, true);
		return () => document.removeEventListener("focusin", handleFocusIn, true);
	}, []);

	const membership = useQuery(app_convex_api.organizations.get_membership_by_organization_workspace_name, {
		organizationName,
		workspaceName,
	});

	if (membership === undefined) {
		return (
			<AppLoadingCard
				ref={handleStandaloneFocusTargetRef}
				label="Organization loading"
				title="Loading workspace"
				description="Getting your organization and workspace ready."
			/>
		);
	}

	// When Clerk logs the user out, the app gives them a new anonymous user. That user is not a
	// member of this workspace. So for an anonymous user, no membership means "log in".
	if (membership === null && auth.isAnonymous) {
		return (
			<RouteTenantOrganizationWorkspaceLogin
				ref={handleStandaloneFocusTargetRef}
				organizationName={organizationName}
				workspaceName={workspaceName}
			/>
		);
	}

	if (membership === null) {
		return (
			<main ref={handleStandaloneFocusTargetRef} role="alert" aria-label="Organization access denied" tabIndex={-1}>
				You do not have access to this organization/workspace.
			</main>
		);
	}

	const organizationId = membership.organizationId;
	const workspaceId = membership.workspaceId;

	return (
		<AppTenantProvider
			userId={membership.userId}
			membershipId={membership._id}
			organizationId={organizationId}
			organizationName={organizationName}
			workspaceId={workspaceId}
			workspaceName={workspaceName}
		>
			{/* On a phone the agent chat shows alone, without the app header and sidebar. Other
			    workspace pages keep the desktop layout. A phone user can still open them, even
			    when that layout does not fit the screen. */}
			<div
				ref={handleFocusScopeRef}
				className={cn(
					"RootLayout" satisfies RootLayout_ClassNames,
					isPhoneChat && ("RootLayout-variant-phone" satisfies RootLayout_ClassNames),
				)}
				onFocusCapture={handleWorkspaceFocusCapture}
			>
				{!isPhoneChat && <MainAppHeader />}
				{!isPhoneChat && <MainAppSidebar />}
				<div
					ref={handleFocusTargetRef}
					className={"RootLayout-content" satisfies RootLayout_ClassNames}
					role="region"
					aria-label={`${organizationName}/${workspaceName} workspace content`}
					tabIndex={-1}
				>
					<Outlet />
				</div>
			</div>
		</AppTenantProvider>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName")({
	component: RouteTenantOrganizationWorkspaceLayout,
});

export { Route };
