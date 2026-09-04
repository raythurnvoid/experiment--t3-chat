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
 * Plugin data needs no extra switch: the host delivers the plugin-session JWT together with the
 * session, so the frame's own Convex client authenticates from the init message. Only the fallback
 * exchange at `<apiOrigin>/plugins-ui/session-jwt` (used by an SDK that got no JWT) refuses every
 * origin but its own unless the Convex deployment sets PLUGINS_UI_DEV_EXCHANGE_ORIGIN to this same
 * bare origin (a development-only exception; see plugins_ui.ts).
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

// The SDK sends ready every 500 ms until init arrives. Within the 15-second startup deadline that
// is about 30 sends. A page that sends many more is misbehaving, and the frame stops.
const MAX_READY_MESSAGES = 64;

// Two replacement sessions minted closer together than this are a mint loop, and the frame stops.
// Nothing an honest frame does can ask for a second one this soon. The guard in `handle_refresh`
// tells the whole story.
const REMINT_MIN_GAP_MS = 5 * 60_000;

// #region theme
/**
 * The app's numbered colour scales from `app.css`, as `<scale>: <step count>`. Each scale declares
 * one custom property per step, `--color-<scale>-01` up to `--color-<scale>-<count>`.
 *
 * A plugin page is a cross-origin document, so it inherits none of the app's custom properties and
 * cannot read them. The host resolves every scale value and posts it under its real name. So the app
 * and its plugins share one colour vocabulary: a plugin stylesheet writes the same
 * `var(--color-base-1-03)` the app writes. The list is static because computed styles cannot be
 * enumerated. The page route test parses `app.css` and fails when a scale is added, renamed, or
 * resized there without this list following. The shadcn tokens (`--background`, `--border`,
 * `--primary`, …) are placeholders that will be removed, so they are not sent.
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

// The 104 custom property names the scales above declare, in the same two-digit form as `app.css`.
const PLUGIN_THEME_PROPERTY_NAMES = Object.entries(PLUGIN_THEME_SCALES).flatMap(([scale, steps]) =>
	Array.from({ length: steps }, (_, index) => `--color-${scale}-${String(index + 1).padStart(2, "0")}`),
);

type PluginsUiFrame_Theme = {
	mode: "light" | "dark";
	/**
	 * Keyed by the full custom property name, `--` prefix included, so a page can pass the key to
	 * `setProperty` as it is.
	 */
	tokens: Record<string, string>;
};

/**
 * Is this colour a dark one?
 *
 * Every scale value is written as a complete `oklch()` value in `app.css`, and OKLCH's first
 * component is perceived lightness from 0 to 1. So one number answers the question. If the value is
 * not an `oklch()` colour, treat it as dark. That is what the app paints today.
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
 * the two halves of one message can never disagree. Today the app's numbered palette is
 * dark-oriented and the theme provider does not swap it: a member who picks "light" still sees the
 * same dark surfaces. A frame told `mode: "light"` next to those dark values would paint light
 * panels with dark text, then apply the host's dark surface and light text over them, and the page
 * would be unreadable. Reading the mode from the colour keeps the frame matching the app. When the
 * palette starts swapping, the mode follows it with no edit here.
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
			jwt: string;
			jwtExpiresAt: number;
	  }
	| {
			type: "bonobo:token-error";
			nonce: string;
			requestId: string;
			message: string;
	  };

// The page picks the request id of a token refresh. Accept only a short non-empty string.
function is_bridge_message_id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64;
}

// Both mint actions return the same Result shape, so the page mint's type is the shared contract.
type PluginsUiFrame_MintSessionResult = app_convex_FunctionReturnType<typeof app_convex_api.plugins_ui.mint_page_session>;

/**
 * The `context` a mount point builds for bonobo:init, mirroring the SDK's `BonoboPageContext` and
 * `BonoboFileViewContext` minus `userId`, which the frame adds itself.
 *
 * The SDK drops an init whose context is missing a field, and it says nothing about why. The host
 * does not notice either: `handle_ready` clears the startup deadline the moment it posts init, so
 * that deadline can never fire for a context the SDK then rejects. The SDK stops its ready loop in
 * two places: when an init passes its context check (`frontend.js:554`), and when the page goes away
 * (its `pagehide` listener, `frontend.js:669`). A rejected context reaches neither of them, and the
 * page is still open, so the ready loop keeps running every 500 ms. The 65th ready lands at about 32
 * seconds and takes the flood branch below, and the member is told the page "flooded the bridge and
 * was stopped". That message blames the plugin, while the real cause is a context field this host
 * built wrong. So a renamed or forgotten field has to fail here, at compile time. Keep this in step
 * with `frontend.d.ts` in `packages/bonobo-plugin-sdk`.
 */
