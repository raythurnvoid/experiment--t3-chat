import "./plugins-ui-frame.css";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

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

/**
 * Load one plugin's frame from a local dev server instead of its published bundle, so a UI change
 * can be checked in the browser without publishing it first.
 *
 * The frame holds a plugin-session JWT and the bridge hands it across, so any origin this accepts
 * can act as the signed-in member. Two rules keep that safe. Vite erases this whole branch from a
 * production build, so the shipped bundle has no code path that loads or trusts another origin —
 * the check is not turned off in production, it is absent. And the override names ONE exact origin
 * for ONE version id: not a prefix, not a wildcard, not "any localhost port".
 *
 * This changes where the bundle is fetched from, never whether the installation may run one.
 * `mint_page_session` still refuses a version that is not ready, not reviewed, or has no pages, so
 * capability consent, version binding, and session revocation behave exactly as in production.
 *
 * The local origin serves the page at its ROOT: a dev server has no
 * `/plugins-ui/<versionId>/<entry>` path, that shape belongs to the published asset route.
 *
 * Plugin data needs one more switch. The SDK exchanges its session token at
 * `<apiOrigin>/plugins-ui/session-jwt`, which refuses every origin but its own unless the Convex
 * deployment sets PLUGINS_UI_DEV_EXCHANGE_ORIGIN to this same bare origin (a development-only
 * exception; see plugins_ui.ts). With that variable set, the frame completes the exchange and its
 * own Convex client authenticates, so pages that read plugin data work here too.
 */
function plugin_ui_dev_override() {
	if (!import.meta.env.DEV) {
		return null;
	}

	const pluginVersionId = import.meta.env.VITE_PLUGIN_UI_DEV_VERSION_ID as string | undefined;
	const origin = import.meta.env.VITE_PLUGIN_UI_DEV_ORIGIN as string | undefined;
	if (!pluginVersionId || !origin) {
		return null;
	}

	// Require the value to already BE an origin. A URL carrying a path or a query would make the
	// two uses below disagree: one would load that path, the other would compare the bare origin.
	const parsed = URL.parse(origin);
	if (!parsed || parsed.origin !== origin) {
		console.error("[PluginsUiFrame.devOverride] VITE_PLUGIN_UI_DEV_ORIGIN must be a bare origin", { origin });
		return null;
	}

	return { pluginVersionId, origin };
}

// Max time a frame attempt gets from mount to posting bonobo:init before it counts as failed.
const STARTUP_DEADLINE_MS = 15_000;

// An honest SDK repeats bonobo:ready only until init arrives (≈30 sends worst case). A page
// spamming ready past this allowance is misbehaving, and the frame dies.
const MAX_READY_MESSAGES = 64;

// #region theme
/**
 * The app's numbered colour scales, as `<scale>: <step count>`, and the custom property names they
 * declare in `app.css` (`--color-base-1-01` … `--color-base-1-12`).
 *
 * A plugin page is a cross-origin document, so it inherits none of the app's custom properties and
 * cannot read them. The host resolves every scale value and posts it under its real name. That is
 * one colour vocabulary for the app and its plugins: a plugin stylesheet uses the exact
 * `var(--color-base-1-03)` the app uses, and copies app CSS one to one. The list is static because
 * computed styles cannot be enumerated; the page route test parses `app.css` and fails when the two
 * drift apart. The shadcn tokens (`--background`, `--border`, `--primary`, …) are placeholders on
 * their way out, so they are not sent.
 */
const PLUGIN_THEME_SCALES = {
	"base-1": 12,
	"base-2": 12,
	"base-alt-1": 12,
	"base-alt-2": 12,
	fg: 12,
	accent: 10,
	"accent-alt": 10,
	green: 12,
	red: 12,
};

const PLUGIN_THEME_PROPERTY_NAMES = Object.entries(PLUGIN_THEME_SCALES).flatMap(([scale, steps]) =>
	Array.from({ length: steps }, (_, index) => `--color-${scale}-${String(index + 1).padStart(2, "0")}`),
);

