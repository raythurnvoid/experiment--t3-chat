import { afterEach, describe, expect, test } from "vitest";

import {
	council_provider_create_meeting,
	council_provider_ensure_preset,
	council_provider_fetch_transcript,
	council_provider_find_session,
	council_provider_get_recording,
	council_provider_start_track_recording,
} from "./provider.ts";
import { install_fetch, make_test_env } from "../test/env.ts";

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

describe("council_provider_create_meeting", () => {
	test("sends transcribe_on_end true and record_on_start false", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const created = await council_provider_create_meeting(env, "My meeting");
		expect(created._nay).toBeUndefined();
		expect(created._yay?.providerMeetingId).toBe("pm-1");

		const call = mock.calls.find((candidate) => candidate.url.endsWith("/meetings"));
		expect(call?.bodyJson?.transcribe_on_end).toBe(true);
		expect(call?.bodyJson?.record_on_start).toBe(false);
		expect(call?.headers.get("Authorization")).toBe("Bearer test-api-token");
	});
});

describe("council_provider_ensure_preset", () => {
	test("creates a clone carrying transcription_enabled when only stock presets exist", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/presets/preset-stock-host": () =>
				Response.json({ success: true, data: { config: { c: 1 }, permissions: { can_record: true }, ui: { u: 1 } } }),
			"/presets": (call) => {
				if (call.method === "POST") {
					return Response.json({ success: true, data: { id: "preset-new", permissions: { transcription_enabled: true } } });
				}
				// The live list's `data` IS the array, not an object holding one.
				return Response.json({
					success: true,
					data: [{ id: "preset-stock-host", name: "group_call_host" }],
				});
			},
		});
		restoreFetch = mock.restore;

		const ensured = await council_provider_ensure_preset(env, "host");
		expect(ensured._nay).toBeUndefined();
		expect(ensured._yay).toEqual({ presetName: "council_host_transcription", presetId: "preset-new" });

		const created = mock.calls.find((call) => call.method === "POST" && call.url.endsWith("/presets"));
		expect((created?.bodyJson?.permissions as Record<string, unknown>).transcription_enabled).toBe(true);
		// The stock permissions are cloned, not replaced: only the one switch is added.
		expect((created?.bodyJson?.permissions as Record<string, unknown>).can_record).toBe(true);
	});

	test("refuses an existing preset whose DETAIL read does not prove the permission", async () => {
		const { env } = make_test_env();
		// The list endpoint returns no permissions at all, so only the detail read may decide.
		const mock = install_fetch({
			"/presets/preset-host": () => Response.json({ success: true, data: { permissions: { can_record: true } } }),
			"/presets": () =>
				Response.json({
					success: true,
					data: [{ id: "preset-host", name: "council_host_transcription" }],
				}),
		});
		restoreFetch = mock.restore;

		const ensured = await council_provider_ensure_preset(env, "host");
		expect(ensured._nay?.name).toBe("preset_invalid");
	});
});

describe("council_provider_find_session", () => {
	test("matches on associated_id because the provider's meeting_id filter does not filter", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/sessions?": () =>
				Response.json({
					success: true,
					data: {
						sessions: [
							{ id: "sess-other", associated_id: "pm-other" },
							{ id: "sess-mine", associated_id: "pm-1" },
							{ id: "sess-older", associated_id: "pm-older" },
						],
					},
				}),
		});
		restoreFetch = mock.restore;

		const found = await council_provider_find_session(env, "pm-1");
		expect(found._yay?.sessionId).toBe("sess-mine");
	});

	test("refuses to pick when several sessions claim the meeting", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/sessions?": () =>
				Response.json({
					success: true,
					data: {
						sessions: [
							{ id: "sess-a", associated_id: "pm-1" },
							{ id: "sess-b", associated_id: "pm-1" },
						],
					},
				}),
		});
		restoreFetch = mock.restore;

		const found = await council_provider_find_session(env, "pm-1");
		expect(found._yay).toEqual({ sessionId: null, matchCount: 2 });
	});
});

describe("council_provider_fetch_transcript", () => {
	test("HTTP 200 alone is never ready: no URL, empty body, and [] all answer not-ready", async () => {
		const { env } = make_test_env();
		let downloadBody = "";
		let metadataUrl: string | null = null;
		const mock = install_fetch({
			"transcript?format=JSON": () =>
				Response.json({ success: true, data: metadataUrl ? { transcript_download_url: metadataUrl } : {} }),
			"transcript-download.example": () => new Response(downloadBody, { status: 200 }),
		});
		restoreFetch = mock.restore;

		// No download URL issued yet.
		expect((await council_provider_fetch_transcript(env, "sess-1"))._yay?.ready).toBe(false);

		// URL issued, zero bytes: still generating, not "nobody spoke".
		metadataUrl = "https://transcript-download.example/t";
		expect((await council_provider_fetch_transcript(env, "sess-1"))._yay?.ready).toBe(false);

		// `[]` parses and is still not a transcript.
		downloadBody = "[]";
		expect((await council_provider_fetch_transcript(env, "sess-1"))._yay?.ready).toBe(false);

		// A real line makes it ready, and the speaker ids surface for the identity check.
		downloadBody = JSON.stringify([{ sentence: "words", peerData: { id: "TEST" } }]);
		const ready = await council_provider_fetch_transcript(env, "sess-1");
		expect(ready._yay?.ready).toBe(true);
		if (ready._yay?.ready) {
			expect(ready._yay.speakerIds).toEqual(["TEST"]);
		}
	});
});

describe("council_provider_start_track_recording", () => {
	test("sends the meeting id and the max_seconds cap, without a layers field", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const started = await council_provider_start_track_recording(env, { providerMeetingId: "pm-1", maxSeconds: 3600 });
		expect(started._yay?.providerRecordingId).toBe("rec-1");

		const call = mock.calls.find((candidate) => candidate.url.includes("/recordings/track"));
		expect(call?.bodyJson).toEqual({ meeting_id: "pm-1", max_seconds: 3600 });
	});
});

describe("council_provider_get_recording", () => {
	test("lists the per-participant track files from the first link group", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/recordings/rec-1": () =>
				Response.json({
					success: true,
					data: {
						recording: {
							id: "rec-1",
							status: "UPLOADED",
							download_url: {
								links: [
									{
										download_urls: {
											"council_p1_peer1_peer_audio_1.webm": { download_url: "https://tracks.example/a" },
											"council_p2_peer2_peer_audio_2.webm": { download_url: "https://tracks.example/b" },
										},
									},
								],
							},
						},
					},
				}),
		});
		restoreFetch = mock.restore;

		const recording = await council_provider_get_recording(env, "rec-1");
		expect(recording._yay?.status).toBe("UPLOADED");
		expect(recording._yay?.trackFiles).toEqual([
			{ fileName: "council_p1_peer1_peer_audio_1.webm", downloadUrl: "https://tracks.example/a" },
			{ fileName: "council_p2_peer2_peer_audio_2.webm", downloadUrl: "https://tracks.example/b" },
		]);
	});
});
