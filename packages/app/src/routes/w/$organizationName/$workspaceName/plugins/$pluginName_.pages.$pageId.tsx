import "./plugin-page.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Puzzle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { Id } from "../../../../../../convex/_generated/dataModel.ts";

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

type RefreshResponse =
	| {
			type: "bonobo:token";
			bridgeNonce: string;
			requestId: string;
			token: string;
			tokenExpiresAt: number;
	  }
	| {
			type: "bonobo:token-error";
			bridgeNonce: string;
			requestId: string;
			message: string;
	  };

function is_refresh_request_id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function RoutePluginsPluginPageFrame(props: {
	membershipId: Id<"organizations_workspaces_users">;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	pluginName: string;
	pluginVersionId: Id<"plugins_versions">;
	pageId: string;
	pageTitle: string;
	entry: string;
	onError: (message: string) => void;
}) {
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [bridgeNonce] = useState(() => crypto.randomUUID());

	// Attach the message and load listeners before assigning src so the first page event cannot be missed.
	useLayoutEffect(() => {
		const iframeNode = iframeRef.current;
		const iframeWindow = iframeNode?.contentWindow;
		if (!iframeNode || !iframeWindow) {
			props.onError("Failed to start the plugin page frame");
			return;
		}

		const iframeSrc = new URL(`${CONVEX_HTTP_URL}/plugins-ui/${props.pluginVersionId}/${props.entry}`);
		iframeSrc.hash = new URLSearchParams({
			parentOrigin: window.location.origin,
			bridgeNonce,
		}).toString();
		let cancelled = false;
		let loadCount = 0;
		let sessionId: Id<"plugins_ui_sessions"> | null = null;
		let revokeStarted = false;
		let mintStarted = false;
		let initMessage: unknown = null;
		let refreshInFlight: { requestId: string; promise: Promise<RefreshResponse> } | null = null;
		let lastRefreshResponse: RefreshResponse | null = null;

		const startupDeadline = setTimeout(() => {
			if (!cancelled) {
				cancelled = true;
				props.onError("The plugin page did not start in time");
			}
		}, PAGE_STARTUP_DEADLINE_MS);

		const revoke_session = (id: Id<"plugins_ui_sessions"> | null) => {
			if (!id || revokeStarted) {
				return;
			}
			revokeStarted = true;
			void app_convex
				.mutation(app_convex_api.plugins_ui.revoke_page_session, {
					membershipId: props.membershipId,
					sessionId: id,
				})
				.catch((error) => {
					console.error("[RoutePluginsPluginPage] Failed to revoke page session:", {
						error,
						pluginName: props.pluginName,
					});
				});
		};

		const post_to_iframe = (message: unknown) => {
			if (cancelled || iframeRef.current !== iframeNode) {
				return;
			}
			// The sandboxed document has an opaque origin, so no concrete targetOrigin can match it.
			iframeWindow.postMessage(message, "*");
		};

		const token_error = (requestId: string, message: string): RefreshResponse => ({
			type: "bonobo:token-error",
			bridgeNonce,
			requestId,
			message,
		});

		const handle_ready = () => {
			// The SDK repeats ready until init arrives, so replay the same init instead of minting again.
			if (initMessage) {
				post_to_iframe(initMessage);
				return;
			}
			if (mintStarted) {
				return;
			}

			mintStarted = true;
			const mintPromise = app_convex.mutation(app_convex_api.plugins_ui.mint_page_session, {
				membershipId: props.membershipId,
				pluginName: props.pluginName,
			});
			void mintPromise
				.then((result) => {
					if (cancelled || iframeRef.current !== iframeNode) {
						// A mint can finish after Retry or unmount. Revoke it instead of posting to a stale frame.
						if (result._yay) {
							revoke_session(result._yay.sessionId);
						}
						return;
					}
					if (result._nay) {
						cancelled = true;
						props.onError(result._nay.message);
						return;
					}
					if (result._yay.pluginVersionId !== props.pluginVersionId) {
						revoke_session(result._yay.sessionId);
						cancelled = true;
						props.onError("The installed plugin version changed while the page was starting");
						return;
					}

					sessionId = result._yay.sessionId;
					initMessage = {
						type: "bonobo:init",
						bridgeNonce,
						apiOrigin: CONVEX_HTTP_URL,
						token: result._yay.token,
						tokenExpiresAt: result._yay.expiresAt,
						context: {
							pluginName: props.pluginName,
							pageId: props.pageId,
							pageTitle: props.pageTitle,
							organizationId: props.organizationId,
							workspaceId: props.workspaceId,
						},
					};
					post_to_iframe(initMessage);
					clearTimeout(startupDeadline);
				})
				.catch((error) => {
					console.error("[RoutePluginsPluginPage] Failed to mint page session:", {
						error,
						pluginName: props.pluginName,
					});
					if (!cancelled) {
						cancelled = true;
						props.onError("Failed to start the plugin page session");
					}
				});
		};

		const handle_refresh = (requestId: string) => {
			if (!sessionId) {
				post_to_iframe(token_error(requestId, "The plugin page session is not ready"));
				return;
			}
			// Replayed ids receive the same answer, while a different concurrent id is rejected.
			if (lastRefreshResponse?.requestId === requestId) {
				post_to_iframe(lastRefreshResponse);
				return;
			}
			if (refreshInFlight) {
				if (refreshInFlight.requestId === requestId) {
					void refreshInFlight.promise.then(post_to_iframe);
				} else {
					post_to_iframe(token_error(requestId, "Another session refresh is in progress"));
				}
				return;
			}

			const currentSessionId = sessionId;
			const promise: Promise<RefreshResponse> = app_convex
				.mutation(app_convex_api.plugins_ui.refresh_page_session, {
					membershipId: props.membershipId,
					sessionId: currentSessionId,
				})
				.then((result) => {
					if (result._nay) {
						return token_error(requestId, result._nay.message);
					}
					if (result._yay.pluginVersionId !== props.pluginVersionId) {
						return token_error(requestId, "The installed plugin version changed");
					}
					return {
						type: "bonobo:token",
						bridgeNonce,
						requestId,
						token: result._yay.token,
						tokenExpiresAt: result._yay.expiresAt,
					} satisfies RefreshResponse;
				})
				.catch((error) => {
					console.error("[RoutePluginsPluginPage] Failed to refresh page session:", {
						error,
						pluginName: props.pluginName,
					});
					return token_error(requestId, "Failed to refresh the session");
				});
			refreshInFlight = { requestId, promise };
			void promise.then((response) => {
				if (refreshInFlight?.promise === promise) {
					refreshInFlight = null;
					lastRefreshResponse = response;
				}
				post_to_iframe(response);
			});
		};

		const handle_message = (event: MessageEvent) => {
			// Trust only this iframe's opaque-origin WindowProxy and the nonce placed in its fragment.
			if (cancelled || event.source !== iframeWindow || event.origin !== "null") {
				return;
			}
			const data: unknown = event.data;
			if (typeof data !== "object" || data === null) {
				return;
			}
			const message = data as {
				type?: unknown;
				bridgeNonce?: unknown;
				requestId?: unknown;
			};
			if (message.bridgeNonce !== bridgeNonce) {
				return;
			}
			if (message.type === "bonobo:ready") {
				handle_ready();
			} else if (
				message.type === "bonobo:token-refresh-request" &&
				is_refresh_request_id(message.requestId)
			) {
				handle_refresh(message.requestId);
			}
		};

		const handle_load = () => {
			loadCount += 1;
			// The first load is the assigned asset. Any later load is page-controlled navigation.
			if (loadCount > 1 && !cancelled) {
				cancelled = true;
				clearTimeout(startupDeadline);
				revoke_session(sessionId);
				props.onError("The plugin page navigated away and was stopped");
			}
		};

		window.addEventListener("message", handle_message);
		iframeNode.addEventListener("load", handle_load);
		// src is assigned last, after every guard above is active.
		if (iframeNode.getAttribute("src") !== iframeSrc.href) {
			iframeNode.setAttribute("src", iframeSrc.href);
		}

		return () => {
			cancelled = true;
			clearTimeout(startupDeadline);
			window.removeEventListener("message", handle_message);
			iframeNode.removeEventListener("load", handle_load);
			revoke_session(sessionId);
		};
	}, [
		bridgeNonce,
		props.entry,
		props.membershipId,
		props.onError,
		props.organizationId,
		props.pageId,
		props.pageTitle,
		props.pluginName,
		props.pluginVersionId,
		props.workspaceId,
	]);

	return (
		<iframe
			ref={iframeRef}
			className={"RoutePluginsPluginPage-frame" satisfies RoutePluginsPluginPage_ClassNames}
			title={props.pageTitle}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
		/>
	);
}

