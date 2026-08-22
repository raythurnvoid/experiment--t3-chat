import { council_room_boot_js, council_room_client_js } from "./client.ts";

/**
 * The meeting room document the Worker serves at `GET /room`.
 *
 * The room lives on the Council origin, not the app origin. It is one static document with the
 * exact pinned RealtimeKit browser build, inline CSS, and inline scripts. The host ticket arrives
 * in the fragment and is erased before that third-party script runs.
 */

const REALTIMEKIT_SDK_URL = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.1/dist/browser.js";
const REALTIMEKIT_SDK_INTEGRITY = "sha384-EVOSez95uObqUjiV3FecQZJtqOIGneHAfSwbpjvEU2UaxMFJ0BPWRgnDqhKygNm3";

/**
 * QA reads this marker from the served page to prove which room build it has loaded.
 */
const ROOM_REVISION = "council-room-r3";

/**
 * The Worker uses this list for the room CSP. WebRTC media transport is not governed by
 * `connect-src`, so only the SDK, API, and socket origins belong here.
 */
export const council_room_page_external_origins = [
	"https://cdn.jsdelivr.net",
	"https://api.realtime.cloudflare.com",
	"https://*.realtime.cloudflare.com",
	"wss://*.realtime.cloudflare.com",
];

const CONSENT_NOTICE =
	"This meeting may be recorded. If the host starts recording, the name each participant types is attached to " +
	"their part of the transcript and the transcript is used to create a meeting summary. Names are not verified — " +
	"a name tells you which voice said what, not who a person really is.";

