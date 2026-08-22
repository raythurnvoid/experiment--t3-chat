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
		expect(html).toContain('apiPost("/room/api/session", {})');
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

	test("shows the recording consent notice before media starts for both roles", () => {
		// Once on the guest form, once in the pre-join lobby — the lobby is the only door into
		// the call, so the host sees it too.
		const matches = html.match(/This meeting may be recorded\./g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(2);
		expect(html).toContain("attached to their part of the transcript");
		expect(html).toContain("Names are not verified");
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
		expect(html).toMatch(/id="recording-indicator" hidden/);
		expect(html).toContain("[hidden]");
		expect(html).toContain("display: none !important");
		expect(html).toContain('current === "STARTING"');
	});

	test("has a responsive scrollable stage and non-overlapping wrapping controls", () => {
		expect(html).toContain('data-layout="featured"');
		expect(html).toContain('data-side-columns="1"');
		expect(html).toContain("overflow: auto");
		expect(html).toContain("position: static");
		expect(html).toContain("flex-shrink: 0");
		expect(html).toContain("flex-wrap: wrap");
		expect(html).toContain("max-width: 760px");
		expect(html).toContain("max-height: 650px");
	});

	test("gives tile pin actions and toggle controls accessible state", () => {
		expect(html).toContain('className = "participant-pin"');
		expect(html).toContain('setAttribute("aria-label", (state.pinnedKey');
		expect(html).toContain('id="mute-button" aria-pressed="false"');
		expect(html).toContain('id="camera-button" aria-pressed="false"');
		expect(html).toContain('role="status" aria-live="polite"');
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
			"meetingStartTimeUpdate",
			"socketConnectionUpdate",
		]) {
			expect(html).toContain(`"${event}"`);
		}
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
