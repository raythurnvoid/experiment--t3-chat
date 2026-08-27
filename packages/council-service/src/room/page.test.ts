import { describe, expect, test } from "vitest";

import { council_room_boot_js, council_room_client_js } from "./client.ts";
import { council_room_page_external_origins, council_room_page_html } from "./page.ts";

const html = council_room_page_html();

describe("council_room_page_external_origins", () => {
	test("is a non-empty list of https/wss sources with no duplicates", () => {
		expect(council_room_page_external_origins.length).toBeGreaterThan(0);
		for (const origin of council_room_page_external_origins) {
			expect(origin).toMatch(/^(https|wss):\/\//);
		}
		expect(new Set(council_room_page_external_origins).size).toBe(council_room_page_external_origins.length);
	});

	test("covers the SDK CDN the page's script tag loads from", () => {
		expect(council_room_page_external_origins).toContain("https://cdn.jsdelivr.net");
		expect(html).toContain('src="https://cdn.jsdelivr.net/');
	});

	test("covers the RealtimeKit API and socket hosts, https and wss both", () => {
		// The SDK bundle hardcodes the API base and builds every other host as
		// <servicePrefix>.realtime.cloudflare.com, including the wss socket-edge endpoint.
		expect(council_room_page_external_origins).toContain("https://api.realtime.cloudflare.com");
		expect(council_room_page_external_origins).toContain("https://*.realtime.cloudflare.com");
		expect(council_room_page_external_origins).toContain("wss://*.realtime.cloudflare.com");
	});

	test("holds exactly the four entries above and nothing else", () => {
		// The list is the room's CSP. The same SDK bundle also names two dyte.in environments that
		// are left out on purpose, so widening this list has to be a deliberate edit that updates
		// this count, not a line someone adds while chasing a WebRTC failure.
		expect(council_room_page_external_origins).toHaveLength(4);
	});
});

describe("council_room_page_html", () => {
	test("is a complete standalone document", () => {
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain('<html lang="en">');
		expect(html).toContain("<title>Council meeting room</title>");
		expect(html).toContain('<meta name="viewport"');
	});

	test("exposes a revision marker for QA provenance checks", () => {
		expect(html).toMatch(/<meta name="council-room-revision" content="[^"]+" \/>/);
	});

	test("pins the SDK by exact version and subresource integrity hash", () => {
		// This page holds a live participant token. The hash pin means a changed file at the same
		// CDN version does not run at all.
		expect(html).toContain('src="https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.1/dist/browser.js"');
		expect(html).toContain('integrity="sha384-EVOSez95uObqUjiV3FecQZJtqOIGneHAfSwbpjvEU2UaxMFJ0BPWRgnDqhKygNm3"');
		expect(html).toContain('crossorigin="anonymous"');
	});

	test("listens for a later ticket fragment paste", () => {
		expect(html).toContain("hashchange");
		expect(html).toContain("captureTicketFromHash");
	});

	test("clears the ticket fragment before the SDK script tag", () => {
		const clearIndex = html.indexOf("history.replaceState");
		const sdkIndex = html.indexOf("cdn.jsdelivr.net");
		expect(clearIndex).toBeGreaterThan(-1);
		expect(sdkIndex).toBeGreaterThan(-1);
		expect(clearIndex).toBeLessThan(sdkIndex);
	});

	test("never puts the ticket or join code into a URL", () => {
		// The ticket arrives in the fragment and leaves in a POST body; the code only ever
		// travels in a POST body. A query-string form of either would land in access logs.
		expect(html).not.toMatch(/[?&]ticket=/);
		expect(html).not.toMatch(/[?&]code=/);
		expect(html).toContain('"/room/api/session"');
		expect(html).toContain('"/room/api/guest-session"');
	});

	test("resumes a live cookie before showing the guest form", () => {
		expect(html).toContain("resumeOrGuest");
		// The resume names the meeting this page was opened for. One room cookie covers the whole
		// origin, so without it the service resumes whatever meeting the visitor was in last. What
		// the client actually sends is asserted in client.test.ts; this only checks that the page
		// really serves that client.
		expect(html).toContain("{ meetingId: meetingId }");
	});

	test("serves no hard-coded guest-join attempt count", () => {
		// client.ts is embedded in this document as plain text, so its comments are readable in
		// view-source. One of them named the guest-join limit as ten. The number lives in
		// council_RATE_LIMITS in db.ts and was raised to 50, so the room served every guest a count
		// that was wrong by a factor of five. Name the bucket and the window, never the count.
		expect(html).toContain("spends one of the guest-join attempts");
		expect(html).not.toMatch(/ten guest-join attempts/u);
	});

	test("keeps the CSRF token in a header, not in storage", () => {
		expect(html).toContain("X-Council-Csrf");
		expect(html).not.toContain("localStorage");
		expect(html).not.toContain("sessionStorage");
	});

	test("labels every guest form field through label[for]", () => {
		expect(html).not.toContain("novalidate");
		for (const id of ["guest-code", "guest-name", "guest-email"]) {
			expect(html).toContain(`<label for="${id}">`);
			expect(html).toContain(`id="${id}"`);
		}
	});

	test("labels the host lobby name field through label[for]", () => {
		expect(html).toContain('<label for="host-name">');
		expect(html).toContain('id="host-name"');
		expect(html).toContain('id="host-name-field"');
	});

	test("puts the host lobby name field in a form whose default button is Join", () => {
		// Every host reaches this field with an empty name, because routes-room.ts writes the host row
		// with an empty display_name and the lobby is where it gets typed. Enter is the key they press
		// after typing it, and the lobby had no form at all, so the key did nothing for all of them.
		// The client listens on the form, so the submit type below is what keeps the Join button
		// working at all: measured in Edge on the served page, a type="button" Join raised no submit
		// event on press and the room did not react. Enter survives that one only while this form has
		// a single field, because a form with no submit button still submits on its one field.
		const formStart = html.indexOf('<form id="lobby-form">');
		expect(formStart).toBeGreaterThan(-1);
		const formEnd = html.indexOf("</form>", formStart);
		expect(html.indexOf('id="host-name"')).toBeGreaterThan(formStart);
		expect(html.indexOf('id="host-name"')).toBeLessThan(formEnd);
		expect(html.indexOf('id="join-button"')).toBeGreaterThan(formStart);
		expect(html.indexOf('id="join-button"')).toBeLessThan(formEnd);
		expect(html).toContain('<button type="submit" class="button button-primary button-wide" id="join-button">');
		// required cannot state it here. The field is hidden for a host who already has a name, a
		// hidden control is still constraint-validated, and required would then block this form's
		// submit for every one of those hosts. room/client.ts checks the name and marks the field
		// aria-required while it is shown; client.test.ts asserts that mark.
		expect(html).not.toMatch(/id="host-name"[^>]*\srequired/u);
	});

	test("gives the text inputs a boundary that shows where the field is", () => {
		// --room-border measures 1.44:1 against the card behind the field and the field's fill is
		// 1.04:1 against that same card, so the label was the only thing saying where the input was.
		// WCAG 1.4.11 asks 3:1 for the boundary that identifies a control, and this is the guest join
		// form, which every guest has to use. --room-input-border measures 3.09:1 against the card
		// and 3.20:1 against the fill. Hover has to stay lighter than that or it dims the boundary
		// below the floor exactly while the pointer is on the field: the old #555a66 was 2.64:1.
		expect(html).toContain("--room-input-border: #5f6474;");
		const fromRule = html.slice(html.indexOf(".field input {"));
		const inputRule = fromRule.slice(0, fromRule.indexOf("}"));
		expect(inputRule).toContain("border: 1px solid var(--room-input-border);");
		expect(inputRule).not.toContain("var(--room-border)");
		expect(html).toContain(".field input:hover {\n\tborder-color: #6b7183;\n}");
		expect(html).not.toContain("#555a66");
	});

	test("lets both display name fields reach the byte cap the server actually enforces", () => {
		// maxlength counts UTF-16 units while the server caps displayName at 128 UTF-8 bytes
		// (routes-room.ts). A 44-character CJK name is 44 units and 132 bytes, so maxlength="120" let
		// the browser accept it and the server refused it, and the guest read the raw server string
		// "displayName is longer than 128 bytes". An attribute that counts the wrong unit cannot
		// guard this, so it is gone; the byte check belongs in room/client.ts, which can count what
		// the server counts and can word its own message.
		expect(html).not.toContain("maxlength");
		expect(html).toContain(
			'<input id="guest-name" name="displayName" type="text" autocomplete="name" required aria-describedby="guest-name-hint" />',
		);
		expect(html).toContain(
			'<input id="host-name" name="displayName" type="text" autocomplete="name" aria-describedby="host-name-hint" />',
		);
	});

	test("pairs every refusable field with the hint and error ids room/client.ts points at", () => {
		// refuseField in room/client.ts rewrites a refused field's aria-describedby to
		// "<hint id> <error id>". The error line is role="alert", so it speaks once and is never read
		// again, and without that rewrite a member who tabs back into the box hears only the static
		// hint. Both halves of the pair are written here, so renaming one on this side would leave
		// the client describing a node that does not exist, and nothing would say so at runtime.
		for (const [inputId, hintId, errorId] of [
			["guest-code", "guest-code-hint", "guest-error"],
			["guest-name", "guest-name-hint", "guest-error"],
			["host-name", "host-name-hint", "lobby-error"],
		]) {
			expect(html).toContain(`id="${inputId}" `);
			expect(html).toContain(`aria-describedby="${hintId}"`);
			expect(html).toContain(`id="${hintId}"`);
			expect(html).toContain(`id="${errorId}" role="alert"`);
		}
	});

	test("shows the recording consent notice before media starts for both roles", () => {
		// Once on the guest form, once in the pre-join lobby — the lobby is the only door into
		// the call, so the host sees it too.
		const matches = html.match(/This meeting may be recorded\./g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(2);
		expect(html).toContain("not used to label who spoke");
		expect(html).not.toContain("attached to the transcript");
		expect(html).not.toContain("attached to their part of the transcript");
	});

	test("ships every call control the room contract names", () => {
		for (const id of [
			"participant-list",
			"mute-button",
			"camera-button",
			"play-audio-button",
			"leave-button",
			"start-recording-button",
			"end-meeting-button",
			"recording-indicator",
			"meeting-elapsed",
			"connection-status",
			"host-confirm-yes",
			"host-confirm-cancel",
		]) {
			expect(html).toContain(`id="${id}"`);
		}
		expect(html).toContain('<svg viewBox="0 0 24 24">');
	});

	test("hides the host controls until the session says the participant is the host", () => {
		expect(html).toMatch(/id="start-recording-button" hidden/);
		expect(html).toMatch(/id="end-meeting-button" hidden/);
		expect(html).toContain('participant.role !== "host"');
	});

	test("keeps recording UI hidden until recording is active", () => {
		expect(html).toMatch(/id="recording-indicator" tabindex="-1" hidden/);
		expect(html).toContain("[hidden]");
		expect(html).toContain("display: none !important");
		expect(html).toContain('current === "STARTING"');
	});

	test("has a responsive scrollable stage and non-overlapping wrapping controls", () => {
		expect(html).toContain('data-layout="featured"');
		expect(html).toContain('data-side-columns="1"');
		expect(html).toContain('data-layout="grid"');
		expect(html).toContain("overflow: auto");
		expect(html).toContain("position: static");
		expect(html).toContain("flex-shrink: 0");
		expect(html).toContain("flex-wrap: wrap");
	});

	test("keeps the phone rules and the short-window rules in separate media queries", () => {
		// One combined query applied the one-tile-per-row phone layout to every window under
		// 650px tall, which is any laptop at 200% zoom (WCAG 1.4.4). Splitting them was not
		// enough on its own: zoom halves the window in CSS pixels, so 1366x768 at 200% is
		// 683x384, and the 761px floor the short-window block used to carry sent exactly that
		// window back into the phone rules. The shape test replaces the floor, and the two
		// conditions meet without touching, so a square window matches the phone block only.
		expect(html).toContain("@media (max-width: 760px) and (aspect-ratio <= 1/1) {");
		expect(html).toContain("@media (max-height: 650px) and (aspect-ratio > 1/1) {");
		expect(html).not.toContain("@media (max-width: 760px), (max-height: 650px)");
		expect(html).not.toContain("min-width: 761px");
	});

	test("caps the avatar letter inside the short-window block", () => {
		// That block shrinks the avatar circle. The letter's line box is the grid item's automatic
		// minimum height, so a letter left at the desktop size holds the box taller than the width
		// and the circle renders as an ellipse: 54x104 at 1024x600 before the cap.
		const fromBlock = html.slice(html.indexOf("@media (max-height: 650px)"));
		const shortWindowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(shortWindowRules).toContain(".participant-avatar span {");
		expect(shortWindowRules).toMatch(/\.participant-avatar \{\n\t\tfont-size: clamp\(/);
	});

	test("collapses the header in the short-window block so the chips clear the clock", () => {
		// The block shortened the header but left its content alone. .room-header-status has an auto
		// inline-start margin and min-width: 0, so flexbox shrinks its box below the two nowrap chips
		// it holds and they paint over the elapsed clock: 25px of overlap at 683x384, which is
		// 1366x768 at 200% zoom (WCAG 1.4.4); the whole clock at 620x400, where it painted as
		// "C00:00ed"; and 24px over the clock plus 31px over the title at 512x384. The clock is the
		// only place the room says how long the meeting has run. happy-dom does no layout, so this
		// pins the rule text and the browser measurement carries the behavioural claim.
		const fromBlock = html.slice(html.indexOf("@media (max-height: 650px)"));
		const shortWindowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(shortWindowRules).toContain(
			".room-brand span:last-child,\n\t.room-header-divider {\n\t\tdisplay: none;\n\t}",
		);
		expect(shortWindowRules).toContain(".room-header-status {\n\t\tflex-shrink: 0;\n\t}");
	});

	test("matches the short-window stage lane to the floating control bar", () => {
		// The bar there is 88px tall and sits 18px above the window bottom, so the lane under the
		// tiles has to be 106px. At 96px the bottom row of name chips sat 10px behind the buttons.
		const fromBlock = html.slice(html.indexOf("@media (max-height: 650px)"));
		const shortWindowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(shortWindowRules).toContain("padding: 12px 14px 106px;");
		// The banner floats on the same lane, so its offset is the same footprint. While it said 96px
		// its bottom edge sat 10px inside the bar and painted over the bar's top padding, measured in
		// Edge at 900x600 and at 683x384, which is 1366x768 at 200% zoom. Nothing was blocked, so this
		// was paint only.
		expect(shortWindowRules).toContain(".host-error {\n\t\tbottom: 106px;\n\t}");
	});

	test("matches the desktop banner offset to the taller desktop control bar", () => {
		// Same rule as the lane above, one block up. The desktop bar is 100px tall and floats 18px
		// above the window bottom, which is the 118px .participant-stage already reserves. The banner
		// carried the short-window block's 106px instead and painted 12px inside the bar, measured in
		// Edge at 1440x900 and 1280x800. The two numbers move together, so pin them together.
		expect(html).toContain("padding: 16px 18px 118px;");
		expect(html).toContain(".host-error {\n\tposition: absolute;\n\tz-index: 21;\n\tleft: 50%;\n\tbottom: 118px;");
	});

	test("takes the control bar out of the float when the window is narrower than the bar", () => {
		// The floating bar needs 628px for its widest label and keeps 16px of window on each side,
		// so under a 660px window it cannot hold that width and the controls shrink under their own
		// labels. The query starts at 659px, the first width where that happens. A static bar keeps
		// the multi-column stage; sending these windows back to the phone rules would put one tile
		// per row again, the defect above.
		const query = "@media (max-height: 650px) and (aspect-ratio > 1/1) and (max-width: 659px) {";
		const fromBlock = html.slice(html.indexOf(query));
		const narrowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(html).toContain(query);
		expect(narrowRules).toContain("position: static;");
		expect(narrowRules).toContain("padding-bottom: 12px;");
		// The bar is a normal block under the stage here, so a banner pinned above the window bottom
		// lands on the bar's first row. At 512x384 — a 1024x768 display at 200% browser zoom, WCAG
		// 1.4.4 — elementFromPoint at the control centres answered host-error for mute, camera, the
		// participant count, start recording and end meeting, and only Leave stayed reachable. The
		// banner has no dismiss and no auto-clear: the two presses that clear it are among the ones
		// it covers, so the host stays locked out for the rest of the meeting.
		expect(narrowRules).toContain(".host-error {\n\t\tposition: static;");
		// The banner is a call-view child that follows the bar in the document, so the bar has to be
		// ordered last for the banner to land above it.
		expect(narrowRules).toContain("order: 1;");
	});

	test("pins the values the control bar's 628px minimum is derived from", () => {
		// The comment on that media query derives the minimum by hand, and the widest label is what
		// drives it: "Recording unavailable" measures 125px, its control adds 8px of padding each
		// side and a 1px border to reach 143px, the other five come to 423px, and the six plus five
		// 8px gaps plus 10px of bar padding each side plus its 1px border make 628. Add the 32px of
		// window the bar leaves itself and that is the 660px window it needs. Nothing recomputes any
		// of it when an input moves. The last version of this comment derived 566 from six controls
		// held at their 84px floor, which is only true while every label is short, and it went stale
		// the moment a 21-character label was added. Pin the inputs and the results together, so a
		// changed value fails here and sends the next reader to the recipe instead of past a stale
		// number.
		const fromControl = html.slice(html.indexOf(".control {"));
		expect(fromControl.slice(0, fromControl.indexOf("}"))).toContain("min-width: 84px;");
		const fromLabel = html.slice(html.indexOf(".control-label {"));
		expect(fromLabel.slice(0, fromLabel.indexOf("}"))).toContain("font-size: 12px;");
		const fromBar = html.slice(html.indexOf(".control-bar {"));
		const barRule = fromBar.slice(0, fromBar.indexOf("}"));
		expect(barRule).toContain("gap: 8px;");
		expect(barRule).toContain("padding: 10px;");
		expect(barRule).toContain("max-width: calc(100% - 32px);");
		// The 143px control uses this block's own padding, not the base 10px, because the query the
		// number belongs to also carries max-height: 650px and never applies outside it.
		const fromShortWindow = html.slice(html.indexOf("@media (max-height: 650px)"));
		const shortWindowRules = fromShortWindow.slice(0, fromShortWindow.indexOf("\n}\n"));
		expect(shortWindowRules).toContain(".control {\n\t\tmin-height: 58px;\n\t\tpadding: 5px 8px;\n\t}");
		expect(html).toContain("566 + 40 + 20 + 2 = 628");
		expect(html).toContain("it needs a 660px window");
	});

	test("derives that minimum from the longest label the client can write", () => {
		// The derivation is only as good as its widest input, and the last one went stale because a
		// label grew and nobody re-measured. Read the labels out of the client this page ships and
		// fail here when the longest one is no longer the one the comment names.
		// Character count is a proxy for width, and not a perfect one: "Participants" is 12
		// characters and 67.1px while "Microphone" is 10 and 67.8px. It is the right tripwire
		// anyway, because the change that breaks the derivation is a longer string being added, and
		// happy-dom does no layout so the browser measurement carries the pixel claim.
		const fromLabels = council_room_client_js.slice(council_room_client_js.indexOf("var RECORDING_LABELS = {"));
		const labels = [...fromLabels.slice(0, fromLabels.indexOf("};")).matchAll(/: "([^"]*)"/g)].map(
			(match) => match[1],
		);
		expect(labels).toContain("Recording unavailable");
		expect(labels.reduce((widest, label) => (label.length > widest.length ? label : widest))).toBe(
			"Recording unavailable",
		);
		// The comment has to name the label it derived from, or the next reader cannot check it.
		expect(html).toContain("RECORDING_LABELS.unavailable");
		expect(html).toContain("it measures 125px");
	});

	test("lets the call column scroll where the static bar no longer fits inside it", () => {
		// In this block the bar and the banner are both normal blocks in the call column, the bar
		// refuses to shrink and the stage is already down to nothing, so on the shortest windows the
		// three add up to more than the column shows. The base rule clips instead of scrolling and
		// the bar is last, so the clip took the bar: at 320x256 — a 1280x1024 monitor at 400% browser
		// zoom, the reflow size WCAG 1.4.10 names — the column held 286px of content in 200px,
		// #leave-button measured a visible height of 0, and elementFromPoint at its centre answered
		// nothing. Tab still scrolled the bar into view, so a keyboard user escaped; a pointer or
		// touch user could not reach Leave or End for all for the rest of the meeting. happy-dom does
		// no layout, so this pins the rule text and the browser measurement carries the behaviour.
		const query = "@media (max-height: 650px) and (aspect-ratio > 1/1) and (max-width: 659px) {";
		const fromBlock = html.slice(html.indexOf(query));
		const narrowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(narrowRules).toContain(".call-view {\n\t\toverflow-y: auto;\n\t}");
		// The block axis only. overflow-x stays hidden from the base rule, so the window still
		// scrolls in one direction and not in two, which is the trade this whole block is built on.
		expect(narrowRules).not.toContain("overflow: auto");
	});

	test("keeps the host error banner out of the phone control bar", () => {
		// In the phone rules the bar is a normal block under the stage, and a host's six controls
		// always wrap to two rows: the bar measured 159px tall at both 390x844 and 320x640. A banner
		// pinned 124px above the window bottom landed inside the bar's first row, overlapped it by
		// 35px, and elementFromPoint at the icon centres answered host-error for mute, camera,
		// participant count and start recording at 390x844, and for mute, camera and participant
		// count at 320x640. The banner has no dismiss and no auto-clear, so those icons stayed
		// unreachable for the rest of the meeting. A hard-coded offset drifts again the next time a
		// control is added, so the banner sits in the column instead.
		const query = "@media (max-width: 760px) and (aspect-ratio <= 1/1) {";
		const fromBlock = html.slice(html.indexOf(query));
		const phoneRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(phoneRules).toContain(".host-error {\n\t\tposition: static;");
		expect(phoneRules).not.toContain("bottom: 124px");
		// The banner is a call-view child that follows the bar in the document, so the bar has to be
		// ordered last for the banner to land above it.
		expect(phoneRules).toContain("order: 1;");
	});

	test("lets a control label wrap in both blocks that take the bar out of the float", () => {
		// The base .control-label is nowrap, and it was sized against the floating bar, whose
		// controls never go under 84px. Both blocks below drop a control to 68px, and the longest
		// label the client writes is "Recording unavailable", which needs 125px. Measured on the
		// shipped CSS with a real 502 from start-recording, so the client wrote the label itself:
		// at 390x844 the label box ran to 400px in a 390px window and overlapped "Participants" by
		// 1px, so the bar read "ParticipantsRecording unavailab"; at 360x740 the overlap was 9px
		// and "ble" was off the window; at 320x640 and 320x256 the box started at -6px and -4px
		// and the "R" was off the left edge; at 430x932 it overlapped "Participants" by 12px and
		// "End for all" by 7px while staying inside the window, so no scrollbar even hinted at it.
		// Both blocks hide the overflow, so none of that text could be scrolled to. With the
		// override the label is two lines, nothing overlaps and nothing leaves the window at any of
		// those five sizes.
		// client.test.ts asserts ten times that these label strings are WRITTEN and not once that
		// they can be READ. That asymmetry is the gap this test fills. happy-dom does no layout, so
		// this pins the rule text and the browser measurement carries the behaviour.
		const phoneQuery = "@media (max-width: 760px) and (aspect-ratio <= 1/1) {";
		const fromPhone = html.slice(html.indexOf(phoneQuery));
		const phoneRules = fromPhone.slice(0, fromPhone.indexOf("\n}\n"));
		expect(phoneRules).toContain(".control-label {\n\t\twhite-space: normal;\n\t}");
		const narrowQuery = "@media (max-height: 650px) and (aspect-ratio > 1/1) and (max-width: 659px) {";
		const fromNarrow = html.slice(html.indexOf(narrowQuery));
		const narrowRules = fromNarrow.slice(0, fromNarrow.indexOf("\n}\n"));
		expect(narrowRules).toContain(".control-label {\n\t\twhite-space: normal;\n\t}");
		// Keep the base rule on nowrap. The floating bar's 628px minimum is derived from single-line
		// labels, and the test above pins that arithmetic and the comment that explains it.
		// pointer-events: none rides along in the same rule. A label is text on a button, .control
		// does not clip it, and an overflowing one took the neighbouring control's clicks: at
		// 600x450 elementFromPoint over the covered strip of "End for all" answered the label, and
		// the control the label belongs to is disabled in that stage, so the press did nothing.
		expect(html).toContain(
			".control-label {\n\tfont-size: 12px;\n\twhite-space: nowrap;\n\tpointer-events: none;\n}",
		);
	});

	test("gives the featured rows the same floor as the tiles they hold", () => {
		// A row floor of 0 let the rows shrink under the tile min-height. The tiles kept their own
		// size, so the bottom row ran on under the control bar and the stage did not scroll at all:
		// 40px of that row was unreachable at 683x384. Content behind the bar cannot be reached and
		// content inside a scroll can, so the rows carry the tile floor in both places now.
		expect(html).toContain("grid-template-rows: repeat(2, minmax(220px, 1fr));");
		const fromBlock = html.slice(html.indexOf("@media (max-height: 650px)"));
		const shortWindowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(shortWindowRules).toContain("grid-template-rows: repeat(2, minmax(140px, 1fr));");
		expect(html).not.toContain("grid-template-rows: repeat(2, minmax(0, 1fr));");
	});

	test("gives tile pin actions and toggle controls accessible state", () => {
		expect(html).toContain('className = "participant-pin"');
		// The pinned button shows "Pinned", so its accessible name has to contain that word
		// (WCAG 2.5.3 Label in Name).
		expect(html).toContain('pinned ? "Pinned — unpin " + name : "Pin " + name');
		expect(html).toContain('id="mute-button" aria-pressed="false"');
		expect(html).toContain('id="camera-button" aria-pressed="false"');
		expect(html).toContain('role="status" aria-live="polite"');
	});

	test("keeps the resting pin label above the contrast minimum on both of its backdrops", () => {
		// The rule fades the label and its background together, so this number is a contrast budget.
		// The 0.72 this test used to assert was not wrong, it was measured against one backdrop out
		// of two. The pin sits on the tile only while that peer's camera is off, and against the tile
		// 0.72 does measure 9.25:1, where the 0.35 before it measured 3.23:1. With the camera on the
		// pin sits on video instead, and a white frame is the hard case: 0.72 composites the box to
		// rgb(122,123,124) and the 16px label to rgb(247,248,249), which is 3.99:1 and under the
		// 4.5:1 minimum. 0.85 measures 5.61:1 on the white frame and 12.54:1 on the tile. Do not drop
		// to 0.80: that is 4.90:1 on the white frame, with nothing left for rounding.
		expect(html).toContain(".participant-pin:not([aria-pressed=\"true\"]) {\n\t\topacity: 0.85;");
	});

	test("gives the focus ring a page-coloured band where it floats over camera video", () => {
		// The pin and the recovery button float over the tiles, so with the ring 3px off the button
		// both of its neighbours are raw video: --room-focus measures 2.23:1 on a white frame and
		// 1.77:1 on mid-grey, under the 3:1 of WCAG 1.4.11. The band paints page colour from the
		// button edge out to 9px, and an outer box-shadow paints under the outline, so the ring lands
		// on top of it at 3px to 6px and both neighbours become #08090b at 8.93:1.
		// Closing the gap with outline-offset: 0 is not the fix. That puts the ring on the button's
		// own 1px white-16% border, which composites to 2.65:1 over a white frame, and to 2.28:1
		// while the pin is pressed and painted --room-accent-text-safe.
		expect(html).toContain(
			".participant-pin:focus-visible,\n.audio-recovery:focus-visible {\n\tbox-shadow: 0 0 0 9px var(--room-bg);\n}",
		);
		expect(html).toContain(":focus-visible {\n\toutline: 3px solid var(--room-focus);\n\toutline-offset: 3px;\n}");
	});

	test("leaves that ring on every heading the room moves focus to", () => {
		// The rule above only helps if nothing outranks it. showView focuses #guest-heading,
		// #lobby-heading, #ended-heading and #error-heading on every view change, and all four are
		// .view-card h1. While .view-card h1:focus shared a rule with .call-heading:focus, that
		// selector out-specified the ring and every one of the four lost it: :focus matches whenever
		// :focus-visible does, so the ring never painted and a member moving by keyboard was left
		// with no mark at all. The error card is the worst of the four, because it holds no focusable
		// control, so the next Tab reveals nothing either.
		// .call-heading is the one allowed exception: it is 1px and clipped, so a ring on it marks
		// nothing anybody can see. Assert it is still the only one, and that no rule turns the ring
		// off some other way.
		const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
		const blocks = css.split("}").filter((block) => block.includes("outline: none"));
		expect(blocks).toHaveLength(1);
		expect(blocks[0].split("{")[0].trim()).toBe(".call-heading:focus");
		expect(css).not.toContain("outline: 0");
		for (const headingId of ["guest-heading", "lobby-heading", "ended-heading", "error-heading"]) {
			expect(html).toContain(`<h1 id="${headingId}" tabindex="-1">`);
		}
	});

	test("makes the host error banner a focus target the ring can paint on", () => {
		// catchFocusOnCallNotice in room/client.ts parks a host on this banner when the control they
		// pressed turns disabled under them. A <p> takes focus only with tabindex, and a missing one
		// fails silently: focus() does nothing, the host stays on the body, and no test in
		// client.test.ts can see the difference because happy-dom focuses any element it is asked to.
		// So the browser half of that contract is pinned here.
		expect(html).toContain('<p class="host-error" id="host-error" role="alert" tabindex="-1" hidden></p>');
		// It needs no :focus rule of its own. The page ring above is a bare :focus-visible selector,
		// and the test above proves .call-heading:focus is the only rule that turns a ring off, so
		// this banner is not one of them. That is the whole point of moving focus here: the previous
		// target was .call-heading, which is 1px and clipped, so its ring painted nothing.
		expect(html).toContain(".call-heading {\n\tposition: absolute;\n\twidth: 1px;");
	});

	test("makes the recording pill a focus target the ring can paint on", () => {
		// catchFocusOnCallNotice in room/client.ts prefers this pill over the clipped call heading
		// when the provider's broadcast closes the recording control and no notice line is up. Same
		// browser contract as the banner test above: a <p> takes focus only with tabindex, a missing
		// one fails silently, and happy-dom focuses any element it is asked to, so the browser half
		// is pinned here. tabindex="-1" keeps the pill out of the tab order — only the client's own
		// focus() call reaches it. Measured in the attached Edge on the served page: keyboard-reached
		// focus painted the ring at solid 3px on the pill's 84x20 box, where the heading's 1x1
		// clipped box with outline: none painted nothing.
		expect(html).toMatch(/id="recording-indicator" tabindex="-1" hidden/);
	});

	test("makes the call status line a focus target the ladders can land on", () => {
		// catchFocusOnCallNotice in room/client.ts parks a host on this line while it is visible, and
		// retryBlockedAudio focuses it directly when the recovery button vanishes under the listener.
		// Same browser contract as the banner test above: a <p> takes focus only with tabindex, a
		// missing one fails silently, and happy-dom focuses any element it is asked to, so the
		// browser half is pinned here. tabindex="-1" keeps the line out of the tab order — only the
		// client's own focus() calls reach it.
		expect(html).toContain(
			'<p class="call-status" id="call-status" role="status" aria-live="polite" tabindex="-1" hidden></p>',
		);
	});

	test("makes the call heading a focus target for the view change and the ladder floor", () => {
		// showView focuses #call-heading on entering the call, and both focus ladders in
		// room/client.ts fall back to it when no banner, status line, or recording pill is up. An
		// <h1> takes focus only with tabindex, and a missing one fails silently in the same way the
		// two tests above describe. The heading is 1px and clipped, so its ring paints nothing — the
		// tests above pin that trade-off; this one pins only that the landing takes focus at all.
		expect(html).toContain('<h1 class="call-heading" id="call-heading" tabindex="-1">');
	});

	test("hands pointer events back to the recovery button only, never to the status line", () => {
		// .call-notices floats over the top row of tiles and is pointer-events: none for that reason.
		// While the status line took its pointer events back too, that 620x42 paragraph covered the
		// pin buttons underneath it. With "Connection lost. Reconnecting…" showing, elementFromPoint
		// at the pin centres answered call-status for two of five pins at 1440x900 and at 1024x600,
		// three of five at 720x450, and the top pin at 390x844. That message carries no auto-clear,
		// so the unpin button was dead for the whole outage.
		const blocks = html
			.slice(html.indexOf("<style>"), html.indexOf("</style>"))
			.split("}")
			.filter((block) => block.includes("pointer-events: auto"));
		expect(blocks).toHaveLength(1);
		const parts = blocks[0].split("{");
		const selector = parts[parts.length - 2];
		expect(selector).toContain(".audio-recovery");
		expect(selector).not.toContain(".call-status");
	});

	test("paints every labelled accent surface with the text-safe accent", () => {
		// The bright accent fails AA behind a label: white measured 3.45:1 on it and the pinned pin
		// label measured 3.17:1. It has to stay bright anyway, because the count badge paints its
		// digit in the page background colour and measures 5.77:1 only while the accent is bright.
		// So labelled surfaces take the darker value: white 5.08:1, hover 4.70:1, pin label 4.66:1.
		expect(html).toContain("--room-accent: #5b82ff;");
		expect(html).toContain("--room-accent-text-safe: #4968cc;");
		expect(html).toContain("--room-accent-text-safe-hover: #4c6dd6;");
		expect(html).toContain(".button-primary {\n\tbackground: var(--room-accent-text-safe);\n\tborder-color: var(--room-accent-text-safe);");
		expect(html).toContain(
			'.button-primary:hover:not(:disabled):not([aria-busy="true"]) {\n\tbackground: var(--room-accent-text-safe-hover);',
		);
		expect(html).toContain('.participant-pin[aria-pressed="true"] {\n\tbackground: var(--room-accent-text-safe);');
		// #7193ff was the old hover and measured 2.87:1.
		expect(html).not.toContain("#7193ff");
	});

	test("paints the danger label surface with the text-safe danger", () => {
		// White on #df4b47 measured 4.01:1 and on its old #ed5a55 hover 3.39:1. Danger splits for the
		// mirror reason the accent does: the plain token is the end-meeting circle, and darkening it
		// drops that circle to 3.37:1 against the control bar and to 2.79:1 when bright video shows
		// through. So the circle keeps #df4b47 and the button takes 5.00:1 / 4.64:1.
		expect(html).toContain("--room-danger: #df4b47;");
		expect(html).toContain("--room-danger-text-safe: #c4423e;");
		expect(html).toContain("--room-danger-text-safe-hover: #cd4541;");
		expect(html).toContain(".button-danger {\n\tbackground: var(--room-danger-text-safe);\n\tborder-color: var(--room-danger-text-safe);");
		expect(html).toContain(
			'.button-danger:hover:not(:disabled):not([aria-busy="true"]) {\n\tbackground: var(--room-danger-text-safe-hover);',
		);
		expect(html).toContain(".control-danger .control-icon {\n\tbackground: var(--room-danger);");
		// #ed5a55 was the old hover and measured 3.39:1.
		expect(html).not.toContain("#ed5a55");
	});

	test("gives End for all its own glyph and the filled destructive circle", () => {
		// The two controls painted the same handset path, and the quieter of the pair was the one
		// that ends the meeting for everybody: Leave carried the filled red circle while End for all
		// had only a 42%-opacity red border on a grey one. A 12px label was the whole difference.
		const svgOf = (id: string) => {
			const fromButton = html.slice(html.indexOf(`id="${id}"`));
			const start = fromButton.indexOf("<svg");
			return fromButton.slice(start, fromButton.indexOf("</svg>", start) + "</svg>".length);
		};
		expect(svgOf("end-meeting-button")).toContain("<svg");
		expect(svgOf("end-meeting-button")).not.toBe(svgOf("leave-button"));
		expect(html).toContain('class="control control-danger control-host-end" id="end-meeting-button"');
		expect(html).toContain('class="control" id="leave-button"');
	});

	test("keeps the end-meeting dialog heading one level below the view heading", () => {
		// The call view's h1 is the visually hidden .call-heading, and nothing sits between it and
		// this dialog title, so h3 skipped a level and failed the heading-order check.
		expect(html).toContain('<h2 id="host-confirm-heading">End this meeting?</h2>');
		expect(html).toContain(".host-confirm-card h2 {");
		expect(html).not.toContain("<h3");
	});

	test("gives the video-state label the meta chip styling and hides it while blank", () => {
		// These two rules only make sense together. The client blanks the label instead of removing
		// the element, so the shared chip padding alone would paint an empty chip on every tile that
		// does have a picture, which is the common case.
		expect(html).toContain(".participant-name,\n.participant-video-state,\n.participant-mic {");
		expect(html).toContain(".participant-video-state:empty {\n\tdisplay: none;\n}");
		// A third chip does not fit in the narrowest tile the stage can show, so the chips have to be
		// allowed to shrink. Without these two the row ran 28px past the tile edge at 560x420.
		expect(html).toContain(".participant-mic {\n\tmin-width: 0;\n\tmin-height: 38px;");
		expect(html).toContain("\talign-items: center;\n\toverflow: hidden;\n\tpadding: 7px 11px;");
	});

	test("keeps the name chip a block container so its own ellipsis paints", () => {
		// text-overflow applies to a block container's inline content. Inside the shared flex chip
		// box the text is an anonymous flex item, so the declaration did nothing and a clipped name
		// was cut mid-glyph with no mark from 1024x600 down. The line height replaces what
		// align-items used to do: 24px plus the 7px padding on each side is the chip's own 38px
		// floor, so nothing else moves.
		const fromRule = html.slice(html.indexOf(".participant-name {"));
		const nameRule = fromRule.slice(0, fromRule.indexOf("}"));
		expect(nameRule).toContain("text-overflow: ellipsis;");
		expect(nameRule).not.toMatch(/display:\s*(inline-)?flex/);
		expect(nameRule).toContain("display: block;");
		expect(nameRule).toContain("line-height: 24px;");
		// The room reserves 54px of the name's line for the pin button's column, but the chip row only
		// reaches that column in the short-window block: there a tile sits on a 140px floor and three
		// wrapped 30px chips are 102px against the 76px the tile leaves above the row. Measured at
		// 560x420, where a 129px tile puts "No video" and "Mic off" on separate lines: the name's line
		// met the pin band, and unclamped its box ran 46px under the button. With the base 220px tile
		// and 38px chips the same three lines are 134px against 156px, so nothing there can touch the
		// pin, and the reserve only cut names that fitted.
		expect(nameRule).not.toContain("max-width");
		const fromBlock = html.slice(html.indexOf("@media (max-height: 650px)"));
		const shortWindowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(shortWindowRules).toContain(".participant-name {\n\t\tmax-width: calc(100% - 54px);\n\t}");
	});

	test("keeps the two state chips whole instead of cutting them into fragments", () => {
		// Neither chip set white-space, so its text wrapped and the shared overflow: hidden cut the
		// second line off: "Mic" / "off" on a 171px side tile at 720x450, "Mi" / "of" on a 129px one
		// at 560x420. The mic chip is the only place the room reports a muted participant, so that
		// is lost content, and 720x450 is a 1440x900 window at 200% zoom (WCAG 1.4.4). The two go
		// together: a chip that cannot shrink runs past the tile edge unless the row can wrap.
		expect(html).toContain(
			".participant-video-state,\n.participant-mic {\n\tflex-shrink: 0;\n\twhite-space: nowrap;\n}",
		);
		const fromMeta = html.slice(html.indexOf(".participant-meta {"));
		expect(fromMeta.slice(0, fromMeta.indexOf("}"))).toContain("flex-wrap: wrap;");
		// The wrapped row has 130px inside a tile sitting on the short-window 140px floor. At the
		// shipped 38px chip and 10px gap the worst case was three lines and 134px, and the tile cut
		// 5px off the top. At 30px and 6px that case is 102px, and 720x450 is 66px because both
		// chips fit on one line there. The 14px text size stays: this block is where a 200% zoom
		// window lands, and shrinking the text to win room back is what that zoom asked against.
		const fromBlock = html.slice(html.indexOf("@media (max-height: 650px)"));
		const shortWindowRules = fromBlock.slice(0, fromBlock.indexOf("\n}\n"));
		expect(shortWindowRules).toContain(".participant-meta {\n\t\tgap: 6px;\n\t}");
		expect(shortWindowRules).toContain(
			".participant-name,\n\t.participant-video-state,\n\t.participant-mic {\n\t\tmin-height: 30px;\n\t\tpadding: 3px 9px;\n\t}",
		);
	});

	test("stops painting the video-state chip where the side tile cannot hold it", () => {
		// The chip needs 77px and starts 10px inside the tile. In the featured layout with four or
		// five people the two side columns measured 67px at 320x256, 77px at 360x280 and 88px at
		// 400x300, so the tile's overflow cut the text and three of five tiles read "No vid" at
		// 320x256 — a 1280x1024 monitor at 400% zoom, the reflow size WCAG 1.4.10 names. It cannot
		// be shrunk out of: "video" alone still needs more room than the tile has.
		const fromRule = html.slice(html.indexOf("@media (max-height: 650px) and (aspect-ratio > 1/1) and (max-width: 409px)"));
		const narrowBlock = fromRule.slice(0, fromRule.indexOf("\n}\n"));
		expect(narrowBlock).toContain('.participant-stage[data-layout="featured"][data-side-columns="2"]');
		expect(narrowBlock).toContain('.participant-tile:not([data-featured="true"])');
		// Out of sight, not out of the accessibility tree. The tile is a role="listitem" whose video
		// and avatar are aria-hidden, so this chip is the only place a screen reader hears that there
		// is no picture; display: none would take that away, and the avatar circle only replaces it
		// for someone who can see the tile.
		expect(narrowBlock).toContain("clip-path: inset(50%);");
		expect(narrowBlock).not.toContain("display: none;");
		// Keep the scope to the tiles that measured too small: the featured tile is 123px at 320x256,
		// three people give 97px side tiles, and from 410px the side tiles are 90px and fit again.
		expect(narrowBlock).not.toContain('.participant-stage[data-layout="featured"][data-side-columns="1"]');
	});

	test("paints the muted-mic chip in the red that survives bright video", () => {
		// The chip stays red on purpose: it is the only sign on the tile that you cannot hear this
		// person, so a neutral colour would lose that. But it sits on the tile's video behind a
		// rgb(12 13 16 / 82%) background, and a white frame composites the chip to rgb(56,57,59).
		// --room-recording measures 3.62:1 there, under the 4.5:1 that 14px normal-weight text needs
		// (WCAG 1.4.3); it holds only to about frame luminance 170. --room-error is 5.64:1 on that
		// white frame and 9.21:1 on a dark tile. --room-recording keeps the header dot, which is not
		// text and never sits on video.
		expect(html).toContain('.participant-mic[data-muted="true"] {\n\tcolor: var(--room-error);\n}');
		expect(html).toContain(".room-recording-dot {\n\tcolor: var(--room-recording);");
	});

	test("reports the participant count without a disabled control", () => {
		// A disabled button drops the count to 2.14:1 and takes it out of the tab order, and the
		// number is content, not an action.
		expect(html).toContain('id="participant-count-status" role="status"');
		expect(html).not.toMatch(/id="participant-count-status"[^>]*disabled/);
		expect(html).toContain('<em class="control-count-badge" id="participant-count">0</em>');
		expect(html).not.toContain('<span class="control-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9"');
	});

	test("makes a busy button stop looking pressable without dimming its own label", () => {
		// A control that waits for an answer marks itself busy instead of disabling itself, because a
		// disabled control blurs and the keyboard member loses their place. It then has to stop looking
		// pressable. .control carried that pair of rules; .button did not, and the three buttons that
		// go busy are all .button-primary: #guest-submit, #join-button and #rejoin-button. Each kept
		// full accent fill and still lightened under the pointer for the length of its request, while
		// dropping every press, because :not(:disabled) is true while a control is busy.
		expect(html).toContain(".button:disabled {\n\topacity: 0.55;\n\tcursor: default;\n}");
		expect(html).toContain('.control:disabled,\n.control[aria-busy="true"] {\n\topacity: 0.58;\n\tcursor: default;\n}');
		// A busy .button dims its fill and keeps its label opaque. Group opacity fades the label with
		// the fill, and these three swap their label to "Checking invite...", "Joining..." or
		// "Rejoining...", which is the sentence that reports the wait. Measured in Edge on the lobby
		// card: white on the accent is 5.08:1 at rest and 3.19:1 at opacity 0.55, under the 4.5:1 a
		// 16px bold label needs (WCAG 1.4.3). The fill-only dim measures 9.45:1. The exemption for an
		// inactive component does not reach these: measured on the served page a busy #join-button
		// reports disabled false, no aria-disabled, tabIndex 0, and it keeps focus.
		expect(html).toContain('.button[aria-busy="true"] {\n\tcursor: default;\n}');
		expect(html).toContain(
			'.button-primary[aria-busy="true"] {\n\tbackground: color-mix(in srgb, var(--room-accent-text-safe) 55%, transparent);',
		);
		const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
		// No .button rule a busy button matches may declare opacity, in any family. Re-merging the busy
		// selector back into the disabled rule is how the label fade would return, and this catches
		// that shape as well as an opacity added to one variant. .control is exempt and keeps its own:
		// it paints no fill of its own, so there is nothing else to dim, and its label still measures
		// 5.99:1 over a dark tile and 5.40:1 over a white video frame. "button.control" carries no dot
		// before the word, so the pattern below does not reach it.
		expect(css).not.toMatch(/\.button[^{}]*\[aria-busy="true"\][^{}]*\{[^{}]*opacity/);
		// Every hover rule in both families needs the guard, or a busy control lights up through the
		// one that was missed. .button-primary:hover outranks .button:hover, so guarding only one of
		// the two would have swapped the accent hover for the plain grey one instead of removing it.
		expect(css).toMatch(/\.button:hover:not\(:disabled\):not\(\[aria-busy="true"\]\)/);
		expect(css).toMatch(/\.button-primary:hover:not\(:disabled\):not\(\[aria-busy="true"\]\)/);
		expect(css).toMatch(/\.button-danger:hover:not\(:disabled\):not\(\[aria-busy="true"\]\)/);
		expect(css).toMatch(/button\.control:hover:not\(:disabled\):not\(\[aria-busy="true"\]\)/);
		expect(css.match(/:hover:not\(:disabled\)(?!:not\(\[aria-busy="true"\]\))/g)).toBeNull();
	});

	test("offers a way back after leaving the meeting", () => {
		expect(html).toMatch(/id="rejoin-button" hidden/);
		expect(html).toContain('endLocally("You left the meeting.", true)');
	});

	test("starts with only the loading view visible", () => {
		for (const id of ["view-guest", "view-lobby", "view-call", "view-ended", "view-error"]) {
			expect(html).toMatch(new RegExp(`id="${id}"[^>]*hidden`));
		}
		expect(html).not.toMatch(/id="view-loading"[^>]*hidden/);
	});

	test("wires behavior through addEventListener, never inline handler attributes", () => {
		expect(html).toContain("addEventListener");
		expect(html).not.toMatch(/\son(click|change|input|submit|load|error|focus|blur|key[a-z]+|mouse[a-z]+)\s*=/i);
	});

	test("gates the joined UI on roomJoined and asks for audio explicitly", () => {
		// join() can resolve while the participant is stuck in a waiting room and is never
		// recorded, and join() resolving does not publish the microphone (M0 findings).
		expect(html).toContain("roomJoined");
		expect(html).toContain("enableAudio");
	});

	test("uses one abortable deadline across every provider join stage", () => {
		expect(html).toContain("JOIN_TIMEOUT_MS");
		expect(html).toContain("AbortController");
		expect(html).toContain("cancelJoinOperation");
		expect(html).toContain('operation.stage = "initializing"');
		expect(html).toContain('operation.stage = "joining"');
	});

	test("wires exact RealtimeKit media and reconnect events", () => {
		for (const event of [
			"videoUpdate",
			"audioUpdate",
			"participantJoined",
			"participantLeft",
			"roomLeft",
			"roomJoined",
			"mediaPermissionUpdate",
			"meetingStartTimeUpdate",
			"socketConnectionUpdate",
		]) {
			expect(html).toContain(`"${event}"`);
		}
		// For audio and video, the two kinds the room asks for, SDK 2.0.1 sends one of six messages:
		// ACCEPTED, DENIED, SYSTEM_DENIED, NOT_REQUESTED, COULD_NOT_START and NO_DEVICES_AVAILABLE.
		// The enum holds a seventh, CANCELED, but the bytes the integrity hash above pins only produce
		// it for kind "screenshare", which the room never asks for. Do not add it here.
		// ACCEPTED is the only one that leaves the track working, so it is the only one the room may
		// stay silent about. Naming the two refusals instead was wrong: Chromium's
		// mapper sends NotReadableError and every error it does not recognise to COULD_NOT_START, so
		// a microphone another app holds, a failed device and an unplugged one all arrived on a
		// message the old guard dropped without a word, after the SDK had already turned the track
		// off. COULD_NOT_START is not a permission answer either, so it gets its own message that
		// does not send the listener to check the browser permission.
		expect(html).toContain('payload.message === "ACCEPTED"');
		expect(html).toContain('payload.message === "COULD_NOT_START"');
		// Assert the clause that carries the difference, not the whole sentence: this branch has to
		// name the other app holding the device, because sending the listener to the permission
		// screen is the one answer that cannot help here. room/client.ts owns the exact wording.
		expect(html).toContain("Close any other app using it");
		expect(html).not.toContain('payload.message !== "DENIED"');
		expect(html).toContain('payload.state === "disconnected"');
		expect(html).toContain('payload.state === "failed"');
		expect(html).toContain("if (state.reconnecting)");
	});

	test("keeps connection and recording labels visible on narrow rooms", () => {
		expect(html).not.toContain(".connection-status span:last-child");
		expect(html).not.toContain(".room-recording span:last-child");
	});

	test("describes the end-meeting dialog consequence", () => {
		expect(html).toContain('aria-describedby="host-confirm-text"');
	});

	test("attaches real media tracks and provides autoplay recovery", () => {
		expect(html).toContain("new MediaStream([track])");
		expect(html).toContain("element.srcObject");
		expect(html).toContain("playRemoteAudio");
		expect(html).toContain("retryBlockedAudio");
		expect(html).toContain("video.playsInline = true");
		expect(html).toContain('.participant-tile[data-video="on"] .participant-avatar');
	});

	test("generates a joinAttemptId and reuses it across retries of the same attempt", () => {
		expect(html).toContain("joinAttemptId");
		expect(html).toContain("crypto.randomUUID()");
		expect(html).toContain("state.joinAttempt.key !== attemptKey");
	});

	test("polls meeting state and treats every non-open status as over", () => {
		expect(html).toContain('"/room/api/state"');
		expect(html).toContain('status !== "recording_start_unknown"');
	});

	test("renders untrusted display names through textContent only", () => {
		expect(html).not.toContain("innerHTML");
		expect(html).toContain("record.name.textContent = name");
		expect(html).toContain("record.avatar.textContent = displayInitials(name)");
	});

	test("respects reduced motion for the recording pulse", () => {
		expect(html).toContain("prefers-reduced-motion");
	});

	test("both inline scripts are syntactically valid JavaScript", () => {
		// The scripts ship as strings, so a typo would only surface in a live browser. The Function
		// constructor compiles without running, which catches syntax errors here.
		expect(() => new Function(council_room_boot_js)).not.toThrow();
		expect(() => new Function(council_room_client_js)).not.toThrow();
	});

	test("the inline scripts cannot terminate their own script tags early", () => {
		// A literal closing script sequence inside the inline text would cut the document in half.
		const scriptBodies = [council_room_boot_js, council_room_client_js];
		for (const body of scriptBodies) {
			expect(body.toLowerCase()).not.toContain("</script");
		}
	});
});