type PluginsUiFrame_InitContext =
	| {
			kind: "page";
			pluginName: string;
			pageId: string;
			pageTitle: string;
			organizationId: string;
			workspaceId: string;
	  }
	| {
			kind: "file_view";
			pluginName: string;
			fileViewId: string;
			fileViewTitle: string;
			organizationId: string;
			workspaceId: string;
			file: {
				fileNodeId: string;
				name: string;
				path: string;
				contentType: string;
			};
	  };

// Exported so both mount points can type their `useFn` callbacks against this contract.
export type PluginsUiFrame_Props = {
	membershipId: Id<"organizations_workspaces_users">;
	pluginName: string;
	pluginVersionId: Id<"plugins_versions">;
	entry: string;
	title: string;
	/** Human label used inside frame error messages. */
	kindLabel: "plugin page" | "plugin view";
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
	getInitContext: () => PluginsUiFrame_InitContext;
	/**
	 * Called when the bridge handshake finishes: the frame answered ready and the host has posted
	 * init to it. A mount point uses this to take down the placeholder it shows over the iframe,
	 * which paints nothing of its own for as long as the startup takes.
	 *
	 * It says the handshake finished. It does NOT say the plugin has painted anything. The page's
	 * own code starts running when init arrives, and how long it takes to draw after that is the
	 * plugin's business, not something this host can see.
	 *
	 * It fires at most once per mount. The SDK repeats ready every 500 ms until init reaches it, and
	 * the host answers every one of those with the same init, so without that rule a caller would be
	 * told "started" again and again.
	 *
	 * It does not fire when the frame is stopped before init goes out. A mint that was refused or
	 * threw, a mint whose plugin version changed under it, and the 15-second startup deadline all end
	 * the frame with no handshake. A caller that must also take its placeholder down in those cases
	 * does that from `onError`.
	 *
	 * `onStarted` is not the last word, and an `onError` does not mean it fired. A ready flood and a
	 * self-navigation stop the frame whether or not it ever started: the flood branch returns before
	 * init goes out, and the second-load branch never looks at init.
	 *
	 * Optional because a mount point that shows no placeholder has nothing to do with this. Unlike
	 * `onError`, a caller that drops it costs the member nothing.
	 *
	 * Its identity is free: the frame reads it from a ref, so a new closure on every render is fine
	 * and does not need `useFn`.
	 */
	onStarted?: () => void;
	onError: (message: string) => void;
};

/**
 * Turn a mint refusal into the sentence the member reads. Both mount points show this message in an
 * alert that replaces the frame, so it is the whole thing the member is left looking at, and the raw
 * "Rate limit exceeded" tells them nothing they can do about it. Only that one refusal is rewritten,
 * and it names the wait the server sent. "Rate limit exceeded" is the literal from
 * `rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE`.
 *
 * Every other refusal is passed through with the words the server chose, and none of those words
 * name the frame, the plugin, or anything the member can do. The mint doors in
 * `convex/plugins_ui.ts` answer only "Unauthenticated", "Unauthorized", "Not found", "Rate limit
 * exceeded", or "Permission denied" (that last one comes from
 * `access_control_db_authorize_membership`), so a member can end up reading two words beside a Retry
 * button. Usually those words only flash by. An uninstall or a disable refuses the mint, and it also
 * drops the page from the live `list_ui_pages` query, so the route replaces this alert with its own
 * "not available" message a moment later. Changing this message set is not a local edit, because the
 * route test pins the pass-through.
 *
 * There are two call sites and they are not the same event for the member.
 *
 * The first one is the first mint of a frame that has not started yet. Nothing is lost, the member
 * has a Retry button under the alert, and the rate-limit sentence fits what they did: they started
 * the page a moment ago.
 *
 * The second one is the re-mint that `handle_refresh` does after the server deleted the session doc.
 * It runs on a frame that already initialised, so the alert takes away a running page together with
 * the member's state, their draft, and their live subscriptions. The rate-limit sentence reads wrong
 * there. A member whose laptop slept for half an hour started the page once, not "too many times in
 * a row". Both call sites still share this one sentence. Giving the second one its own wording is a
 * product decision nobody has made yet.
 *
 * The host does not wait and mint again, the way `handle_refresh` waits and rotates again. A
 * rotation can wait because the page is still running and keeps its state while it waits. By the
 * time this function runs the frame is stopped at both call sites, and Retry is the only way back,
 * so waiting inside the host would only delay the same alert. Do not "fix" that asymmetry.
 */
