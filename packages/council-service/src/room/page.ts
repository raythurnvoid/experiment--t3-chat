import { council_room_boot_js, council_room_client_js } from "./client.ts";

/**
 * The meeting room document the Worker serves at `GET /room`.
 *
 * The room lives on the Council origin, not the app origin. It is one static document with the
 * exact pinned RealtimeKit browser build, inline CSS, and inline scripts. The host ticket arrives
 * in the fragment and is erased before that third-party script runs.
 *
 * A host opens `/room?m=<meetingId>#ticket=<one-time>`. The boot script in the head takes the
 * ticket out of the fragment and erases the fragment, then the client exchanges the ticket. The
 * erase keeps the `?m=` query. That is what lets a reload resume the cookie session, and fall back
 * to the guest form when there is no session. If someone pastes a fresh `#ticket=` into the open
 * page, the `hashchange` listener in `room/client.ts` runs the exchange again.
 *
 * A guest opens `/room?m=<meetingId>` with no fragment. The page first tries to resume a live
 * cookie session. If that fails it asks for the join code, a display name, and an optional email.
 * The join code only ever travels in a POST body.
 */

/**
 * The hash below belongs to this exact URL. Change one and the browser refuses the script, so
 * always update both together, and take the new hash from the file the CDN serves for the new
 * version.
 */
const REALTIMEKIT_SDK_URL = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.1/dist/browser.js";
const REALTIMEKIT_SDK_INTEGRITY = "sha384-EVOSez95uObqUjiV3FecQZJtqOIGneHAfSwbpjvEU2UaxMFJ0BPWRgnDqhKygNm3";

/**
 * QA reads this marker from the served page to prove which room build it has loaded. Bump it
 * whenever you change `room/page.ts` or `room/client.ts`. If you forget, the next QA run reads the
 * old value, matches it against the value the harness notes record, and wrongly concludes that the
 * Worker is serving its own tree.
 */
const ROOM_REVISION = "council-room-r31";

/**
 * The Worker builds the room page's CSP from this list. A missing entry breaks the room in a live
 * browser, and the unit tests in this folder cannot see that.
 *
 * Where each entry comes from:
 * - `https://cdn.jsdelivr.net` is the pinned script tag above.
 * - `https://api.realtime.cloudflare.com` is the API base hardcoded inside that pinned bundle.
 * - The two wildcards cover the hosts the bundle builds at runtime as
 *   `<prefix>.realtime.cloudflare.com`. The prefixes are `api`, `api-silos`, `socket-edge`,
 *   `location`, `location-legacy`, and `da-collector`. The bundle also derives `wss://` URLs from
 *   those https ones, so the socket form needs its own entry.
 *
 * These names were read out of the exact SDK 2.0.1 bytes the hash above pins, not out of a live
 * run. The location service hands out the media hostnames while a call runs, so an end-to-end run
 * still has to confirm that no host outside `*.realtime.cloudflare.com` shows up.
 *
 * The same bundle also contains `api.cluster.dyte.in` and `api.testingv3.dyte.in`. Those are the
 * vendor's non-production environments. They are left out on purpose. Do not add them.
 *
 * The audio and video themselves travel over WebRTC, which CSP `connect-src` does not govern, so
 * no media-transport host belongs in this list.
 */
export const council_room_page_external_origins = [
	"https://cdn.jsdelivr.net",
	"https://api.realtime.cloudflare.com",
	"https://*.realtime.cloudflare.com",
	"wss://*.realtime.cloudflare.com",
];

// Composite start writes one mixed audio file. Those lines use the fixed Meeting name, so do not
// promise that a typed display name labels who spoke.
const CONSENT_NOTICE =
	"This meeting may be recorded. If the host starts recording, Council saves one recording and one transcript, " +
	"and the transcript is used to create a meeting summary. Shared screens are captured in the recording. " +
	"The name you type is shown to other people in the room. It is not used to label who spoke.";

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
	/* The text inputs need a border of their own. --room-border measures 1.44:1 against the card
	   behind the field and the field's own fill is 1.04:1 against that card, so nothing marks where
	   the field is. WCAG 1.4.11 asks 3:1 for the boundary that identifies a control. This value
	   measures 3.09:1 against the card and 3.20:1 against the fill. Keep it separate from
	   --room-border: the card and chip borders are decoration, they carry no such floor, and
	   brightening them all would turn every panel edge into a line that asks to be read. */
	--room-input-border: #5f6474;
	/* Accent and danger each come in two values, and the pairs must not be merged. The plain token
	   paints shapes that carry no text, where the contrast floor is 3:1. The text-safe one paints a
	   surface with a label on it, where the floor is 4.5:1. One value per colour cannot do both.
	   Darkening the accent until white text passes drops the featured-tile border to 2.94:1 on
	   --room-surface-soft, and the count badge, which paints its digit in the page background
	   colour, from 5.77:1 to 4.42:1. Darkening the danger drops the end-meeting circle to 3.37:1
	   against the control bar, and to 2.79:1 when bright video shows through the bar. */
	--room-accent: #5b82ff;
	/* White text 5.08:1, and the pinned pin label 4.66:1. The hover value is lighter, the way every
	   other hover in this file is, and still measures 4.70:1. */
	--room-accent-text-safe: #4968cc;
	--room-accent-text-safe-hover: #4c6dd6;
	--room-accent-soft: #263863;
	--room-danger: #df4b47;
	/* White text 5.00:1, where the bright value above measured 4.01:1. Hover 4.64:1. */
	--room-danger-text-safe: #c4423e;
	--room-danger-text-safe-hover: #cd4541;
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

