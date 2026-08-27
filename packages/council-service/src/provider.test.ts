import { afterEach, describe, expect, test } from "vitest";

import {
	council_provider_add_participant,
	council_provider_create_meeting,
	council_provider_ensure_preset,
	council_provider_fetch_transcript,
	council_provider_find_session,
	council_provider_get_active_session,
	council_provider_get_recording,
	council_provider_start_recording,
} from "./provider.ts";
import { install_fetch, is_start_recording_call, make_test_env } from "../test/env.ts";

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

	// `typeof value === "string"` accepts `""`, so a field that is present and empty needs its own
	// case: a missing field proves nothing about it. Storing this one would put every later provider
	// URL for the meeting one segment short — `/meetings//participants` — while the row says the
	// meeting was created.
	test("refuses an empty meeting id the same way it refuses a missing one", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/meetings": () => Response.json({ success: true, data: { meeting: { id: "" } } }),
		});
		restoreFetch = mock.restore;

		const created = await council_provider_create_meeting(env, "My meeting");
		expect(created._nay?.name).toBe("provider_refused");
	});
});

describe("council_provider_add_participant", () => {
	// One case per field, each empty on its own. A single answer empty in both would leave either
	// check deletable with the suite still green.
	//
	// The id is what the provider writes into every track file name, and it is stored in D1, where
	// `discover_tracks` and `fetch_provider_transcript` read a column for truthiness — an empty one
	// reads back as absent while the row says it is set. The token is the member's whole join
	// credential, and the same statement that stores it marks the admission finished, so a member
	// handed an empty one holds a slot they can never use and no retry mints them a real token.
	test.each([
		["an empty participant id", { id: "", token: "tokenheader.tokenpayload.tokensig" }],
		["an empty join token", { id: "prov-1", token: "" }],
	])("refuses %s the same way it refuses a missing field", async (_label, data) => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/participants": () => Response.json({ success: true, data }),
		});
		restoreFetch = mock.restore;

		const added = await council_provider_add_participant(env, {
			providerMeetingId: "pm-1",
			name: "Alice",
			presetName: "council_host_transcription",
			customParticipantId: "participant-1",
		});

		expect(added._nay?.name).toBe("provider_refused");
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
		// A preset is created once and only verified afterwards, so an explicit `false` is the case
		// that matters: that is what the preset carries once somebody turns transcription off in the
		// provider dashboard.
		let detailBody: Record<string, unknown> = { permissions: { can_record: true } };
		// The list endpoint returns no permissions at all, so only the detail read may decide.
		const mock = install_fetch({
			"/presets/preset-host": () => Response.json({ success: true, data: detailBody }),
			"/presets": () =>
				Response.json({
					success: true,
					data: [{ id: "preset-host", name: "council_host_transcription" }],
				}),
		});
		restoreFetch = mock.restore;

		// The permission is not in the answer at all.
		const absent = await council_provider_ensure_preset(env, "host");
		expect(absent._nay?.name).toBe("preset_invalid");

		// The permission is in the answer and says `false`. A guard that only asked whether the field
		// is there would accept this preset, and every meeting would run without a transcript.
		detailBody = { permissions: { can_record: true, transcription_enabled: false } };
		const disabled = await council_provider_ensure_preset(env, "host");
		expect(disabled._nay?.name).toBe("preset_invalid");
	});

	// The list can answer a council preset whose id is present and empty. Reading its detail would
	// GET `/presets/` — the list URL — and verify nothing. An empty id is a preset that is not
	// there, so the stock clone path is the answer, same as for a missing preset.
	test("a listed council preset with an empty id is recreated from stock, not read", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/presets/preset-stock-host": () =>
				Response.json({ success: true, data: { config: {}, permissions: {}, ui: {} } }),
			"/presets": (call) => {
				if (call.method === "POST") {
					return Response.json({ success: true, data: { id: "preset-new" } });
				}
				return Response.json({
					success: true,
					data: [
						{ id: "", name: "council_host_transcription" },
						{ id: "preset-stock-host", name: "group_call_host" },
					],
				});
			},
		});
		restoreFetch = mock.restore;

		const ensured = await council_provider_ensure_preset(env, "host");
		expect(ensured._nay).toBeUndefined();
		expect(ensured._yay).toEqual({ presetName: "council_host_transcription", presetId: "preset-new" });
	});

	// The same empty id on the stock preset: it cannot be a clone source, because its detail read
	// would GET the list URL and clone nothing real.
	test("a stock preset with an empty id is missing, not a source to clone", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/presets": () => Response.json({ success: true, data: [{ id: "", name: "group_call_host" }] }),
		});
		restoreFetch = mock.restore;

		const ensured = await council_provider_ensure_preset(env, "host");
		expect(ensured._nay?.name).toBe("preset_missing");
	});

	// A created preset with an empty id would be handed to Add Participant as a preset name that
	// verifies against nothing on the next run.
	test("a created preset whose id comes back empty is refused, not kept", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/presets/preset-stock-host": () =>
				Response.json({ success: true, data: { config: {}, permissions: {}, ui: {} } }),
			"/presets": (call) => {
				if (call.method === "POST") {
					return Response.json({ success: true, data: { id: "" } });
				}
				return Response.json({ success: true, data: [{ id: "preset-stock-host", name: "group_call_host" }] });
			},
		});
		restoreFetch = mock.restore;

		const ensured = await council_provider_ensure_preset(env, "host");
		expect(ensured._nay?.name).toBe("provider_refused");
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

	// The found id is stored in `meetings.provider_session_id`, and `fetch_provider_transcript`
	// reads that column for truthiness — an empty one reads back as absent while the row says it is
	// set. Answer null so the caller keeps polling instead of storing it.
	test("one matched session with an empty id answers null like no match", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/sessions?": () => Response.json({ success: true, data: { sessions: [{ id: "", associated_id: "pm-1" }] } }),
		});
		restoreFetch = mock.restore;

		const found = await council_provider_find_session(env, "pm-1");
		expect(found._yay).toEqual({ sessionId: null, matchCount: 1 });
	});
});

