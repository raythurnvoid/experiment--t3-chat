import { council_room_boot_js, council_room_client_js } from "./client.ts";

/**
 * The meeting room document the Worker serves at `GET /room`.
 *
 * The room lives on the Council origin, not the app origin, so a stranger's browser holding this
 * page shares no storage or cookie scope with the app (plan assumption E2). The document is fully
 * static: one pinned SDK script tag plus inline CSS and inline scripts, no other assets. The
 * Worker builds the response CSP from `council_room_page_external_origins`; the inline scripts
 * need `script-src` to allow them (hash or unsafe-inline) next to the CDN origin.
 *
 * Two entry paths, from the pinned room contract:
 * - Member host: `/room?m=<meetingId>#ticket=<one-time>` — the head boot script captures and
 *   erases the fragment before the SDK script runs, then the client exchanges the ticket. The
 *   `?m=` query survives the erase so a reload can resume the cookie session or fall back to the
 *   guest form. A later `#ticket=` paste is handled by `hashchange`.
 * - Guest: `/room?m=<meetingId>` — a join form asks for the join code, a display name, and an
 *   optional email. The code travels only in the POST body. A live cookie is resumed first.
 */

/**
 * The exact SDK build the M0 audits drove. Pinned by hash, not just by version: this page holds a
 * live participant token, so a changed file at the same CDN version must not run at all.
 */
const REALTIMEKIT_SDK_URL = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.1/dist/browser.js";
const REALTIMEKIT_SDK_INTEGRITY = "sha384-EVOSez95uObqUjiV3FecQZJtqOIGneHAfSwbpjvEU2UaxMFJ0BPWRgnDqhKygNm3";

/**
 * QA reads this marker from the served page to prove it is looking at this build of the room and
 * not a previous deploy. Bump it whenever the room document changes.
 */
const ROOM_REVISION = "council-room-r2";

/**
 * Every external origin the room page needs. The Worker builds the page's CSP from this list, so
 * a missing entry breaks the room in a way unit tests cannot see.
 *
 * Where each entry comes from:
 * - `https://cdn.jsdelivr.net` — the pinned SDK script tag above (`script-src`).
 * - `https://api.realtime.cloudflare.com` — hardcoded API base inside the pinned SDK bundle.
 * - The two wildcard entries cover every host the pinned bundle builds as
 *   `<servicePrefix>.realtime.cloudflare.com` with prefixes `api`, `api-silos`, `socket-edge`,
 *   `location`, `location-legacy`, and `da-collector`, plus the `wss://` forms the bundle derives
 *   from those https URLs. Verified against the exact SDK 2.0.1 bytes (SRI hash above), not
 *   against a live run: the media hostnames are handed out at runtime by the location service, so
 *   E2E must confirm no host outside `*.realtime.cloudflare.com` appears. The bundle also
 *   contains `api.cluster.dyte.in` and `api.testingv3.dyte.in`, which are non-production
 *   environment bases and are deliberately not allowed here.
 *
 * The actual audio/video media flows over WebRTC, which CSP `connect-src` does not govern, so no
 * media-transport entry belongs in this list.
 */
export const council_room_page_external_origins = [
	"https://cdn.jsdelivr.net",
	"https://api.realtime.cloudflare.com",
	"https://*.realtime.cloudflare.com",
	"wss://*.realtime.cloudflare.com",
];

/**
 * Shown before media starts for both roles: on the guest form and again in the pre-join lobby,
 * which is the only door into the call. Names are unverified by design, and the plan requires the
 * UI to say so rather than imply verified identity.
 */
const CONSENT_NOTICE =
	"This meeting is recorded. The name each participant types is attached to their part of the " +
	"transcript. Names are not verified — a name tells you which voice said what, not who a person really is.";

