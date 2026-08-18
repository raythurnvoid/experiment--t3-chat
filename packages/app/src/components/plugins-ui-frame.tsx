import "./plugins-ui-frame.css";

import { memo, useLayoutEffect, useRef, useState } from "react";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import {
	app_convex,
	app_convex_api,
	app_convex_deployment_url,
	type app_convex_FunctionReturnType,
} from "@/lib/app-convex-client.ts";
import type { Id } from "../../convex/_generated/dataModel.ts";

const CONVEX_HTTP_URL = import.meta.env.VITE_CONVEX_HTTP_URL as string;
const CONVEX_HTTP_ORIGIN = new URL(CONVEX_HTTP_URL).origin;

// Max time a frame attempt gets from mount to posting bonobo:init before it counts as failed.
const STARTUP_DEADLINE_MS = 15_000;

// An honest SDK repeats bonobo:ready only until init arrives (≈30 sends worst case). A page
// spamming ready past this allowance is misbehaving, and the frame dies.
const MAX_READY_MESSAGES = 64;

// #region frame
type PluginsUiFrame_ClassNames = "PluginsUiFrame";

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

// Page-chosen correlation ids for token refresh requests.
function is_bridge_message_id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

// Both mint mutations return the same Result shape, so the page mint's type is the shared contract.
type PluginsUiFrame_MintSessionResult = app_convex_FunctionReturnType<typeof app_convex_api.plugins_ui.mint_page_session>;

type PluginsUiFrame_Props = {
	membershipId: Id<"organizations_workspaces_users">;
	pluginName: string;
	pluginVersionId: Id<"plugins_versions">;
	entry: string;
	title: string;
	/** Human label used inside frame error messages, e.g. "plugin page" or "plugin view". */
	kindLabel: string;
	/**
	 * Mints this frame's session. Wrap in `useFn`: a new identity re-runs the bridge effect, which
	 * tears the frame down.
	 */
	mintSession: () => Promise<PluginsUiFrame_MintSessionResult>;
	/**
	 * Builds the `context` object posted in bonobo:init. The frame adds `userId` itself, so both
	 * context kinds carry it without each caller repeating it. Wrap in `useFn` for the same reason
	 * as `mintSession`.
	 */
	getInitContext: () => Record<string, unknown>;
	onError: (message: string) => void;
};

/**
 * The sandboxed iframe host shared by plugin pages and plugin file views. It loads the plugin's
 * published HTML entry, mints a `plu_` session through `mintSession`, and speaks the
 * bonobo:ready/init/token postMessage protocol with the SDK inside the frame. That protocol is
 * all the host does: the page talks to Convex itself, with a plugin-session JWT it gets from the
 * `/plugins-ui/session-jwt` exchange (init hands it the deployment URL for that). The caller keys
 * this component so that every meaningful change (tenant, version, view, retry) gets a fresh
 * document and bridge nonce.
 */