function RoutePluginsPluginPage() {
	const { pluginName, pageId } = Route.useParams();
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const uiPages = useQuery(app_convex_api.plugins_ui.list_ui_pages, { membershipId });
	const retryButtonRef = useRef<HTMLButtonElement | null>(null);
	const [sessionError, setSessionError] = useState<{ frameKey: string; message: string } | null>(null);
	// Incremented by Retry. It keys the iframe so each attempt gets a fresh document, and re-runs
	// the bridge effect so the deadline timer restarts and the message listener attaches again.
	const [attempt, setAttempt] = useState(0);

	const plugin = uiPages?.find((item) => item.pluginName === pluginName) ?? null;
	const page = plugin?.pages.find((item) => item.id === pageId) ?? null;

	const pluginVersionId = plugin?.pluginVersionId ?? null;
	// Any tenant, version, page, or Retry change creates a new iframe and bridge nonce.
	const frameKey = `${membershipId}:${pluginVersionId ?? "missing"}:${pageId ?? "missing"}:${attempt}`;
	const activeSessionError = sessionError?.frameKey === frameKey ? sessionError.message : null;
	const handleFrameError = useCallback((message: string) => setSessionError({ frameKey, message }), [frameKey]);

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
				<RoutePluginsPluginPageFrame
					key={frameKey}
					membershipId={membershipId}
					organizationId={organizationId}
					workspaceId={workspaceId}
					pluginName={pluginName}
					pluginVersionId={plugin.pluginVersionId}
					pageId={pageId}
					pageTitle={page.title}
					entry={page.entry}
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