describe("council_provider_get_active_session", () => {
	// An empty id would land in the next `/sessions/` request one path segment short. Null is what
	// every caller already handles: no active session.
	test("an empty active-session id answers null like a missing session", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/active-session": () => Response.json({ success: true, data: { id: "" } }),
		});
		restoreFetch = mock.restore;

		const active = await council_provider_get_active_session(env, "pm-1");
		expect(active._yay).toEqual({ sessionId: null });
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

	test("a transcript past the read cap answers not-ready instead of buffering it", async () => {
		const { env } = make_test_env();
		// The people in the meeting decide how long this file is, and it is only a diagnostic. One
		// sentence past the cap stands for a meeting that talked for hours.
		const oversized = JSON.stringify([{ sentence: "x".repeat(5 * 1024 * 1024), peerData: { id: "TEST" } }]);
		const mock = install_fetch({
			"transcript?format=JSON": () =>
				Response.json({
					success: true,
					data: { transcript_download_url: "https://transcript-download.example/t" },
				}),
			"transcript-download.example": () => new Response(oversized, { status: 200 }),
		});
		restoreFetch = mock.restore;

		const fetched = await council_provider_fetch_transcript(env, "sess-1");

		// Not-ready is the same answer a transcript still being written gets: the caller polls, gives
		// up, and finishes the meeting without the diagnostic file.
		expect(fetched._yay?.ready).toBe(false);
	});
});

