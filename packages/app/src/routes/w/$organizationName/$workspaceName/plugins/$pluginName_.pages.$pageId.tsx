import "./plugin-page.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Puzzle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { plugins_UI_PAGES_PROTOCOL_VERSION } from "../../../../../../shared/plugins.ts";

const CONVEX_HTTP_URL = import.meta.env.VITE_CONVEX_HTTP_URL as string;

// Max time a page attempt gets from mount to posting bonobo:init before it counts as failed.
const PAGE_STARTUP_DEADLINE_MS = 15_000;

// #region root
type RoutePluginsPluginPage_ClassNames =
	| "RoutePluginsPluginPage"
	| "RoutePluginsPluginPage-loading"
	| "RoutePluginsPluginPage-missing"
	| "RoutePluginsPluginPage-error"
	| "RoutePluginsPluginPage-frame";

function RoutePluginsPluginPage() {
	const { pluginName, pageId } = Route.useParams();
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const uiPages = useQuery(app_convex_api.plugins_ui.list_ui_pages, { membershipId });
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const frameLoadCountRef = useRef(0);
	const retryButtonRef = useRef<HTMLButtonElement | null>(null);
	const [sessionError, setSessionError] = useState<string | null>(null);
	// Incremented by Retry. It keys the iframe so each attempt gets a fresh document, and re-runs
	// the bridge effect so the deadline timer restarts and the message handler subscribes again.
	const [attempt, setAttempt] = useState(0);

	const plugin = uiPages?.find((item) => item.pluginName === pluginName) ?? null;
	const page = plugin?.pages.find((item) => item.id === pageId) ?? null;
	const pageTitle = page?.title ?? null;

	// The effect depends on these scalars on purpose: page content never changes for a given
	// (pluginVersionId, pageId), so the bridge only re-subscribes when the rendered page actually
	// changes, not every time the query delivers a new result object.
	const pluginVersionId = plugin?.pluginVersionId ?? null;
	useEffect(() => {
		if (!pluginVersionId || pageId === undefined || pageTitle === null) {
			return;
		}

		// A stale error from a previously rendered page would keep the new page's iframe unmounted.
		setSessionError(null);
		// This effect runs after commit but before the new src's load event, so a legitimate page
		// switch starts the count from zero again.
		frameLoadCountRef.current = 0;

		// Startup deadline: if the asset service is down or the sandbox hangs, the page must show a
		// retryable error instead of loading forever. The timer is cleared only once bonobo:init is
		// posted (not already on bonobo:ready), so a hung session mint is covered too. The
		// functional update keeps an earlier, more specific error (mint failure, self-navigation)
		// from being overwritten.
		const startupDeadline = setTimeout(() => {
			setSessionError((current) => current ?? "The plugin page did not start in time");
		}, PAGE_STARTUP_DEADLINE_MS);

		let cancelled = false;

		const post_to_iframe = (message: unknown) => {
			// The sandboxed document has an opaque origin, so no concrete targetOrigin can ever
			// match it — "*" is the only option. This stays safe because we only post on the
			// contentWindow of our own iframe.
			iframeRef.current?.contentWindow?.postMessage(message, "*");
		};

		const mint_session = () =>
			app_convex.mutation(app_convex_api.plugins_ui.mint_page_session, { membershipId, pluginName });

		const handle_message = (event: MessageEvent) => {
			// The sandboxed (allow-scripts, no allow-same-origin) document has an opaque origin, so
			// event.origin is the string "null" and cannot identify the sender. The only reliable
			// check is that event.source is our iframe's contentWindow; everything else is dropped
			// silently.
			if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
				return;
			}

			const data: unknown = event.data;
			if (typeof data !== "object" || data === null) {
				return;
			}
			const message = data as { type?: unknown; protocolVersion?: unknown; requestId?: unknown };

			if (message.type === "bonobo:ready" && message.protocolVersion === plugins_UI_PAGES_PROTOCOL_VERSION) {
				mint_session()
					.then((result) => {
						if (cancelled) {
							return;
						}
						if (result._nay) {
							// Without a session the page cannot call the API at all, so replace the iframe
							// with the error instead of posting anything.
							setSessionError(result._nay.message);
							return;
						}

						post_to_iframe({
							type: "bonobo:init",
							protocolVersion: plugins_UI_PAGES_PROTOCOL_VERSION,
							apiOrigin: CONVEX_HTTP_URL,
							token: result._yay.token,
							tokenExpiresAt: result._yay.expiresAt,
							context: { pluginName, pageId, pageTitle, organizationId, workspaceId },
						});
						clearTimeout(startupDeadline);
					})
					.catch((error) => {
						console.error("[RoutePluginsPluginPage] Failed to mint page session:", { error, pluginName });
						if (!cancelled) {
							setSessionError("Failed to start the plugin page session");
						}
					});
				return;
			}

			if (message.type === "bonobo:token-refresh-request" && typeof message.requestId === "string") {
				const requestId = message.requestId;
				mint_session()
					.then((result) => {
						if (cancelled) {
							return;
						}
						if (result._nay) {
							post_to_iframe({ type: "bonobo:token-error", requestId, message: result._nay.message });
							return;
						}

						post_to_iframe({
							type: "bonobo:token",
							requestId,
							token: result._yay.token,
							tokenExpiresAt: result._yay.expiresAt,
						});
					})
					.catch((error) => {
						console.error("[RoutePluginsPluginPage] Failed to refresh page session:", { error, pluginName });
						if (!cancelled) {
							post_to_iframe({ type: "bonobo:token-error", requestId, message: "Failed to refresh the session" });
						}
					});
				return;
			}

			// Unknown message types are ignored: newer plugin SDKs may speak a newer protocol.
		};

		window.addEventListener("message", handle_message);
		return () => {
			cancelled = true;
			clearTimeout(startupDeadline);
			window.removeEventListener("message", handle_message);
		};
	}, [membershipId, organizationId, workspaceId, pluginName, pageId, pageTitle, pluginVersionId, attempt]);

	// The error replaces the iframe (and any focus that was inside it), so move focus to the one
	// available action.
	useEffect(() => {
		if (sessionError !== null) {
			retryButtonRef.current?.focus();
		}
	}, [sessionError]);

	const handleRetry = useFn(() => {
		setSessionError(null);
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

	// The session token travels exclusively over postMessage; only public identifiers go in the URL.
	const iframeSrc = `${CONVEX_HTTP_URL}/plugins-ui/${plugin.pluginVersionId}/${page.entry}?parentOrigin=${encodeURIComponent(window.location.origin)}&pageId=${page.id}`;

	return (
		<main className={"RoutePluginsPluginPage" satisfies RoutePluginsPluginPage_ClassNames}>
			{breadcrumb}
			{sessionError ? (
				<div className={"RoutePluginsPluginPage-error" satisfies RoutePluginsPluginPage_ClassNames} role="alert">
					{sessionError}
					<MyButton ref={retryButtonRef} onClick={handleRetry}>
						Retry
					</MyButton>
				</div>
			) : (
				<iframe
					key={attempt}
					ref={iframeRef}
					className={"RoutePluginsPluginPage-frame" satisfies RoutePluginsPluginPage_ClassNames}
					title={page.title}
					sandbox="allow-scripts"
					src={iframeSrc}
					onLoad={() => {
						frameLoadCountRef.current += 1;
						// Only the sandboxed document itself can navigate the frame (we never change
						// src, and it has no allow-top-navigation). After such a navigation the frame
						// may host a foreign document that still passes the event.source check, so
						// unmount the iframe before it can ask for tokens. What remains: the document
						// keeps the token it already had until it expires; the per-call liveness
						// checks and the 30-minute expiry limit that.
						if (frameLoadCountRef.current > 1) {
							setSessionError("The plugin page navigated away and was stopped");
						}
					}}
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