function mint_error_message(kindLabel: PluginsUiFrame_Props["kindLabel"], message: string, retryAfterMs?: number) {
	if (message !== "Rate limit exceeded") {
		return message;
	}

	// The server sends the wait in milliseconds. Round it up so the member never retries too early.
	// The bucket always sends a number; the fallback covers a deployment older than this field.
	const waitSeconds = typeof retryAfterMs === "number" ? Math.ceil(retryAfterMs / 1000) : 5;
	const wait = waitSeconds === 1 ? "1 second" : `${waitSeconds} seconds`;
	return `The ${kindLabel} was started too many times in a row. Wait ${wait}, then press Retry.`;
}

/**
 * The sandboxed iframe host shared by plugin pages and plugin file views. It loads the plugin's
 * published HTML entry, mints a `plu_` session through `mintSession`, and speaks the
 * bonobo:ready/init/token postMessage protocol with the SDK inside the frame. That protocol is
 * all the host does: the page talks to Convex itself, with the plugin-session JWT that init and
 * every token message carry beside the `plu_` token (init also hands it the deployment URL). The
 * caller keys this component so that every meaningful change (tenant, version, view, retry) gets a
 * fresh document and nonce. A session that expired while the device slept is not such a change: the
 * host mints a new session for the same document and answers the pending refresh with it, so the
 * page keeps its state and its live subscriptions.
 *
 * Trust is layered, and each layer answers one question. CSP `frame-ancestors` on the asset
 * response decides which origins may embed the frame at all. The `event.source` and
 * `event.origin` checks in the message handler decide which window is talking. The nonce decides
 * which mount a message belongs to, so a late reply from an earlier mount is dropped; it is
 * visible to the page and is not a secret. The `parentOrigin` in the fragment only tells the SDK
 * where to address its messages, so it never posts with `"*"`. Authority comes from none of
 * these: only the session mint below produces a token, and only for a member the host has already
 * authenticated, a Clerk user or an anonymous one.
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
		onStarted,
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
	// `onStarted` is deliberately kept OUT of the bridge effect's dependency array, so the effect
	// reads the latest one from here. Its identity belongs to the mount point, and a mount point that
	// passes a plain arrow would hand the effect a new value on every render; the effect would then
	// re-run, revoke the session, and mint again while the page is already initialized, which is the
	// failure the comment above the `src` assignment describes. `onError` may be a dependency because
	// a mount point has to give it an identity that never changes, or one that changes only together
	// with the `key` that remounts the frame. A state setter and a `useCallback` on `frameKey` both
	// do that. Nothing forces that on `onStarted`.
	const onStartedRef = useRef(onStarted);

	// Keep the ref pointing at the current callback. This is a plain effect, so on mount it runs
	// AFTER the layout effect below installs the bridge. That is safe: the first bonobo:ready is a
	// message event from the frame, so it can never arrive before this render has finished. The
	// initial `useRef` value covers the callback the mount started with anyway.
	useEffect(() => {
		onStartedRef.current = onStarted;
	}, [onStarted]);

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
		// When the last replacement session was minted. `handle_refresh` reads it to tell a mint loop
		// from a device that slept twice.
		let lastRemintAt: number | null = null;
		let frameReady = false;
		let startedNotified = false;
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

		// Tell the caller the frame is running, once per mount. Init goes out from two places, and
		// which one sends it depends on whether the mint or the frame finished first, so both call
		// this. The flag is what keeps it to one call: the SDK repeats ready every 500 ms until it
		// gets an init, and every one of those repeats is answered with the same init again.
		const notify_started = () => {
			if (startedNotified) {
				return;
			}
			startedNotified = true;
			onStartedRef.current?.();
		};

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
			// A ready that arrives after init is answered with the same init again, because the SDK's
			// 500 ms retry can race the first init. A reload or a navigation is caught by the next
			// `load` event, which stops the frame and revokes the session.
			if (initMessage) {
				post_to_iframe(initMessage);
				clearTimeout(startupDeadline);
				notify_started();
				// init carries the theme read when the session was minted. If the member switched theme
				// while the frame was still loading, the sender above dropped that switch because the
				// frame was not ready. Send it now; the sender skips it when nothing changed.
				postThemeRef.current?.(read_plugin_theme());
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
					onError(mint_error_message(kindLabel, result._nay.message, result._nay.data?.retryAfterMs));
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
					// The SDK's own ConvexClient connects here and authenticates with the JWT below.
					convexUrl: app_convex_deployment_url,
					token: result._yay.token,
					tokenExpiresAt: result._yay.expiresAt,
					jwt: result._yay.jwt,
					jwtExpiresAt: result._yay.jwtExpiresAt,
					// userId comes after the spread so the frame's authenticated value always wins.
					context: { ...getInitContext(), userId },
				};
				// The frame answered ready while the mint was still running, so this is where init goes
				// out and where the frame counts as started.
				if (frameReady) {
					post_to_iframe(initMessage);
					clearTimeout(startupDeadline);
					notify_started();
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
			const rotate_session = () =>
				app_convex.action(app_convex_api.plugins_ui.refresh_ui_session, {
					membershipId,
					sessionId: currentSessionId,
				});
			const promise: Promise<RefreshResponse> = rotate_session()
				.then(async (first) => {
					let result = first;
					// Every rotation, page or file view, charges `plugins_ui_session_mint`, and that bucket
					// holds two tokens. A page also mints on that same bucket, so for a page a Retry, a
					// second plugin tab, or StrictMode's double mint in development can leave it empty for
					// a few seconds. A file view mints on its own larger bucket
					// (`plugins_ui_file_view_session_mint`, eight tokens), so only its rotations reach this
					// bucket and it sees this refusal far less often. Answering token-error here used to
					// end the page: the SDK's auth callback tries the refresh three times in all, waiting
					// one second and then two seconds in between. When the third try fails it answers null,
					// the frame's Convex client drops to unauthenticated, and the member sees a page that
					// stopped working with no host alert and no Retry.
					//
					// So wait the delay the server sent and rotate once more. "Rate limit exceeded" is the
					// literal from `rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE`.
					if (result._nay?.message === "Rate limit exceeded" && !cancelled) {
						const retryAfterMs = result._nay.data?.retryAfterMs;
						// This wait plus the two round trips around it must fit inside the SDK's 10-second
						// refresh deadline (`REFRESH_DEADLINE_MS` in
						// `packages/bonobo-plugin-sdk/frontend.js`). If the host answers after that, the SDK
						// has already dropped the request, the host still thinks it answered, so it never
						// calls `onError` and the member gets a dead page with no alert. What bounds the
						// wait is the bucket's rate: the refusal asks for one token, so the wait cannot
						// exceed `period / rate`, which is 5 seconds for `plugins_ui_session_mint` in
						// `packages/app/convex/rate_limiter.ts`. Changing that bucket to a slower rate
						// breaks this.
						if (typeof retryAfterMs === "number" && iframeRef.current === iframeNode) {
							await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
							if (!cancelled && iframeRef.current === iframeNode) {
								result = await rotate_session();
							}
						}
						// A refusal with no delay to wait, or a bucket still empty after waiting it, leaves
						// the page nothing left to wait for. Stop the frame so the member gets the alert and
						// its Retry button instead of a page that quietly stopped. Any other refusal from
						// the second try falls through to the branches below, so a session that went away
						// during the wait is still re-minted rather than killed.
						//
						// Answer the frame before setting `cancelled`, because `post_to_iframe` goes silent
						// as soon as that flag is set. Today the answer changes nothing the member sees.
						// Both mount points render their alert INSTEAD of the frame, so `onError` unmounts
						// the iframe in the same commit and takes the SDK's document with it, together
						// with its pending refresh and its refresh deadline. The stop paths below set
						// `cancelled` first, so their `token_error` return is dropped; that is the same
						// no-op written the other way round. Keep this order anyway. It costs nothing, and
						// it is the answer the SDK needs if a mount point ever shows its error beside a
						// frame it keeps alive.
						if (result._nay?.message === "Rate limit exceeded" && !cancelled) {
							const answer = token_error(requestId, result._nay.message);
							post_to_iframe(answer);
							cancelled = true;
							clearTimeout(startupDeadline);
							onError(`The ${kindLabel} could not renew its session`);
							return answer;
						}
					}

					if (result._nay) {
						// A refusal other than "Unauthorized" is answered with token-error. The SDK retries
						// it a few times and then gives up. Several of them are permanent — "Not found"
						// for a disabled installation, a changed version, a purged workspace or a deleted
						// file node, and the read-permission refusal for a restriction added mid-session —
						// but for uninstall, disable, upgrade, and purge the owner's live query replaces
						// or removes this frame before that matters. Host-initiated kills (ready flood,
						// second load) set `cancelled` before this handler can run, so a page the host
						// revoked on purpose never mints itself a new session.
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
						// Stop a mint loop, and tell it from a slept device by how fast the second ask
						// arrives.
						//
						// The page picks the request ids, so it can post one refresh request after
						// another. If every rotation finds the session gone, the host would mint a new
						// session for each one, seconds apart. That is the loop this stops.
						//
						// An honest frame cannot ask again that soon. The re-mint hands the SDK a JWT
						// that lasts the whole new session, and `jwt_is_fresh()`
						// (`packages/bonobo-plugin-sdk/frontend.js:304`) answers every ask from that JWT
						// until it is a minute from expiry. A session lasts `SESSION_TTL_MS` in
						// `convex/plugins_ui.ts`, half an hour, so the next ask is about half an hour
						// away. A device that sleeps through a second session lands far past this gap
						// and keeps its running page.
						//
						// This does not catch a slow loop. If something outside the frame keeps deleting
						// sessions, the host mints a new one at every session end, about twice an hour.
						// That is not a runaway, and each of those mints makes the page work again until
						// its session goes too.
						if (lastRemintAt !== null && Date.now() - lastRemintAt < REMINT_MIN_GAP_MS) {
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
							// The member gets the readable sentence from `onError`. The token-error below
							// never reaches the page: `cancelled` was set two lines up, so `post_to_iframe`
							// drops it, and the mount point replaces the iframe with its alert in the same
							// commit. It still carries the raw message because every arm of this function
							// must return a response, and because that is the right value to send if a
							// mount point ever keeps a stopped frame on screen.
							onError(mint_error_message(kindLabel, minted._nay.message, minted._nay.data?.retryAfterMs));
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
						lastRemintAt = Date.now();
						return {
							type: "bonobo:token",
							nonce,
							requestId,
							token: minted._yay.token,
							tokenExpiresAt: minted._yay.expiresAt,
							jwt: minted._yay.jwt,
							jwtExpiresAt: minted._yay.jwtExpiresAt,
						} satisfies RefreshResponse;
					}
					if (result._yay.pluginVersionId !== pluginVersionId) {
						return token_error(requestId, "The installed plugin version changed");
					}
					// A rotation that succeeds proves the session is alive, so the gap above starts over.
					lastRemintAt = null;
					return {
						type: "bonobo:token",
						nonce,
						requestId,
						token: result._yay.token,
						tokenExpiresAt: result._yay.expiresAt,
						jwt: result._yay.jwt,
						jwtExpiresAt: result._yay.jwtExpiresAt,
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
			//
			// The iframe runs its own Convex client, so revoking the session here is what actually
			// ends the page's subscriptions: every plugin door re-reads the session doc, and a
			// deleted doc turns those queries into null — or into an empty final page for the
			// paginated door, which cannot answer null. Either way the page stops seeing data.
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
		//
		// Under StrictMode the effect runs twice on mount. Setting the same src again would reload the
		// frame, so skip it when it is already set.
		//
		// What decides whether that skip is safe is timing, not whether the frame remounts. A re-run
		// before the frame has loaded is harmless: the SDK has not sent ready yet, so the new run tears
		// down and mints again while nothing is waiting for an answer. A re-run after the first init is
		// the fatal one: the cleanup revokes the session and the new run mints another, but the SDK
		// stops repeating ready once it is initialized, so no init reaches the page and the startup
		// deadline kills it.
		//
		// So a new dependency below must be one of two things: stable for the whole life of this mount,
		// or part of `frameKey`, which both mount points pass as this component's `key`, so a change
		// there remounts the frame instead of re-running this effect. `entry`, `pluginName`, and
		// `userId` are in neither group. They are safe only because they cannot change on their own:
		// `entry` and `pluginName` come from the version doc, and `pluginVersionId` pins both of them.
		// `pluginName` is that doc's `name`, and `entry` comes from its `pages` or `fileViews`. A
		// `plugins_versions` doc is not frozen. `convex/plugins.ts` patches that table in four places.
		// Only one of them rewrites those fields: the republish of an artifact that never became ready
		// (`convex/plugins.ts:535`). That patch selects its row by `name` and `artifactHash`, so it
		// cannot change the name. It also runs only while `sourceStatus` is not "ready", and a mint
		// refuses a version that is not ready. So a frame never runs on a doc that patch can still
		// touch. `userId` is pinned the same way by `membershipId`, because a membership doc belongs to
		// one user. Both `pluginVersionId` and `membershipId` ARE in `frameKey`.
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