describe("council_provider_start_recording", () => {
	test("starts a composite recording with the meeting-length cap", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const started = await council_provider_start_recording(env, { providerMeetingId: "pm-1", maxSeconds: 3600 });
		expect(started._yay?.providerRecordingId).toBe("rec-1");

		const call = mock.calls.find((candidate) => is_start_recording_call(candidate));
		expect(call?.url.includes("/recordings/track")).toBe(false);
		expect(call?.bodyJson).toEqual({
			meeting_id: "pm-1",
			max_seconds: 3600,
			audio_config: { channel: "mono", codec: "AAC", export_file: true },
			video_config: { codec: "H264", export_file: true, width: 1280, height: 720 },
			realtimekit_bucket_config: { enabled: true },
		});
	});

	// This is the quietest of the empty ids. Kept, it becomes the meeting's stored recording id, and
	// `discover_tracks` in `pipeline.ts` returns no files at all when that column is falsy. The run
	// would not fail: the meeting would finish and publish a transcript saying nobody spoke.
	test("refuses an empty recording id the same way it refuses a missing one", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"POST /recordings": () => Response.json({ success: true, data: { recording: { id: "" } } }),
		});
		restoreFetch = mock.restore;

		const started = await council_provider_start_recording(env, { providerMeetingId: "pm-1", maxSeconds: 3600 });
		expect(started._nay?.name).toBe("provider_refused");
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
		expect(recording._yay?.recordingDuration).toBeNull();
		expect(recording._yay?.trackFiles).toEqual([
			{
				fileName: "council_p1_peer1_peer_audio_1.webm",
				downloadUrl: "https://tracks.example/a",
				kind: "track",
				contentType: "audio/webm",
			},
			{
				fileName: "council_p2_peer2_peer_audio_2.webm",
				downloadUrl: "https://tracks.example/b",
				kind: "track",
				contentType: "audio/webm",
			},
		]);
	});

	test("lists the mixed video and audio files from a composite recording", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/recordings/rec-1": () =>
				Response.json({
					success: true,
					data: {
						recording: {
							id: "rec-1",
							status: "UPLOADED",
							recording_duration: 790,
							download_url: "https://tracks.example/video",
							audio_download_url: "https://tracks.example/audio",
						},
					},
				}),
		});
		restoreFetch = mock.restore;

		const recording = await council_provider_get_recording(env, "rec-1");
		expect(recording._yay?.status).toBe("UPLOADED");
		expect(recording._yay?.recordingDuration).toBe(790);
		expect(recording._yay?.trackFiles).toEqual([
			{
				fileName: "recording.mp4",
				downloadUrl: "https://tracks.example/video",
				kind: "composite-video",
				contentType: "video/mp4",
			},
			{
				fileName: "recording-audio.m4a",
				downloadUrl: "https://tracks.example/audio",
				kind: "composite-audio",
				contentType: "audio/mp4",
			},
		]);
	});

	// An empty download URL is no capability at all: handing it to the track download would fetch
	// nothing and fail the run on a file the provider never really offered. Dropping the entry gives
	// that track the same treatment as one the provider did not list.
	test("a track entry with an empty download_url is dropped from the list", async () => {
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
											"council_p1_peer1_peer_audio_1.webm": { download_url: "" },
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
		expect(recording._yay?.trackFiles).toEqual([
			{
				fileName: "council_p2_peer2_peer_audio_2.webm",
				downloadUrl: "https://tracks.example/b",
				kind: "track",
				contentType: "audio/webm",
			},
		]);
	});

	// The provider drops a recording after its seven-day expiry, and the deletion pipeline skips
	// its stop on exactly this name. Every other refusal keeps `provider_refused`, so a transient
	// 500 can never read like the recording being gone.
	test("404 answers not_found while any other refusal stays provider_refused", async () => {
		const { env } = make_test_env();
		let status = 404;
		const mock = install_fetch({
			"/recordings/rec-1": () => Response.json({ success: false }, { status }),
		});
		restoreFetch = mock.restore;

		const dropped = await council_provider_get_recording(env, "rec-1");
		expect(dropped._nay?.name).toBe("not_found");

		status = 500;
		const refused = await council_provider_get_recording(env, "rec-1");
		expect(refused._nay?.name).toBe("provider_refused");
	});
});
