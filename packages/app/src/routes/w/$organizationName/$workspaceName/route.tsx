import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useLayoutEffect, useRef } from "react";

import { MainAppHeader } from "@/components/main-app-header.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { cn } from "@/lib/utils.ts";
import { PluginPublishSessionProvider } from "./plugins/publisher/-plugin-publish-session.tsx";

import type { RootLayout_ClassNames } from "@/routes/__root.tsx";

function RouteTenantOrganizationWorkspaceLayout() {
	const params = Route.useParams();
	const { organizationName, workspaceName } = params;
	const publishSessionManager = PluginPublishSessionProvider.useContext();
	const focusTargetRef = useRef<HTMLElement>(null);
	const focusScopeRef = useRef<HTMLElement>(null);
	const focusTargetWasFocusedRef = useRef(false);
	const workspaceKey = `${organizationName}/${workspaceName}`;
	const setWorkspaceFocusTarget = useFn(publishSessionManager.setWorkspaceFocusTarget);
	const setFocusTargetRef = useFn((target: HTMLElement | null) => {
		focusTargetRef.current = target;
		setWorkspaceFocusTarget(target, workspaceKey);
		// Transfer only focus that fell because React replaced the registered target.
		if (target && focusTargetWasFocusedRef.current && document.activeElement === document.body) {
			target.focus();
		}
	});
	const setFocusScopeRef = useFn((target: HTMLElement | null) => {
		focusScopeRef.current = target;
	});
	const setStandaloneFocusTargetRef = useFn((target: HTMLElement | null) => {
		setFocusScopeRef(target);
		setFocusTargetRef(target);
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
			<main
				ref={setStandaloneFocusTargetRef}
				role="status"
				aria-live="polite"
				aria-label="Organization loading"
				tabIndex={-1}
			>
				Loading organization
			</main>
		);
	}

	if (membership === null) {
		return (
			<main ref={setStandaloneFocusTargetRef} role="alert" aria-label="Organization access denied" tabIndex={-1}>
				You do not have access to this organization/workspace.
			</main>
		);
	}

	const organizationId = membership.organizationId;
	const workspaceId = membership.workspaceId;

	return (
		<AppTenantProvider
			membershipId={membership._id}
			organizationId={organizationId}
			organizationName={organizationName}
			workspaceId={workspaceId}
			workspaceName={workspaceName}
		>
			<div
				ref={setFocusScopeRef}
				className={cn("RootLayout" satisfies RootLayout_ClassNames)}
				onFocusCapture={handleWorkspaceFocusCapture}
			>
				<MainAppHeader />
				<MainAppSidebar />
				<div
					ref={setFocusTargetRef}
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