const ROOM_CSS = `
:root {
	--room-bg: #f6f6f8;
	--room-surface: #ffffff;
	--room-text: #1b1b20;
	--room-text-dim: #55555e;
	--room-border: #d4d4dc;
	--room-accent: #2f5fd0;
	--room-accent-text: #ffffff;
	--room-danger: #b3261e;
	--room-danger-text: #ffffff;
	--room-error: #b3261e;
	--room-focus: #2f5fd0;
	--room-recording: #b3261e;
}

@media (prefers-color-scheme: dark) {
	:root {
		--room-bg: #0b0b0e;
		--room-surface: #16161a;
		--room-text: #ececef;
		--room-text-dim: #9a9aa3;
		--room-border: #2c2c33;
		--room-accent: #8ab4ff;
		--room-accent-text: #0b0b0e;
		--room-danger: #ff8f8f;
		--room-danger-text: #1b0b0b;
		--room-error: #ff8f8f;
		--room-focus: #8ab4ff;
		--room-recording: #ff6d6d;
	}
}

* {
	box-sizing: border-box;
}

html,
body {
	margin: 0;
	padding: 0;
}

body {
	background: var(--room-bg);
	color: var(--room-text);
	font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	font-size: 16px;
	line-height: 1.5;
}

.room {
	max-width: 560px;
	margin: 0 auto;
	padding: 24px 16px 48px;
}

.room-header {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 8px 16px;
	margin-bottom: 24px;
}

.room-title {
	margin: 0;
	font-size: 20px;
	font-weight: 600;
}

.room-meeting-name {
	margin: 0;
	color: var(--room-text-dim);
}

.room-recording {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
	margin-inline-start: auto;
	font-weight: 600;
	color: var(--room-recording);
}

.room-recording-dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: var(--room-recording);
	animation: room-recording-pulse 1.6s ease-in-out infinite;
}

@keyframes room-recording-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.35;
	}
}

.view {
	background: var(--room-surface);
	border: 1px solid var(--room-border);
	border-radius: 12px;
	padding: 20px;
}

.view h2 {
	margin: 0 0 12px;
	font-size: 18px;
}

.view h2:focus {
	outline: none;
}

.view h3 {
	margin: 20px 0 8px;
	font-size: 15px;
}

.consent-notice {
	margin: 0 0 16px;
	padding: 12px;
	border: 1px solid var(--room-border);
	border-radius: 8px;
	color: var(--room-text-dim);
	font-size: 14px;
}

.field {
	margin-bottom: 16px;
}

.field label {
	display: block;
	margin-bottom: 4px;
	font-weight: 600;
	font-size: 14px;
}

.field input {
	width: 100%;
	min-height: 44px;
	padding: 8px 12px;
	border: 1px solid var(--room-border);
	border-radius: 8px;
	background: var(--room-bg);
	color: var(--room-text);
	font: inherit;
}

.field input[aria-invalid="true"] {
	border-color: var(--room-error);
}

.field-hint {
	margin: 4px 0 0;
	font-size: 13px;
	color: var(--room-text-dim);
}

.optional {
	font-weight: 400;
	color: var(--room-text-dim);
}

.form-error {
	margin: 0 0 16px;
	color: var(--room-error);
	font-weight: 600;
}

.button {
	appearance: none;
	min-height: 44px;
	min-width: 44px;
	padding: 8px 20px;
	border: 1px solid var(--room-border);
	border-radius: 8px;
	background: var(--room-surface);
	color: var(--room-text);
	font: inherit;
	cursor: pointer;
}

.button:hover {
	border-color: var(--room-text-dim);
}

.button:disabled {
	opacity: 0.6;
	cursor: default;
}

.button-primary {
	background: var(--room-accent);
	border-color: var(--room-accent);
	color: var(--room-accent-text);
	font-weight: 600;
}

.button-danger {
	background: var(--room-danger);
	border-color: var(--room-danger);
	color: var(--room-danger-text);
	font-weight: 600;
}

:focus-visible {
	outline: 2px solid var(--room-focus);
	outline-offset: 2px;
}

.lobby-facts {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 4px 16px;
	margin: 0 0 16px;
}

.lobby-facts dt {
	font-weight: 600;
	font-size: 14px;
}

.lobby-facts dd {
	margin: 0;
	font-size: 14px;
	overflow-wrap: anywhere;
}

.lobby-deadline {
	margin: 0 0 16px;
	font-size: 14px;
	color: var(--room-text-dim);
}

.call-status {
	margin: 0 0 12px;
	font-size: 14px;
	color: var(--room-text-dim);
}

.participant-list {
	margin: 0 0 16px;
	padding: 0;
	list-style: none;
}

.participant-list li {
	padding: 8px 0;
	border-bottom: 1px solid var(--room-border);
	overflow-wrap: anywhere;
}

.participant-count {
	margin: 0 0 16px;
	font-size: 13px;
	color: var(--room-text-dim);
}

.call-controls {
	display: flex;
	flex-wrap: wrap;
	gap: 12px;
}

.host-controls {
	margin-top: 20px;
	padding-top: 16px;
	border-top: 1px solid var(--room-border);
}

.host-controls-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 12px;
}

.host-confirm {
	margin-top: 12px;
	padding: 12px;
	border: 1px solid var(--room-border);
	border-radius: 8px;
}

.host-confirm p {
	margin: 0 0 12px;
	font-weight: 600;
}

.host-confirm-buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 12px;
}

@media (prefers-reduced-motion: reduce) {
	.room-recording-dot {
		animation: none;
	}
}
`;