type PluginsUiFrame_Theme = {
	mode: "light" | "dark";
	/** Keyed by the full custom property name, `--` prefix included, so a page can `setProperty` it as is. */
	tokens: Record<string, string>;
};

/**
 * Is this colour a dark one?
 *
 * Every scale value is written as a complete `oklch()` value in `app.css`, and OKLCH's first
 * component is perceived lightness from 0 to 1. So one number answers the question. A value this
 * cannot read answers dark, which is what the app paints today.
 */
function is_dark_theme_color(color: string) {
	const lightness = /^oklch\(\s*([\d.]+)(%?)/u.exec(color);
	if (!lightness) {
		return true;
	}

	const value = Number(lightness[1]);
	return (lightness[2] === "%" ? value / 100 : value) < 0.5;
}

/**
 * Read the theme the app is painted with right now.
 *
 * The values come from the root element, so they are whatever the current theme class resolves them
 * to. **The mode is read from the surface colour (`--color-base-1-01`) and not from that class**, so
 * the two halves of one message can never disagree. Today the app's numbered palette is dark-oriented and the theme
 * provider does not swap it: a member who picks "light" still sees the same dark surfaces. A frame
 * told `mode: "light"` beside those dark values paints its own light panels and its own dark text,
 * then reads the host's dark surface and its light text back over them, and the page ends up
 * unreadable. Reading the mode off the colour keeps the frame matching the app around it, and when
 * the palette does start swapping the mode follows it with no edit here.
 */
function read_plugin_theme(): PluginsUiFrame_Theme {
	const styles = getComputedStyle(document.documentElement);
	const tokens: Record<string, string> = {};
	for (const name of PLUGIN_THEME_PROPERTY_NAMES) {
		tokens[name] = styles.getPropertyValue(name).trim();
	}

	return {
		mode: is_dark_theme_color(tokens["--color-base-1-01"]) ? "dark" : "light",
		tokens,
	};
}
// #endregion theme

// #region frame
type PluginsUiFrame_ClassNames = "PluginsUiFrame";

type RefreshResponse =
	| {
			type: "bonobo:token";
			nonce: string;
			requestId: string;
			token: string;
			tokenExpiresAt: number;
	  }
	| {
			type: "bonobo:token-error";
			nonce: string;
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
	 * Mints this frame's session. Called once while the iframe loads, and again when a token
	 * refresh finds the session gone, to replace it for the same frame. Wrap in `useFn`: a new
	 * identity re-runs the bridge effect, which tears the frame down.
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
 * document and nonce. A session that expired while the device slept is not such a change: the
 * host mints a new session for the same document and answers the pending refresh with it, so the
 * page keeps its state and its live subscriptions.
 *
 * Trust is layered, and each layer answers one question. CSP `frame-ancestors` on the asset
 * response decides which origins may embed the frame at all. The `event.source` and
 * `event.origin` checks in the message handler decide which window is talking. The nonce decides
 * which mount a message belongs to, so a late reply from an earlier mount is dropped; it is
 * visible to the page and is not a secret. The `parentOrigin` in the fragment only tells the SDK
 * where to address its messages, so it never posts with `"*"`. Authority comes from none of
 * these: only the session mint below produces a token, and only for a signed-in member.
 */
export const PluginsUiFrame = memo(function PluginsUiFrame(props: PluginsUiFrame_Props) {
	const {
		membershipId,
		pluginName,
		pluginVersionId,
		entry,
		title,
		kindLabel,
		mintSession,
		getInitContext,
		onError,
	} = props;
	// The frame only mounts for an authenticated member, and the SDK requires `userId` in the init
	// context of both kinds.
	const { userId } = AppAuthProvider.useAuthenticated();
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const [nonce] = useState(() => crypto.randomUUID());
	// The bridge effect owns the frame's origin and its ready state, and it must never re-run for a
	// theme change: that would tear the frame down and remount the plugin page. It installs a sender
	// here instead, and the theme effect below calls whatever is installed.
	const postThemeRef = useRef<((theme: PluginsUiFrame_Theme) => void) | null>(null);

	// Attach the message and load listeners before assigning src so the first page event cannot be missed.
	useLayoutEffect(() => {
		const iframeNode = iframeRef.current;
		const iframeWindow = iframeNode?.contentWindow;
		if (!iframeNode || !iframeWindow) {
			onError(`Failed to start the ${kindLabel} frame`);
			return;
		}

		// Both the src and the trusted origin come from the same decision, so they can never
		// disagree: a frame loaded from the override but judged against the published origin would
		// render and then drop every bridge message, which reads as a broken plugin.
		const override = plugin_ui_dev_override();
		const devOverrideOrigin = override?.pluginVersionId === pluginVersionId ? override.origin : null;
		const trustedFrameOrigin = devOverrideOrigin ?? CONVEX_HTTP_ORIGIN;
		const iframeSrc = new URL(
			devOverrideOrigin === null ? `${CONVEX_HTTP_URL}/plugins-ui/${pluginVersionId}/${entry}` : devOverrideOrigin,
		);
		iframeSrc.hash = new URLSearchParams({
			parentOrigin: window.location.origin,
			nonce,
		}).toString();
		let cancelled = false;
		let loadCount = 0;
		let sessionId: Id<"plugins_ui_sessions"> | null = null;
		// Per id, not one flag for the frame: a re-mint gives the frame a second session id, and that
		// one must still be revocable after the first was marked gone.
		const revokedSessionIds = new Set<Id<"plugins_ui_sessions">>();
		let remintPending = false;
		let frameReady = false;
		let initMessage: unknown = null;
		let refreshInFlight: { requestId: string; promise: Promise<RefreshResponse> } | null = null;
		let lastRefreshResponse: RefreshResponse | null = null;
		let readyCount = 0;
		let lastThemeSent: string | null = null;

		const startupDeadline = setTimeout(() => {
			if (!cancelled) {
				cancelled = true;
				onError(`The ${kindLabel} did not start in time`);
			}
		}, STARTUP_DEADLINE_MS);

		const revoke_session = (id: Id<"plugins_ui_sessions"> | null) => {
			if (!id || revokedSessionIds.has(id)) {
				return;
			}
			revokedSessionIds.add(id);
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
			// The same origin the src was built from. A message sent to any other origin is dropped
			// by the browser, so an overridden frame would never receive its token.
			iframeWindow.postMessage(message, trustedFrameOrigin);
		};

		postThemeRef.current = (theme: PluginsUiFrame_Theme) => {
			// init carries the first theme, so nothing goes out before the page can receive it.
			const serialized = JSON.stringify(theme);
			if (!frameReady || !initMessage || serialized === lastThemeSent) {
				return;
			}
			lastThemeSent = serialized;
			post_to_iframe({ type: "bonobo:theme", nonce, theme });
		};

		const token_error = (requestId: string, message: string): RefreshResponse => ({
			type: "bonobo:token-error",
			nonce,
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
				const theme = read_plugin_theme();
				lastThemeSent = JSON.stringify(theme);
				initMessage = {
					type: "bonobo:init",
					nonce,
					// A cross-origin frame inherits no custom properties, so the page gets values it can
					// paint with immediately instead of a name it would have to resolve.
					theme,
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
				.then(async (result) => {
					if (result._nay) {
						// Every refresh failure except "Unauthorized" is transient and answers
						// token-error, so the SDK's own retry handles it. Host-initiated kills (ready
						// flood, second load) set `cancelled` before this handler can run, so a page
						// the host revoked on purpose never mints itself a new session.
						if (result._nay.message !== "Unauthorized" || cancelled) {
							return token_error(requestId, result._nay.message);
						}
						// "Unauthorized" means the session doc is gone for good: the server deleted
						// it because the device slept past the session expiry. Answering token-error
						// would leave the page dead, and remounting the frame would lose its state,
						// its draft, and its live subscriptions. So mint a new session for this same
						// document and answer this refresh with it. The gone doc has nothing left to
						// revoke.
						revokedSessionIds.add(currentSessionId);
						// One re-mint per session: a re-minted session that is gone again before it
						// ever refreshed means something keeps deleting sessions, so stop instead of
						// minting in a loop.
						if (remintPending) {
							cancelled = true;
							clearTimeout(startupDeadline);
							onError(`The ${kindLabel} session was lost`);
							return token_error(requestId, result._nay.message);
						}
						const minted = await mintSession();
						if (cancelled || iframeRef.current !== iframeNode) {
							// Same rule as the first mint: never hand a token to a stale frame.
							if (minted._yay) {
								revoke_session(minted._yay.sessionId);
							}
							return token_error(requestId, result._nay.message);
						}
						if (minted._nay) {
							cancelled = true;
							clearTimeout(startupDeadline);
							onError(minted._nay.message);
							return token_error(requestId, minted._nay.message);
						}
						if (minted._yay.pluginVersionId !== pluginVersionId) {
							revoke_session(minted._yay.sessionId);
							cancelled = true;
							clearTimeout(startupDeadline);
							onError("The installed plugin version changed");
							return token_error(requestId, "The installed plugin version changed");
						}
						sessionId = minted._yay.sessionId;
						remintPending = true;
						return {
							type: "bonobo:token",
							nonce,
							requestId,
							token: minted._yay.token,
							tokenExpiresAt: minted._yay.expiresAt,
						} satisfies RefreshResponse;
					}
					if (result._yay.pluginVersionId !== pluginVersionId) {
						return token_error(requestId, "The installed plugin version changed");
					}
					// A refresh that succeeds proves the current session is healthy again.
					remintPending = false;
					return {
						type: "bonobo:token",
						nonce,
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
			// Trust only this iframe's WindowProxy, the origin its src was built from, and the nonce
			// placed in its fragment.
			if (cancelled || event.source !== iframeWindow || event.origin !== trustedFrameOrigin) {
				return;
			}
			const data: unknown = event.data;
			if (typeof data !== "object" || data === null) {
				return;
			}
			const message = data as {
				type?: unknown;
				nonce?: unknown;
				requestId?: unknown;
			};
			if (message.nonce !== nonce) {
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
			postThemeRef.current = null;
			window.removeEventListener("message", handle_message);
			iframeNode.removeEventListener("load", handle_load);
			revoke_session(sessionId);
		};
	}, [nonce, entry, getInitContext, kindLabel, membershipId, mintSession, onError, pluginName, pluginVersionId, userId]);

	// Watch the root element rather than the theme context. The provider stamps the class in its own
	// effect and it is an ancestor of this frame, so a descendant effect keyed on the resolved theme
	// runs BEFORE the class is swapped and would read the values of the theme being left. The observer
	// runs after the DOM change, so it always reports what the frame's neighbours are painted with.
	useEffect(() => {
		const observer = new MutationObserver(() => {
			postThemeRef.current?.(read_plugin_theme());
		});
		observer.observe(document.documentElement, { attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	return (
		// The frame and public API share the Convex origin, so normal JSON requests need no CORS
		// preflight. The host app uses a different origin, so the plugin still cannot reach its DOM.
		// `allow-forms` only lets the submit EVENT fire so plugin code can handle it in JS; the
		// asset CSP's `form-action 'none'` still blocks every real HTTP form submission.
		//
		// `clipboard-write` is Permissions-Policy gated, and a cross-origin frame does not inherit it.
		// Without this grant every Copy button in every plugin rejects with `NotAllowedError`. Some
		// plugin values are shown once and cannot be read again, so a failed copy loses them for good.
		// This is the shared host frame, so the grant reaches every plugin. It is a reviewed host
		// capability, recorded in `.agents/skills/plugin-system/SKILL.md`. Do not add another feature
		// to this list without recording it the same way.
		<iframe
			ref={iframeRef}
			className={"PluginsUiFrame" satisfies PluginsUiFrame_ClassNames}
			title={title}
			sandbox="allow-scripts allow-same-origin allow-forms"
			allow="clipboard-write"
			referrerPolicy="no-referrer"
		/>
	);
});
// #endregion frame
