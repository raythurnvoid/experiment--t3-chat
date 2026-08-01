import "./plugin-page.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Puzzle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { PluginsUiFrame } from "@/components/plugins-ui-frame.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

// #region root
type RoutePluginsPluginPage_ClassNames =
	| "RoutePluginsPluginPage"
	| "RoutePluginsPluginPage-loading"
	| "RoutePluginsPluginPage-missing"
	| "RoutePluginsPluginPage-error";

function RoutePluginsPluginPage() {
	const { pluginName, pageId } = Route.useParams();
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const uiPages = useQuery(app_convex_api.plugins_ui.list_ui_pages, { membershipId });
	const retryButtonRef = useRef<HTMLButtonElement | null>(null);
	const [sessionError, setSessionError] = useState<{ frameKey: string; message: string } | null>(null);
	// Incremented by Retry. It keys the iframe so each attempt gets a fresh document and bridge nonce.
	const [attempt, setAttempt] = useState(0);

	const plugin = uiPages?.find((item) => item.pluginName === pluginName) ?? null;
	const page = plugin?.pages.find((item) => item.id === pageId) ?? null;

	const pluginVersionId = plugin?.pluginVersionId ?? null;
	// Any tenant, version, page, or Retry change creates a new iframe and bridge nonce.
	const frameKey = `${membershipId}:${pluginVersionId ?? "missing"}:${pageId ?? "missing"}:${attempt}`;
	const activeSessionError = sessionError?.frameKey === frameKey ? sessionError.message : null;
	// useCallback on frameKey, not useFn: an error from a stale frame must record the old key so it
	// gets ignored instead of being blamed on the new frame.
	const handleFrameError = useCallback((message: string) => setSessionError({ frameKey, message }), [frameKey]);

	const mintSession = useFn(() =>
		app_convex.mutation(app_convex_api.plugins_ui.mint_page_session, {
			membershipId,
			pluginName,
		}),
	);

	const getInitContext = useFn(() => ({
		kind: "page",
		pluginName,
		pageId,
		pageTitle: page?.title ?? "",
		organizationId,
		workspaceId,
	}));

	// The error replaces the iframe (and any focus that was inside it), so move focus to the one
	// available action.
	useEffect(() => {
		if (activeSessionError !== null) {
			retryButtonRef.current?.focus();
		}
	}, [activeSessionError]);

	const handleRetry = useFn(() => {
		setAttempt((current) => current + 1);
	});

	const breadcrumb = (
		<PluginsHeaderBreadcrumb
			trail={["plugins"]}
			current={plugin && page ? `${plugin.displayName} / ${page.title}` : pluginName}
		/>
	);

	if (uiPages === undefined) {
		return (
			<main
				className={"RoutePluginsPluginPage" satisfies RoutePluginsPluginPage_ClassNames}
				role="status"
				aria-live="polite"
			>
				{breadcrumb}
				<div className={"RoutePluginsPluginPage-loading" satisfies RoutePluginsPluginPage_ClassNames}>
					<Puzzle aria-hidden />
					Loading plugin page...
				</div>
			</main>
		);
	}

	if (!plugin || !page) {
		return (
			<main className={"RoutePluginsPluginPage" satisfies RoutePluginsPluginPage_ClassNames}>
				{breadcrumb}
				<div className={"RoutePluginsPluginPage-missing" satisfies RoutePluginsPluginPage_ClassNames}>
					This plugin page is not available.
				</div>
			</main>
		);
	}

	return (
		<main className={"RoutePluginsPluginPage" satisfies RoutePluginsPluginPage_ClassNames}>
			{breadcrumb}
			{activeSessionError ? (
				<div className={"RoutePluginsPluginPage-error" satisfies RoutePluginsPluginPage_ClassNames} role="alert">
					{activeSessionError}
					<MyButton ref={retryButtonRef} onClick={handleRetry}>
						Retry
					</MyButton>
				</div>
			) : (
				<PluginsUiFrame
					key={frameKey}
					membershipId={membershipId}
					pluginName={pluginName}
					pluginVersionId={plugin.pluginVersionId}
					entry={page.entry}
					title={page.title}
					kindLabel="plugin page"
					mintSession={mintSession}
					getInitContext={getInitContext}
					onError={handleFrameError}
				/>
			)}
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/$pluginName_/pages/$pageId")({
	component: RoutePluginsPluginPage,
});

export { Route };
// #endregion root