/* These two controls float over the tiles, so when that peer's camera is on the 3px gap inside the
   ring and the space outside it are both raw video. --room-focus then measures 2.23:1 on a white
   frame and 1.77:1 on mid-grey, under the 3:1 WCAG 1.4.11 asks of a focus indicator. The shadow
   below paints one band of page colour from the button edge out to 9px. An outer box-shadow is
   painted under the outline, so the ring still lands on top of it at 3px to 6px: the ring keeps its
   gap and both of its neighbours become #08090b at 8.93:1, in every tile state.
   Do not close the gap with outline-offset: 0 instead. That puts the ring straight on the button's
   own edge, which is a 1px white-16% border and composites to 2.65:1 over a white frame, and to
   2.28:1 while the pin is pressed and painted --room-accent-text-safe.
   The band stops at 9px because the pin sits 10px inside a tile that clips its overflow, so a wider
   band would be cut off. On .audio-recovery it takes the place of the ambient shadow while the
   button is focused. */
.participant-pin:focus-visible,
.audio-recovery:focus-visible {
	box-shadow: 0 0 0 9px var(--room-bg);
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

.view-card h1 {
	margin: 0 0 10px;
	font-size: clamp(24px, 5vw, 32px);
	line-height: 1.15;
}

/* Only the hidden call heading kills the ring. showView moves focus to #guest-heading,
   #lobby-heading, #ended-heading and #error-heading on every view change, and all four are
   .view-card h1. While .view-card h1:focus sat in this selector it out-specified the :focus-visible
   rule above, and :focus matches whenever :focus-visible does, so not one of the four ever painted a
   ring. A member moving by keyboard was left with no mark at all. The error card is the worst of the
   four: it holds no focusable control, so the next Tab reveals nothing either. The Council plugin
   draws the ring for the same reason in plugins/bonobo-plugin-council/src/council.css.
   .call-heading keeps the rule because it is 1px and clipped, so a ring there would mark nothing
   anybody can see. */
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
	border: 1px solid var(--room-input-border);
	border-radius: 10px;
	background: #0f1115;
	color: var(--room-text);
}

/* Hover has to stay lighter than the resting border. The hover this replaces was darker than the
   new resting value and measured 2.64:1 against the card, so it would have dimmed the boundary
   below the 3:1 floor exactly while the pointer was on the field. This value measures 3.75:1. */