export function council_room_page_html() {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="referrer" content="no-referrer" />
		<meta name="robots" content="noindex" />
		<meta name="council-room-revision" content="${ROOM_REVISION}" />
		<title>Council meeting room</title>
		<script>${council_room_boot_js}</script>
		<script src="${REALTIMEKIT_SDK_URL}" integrity="${REALTIMEKIT_SDK_INTEGRITY}" crossorigin="anonymous"></script>
		<style>${ROOM_CSS}</style>
	</head>
	<body>
		<main class="room">
			<header class="room-header">
				<h1 class="room-title">Council meeting</h1>
				<p class="room-meeting-name" id="meeting-title" hidden></p>
				<p class="room-recording" id="recording-indicator" role="status" hidden>
					<span class="room-recording-dot" aria-hidden="true"></span>
					Recording
				</p>
			</header>

			<section class="view" id="view-loading" role="status" aria-live="polite">
				<p>Preparing the meeting room…</p>
			</section>

			<section class="view" id="view-guest" aria-labelledby="guest-heading" hidden>
				<h2 id="guest-heading" tabindex="-1">Join the meeting</h2>
				<p class="consent-notice">${CONSENT_NOTICE}</p>
				<form id="guest-form" novalidate>
					<div class="field">
						<label for="guest-code">Join code</label>
						<input id="guest-code" name="code" type="text" autocomplete="off" spellcheck="false" required aria-describedby="guest-code-hint" />
						<p class="field-hint" id="guest-code-hint">The code the meeting host shared with you. If you were the host, get a new room link from the Council page.</p>
					</div>
					<div class="field">
						<label for="guest-name">Display name</label>
						<input id="guest-name" name="displayName" type="text" autocomplete="name" required maxlength="120" aria-describedby="guest-name-hint" />
						<p class="field-hint" id="guest-name-hint">Shown to other participants and attached to the transcript.</p>
					</div>
					<div class="field">
						<label for="guest-email">Email <span class="optional">(optional)</span></label>
						<input id="guest-email" name="email" type="email" autocomplete="email" aria-describedby="guest-email-hint" />
						<p class="field-hint" id="guest-email-hint">Not shown to other participants.</p>
					</div>
					<p class="form-error" id="guest-error" role="alert" hidden></p>
					<button type="submit" class="button button-primary" id="guest-submit">Continue</button>
				</form>
			</section>

			<section class="view" id="view-lobby" aria-labelledby="lobby-heading" hidden>
				<h2 id="lobby-heading" tabindex="-1">Ready to join</h2>
				<dl class="lobby-facts">
					<dt>Meeting</dt>
					<dd id="lobby-meeting"></dd>
					<dt>Joining as</dt>
					<dd id="lobby-name"></dd>
					<dt>Role</dt>
					<dd id="lobby-role"></dd>
				</dl>
				<div class="field" id="host-name-field" hidden>
					<label for="host-name">Display name</label>
					<input id="host-name" name="displayName" type="text" autocomplete="name" maxlength="120" aria-describedby="host-name-hint" />
					<p class="field-hint" id="host-name-hint">Shown to other participants and attached to the transcript.</p>
				</div>
				<p class="lobby-deadline" id="lobby-deadline"></p>
				<p class="consent-notice">${CONSENT_NOTICE}</p>
				<p class="form-error" id="lobby-error" role="alert" hidden></p>
				<button type="button" class="button button-primary" id="join-button">Join meeting</button>
			</section>

			<section class="view" id="view-call" aria-labelledby="call-heading" hidden>
				<h2 id="call-heading" tabindex="-1">In the meeting</h2>
				<p class="call-status" id="call-status" role="status" aria-live="polite"></p>
				<h3 id="participants-heading">Participants</h3>
				<p class="participant-count" id="participant-count"></p>
				<ul class="participant-list" id="participant-list" aria-labelledby="participants-heading"></ul>
				<div class="call-controls">
					<button type="button" class="button" id="mute-button">Mute microphone</button>
					<button type="button" class="button" id="leave-button">Leave meeting</button>
				</div>
				<div class="host-controls" id="host-controls" hidden>
					<h3>Host controls</h3>
					<div class="host-controls-buttons">
						<button type="button" class="button" id="start-recording-button">Start recording</button>
						<button type="button" class="button button-danger" id="end-meeting-button">End meeting</button>
					</div>
					<div class="host-confirm" id="host-confirm" hidden>
						<p id="host-confirm-text"></p>
						<div class="host-confirm-buttons">
							<button type="button" class="button button-primary" id="host-confirm-yes">Confirm</button>
							<button type="button" class="button" id="host-confirm-cancel">Cancel</button>
						</div>
					</div>
					<p class="form-error" id="host-error" role="alert" hidden></p>
				</div>
			</section>

			<section class="view" id="view-ended" aria-labelledby="ended-heading" hidden>
				<h2 id="ended-heading" tabindex="-1">Meeting ended</h2>
				<p id="ended-message"></p>
			</section>

			<section class="view" id="view-error" aria-labelledby="error-heading" hidden>
				<h2 id="error-heading" tabindex="-1">Something went wrong</h2>
				<p class="form-error" id="error-message" role="alert"></p>
			</section>
		</main>
		<script>${council_room_client_js}</script>
	</body>
</html>
`;
}