const ROOM_CSS = `
:root {
	color-scheme: dark;
	--room-bg: #08090b;
	--room-surface: #121419;
	--room-surface-raised: #1b1d22;
	--room-surface-soft: #25272d;
	--room-text: #f4f5f7;
	--room-text-dim: #aeb2bc;
	--room-border: #30333a;
	--room-accent: #5b82ff;
	--room-accent-soft: #263863;
	--room-danger: #df4b47;
	--room-danger-hover: #ed5a55;
	--room-error: #ff9995;
	--room-success: #6fd69b;
	--room-focus: #8eabff;
	--room-recording: #ef625d;
}

* {
	box-sizing: border-box;
}

[hidden] {
	display: none !important;
}

html,
body {
	width: 100%;
	height: 100%;
	margin: 0;
	padding: 0;
	overflow: hidden;
}

body {
	background:
		radial-gradient(circle at 50% -20%, rgb(58 70 99 / 24%), transparent 38%),
		var(--room-bg);
	color: var(--room-text);
	font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	font-size: 16px;
	line-height: 1.45;
}

button,
input {
	font: inherit;
}

button {
	touch-action: manipulation;
}

:focus-visible {
	outline: 3px solid var(--room-focus);
	outline-offset: 3px;
}

.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

.room {
	width: 100%;
	height: 100%;
	min-width: 0;
	display: flex;
	flex-direction: column;
}

.room-header {
	min-height: 72px;
	display: flex;
	align-items: center;
	gap: 18px;
	padding: 14px 24px;
	border-bottom: 1px solid rgb(255 255 255 / 9%);
	background: rgb(8 9 11 / 88%);
	backdrop-filter: blur(14px);
}

.room-brand {
	display: flex;
	align-items: center;
	gap: 11px;
	font-size: 19px;
	font-weight: 650;
	white-space: nowrap;
}

.room-mark {
	position: relative;
	width: 28px;
	height: 28px;
	border: 2px solid var(--room-accent);
	border-radius: 50%;
	box-shadow:
		inset 0 0 0 4px var(--room-bg),
		inset 0 0 0 6px var(--room-accent);
}

.room-mark::before,
.room-mark::after {
	content: "";
	position: absolute;
	background: var(--room-accent);
}

.room-mark::before {
	inset: -4px 11px;
	width: 2px;
}

.room-mark::after {
	inset: 11px -4px;
	height: 2px;
}

.room-header-divider {
	width: 1px;
	height: 26px;
	background: var(--room-border);
}

.room-meeting-name {
	min-width: 0;
	max-width: 42vw;
	margin: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 17px;
}

.room-elapsed {
	margin: 0;
	color: var(--room-text-dim);
	font-variant-numeric: tabular-nums;
}

.room-header-status {
	margin-inline-start: auto;
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 18px;
	min-width: 0;
}

.connection-status,
.room-recording {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
	font-size: 14px;
	white-space: nowrap;
}

.connection-dot,
.room-recording-dot {
	width: 9px;
	height: 9px;
	border-radius: 50%;
	background: currentColor;
}

.connection-status {
	color: var(--room-success);
}

.connection-status[data-state="reconnecting"],
.connection-status[data-state="problem"] {
	color: #f6bd60;
}

.room-recording {
	color: var(--room-text);
}

.room-recording-dot {
	color: var(--room-recording);
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

.view-card-shell {
	flex: 1;
	min-height: 0;
	display: grid;
	place-items: center;
	overflow: auto;
	padding: 28px 18px;
}

.view-card {
	width: min(100%, 520px);
	padding: 28px;
	border: 1px solid var(--room-border);
	border-radius: 20px;
	background: rgb(20 22 27 / 96%);
	box-shadow: 0 26px 80px rgb(0 0 0 / 36%);
}

.view-card h1,
.view-card h2 {
	margin: 0 0 10px;
	font-size: clamp(24px, 5vw, 32px);
	line-height: 1.15;
}

.view-card h1:focus,
.view-card h2:focus,
.call-heading:focus {
	outline: none;
}

.view-intro {
	margin: 0 0 22px;
	color: var(--room-text-dim);
}

.consent-notice {
	margin: 20px 0;
	padding: 13px 14px;
	border: 1px solid var(--room-border);
	border-radius: 12px;
	background: var(--room-surface-soft);
	color: var(--room-text-dim);
	font-size: 14px;
}

.field {
	margin-bottom: 16px;
}

.field label {
	display: block;
	margin-bottom: 6px;
	font-weight: 650;
	font-size: 14px;
}

.field input {
	width: 100%;
	min-height: 48px;
	padding: 10px 13px;
	border: 1px solid var(--room-border);
	border-radius: 10px;
	background: #0f1115;
	color: var(--room-text);
}

.field input:hover {
	border-color: #555a66;
}

.field input[aria-invalid="true"] {
	border-color: var(--room-error);
}

.field-hint,
.lobby-deadline {
	margin: 5px 0 0;
	font-size: 13px;
	color: var(--room-text-dim);
}

.optional {
	font-weight: 400;
	color: var(--room-text-dim);
}

.form-error {
	margin: 14px 0;
	color: var(--room-error);
	font-weight: 600;
}

.button {
	appearance: none;
	min-width: 44px;
	min-height: 44px;
	padding: 9px 18px;
	border: 1px solid var(--room-border);
	border-radius: 11px;
	background: var(--room-surface-soft);
	color: var(--room-text);
	cursor: pointer;
}

.button:hover:not(:disabled) {
	background: #30333a;
}

.button:disabled {
	opacity: 0.55;
	cursor: default;
}

.button-primary {
	background: var(--room-accent);
	border-color: var(--room-accent);
	color: #ffffff;
	font-weight: 700;
}

.button-primary:hover:not(:disabled) {
	background: #7193ff;
}

.button-danger {
	background: var(--room-danger);
	border-color: var(--room-danger);
	color: #ffffff;
	font-weight: 700;
}

.button-danger:hover:not(:disabled) {
	background: var(--room-danger-hover);
}

.button-wide {
	width: 100%;
}

.lobby-person {
	display: grid;
	grid-template-columns: 82px minmax(0, 1fr);
	align-items: center;
	gap: 18px;
	margin: 22px 0;
	padding: 16px;
	border-radius: 16px;
	background: var(--room-surface-soft);
}

.lobby-avatar {
	width: 82px;
	height: 82px;
	display: grid;
	place-items: center;
	border-radius: 50%;
	background: linear-gradient(145deg, #7696ff, #465eae);
	font-size: 30px;
	font-weight: 650;
}

.lobby-facts {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	gap: 5px 12px;
	margin: 0;
}

.lobby-facts dt {
	color: var(--room-text-dim);
	font-size: 13px;
}

.lobby-facts dd {
	min-width: 0;
	margin: 0;
	overflow-wrap: anywhere;
	font-size: 14px;
	font-weight: 600;
}

.lobby-progress {
	min-height: 24px;
	margin: 14px 0 0;
	color: var(--room-text-dim);
	text-align: center;
}

.call-view {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

.call-heading {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
}

.call-notices {
	position: absolute;
	z-index: 20;
	top: 84px;
	left: 50%;
	width: min(calc(100% - 32px), 620px);
	transform: translateX(-50%);
	pointer-events: none;
}

.call-status,
.audio-recovery {
	margin: 0 0 8px;
	padding: 10px 14px;
	border: 1px solid var(--room-border);
	border-radius: 10px;
	background: rgb(25 27 32 / 94%);
	box-shadow: 0 8px 24px rgb(0 0 0 / 26%);
	font-size: 14px;
	text-align: center;
	pointer-events: auto;
}

.audio-recovery {
	display: block;
	margin-inline: auto;
	color: var(--room-text);
	cursor: pointer;
}

.participant-stage {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	grid-auto-rows: minmax(220px, 1fr);
	gap: 10px;
	overflow: auto;
	padding: 16px 18px 118px;
}

.participant-stage[data-count="1"] {
	grid-template-columns: minmax(0, 1fr);
}

.participant-stage[data-layout="featured"] {
	grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr);
	grid-template-rows: repeat(2, minmax(0, 1fr));
}

.participant-stage[data-layout="featured"][data-side-columns="1"] {
	grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr);
}

.participant-stage[data-layout="featured"][data-side-columns="2"] {
	grid-template-columns: minmax(0, 1.75fr) repeat(2, minmax(0, 0.95fr));
}

.participant-stage[data-layout="featured"] .participant-tile[data-featured="true"] {
	grid-column: 1;
	grid-row: 1 / -1;
}

.participant-tile {
	position: relative;
	min-width: 0;
	min-height: 220px;
	overflow: hidden;
	border: 1px solid rgb(255 255 255 / 7%);
	border-radius: 14px;
	background:
		radial-gradient(circle at 50% 30%, rgb(82 87 99 / 34%), transparent 55%),
		#202226;
}

.participant-tile[data-featured="true"] {
	border: 2px solid var(--room-accent);
}

.participant-video {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
	background: #17191d;
}

.participant-tile[data-video="off"] .participant-video {
	display: none;
}

.participant-tile[data-video="on"] .participant-avatar {
	display: none;
}

.participant-avatar {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	font-size: clamp(34px, 7vw, 72px);
	font-weight: 500;
	color: #ffffff;
}

.participant-avatar span {
	display: grid;
	place-items: center;
	width: clamp(74px, 13vw, 132px);
	aspect-ratio: 1;
	border-radius: 50%;
	background: linear-gradient(145deg, #6c8cf2, #4057a1);
}

.participant-meta {
	position: absolute;
	left: 10px;
	right: 10px;
	bottom: 10px;
	display: flex;
	align-items: flex-end;
	justify-content: space-between;
	gap: 10px;
	pointer-events: none;
}

.participant-name,
.participant-mic {
	min-height: 38px;
	display: flex;
	align-items: center;
	padding: 7px 11px;
	border-radius: 9px;
	background: rgb(12 13 16 / 82%);
	backdrop-filter: blur(8px);
	font-size: 14px;
}

.participant-name {
	min-width: 0;
	max-width: calc(100% - 54px);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.participant-mic[data-muted="true"] {
	color: var(--room-recording);
}

.participant-mic[data-muted="false"] {
	display: none;
}

.participant-pin {
	position: absolute;
	z-index: 3;
	top: 10px;
	right: 10px;
	min-width: 44px;
	min-height: 44px;
	padding: 7px 10px;
	border: 1px solid rgb(255 255 255 / 16%);
	border-radius: 10px;
	background: rgb(12 13 16 / 76%);
	color: var(--room-text);
	cursor: pointer;
}

.participant-pin[aria-pressed="true"] {
	background: var(--room-accent);
	border-color: var(--room-accent);
}

@media (hover: hover) and (pointer: fine) {
	.participant-pin:not([aria-pressed="true"]) {
		opacity: 0.35;
	}

	.participant-tile:hover .participant-pin,
	.participant-pin:focus-visible {
		opacity: 1;
	}
}

.audio-bin {
	display: none;
}

.control-bar {
	position: absolute;
	z-index: 15;
	left: 50%;
	bottom: 18px;
	max-width: calc(100% - 32px);
	display: flex;
	align-items: stretch;
	justify-content: center;
	gap: 8px;
	padding: 10px;
	transform: translateX(-50%);
	border: 1px solid rgb(255 255 255 / 9%);
	border-radius: 18px;
	background: rgb(28 30 35 / 94%);
	box-shadow: 0 14px 40px rgb(0 0 0 / 38%);
	backdrop-filter: blur(18px);
}

.control {
	min-width: 84px;
	min-height: 68px;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 5px;
	padding: 8px 10px;
	border: 1px solid transparent;
	border-radius: 13px;
	background: transparent;
	color: var(--room-text);
	cursor: pointer;
}

.control:hover:not(:disabled) {
	background: var(--room-surface-soft);
}

.control:disabled {
	opacity: 0.58;
	cursor: default;
}

.control[aria-pressed="true"] .control-icon {
	box-shadow: 0 0 0 2px var(--room-accent);
}

.control-icon {
	position: relative;
	min-width: 38px;
	height: 38px;
	display: grid;
	place-items: center;
	padding: 0 8px;
	border-radius: 50%;
	background: #303238;
	font-size: 15px;
	font-weight: 700;
}

.control-icon svg {
	width: 21px;
	height: 21px;
}

.control-count-badge {
	position: absolute;
	top: -5px;
	right: -7px;
	min-width: 18px;
	height: 18px;
	display: grid;
	place-items: center;
	padding: 0 4px;
	border: 2px solid #303238;
	border-radius: 999px;
	background: var(--room-accent);
	color: #ffffff;
	font-size: 10px;
	font-style: normal;
	line-height: 1;
}

.control-label {
	font-size: 12px;
	white-space: nowrap;
}

.control-danger .control-icon {
	background: var(--room-danger);
}

.control-host-end {
	border-color: rgb(223 75 71 / 42%);
}

.host-confirm {
	position: fixed;
	z-index: 30;
	inset: 0;
	display: grid;
	place-items: center;
	padding: 20px;
	background: rgb(0 0 0 / 64%);
}

.host-confirm-card {
	width: min(100%, 420px);
	padding: 24px;
	border: 1px solid var(--room-border);
	border-radius: 16px;
	background: var(--room-surface-raised);
	box-shadow: 0 22px 70px rgb(0 0 0 / 55%);
}

.host-confirm-card h3 {
	margin: 0 0 8px;
}

.host-confirm-card p {
	margin: 0 0 18px;
	color: var(--room-text-dim);
}

.host-confirm-buttons {
	display: flex;
	justify-content: flex-end;
	gap: 10px;
}

.host-error {
	position: absolute;
	z-index: 21;
	left: 50%;
	bottom: 106px;
	width: min(calc(100% - 32px), 620px);
	margin: 0;
	padding: 10px 14px;
	transform: translateX(-50%);
	border: 1px solid rgb(255 153 149 / 38%);
	border-radius: 10px;
	background: rgb(45 21 23 / 96%);
	color: var(--room-error);
	text-align: center;
}

@media (max-width: 760px), (max-height: 650px) {
	html,
	body {
		overflow: hidden;
	}

	.room {
		min-height: 100dvh;
		height: 100dvh;
	}

	.room-header {
		position: relative;
		z-index: 14;
		min-height: 62px;
		padding: 10px 14px;
		gap: 10px;
	}

	.room-brand span:last-child,
	.room-header-divider {
		display: none;
	}

	.room-meeting-name {
		max-width: none;
		flex: 1;
		font-size: 14px;
	}

	.room-elapsed,
	.room-recording,
	.connection-status {
		font-size: 12px;
	}

	.room-header-status {
		margin-inline-start: 0;
		gap: 10px;
	}

	.call-view {
		overflow: hidden;
	}

	.call-notices {
		position: fixed;
		top: 70px;
	}

	.participant-stage,
	.participant-stage[data-count="1"],
	.participant-stage[data-layout="featured"],
	.participant-stage[data-layout="featured"][data-side-columns="1"],
	.participant-stage[data-layout="featured"][data-side-columns="2"] {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: none;
		grid-auto-rows: minmax(240px, 58vh);
		overflow: auto;
		padding: 12px 12px 12px;
	}

	.participant-stage[data-layout="featured"] .participant-tile[data-featured="true"] {
		grid-column: auto;
		grid-row: auto;
	}

	.participant-tile {
		min-height: 240px;
	}

	.control-bar {
		position: static;
		flex-shrink: 0;
		left: auto;
		max-width: none;
		flex-wrap: wrap;
		transform: none;
		border-radius: 16px 16px 0 0;
		padding: 8px max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
	}

	.control {
		flex: 1 1 76px;
		min-width: 68px;
		min-height: 58px;
		padding: 5px 7px;
	}

	.control-icon {
		height: 32px;
		min-width: 32px;
	}

	.host-error {
		position: fixed;
		bottom: 124px;
	}
}

@media (max-width: 480px) {
	.view-card-shell {
		place-items: start center;
		padding: 14px 10px;
	}

	.view-card {
		padding: 22px 18px;
		border-radius: 16px;
	}

	.lobby-person {
		grid-template-columns: 64px minmax(0, 1fr);
		gap: 13px;
		padding: 13px;
	}

	.lobby-avatar {
		width: 64px;
		height: 64px;
		font-size: 24px;
	}

	.connection-status,
	.room-recording {
		gap: 4px;
		font-size: 10px;
	}
}

@media (prefers-reduced-motion: reduce) {
	*,
	*::before,
	*::after {
		scroll-behavior: auto !important;
		animation-duration: 0.01ms !important;
		animation-iteration-count: 1 !important;
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
		<main class="room" id="room">
			<header class="room-header" id="room-header" hidden>
				<div class="room-brand"><span class="room-mark" aria-hidden="true"></span><span>Council</span></div>
				<span class="room-header-divider" aria-hidden="true"></span>
				<p class="room-meeting-name" id="meeting-title"></p>
				<p class="room-elapsed"><span class="sr-only">Meeting elapsed time: </span><span id="meeting-elapsed">00:00</span></p>
				<div class="room-header-status">
					<p class="connection-status" id="connection-status" data-state="connected" role="status">
						<span class="connection-dot" aria-hidden="true"></span><span>Connected</span>
					</p>
					<p class="room-recording" id="recording-indicator" hidden>
						<span class="room-recording-dot" aria-hidden="true"></span><span>Recording</span>
					</p>
				</div>
			</header>

			<section class="view-card-shell" id="view-loading" role="status" aria-live="polite">
				<div class="view-card"><p>Preparing the meeting room…</p></div>
			</section>

			<section class="view-card-shell" id="view-guest" aria-labelledby="guest-heading" hidden>
				<div class="view-card">
					<h1 id="guest-heading" tabindex="-1">Join the meeting</h1>
					<p class="view-intro">Enter the details the host shared with you.</p>
					<p class="consent-notice">${CONSENT_NOTICE}</p>
					<form id="guest-form">
						<div class="field">
							<label for="guest-code">Join code</label>
							<input id="guest-code" name="code" type="text" autocomplete="off" spellcheck="false" required aria-describedby="guest-code-hint" />
							<p class="field-hint" id="guest-code-hint">The code the meeting host shared with you.</p>
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
						<button type="submit" class="button button-primary button-wide" id="guest-submit">Continue</button>
					</form>
				</div>
			</section>

			<section class="view-card-shell" id="view-lobby" aria-labelledby="lobby-heading" hidden>
				<div class="view-card">
					<h1 id="lobby-heading" tabindex="-1">Ready to join?</h1>
					<p class="view-intro">Check the name other participants will see.</p>
					<div class="lobby-person">
						<div class="lobby-avatar" id="lobby-avatar" aria-hidden="true">?</div>
						<dl class="lobby-facts">
							<dt>Meeting</dt><dd id="lobby-meeting"></dd>
							<dt>Joining as</dt><dd id="lobby-name"></dd>
							<dt>Role</dt><dd id="lobby-role"></dd>
						</dl>
					</div>
					<div class="field" id="host-name-field" hidden>
						<label for="host-name">Display name</label>
						<input id="host-name" name="displayName" type="text" autocomplete="name" maxlength="120" aria-describedby="host-name-hint" />
						<p class="field-hint" id="host-name-hint">Shown to other participants and attached to the transcript.</p>
					</div>
					<p class="lobby-deadline" id="lobby-deadline"></p>
					<p class="consent-notice">${CONSENT_NOTICE}</p>
					<p class="form-error" id="lobby-error" role="alert" hidden></p>
					<button type="button" class="button button-primary button-wide" id="join-button">Join meeting</button>
					<p class="lobby-progress" id="lobby-progress" role="status" aria-live="polite"></p>
				</div>
			</section>

			<section class="call-view" id="view-call" aria-labelledby="call-heading" hidden>
				<h1 class="call-heading" id="call-heading" tabindex="-1">In the meeting</h1>
				<div class="call-notices">
					<p class="call-status" id="call-status" role="status" aria-live="polite" hidden></p>
					<button type="button" class="audio-recovery" id="play-audio-button" hidden>Play audio</button>
				</div>
				<div class="participant-stage" id="participant-list" role="list" aria-label="Meeting participants" data-count="0"></div>
				<div class="audio-bin" id="audio-bin" aria-hidden="true"></div>
				<div class="control-bar" role="group" aria-label="Meeting controls">
					<button type="button" class="control" id="mute-button" aria-pressed="false">
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span><span class="control-label">Microphone</span>
					</button>
					<button type="button" class="control" id="camera-button" aria-pressed="false">
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 10 5-3v10l-5-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></span><span class="control-label">Camera</span>
					</button>
					<button type="button" class="control" id="participant-count-button" disabled>
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 19c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 6.5a2.7 2.7 0 0 1 0 5.2M17.5 14c2 .7 3.5 2.4 3.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><em class="control-count-badge" id="participant-count">0</em></span><span class="control-label">Participants</span>
					</button>
					<button type="button" class="control" id="start-recording-button" hidden>
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg></span><span class="control-label">Start recording</span>
					</button>
					<button type="button" class="control control-host-end" id="end-meeting-button" hidden>
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13c4.3-3.5 9.7-3.5 14 0l-2.5 3-3-1.5v-2h-3v2L7.5 16z" fill="currentColor"/></svg></span><span class="control-label">End for all</span>
					</button>
					<button type="button" class="control control-danger" id="leave-button">
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13c4.3-3.5 9.7-3.5 14 0l-2.5 3-3-1.5v-2h-3v2L7.5 16z" fill="currentColor"/></svg></span><span class="control-label">Leave</span>
					</button>
				</div>
				<div class="host-confirm" id="host-confirm" role="dialog" aria-modal="true" aria-labelledby="host-confirm-heading" aria-describedby="host-confirm-text" hidden>
					<div class="host-confirm-card">
						<h3 id="host-confirm-heading">End this meeting?</h3>
						<p id="host-confirm-text">Everyone will leave the room. If recording was started, Council will prepare its files.</p>
						<div class="host-confirm-buttons">
							<button type="button" class="button" id="host-confirm-cancel">Cancel</button>
							<button type="button" class="button button-danger" id="host-confirm-yes">End meeting</button>
						</div>
					</div>
				</div>
				<p class="host-error" id="host-error" role="alert" hidden></p>
				<p class="sr-only" id="recording-live" role="status" aria-live="polite"></p>
			</section>

			<section class="view-card-shell" id="view-ended" aria-labelledby="ended-heading" hidden>
				<div class="view-card">
					<h1 id="ended-heading" tabindex="-1">Meeting ended</h1>
					<p id="ended-message"></p>
				</div>
			</section>

			<section class="view-card-shell" id="view-error" aria-labelledby="error-heading" hidden>
				<div class="view-card">
					<h1 id="error-heading" tabindex="-1">Something went wrong</h1>
					<p class="form-error" id="error-message" role="alert"></p>
				</div>
			</section>
		</main>
		<script>${council_room_client_js}</script>
	</body>
</html>
`;
}