.field input:hover {
	border-color: #6b7183;
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

.button:hover:not(:disabled):not([aria-busy="true"]) {
	background: #30333a;
}

/* A button that is waiting for an answer marks itself busy instead of disabling itself, so that it
   keeps keyboard focus while it waits. It has to look the same as one that cannot be pressed, so
   the hover rules skip a busy button too. #guest-submit, #join-button and #rejoin-button each go
   busy for as long as their request takes, and they drop every press until it answers. The .control
   family further down carries the same pair of rules.

   The two states dim by different means, and they must not share one rule. A disabled button is an
   inactive control, so WCAG 1.4.3 asks nothing of its label and opacity may fade the whole box. A
   busy button is not inactive: it stays enabled, keeps its place in the tab order, and the browser
   reports it as pressable. It also swaps its label to "Checking invite...", "Joining..." or
   "Rejoining...", and that sentence is the only thing telling the member what the room is doing.
   Opacity fades the label together with the fill, so it fades that very sentence. Measured on the
   lobby card: white on the accent is 5.08:1 at rest and 3.19:1 at opacity 0.55, under the 4.5:1 a
   16px bold label needs. So a busy button dims its fill alone, in the rule under .button-primary
   below. Do not raise the opacity instead. Both sides fade together, so the ratio barely moves:
   0.75 reaches 4.12:1 and 0.85 only 4.53:1, and by then nothing looks dimmed at all. */
.button:disabled {
	opacity: 0.55;
	cursor: default;
}

.button[aria-busy="true"] {
	cursor: default;
}

.button-primary {
	background: var(--room-accent-text-safe);
	border-color: var(--room-accent-text-safe);
	color: #ffffff;
	font-weight: 700;
}

.button-primary:hover:not(:disabled):not([aria-busy="true"]) {
	background: var(--room-accent-text-safe-hover);
}

/* Dim the accent fill and leave the label opaque: white on it stays above 9.4:1. Read that as a
   floor, not one number. A translucent fill lets the body radial gradient through the card, so the
   exact ratio moves with where the card sits: 9.45:1 clear of the gradient and 9.41:1 at its
   strongest. The fill itself paints the same colour the old rule painted, so the button looks
   exactly as dimmed as before and only the label stopped fading.
   The border gains a little. The background paints under it, so a 55% border now sits on the
   already-dimmed fill and reads 2.72:1 against the card, where the old rule composited border and
   fill in one layer and left them the same colour, 1.92:1. Neither reaches the 3:1 WCAG 1.4.11 asks
   of a control boundary, and the resting button measures 3.58:1. The label carries the button while
   it waits, so leave it there rather than lightening the fill until the boundary passes: the room's
   own accent comment above explains why one accent value cannot serve both floors.
   Name .button-primary here, not .button. A rule on .button would out-rank .button-primary's own
   background and paint a busy Join in the plain grey fill, the same wrong-colour swap the hover
   guards avoid. Every family that can go busy needs its own rule, so add one beside a new family
   that starts marking itself busy. Today all three busy buttons are .button-primary. */
.button-primary[aria-busy="true"] {
	background: color-mix(in srgb, var(--room-accent-text-safe) 55%, transparent);
	border-color: color-mix(in srgb, var(--room-accent-text-safe) 55%, transparent);
}

.button-danger {
	background: var(--room-danger-text-safe);
	border-color: var(--room-danger-text-safe);
	color: #ffffff;
	font-weight: 700;
}

.button-danger:hover:not(:disabled):not([aria-busy="true"]) {
	background: var(--room-danger-text-safe-hover);
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

/* This box floats over the tiles and is usually empty, so it must not swallow clicks meant for a
   tile below it. Only the recovery button below takes its pointer events back, because it is the
   one thing here anybody presses. The status line must not: it is a <p role="status"> nobody
   clicks, and while it took pointer events too that 620x42 paragraph covered the pin buttons on
   the top row of tiles. With "Connection lost. Reconnecting…" showing, elementFromPoint at the pin
   centres answered "call-status" for two of five pins at 1440x900 and 1024x600, three of five at
   720x450, and the top pin at 390x844. That message carries no auto-clear, so the unpin button was
   dead for the whole outage. */
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
}

.audio-recovery {
	display: block;
	margin-inline: auto;
	color: var(--room-text);
	cursor: pointer;
	pointer-events: auto;
}

/* The control bar floats over the bottom of this area, so the padding below leaves it a lane.
   Without it the last row of tiles scrolls to a stop underneath the buttons. The short-window
   rules lower the lane with the bar. The phone rules drop it to nothing, because there the bar
   stops floating and becomes a normal block under the stage.
   .host-error sits on the same lane, so its bottom offset carries this same number in every block
   that keeps the bar floating. Move the two together. */
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

/* Past the featured layout the stage is a plain grid. Let it take as many columns as the width
   allows, so a twelve-person meeting is not a six-row scroll of two columns. */
.participant-stage[data-layout="grid"] {
	grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
}

/* The two rows carry the same floor as the tiles they hold and as grid-auto-rows above. With a
   floor of 0 the rows shrank under the tile min-height, the tiles kept their own size, and the
   bottom row ran on underneath the floating control bar: 40px of it at 683x384. A tile behind the
   bar cannot be reached at all, while a stage that scrolls can, so let the rows hold their floor
   and let the stage scroll.
   The rows are the only thing this rule sets. renderStageLayout writes data-side-columns on the
   same line it writes data-layout="featured", and it only ever writes "1" or "2", so one of the two
   rules below always matches and always wins on specificity. A columns list here could never paint:
   the four-track one that used to sit here implied seven placeable tiles, where
   FEATURED_LAYOUT_MAX_TILES caps the layout at five. */
.participant-stage[data-layout="featured"] {
	grid-template-rows: repeat(2, minmax(220px, 1fr));
}

.participant-stage[data-layout="featured"][data-side-columns="1"] {
	grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr);
}

.participant-stage[data-layout="featured"][data-side-columns="2"] {
	grid-template-columns: minmax(0, 1.75fr) repeat(2, minmax(0, 0.95fr));
}

/* The row span below counts rows in the explicit grid only, so the featured tile always covers
   exactly the two rows declared above. Those two rows now have a floor, so on a short window they
   can add up to more than the stage shows, and the featured tile grows with them into the part
   that scrolls. The client caps the featured layout at five tiles for a related reason: a sixth
   tile would open an implicit row that this span never reaches. */
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

/* The row wraps because the two state chips below refuse to shrink. Without the wrap they would
   keep their full width and run past the tile edge, which the tile then cuts off. With it a chip
   that no longer fits beside its neighbour moves onto its own line and stays readable. The row has
   no top and no height, so it grows upward from the tile's bottom edge. */
.participant-meta {
	position: absolute;
	left: 10px;
	right: 10px;
	bottom: 10px;
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	justify-content: space-between;
	gap: 10px;
	pointer-events: none;
}

/* The min-width and the overflow are what let the name chip give ground and then cut its own text.
   The stage can show a tile with only about 107px of room inside, and a name, a "No video" chip and
   a "Mic off" chip do not fit in that. Without these two nothing in the row could shrink and the
   row ran past the tile edge, where the tile cut it off: 28px past the edge at 560x420. The two
   state chips below opt back out of the shrinking and take their own line instead. */
.participant-name,
.participant-video-state,
.participant-mic {
	min-width: 0;
	min-height: 38px;
	display: flex;
	align-items: center;
	overflow: hidden;
	padding: 7px 11px;
	border-radius: 9px;
	background: rgb(12 13 16 / 82%);
	backdrop-filter: blur(8px);
	font-size: 14px;
}

/* This chip is the one that may be cut short, and it says so with an ellipsis. That needs a block
   container: text-overflow only applies to the inline content of a block, and in the shared flex
   box above the text is an anonymous flex item, so the declaration did nothing and long names were
   cut mid-glyph ("Sofia Herna" with no mark) from 1024x600 down. The line height replaces what
   align-items used to do: 24px plus the 7px padding on each side is the 38px floor above, so the
   text still sits in the middle of the chip and nothing else moves. */