export const PluginsUiFrame = memo(function PluginsUiFrame(props: PluginsUiFrame_Props) {
	const { membershipId, pluginName, pluginVersionId, entry, title, kindLabel, mintSession, getInitContext, onError } =
		props;
	// The frame only mounts for an authenticated member, and the SDK requires `userId` in the init
	// context of both kinds.
	const { userId } = AppAuthProvider.useAuthenticated();
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [bridgeNonce] = useState(() => crypto.randomUUID());

	// Attach the message and load listeners before assigning src so the first page event cannot be missed.
	useLayoutEffect(() => {
		const iframeNode = iframeRef.current;
		const iframeWindow = iframeNode?.contentWindow;
		if (!iframeNode || !iframeWindow) {
			onError(`Failed to start the ${kindLabel} frame`);
			return;
		}

		const iframeSrc = new URL(`${CONVEX_HTTP_URL}/plugins-ui/${pluginVersionId}/${entry}`);
		iframeSrc.hash = new URLSearchParams({
			parentOrigin: window.location.origin,
			bridgeNonce,
		}).toString();
		let cancelled = false;
		let loadCount = 0;
		let sessionId: Id<"plugins_ui_sessions"> | null = null;
		let revokeStarted = false;
		let frameReady = false;
		let initMessage: unknown = null;
		let refreshInFlight: { requestId: string; promise: Promise<RefreshResponse> } | null = null;
		let lastRefreshResponse: RefreshResponse | null = null;
		let readyCount = 0;

		const startupDeadline = setTimeout(() => {
			if (!cancelled) {
				cancelled = true;
				onError(`The ${kindLabel} did not start in time`);
			}
		}, STARTUP_DEADLINE_MS);

		const revoke_session = (id: Id<"plugins_ui_sessions"> | null) => {
			if (!id || revokeStarted) {
				return;
			}
			revokeStarted = true;
			void app_convex
				.mutation(app_convex_api.plugins_ui.revoke_ui_session, {
					membershipId,
					sessionId: id,
				})
				.catch((error) => {
					console.error("[PluginsUiFrame] Failed to revoke ui session:", {
						error,
						pluginName,
					});
				});
		};

		const post_to_iframe = (message: unknown) => {
			if (cancelled || iframeRef.current !== iframeNode) {
				return;
			}
			iframeWindow.postMessage(message, CONVEX_HTTP_ORIGIN);
		};

		const token_error = (requestId: string, message: string): RefreshResponse => ({
			type: "bonobo:token-error",
			bridgeNonce,
			requestId,
			message,
		});

		const handle_ready = () => {
			// An honest SDK stops sending ready at init, so past the allowance the frame dies.
			readyCount += 1;
			if (readyCount > MAX_READY_MESSAGES) {
				cancelled = true;
				clearTimeout(startupDeadline);
				revoke_session(sessionId);
				onError(`The ${kindLabel} flooded the bridge and was stopped`);
				return;
			}
			frameReady = true;
			// The SDK repeats ready until init arrives, so replay the same init when it is available.
			if (initMessage) {
				post_to_iframe(initMessage);
				clearTimeout(startupDeadline);
			}
		};

		// Start the session while the iframe downloads and evaluates its assets. Keep the token in the
		// host until the nonce-bound ready message proves that this frame loaded the bridge SDK.
		const mintPromise = mintSession();
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
					onError(result._nay.message);
					return;
				}
				if (result._yay.pluginVersionId !== pluginVersionId) {
					revoke_session(result._yay.sessionId);
					cancelled = true;
					onError(`The installed plugin version changed while the ${kindLabel} was starting`);
					return;
				}

				sessionId = result._yay.sessionId;
				initMessage = {
					type: "bonobo:init",
					bridgeNonce,
					apiOrigin: CONVEX_HTTP_URL,
					// The SDK's own ConvexClient connects here and authenticates with the JWT it gets
					// from exchanging the session token at the asset origin.
					convexUrl: app_convex_deployment_url,
					token: result._yay.token,
					tokenExpiresAt: result._yay.expiresAt,
					// userId comes after the spread so the frame's authenticated value always wins.
					context: { ...getInitContext(), userId },
				};
				if (frameReady) {
					post_to_iframe(initMessage);
					clearTimeout(startupDeadline);
				}
			})
			.catch((error) => {
				console.error("[PluginsUiFrame] Failed to mint ui session:", {
					error,
					pluginName,
				});
				if (!cancelled) {
					cancelled = true;
					onError(`Failed to start the ${kindLabel} session`);
				}
			});

		const handle_refresh = (requestId: string) => {
			if (!sessionId) {
				post_to_iframe(token_error(requestId, `The ${kindLabel} session is not ready`));
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
				.mutation(app_convex_api.plugins_ui.refresh_ui_session, {
					membershipId,
					sessionId: currentSessionId,
				})
				.then((result) => {
					if (result._nay) {
						return token_error(requestId, result._nay.message);
					}
					if (result._yay.pluginVersionId !== pluginVersionId) {
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
					console.error("[PluginsUiFrame] Failed to refresh ui session:", {
						error,
						pluginName,
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
			// Trust only this iframe's WindowProxy, its asset origin, and the nonce placed in its fragment.
			if (cancelled || event.source !== iframeWindow || event.origin !== CONVEX_HTTP_ORIGIN) {
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
			} else if (message.type === "bonobo:token-refresh-request" && is_bridge_message_id(message.requestId)) {
				handle_refresh(message.requestId);
			}
		};

		const handle_load = () => {
			loadCount += 1;
			// The first load is the assigned asset. Any later load is page-controlled navigation.
			// The iframe runs its own ConvexClient, so revoking the session here is what actually
			// ends the page's subscriptions: every plugin door re-reads the session doc, and a
			// deleted doc turns those queries into null.
			if (loadCount > 1 && !cancelled) {
				cancelled = true;
				clearTimeout(startupDeadline);
				revoke_session(sessionId);
				onError(`The ${kindLabel} navigated away and was stopped`);
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
	}, [bridgeNonce, entry, getInitContext, kindLabel, membershipId, mintSession, onError, pluginName, pluginVersionId, userId]);

	return (
		// The frame and public API share the Convex origin, so normal JSON requests need no CORS
		// preflight. The host app uses a different origin, so the plugin still cannot reach its DOM.
		// `allow-forms` only lets the submit EVENT fire so plugin code can handle it in JS; the
		// asset CSP's `form-action 'none'` still blocks every real HTTP form submission.
		<iframe
			ref={iframeRef}
			className={"PluginsUiFrame" satisfies PluginsUiFrame_ClassNames}
			title={title}
			sandbox="allow-scripts allow-same-origin allow-forms"
			referrerPolicy="no-referrer"
		/>
	);
});
// #endregion frame