.participant-name {
	min-width: 0;
	display: block;
	overflow: hidden;
	line-height: 24px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* These two are short fixed labels, so they never shrink and never break a word. Both used to do
   both: with the default white-space their text wrapped, and the overflow above then cut the
   second line off, leaving "Mic" / "off" at 720x450 and "Mi" / "of" at 560x420. The mic chip is
   the only place the room shows a muted participant — there is no icon behind it — so a cut chip
   loses that state outright (WCAG 1.4.4 Resize text: 720x450 is a 1440x900 window at 200% zoom).
   The wrap on .participant-meta is what keeps flex-shrink: 0 safe. */
.participant-video-state,
.participant-mic {
	flex-shrink: 0;
	white-space: nowrap;
}

/* The client blanks this label instead of removing the element, so every tile that does have a
   picture would paint an empty chip. Hide the chip while the label is blank. Remove this rule only
   together with the blanking in room/client.ts. */
.participant-video-state:empty {
	display: none;
}

/* The client writes data-muted="true" for both labels this chip can carry: "Mic off" when the peer
   muted themselves, and the neutral "No audio" when the room is past the SDK's audio subscription
   limit and never receives that peer at all. Both stay red on purpose, and the attribute gives CSS
   no way to tell them apart anyway. To a listener the two are the same fact — you cannot hear this
   person — and unlike the missing picture, which the avatar already shows, missing sound has no
   other sign on the tile. So this chip is the only thing that reports it and it keeps the alarm
   colour.
   The red is --room-error, not --room-recording. The chip's own background is rgb(12 13 16 / 82%)
   and the tile's video shows through it, so a white frame composites the chip to rgb(56,57,59).
   --room-recording measures 3.62:1 there, under the 4.5:1 that 14px normal-weight text needs
   (WCAG 1.4.3); it holds up to about frame luminance 170 and fails on anything brighter.
   --room-error measures 5.64:1 on that same white frame and 9.21:1 on a dark tile. Keep
   --room-recording on the header dot, which never sits on video. */
.participant-mic[data-muted="true"] {
	color: var(--room-error);
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

/* The pressed pin reads "Pinned", so it is an accent surface with a label on it and takes the
   text-safe accent. On the bright accent that 16px label measured 3.17:1. */
.participant-pin[aria-pressed="true"] {
	background: var(--room-accent-text-safe);
	border-color: var(--room-accent-text-safe);
}

/* The resting pin control fades its own text with it, so the opacity is a contrast budget. It has
   two backdrops and both have to be measured. The pin sits on the tile only while that peer's
   camera is off; with the camera on it sits on video, and a white frame is the hard case. The old
   0.35 failed on the tile at 3.23:1. The 0.72 that replaced it fixed the tile, 9.25:1, but was
   measured against the tile alone: on a white frame the same 0.72 composites the box to
   rgb(122,123,124) and the 16px label to rgb(247,248,249), which is 3.99:1 and under the 4.5:1
   minimum. 0.85 measures 5.61:1 on the white frame and 12.54:1 on the tile. 0.80 reaches only
   4.90:1, which leaves no room for a browser that rounds the composite differently. Re-measure
   both backdrops after any change here. */
@media (hover: hover) and (pointer: fine) {
	.participant-pin:not([aria-pressed="true"]) {
		opacity: 0.85;
	}

	.participant-tile:hover .participant-pin,
	.participant-pin:focus-visible {
		opacity: 1;
	}
}

.share-stage {
	display: none;
	position: relative;
	min-height: 220px;
	margin: 0 16px 12px;
	overflow: hidden;
	border: 1px solid var(--room-border);
	border-radius: 14px;
	background: #050608;
}

.share-stage[data-active="true"] {
	display: block;
}

.share-video {
	display: block;
	width: 100%;
	height: min(58vh, 720px);
	object-fit: contain;
	background: #050608;
}

.share-label,
.share-note {
	position: absolute;
	left: 12px;
	margin: 0;
	padding: 4px 10px;
	border-radius: 8px;
	background: rgb(8 9 11 / 72%);
	color: var(--room-text);
	font-size: 13px;
}

.share-label {
	bottom: 12px;
}

.share-note {
	top: 12px;
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

button.control:hover:not(:disabled):not([aria-busy="true"]) {
	background: var(--room-surface-soft);
}

/* A control that is waiting for an answer marks itself busy instead of disabling itself, so that
   it keeps keyboard focus while it waits. It has to look the same as one that cannot be pressed, so
   the hover rule above skips a busy control too. #mute-button, #camera-button and
   #share-button and #start-recording-button all reach this state, and they drop every press while they are in it. */
.control:disabled,
.control[aria-busy="true"] {
	opacity: 0.58;
	cursor: default;
}

/* The participant count only reports a number, so it is not a button at all. */
.control-static {
	margin: 0;
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
	/* The badge digit is small text on a bright accent. White on that accent measures 3.45:1, so
	   the digit takes the page background colour instead and measures 5.77:1. */
	color: var(--room-bg);
	font-size: 10px;
	font-style: normal;
	font-weight: 700;
	line-height: 1;
}

/* Keep the label out of hit testing. It is text on a button and never a target of its own, and
   .control does not clip it, so a label wider than its control paints over the neighbouring
   control and takes that control's clicks with it. The rules below keep every control wide enough
   for its label at every window size measured, so nothing overflows today. This line is what stops
   the next long label from stealing a press before anyone notices the width.
   Here is what it cost the last time a label did overflow. Measured at 600x450, while the
   narrow-window query below still started at 599px and left that window on the floating bar:
   "Recording unavailable" reached 11px into "End for all", document.elementFromPoint over
   that strip answered the label instead of the button, and Playwright refused a click there with
   "control-label ... subtree intercepts pointer events". The recording control is disabled in
   that stage, so a real press fired nothing at all. No request, no dialog, no feedback.
   The line moves no box. With it added the same window still measured an 88x568 bar and a 394px
   stage. */
.control-label {
	font-size: 12px;
	white-space: nowrap;
	pointer-events: none;
}

/* The filled circle belongs to "End for all", the one control that ends the meeting for everybody.
   "Leave" removes only the person pressing it, so it stays a plain control. The two used to be the
   other way round and they painted the same handset glyph, so a 12px label was all that told them
   apart, and the destructive one was the quieter of the pair. */
.control-danger .control-icon {
	background: var(--room-danger);
}

/* This border is --room-danger at 42% opacity, written out because the rest of the file writes
   its tints out too. Move it whenever --room-danger moves, or the two drift apart. */
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

/* The dialog title is an h2 because the call view's h1 sits directly above it in the outline with
   nothing in between. That h1 is the visually hidden .call-heading, so this is the only heading a
   sighted user sees here. The size is set because this stylesheet never leans on the browser's
   default heading sizes, and the default h2 would jump this title from 19px to 24px. */
.host-confirm-card h2 {
	margin: 0 0 8px;
	font-size: 19px;
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

/* This banner is a focus target, not only an alert. When a host control turns disabled under the
   host's own press the browser drops them to the body, and catchFocusOnCallNotice in room/client.ts
   parks them here, on the sentence that says what happened. That is why the markup carries
   tabindex="-1". It needs no :focus rule of its own: the page's :focus-visible ring above is a bare
   selector and nothing turns it off for this box, and its 3px offset stays inside the 12px to 16px
   this box keeps from the window edge in every block below. Before this the host was parked on
   .call-heading, which is 1px and clipped, so its ring painted no pixels: measured in Chromium,
   focusing it changed nothing on screen while the same ring on a real control did.
   The offset below is the floating control bar's footprint, the same number .participant-stage
   reserves as its bottom padding: the bar is 100px tall here and sits 18px above the window bottom.
   Keep the two in step. While this said 106px the banner's bottom edge sat 12px inside the bar and
   painted over its top padding, measured at 1440x900 and 1280x800. No control was blocked at any of
   the five points a press is tested on, so it was only paint, but 106px was the short landscape
   block's footprint and not this one's. The short landscape block below overrides both numbers. */
.host-error {
	position: absolute;
	z-index: 21;
	left: 50%;
	bottom: 118px;
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

/* Phone-shaped rooms only: a narrow window that is not wider than it is tall. The shape test is
   what keeps a short landscape window out of here. That window is a small laptop or a zoomed
   desktop, and one tile per row there hides most of the meeting. A window that is exactly square
   counts as a phone, and the block below starts one step past square, so the two can never both
   match and leave the cascade to decide. */
@media (max-width: 760px) and (aspect-ratio <= 1/1) {
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
	.participant-stage[data-layout="grid"],
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
		/* The banner below is a call-view child that comes after this bar in the document, so put
		   the bar last in the column and let the banner land above it. */
		order: 1;
	}

	.control {
		flex: 1 1 76px;
		min-width: 68px;
		min-height: 58px;
		padding: 5px 7px;
	}

	/* Let the label wrap here. It is nowrap by default, and a control in this bar is far narrower
	   than the floating bar's 84px floor, so a long label paints outside its own control. The
	   longest one is "Recording unavailable", which the client writes after a 502 from
	   start-recording: it needs 125px inside a 95px control. Measured on the shipped CSS at
	   390x844 its box ran to 400px in a 390px window and overlapped "Participants" by 1px, so it
	   read "ParticipantsRecording unavailab"; at 320x640 it started at -6px and lost the "R" off
	   the left edge. This block sets overflow: hidden on html and body, so nothing scrolls to the
	   cut text and it is simply gone. Leave the base rule on nowrap: the floating bar's 566px
	   minimum is derived from single-line labels. */
	.control-label {
		white-space: normal;
	}

	.control-icon {
		height: 32px;
		min-width: 32px;
	}

	/* The bar is a normal block under the stage here, so the banner has nothing to float over and
	   sits in the column instead. Pinned 124px above the window bottom it landed inside the bar's
	   first row: a host has seven controls, the bar always wraps to two rows, and it measured 159px
	   tall at both 390x844 and 320x640 with six. A seventh control makes that wrap denser. The banner
	   overlapped it by 35px, and elementFromPoint at the icon centres answered "host-error" for mute,
	   camera, participant count and start recording at 390x844, and for mute, camera and participant
	   count at 320x640. There is no dismiss and no auto-clear, so those icons stayed unreachable for
	   the rest of the meeting. Do not go back to a hard-coded offset: it drifts again the next time a
	   control is added. */
	.host-error {
		position: static;
		width: auto;
		margin: 0 12px 8px;
		transform: none;
	}
}

/* A short window that is wider than it is tall: a small laptop, or 200% browser zoom on a normal
   screen (WCAG 1.4.4). This block must not carry a width floor. Zoom halves the window in CSS
   pixels, so 1366x768 at 200% is 683x384, and a floor of 761px sent exactly that window to the
   phone block above. Keep the desktop columns and only lower the row floor, so the meeting still
   fits. */
@media (max-height: 650px) and (aspect-ratio > 1/1) {
	.room-header {
		min-height: 56px;
		padding: 8px 18px;
	}

	/* Collapse the header the way the phone block does. This block shortened the header but left
	   its content alone, and the header does not fit: .room-header-status carries an auto inline
	   start margin and min-width: 0, so flexbox shrinks its box below the two nowrap chips it
	   holds, and the chips paint over the elapsed clock. Measured in Edge on the shipped CSS: 25px
	   of chip over the clock at 683x384, which is 1366x768 at 200% zoom; the whole clock at
	   620x400, where it painted as "C00:00ed"; and 24px over the clock plus 31px over the meeting
	   title at 512x384. The clock is the only place the room says how long the meeting has run, and
	   losing it to zoom is what WCAG 1.4.4 forbids. Dropping the brand word and the divider frees
	   that width, and holding the status box at its own size keeps the chips inside it. The brand
	   icon stays, so the room is still identifiable. */
	.room-brand span:last-child,
	.room-header-divider {
		display: none;
	}

	.room-header-status {
		flex-shrink: 0;
	}

	/* The bar keeps its floating size here: 88px tall, sitting 18px above the window bottom. The
	   lane below the tiles has to match that 106px footprint, or the bottom row of name chips ends
	   up behind the buttons. The .host-error offset near the end of this block carries the same
	   number. Re-measure all three together if the bar changes. */
	.participant-stage {
		grid-auto-rows: minmax(140px, 1fr);
		padding: 12px 14px 106px;
	}

	.participant-tile {
		min-height: 140px;
	}

	/* Move the featured rows down with the tiles, so the two floors stay equal here too. */
	.participant-stage[data-layout="featured"] {
		grid-template-rows: repeat(2, minmax(140px, 1fr));
	}

	/* Cap the letter at half the circle below. The letter's line box is the grid item's automatic
	   minimum height, so a letter left at the desktop size holds the box taller than the width, and
	   the aspect-ratio on the circle cannot pull it back. The circle then renders as an ellipse. */
	.participant-avatar {
		font-size: clamp(24px, 4.5vh, 44px);
	}

	/* Give the wrapped chips a shorter box, because the tiles here sit on their 140px floor and the
	   row grows upward from 10px above the tile's bottom edge, so it has 130px to live in. At the
	   shipped 38px chip and 10px gap the worst case is three lines and 134px: the row started 5px
	   above the tile top and the tile cut it off. At 30px and 6px the same case is 102px, and the
	   200% zoom case at 720x450 is 66px, because "No video" and "Mic off" fit on one line there.
	   The text keeps its 14px size on purpose. This block is what a 200% zoom window lands in, and
	   shrinking the text to win room back is the opposite of what that zoom asked for. */
	.participant-meta {
		gap: 6px;
	}

	.participant-name,
	.participant-video-state,
	.participant-mic {
		min-height: 30px;
		padding: 3px 9px;
	}

	/* Hold the name clear of the pin button's column, and only in this block. The pin sits in the
	   top 54px of the tile, and the chip row grows upward from 10px above the tile's bottom edge,
	   so the row reaches the pin only when it is taller than the tile minus 64px. With the base
	   chips it never gets there: three wrapped lines are 3x38 + 2x10 = 134px against the 156px a
	   220px tile leaves, and against 176px in the 240px phone tile. Here the tile floor is 140px
	   and the chips are 30px, so the same three lines are 102px against 76px, and the name really
	   does run under the pin. Measured at 560x420 and 480x360, where a 129px tile puts "No video"
	   and "Mic off" on separate lines: the name's line met the pin band, and without this reserve
	   its box ran 46px under the button.
	   The reserve is not free. When the row does not wrap that far it cuts a name that would have
	   fitted, and inside this block that cost stays: at 1024x600 a long name is cut with 54px of
	   its own line empty. CSS cannot ask how many lines the row took, so the block keeps the
	   reserve for its worst case. Do not put it back in the base rule, where a name is cut for a
	   collision no tile size there can produce. */
	.participant-name {
		max-width: calc(100% - 54px);
	}

	.participant-avatar span {
		width: clamp(48px, 9vh, 88px);
	}

	.control {
		min-height: 58px;
		padding: 5px 8px;
	}

	.control-icon {
		height: 32px;
		min-width: 32px;
	}

	/* The banner rides on the same 106px footprint the stage reserves above, for the same reason: the
	   bar here is 88px tall and floats 18px above the window bottom, and the base rule's 118px is the
	   taller desktop bar. At the 96px this used to say, the banner's bottom edge sat 10px inside the
	   bar and painted over its top padding. Measured at 900x600 and at 683x384, which is 1366x768 at
	   200% browser zoom. No control was blocked at any of the five points a press is tested on, so it
	   was only paint. */
	.host-error {
		bottom: 106px;
	}
}

/* Narrower than the floating control bar needs to be. The widest label decides that width, not the
   84px floor on a control. The widest one the client can write is RECORDING_LABELS.unavailable in
   room/client.ts, "Recording unavailable", and at the shipped 12px label size it measures 125px.
   This block sizes a control with 8px of padding on each side plus its 1px border, so that one
   control is 143px and Share sits on the 84px floor. The last live six-control measure was
   86 + 84 + 85 + 143 + 84 + 84 = 566. Adding Share at 84px makes 650. Six 8px gaps, 10px of bar
   padding on each side and its 1px border, so 650 + 48 + 20 + 2 = 720. The bar keeps 16px of window
   on each side (max-width: calc(100% - 32px)), so it needs a 752px window.
   Do not read that 650 as six short labels. Share is a short label, so it uses the 84px floor. The
   other six widths are the last live measure. The bar is 720.
   Below 752px the bar is capped and the controls shrink. The recording control eats its own
   padding first, so nothing shows for a while: measured at height 450, the label leaves that
   control at 638px and reaches "End for all" at 622px. The query below still starts at 751px,
   because the width the bar needs is the number a reader can re-derive from the labels, and the
   width where the first pixel of overlap appears is not. Do not move it down to 638.
   Re-measure whenever a control is added, a label changes, or the label font size moves. The
   longest label is the input that decides this, so page.test.ts pins the derivation against
   RECORDING_LABELS.unavailable and fails there when a longer one is added.
   Take the bar out of the float here, the way the phone rules do, and keep the multi-column stage
   above it. Do not shrink the floating bar with flex-wrap instead: it wraps even at widths where
   the bar still fits, and at 400x300 the wrapped bar measured 312px tall with its top 30px above
   the window.
   On the smallest windows this bar wraps to two rows and takes room the tiles used to have, so
   fewer tiles fit at once and the stage scrolls. That is the trade we want: the window scrolls in
   one direction instead of two (WCAG 1.4.10), and sideways scrolling is the thing that rule
   exists to prevent. */
@media (max-height: 650px) and (aspect-ratio > 1/1) and (max-width: 751px) {
	/* Let this column scroll here, and only here. The bar and the banner are both normal blocks in
	   it now, the bar refuses to shrink, and the stage is already down to nothing, so on the
	   shortest windows the three of them add up to more than the column shows. The base rule clips
	   instead of scrolling, and the bar is last, so the clip took the bar: at 320x256 — a 1280x1024
	   monitor at 400% browser zoom, the reflow size WCAG 1.4.10 names — the column measured 286px
	   of content in 200px, #leave-button had a visible height of 0, and elementFromPoint at its
	   centre answered nothing. Tab still scrolled the bar into view, so a keyboard user got out;
	   a pointer or touch user could not reach Leave or End for all for the rest of the meeting.
	   Only the block axis opens. overflow-x stays hidden from the base rule, so this keeps the
	   one-direction scroll the comment above promises. Do not lift this into the base .call-view
	   rule: at larger sizes the floating-bar layout wants the clip. */
	.call-view {
		overflow-y: auto;
	}

	.control-bar {
		position: static;
		flex-shrink: 0;
		max-width: none;
		flex-wrap: wrap;
		transform: none;
		border-radius: 16px 16px 0 0;
		/* The banner below is a call-view child that comes after this bar in the document, so put
		   the bar last in the column and let the banner land above it. */
		order: 1;
	}

	.control {
		flex: 1 1 76px;
		min-width: 68px;
	}

	/* Same reason as the phone block above: the controls here are narrower than the 84px the base
	   nowrap label was sized against, so "Recording unavailable" paints outside its control and
	   the base overflow: hidden takes the part that lands off the window. Measured at 320x256 —
	   a 1280x1024 monitor at 400% browser zoom, the reflow size WCAG 1.4.10 names — the label box
	   started at -4px and the "R" was off the left edge.
	   The wrapped label is two lines, so the control it sits in grows from 66px to 84px and the
	   bar from 163px to 180px. That is 4px more than the column shows at 320x256, and the
	   .call-view rule above already scrolls it. Every control stayed reachable there: the bottom
	   row ends at 249px in a 256px window, and elementFromPoint at all seven centres answered the
	   control itself. */
	.control-label {
		white-space: normal;
	}

	/* The bar sits under the stage now, so the stage keeps no lane for it. */
	.participant-stage {
		padding-bottom: 12px;
	}

	/* The bar is a normal block under the stage here too, so the banner has nothing to float over
	   and has to sit in the column with it. Left pinned above the window bottom it landed on the
	   bar's first row and covered the controls there: at 512x384, which is a 1024x768 display at
	   200% browser zoom (WCAG 1.4.4), only Leave stayed reachable. The banner has no dismiss, and
	   the only two presses that clear it are Start recording and End meeting, so a host who gets a
	   503 from Start recording loses both of them for the rest of the meeting. The phone block
	   above hit the same wall and takes the same way out. */
	.host-error {
		position: static;
		width: auto;
		margin: 0 12px 8px;
		transform: none;
	}
}

/* The "No video" chip does not fit the featured layout's side tiles on a short landscape window
   this narrow. With four or five people those tiles measured 67px at 320x256, 77px at 360x280 and
   88px at 400x300, and the chip needs 77px starting 10px inside the tile. The tile's own overflow
   cut the text, and three of five tiles read "No vid" at 320x256 — a 1280x1024 monitor at 400%
   browser zoom, which is the reflow size WCAG 1.4.10 names. Nothing smaller fits: the chip may not
   shrink, and letting its text wrap does not help either, because the word "video" alone still
   needs more room than the tile has. Shrinking the text is what the short-window block above rules
   out.
   So stop painting the chip, but leave it in the accessibility tree. The avatar circle already
   tells a sighted person that there is no picture. The tile is a role="listitem" whose video and
   avatar are aria-hidden, so this chip is the only place a screen reader hears it, and display:
   none would take that away.
   Keep the scope to the tiles that measured too small. The featured tile is 123px at 320x256 and
   shows the chip whole, three people give 97px side tiles, and from 410px the side tiles are 90px
   and fit again. */
@media (max-height: 650px) and (aspect-ratio > 1/1) and (max-width: 409px) {
	.participant-stage[data-layout="featured"][data-side-columns="2"]
		.participant-tile:not([data-featured="true"])
		.participant-video-state {
		position: absolute;
		width: 1px;
		height: 1px;
		min-height: 0;

		padding: 0;

		overflow: hidden;
		clip-path: inset(50%);
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
					<p class="room-recording" id="recording-indicator" tabindex="-1" hidden>
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
							<input id="guest-name" name="displayName" type="text" autocomplete="name" required aria-describedby="guest-name-hint" />
							<p class="field-hint" id="guest-name-hint">Shown to other participants.</p>
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
					<!-- The lobby is a form so that Enter in the display-name field joins the meeting.
					     routes-room.ts writes the host row with an empty display_name, so every host types
					     their name here on their first meeting, and the lobby had no form at all, so the key
					     did nothing for all of them.
					     Join has to stay type="submit". room/client.ts listens on this form, not on the
					     button, so a type="button" Join is a button nobody can press: measured in Edge on
					     the served page, pressing it raised no submit event and the room did not react.
					     Enter alone survives that, because a form with no submit button and one field still
					     submits on that field, but add a second field here and the key dies with the button.
					     Do not put required on the field below. It is hidden for a host who already has a
					     name, hidden does not exempt a control from constraint validation, and a required
					     field here would block the submit for all of those hosts. room/client.ts checks the
					     name instead, and marks the field aria-required while it is shown. -->
					<form id="lobby-form">
						<div class="field" id="host-name-field" hidden>
							<label for="host-name">Display name</label>
							<input id="host-name" name="displayName" type="text" autocomplete="name" aria-describedby="host-name-hint" />
							<p class="field-hint" id="host-name-hint">Shown to other participants.</p>
						</div>
						<p class="lobby-deadline" id="lobby-deadline"></p>
						<p class="consent-notice">${CONSENT_NOTICE}</p>
						<p class="form-error" id="lobby-error" role="alert" hidden></p>
						<button type="submit" class="button button-primary button-wide" id="join-button">Join meeting</button>
					</form>
					<p class="lobby-progress" id="lobby-progress" role="status" aria-live="polite"></p>
				</div>
			</section>

			<section class="call-view" id="view-call" aria-labelledby="call-heading" hidden>
				<h1 class="call-heading" id="call-heading" tabindex="-1">In the meeting</h1>
				<div class="call-notices">
					<p class="call-status" id="call-status" role="status" aria-live="polite" tabindex="-1" hidden></p>
					<button type="button" class="audio-recovery" id="play-audio-button" hidden>Play audio</button>
				</div>
				<div class="share-stage" id="share-stage" data-active="false" hidden>
					<video class="share-video" id="share-video" autoplay playsinline muted aria-hidden="true"></video>
					<p class="share-note" id="share-note" hidden>Showing the most recent share</p>
					<p class="share-label" id="share-label"></p>
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
					<button type="button" class="control" id="share-button" aria-pressed="false">
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 20h8M12 16v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span><span class="control-label">Share</span>
					</button>
					<p class="control control-static" id="participant-count-status" role="status">
						<span class="control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 19c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 6.5a2.7 2.7 0 0 1 0 5.2M17.5 14c2 .7 3.5 2.4 3.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><em class="control-count-badge" id="participant-count">0</em></span><span class="control-label">Participants</span>
					</p>
					<button type="button" class="control" id="start-recording-button" hidden>
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg></span><span class="control-label">Start recording</span>
					</button>
					<button type="button" class="control control-danger control-host-end" id="end-meeting-button" hidden>
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6.98 6.93a7.5 7.5 0 1 0 10.04 0M12 3.5v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span><span class="control-label">End for all</span>
					</button>
					<button type="button" class="control" id="leave-button">
						<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 13c4.3-3.5 9.7-3.5 14 0l-2.5 3-3-1.5v-2h-3v2L7.5 16z" fill="currentColor"/></svg></span><span class="control-label">Leave</span>
					</button>
				</div>
				<div class="host-confirm" id="host-confirm" role="dialog" aria-modal="true" aria-labelledby="host-confirm-heading" aria-describedby="host-confirm-text" hidden>
					<div class="host-confirm-card">
						<h2 id="host-confirm-heading">End this meeting?</h2>
						<p id="host-confirm-text">Everyone will leave the room. If recording was started, Council will prepare its files.</p>
						<div class="host-confirm-buttons">
							<button type="button" class="button" id="host-confirm-cancel">Cancel</button>
							<button type="button" class="button button-danger" id="host-confirm-yes">End meeting</button>
						</div>
					</div>
				</div>
				<p class="host-error" id="host-error" role="alert" tabindex="-1" hidden></p>
				<p class="sr-only" id="recording-live" role="status" aria-live="polite"></p>
			</section>

			<section class="view-card-shell" id="view-ended" aria-labelledby="ended-heading" hidden>
				<div class="view-card">
					<h1 id="ended-heading" tabindex="-1">Meeting ended</h1>
					<p id="ended-message"></p>
					<button type="button" class="button button-primary button-wide" id="rejoin-button" hidden>Rejoin the meeting</button>
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
