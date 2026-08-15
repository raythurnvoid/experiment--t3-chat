import { afterEach, describe, expect, test } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";

import { council_run_deletion, council_run_processing } from "./pipeline.ts";
import { council_request_processing_redrive } from "./lifecycle.ts";
import { council_get_meeting } from "./db.ts";
import type { WorkflowStep } from "./cf.ts";
import type { Env } from "./env.ts";
import {
	FUTURE,
	install_fetch,
	make_test_env,
	seed_grant,
	seed_meeting,
	seed_participant,
	seed_room_session,
} from "../test/env.ts";

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

/** A pass-through step: callbacks run immediately, sleeps are skipped. The pipeline's own
 * idempotency (artifact rows, track statuses) is what the replay tests exercise. */
function test_step(): WorkflowStep {
	return {
		do: (async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
			const result = await ((callback ?? configOrCallback) as () => Promise<unknown>)();
			// The platform serializes step results, so an `undefined` field comes back as a missing
			// key. The JSON round-trip keeps the harness honest about what survives a step boundary.
			return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
		}) as WorkflowStep["do"],
		sleep: async () => {},
	};
}

/**
 * Live Workflows retry a thrown Error. This fake does the same so a terminal archive refusal
 * must throw NonRetryableError or the test would hang on five retries.
 */
function retrying_step(limit = 5): WorkflowStep {
	return {
		do: (async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
			const fn = (callback ?? configOrCallback) as () => Promise<unknown>;
			let last: unknown;
			for (let attempt = 0; attempt <= limit; attempt++) {
				try {
					const result = await fn();
					return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
				} catch (error) {
					last = error;
					if (error instanceof NonRetryableError) {
						throw error;
					}
				}
			}
			throw last;
		}) as WorkflowStep["do"],
		sleep: async () => {},
	};
}

// Real M0-measured filename shape: {prefix}_{addParticipantDataId}_{peerId}_peer_audio_{unixMs}.webm
const ALICE_PROVIDER_ID = "aaa011ac-fa6a-4acb-8b0a-32eaf9a401aa";
const BOB_PROVIDER_ID = "aaabcb4c-4fcd-47eb-9abf-70324357174f";
const ALICE_FILE = `council_${ALICE_PROVIDER_ID}_peer1_peer_audio_1755200000000.webm`;
const BOB_FILE = `council_${BOB_PROVIDER_ID}_peer2_peer_audio_1755200010000.webm`;

const ALICE_PHRASE = "The purple hedgehog articulated its quarterly forecast";
const BOB_PHRASE = "Nineteen copper kettles whistled in dissent";

/** Whisper mock keyed by decoded audio byte length, so each phrase is bound to exactly one
 * track's bytes and a crossed-wire bug in the pipeline would surface as a crossed name/phrase pair. */
function make_whisper_mock(counter: { runs: number }): Env["AI"] {
	return {
		run: async (_model: string, input: unknown) => {
			counter.runs += 1;
			const byteLength = atob((input as { audio: string }).audio).length;
			if (byteLength === 4) {
				return { text: ALICE_PHRASE, segments: [{ start: 1, end: 3, text: ALICE_PHRASE }] };
			}
			if (byteLength === 5) {
				return { text: BOB_PHRASE, segments: [{ start: 0.5, end: 2, text: BOB_PHRASE }] };
			}
			throw new Error(`Unexpected audio byte length ${byteLength}`);
		},
	};
}

/** The provider mock surface a processing run touches. Insertion order matters: the transcript
 * metadata URL also contains "/sessions/sess-1", so its key must match first.
 *
 * The recording mock is stateful on purpose: the live provider keeps a track recording in
 * RECORDING after the session ends (proven live 2026-08-16 — it runs to its max_seconds cap), so
 * track files exist only after an explicit PUT stop. The mock answers the live flat shape —
 * `data` IS the recording object. */
function processing_fetch_overrides(
	overrides: Record<string, (call: { method: string; bodyJson: Record<string, unknown> | null }) => Response> = {},
) {
	let recordingStopped = false;
	return {
		"/transcript?format=JSON": () =>
			Response.json({ success: true, data: { transcript_download_url: "https://transcript.example/t1" } }),
		"https://transcript.example/t1": () => Response.json([{ sentence: "hello world", peerData: { id: "TEST" } }]),
		"/sessions/sess-1": () => Response.json({ success: true, data: { status: "ENDED", settings: { transcribe_on_end: true } } }),
		"/recordings/rec-1": (call: { method: string; bodyJson: Record<string, unknown> | null }) => {
			if (call.method === "PUT" && call.bodyJson?.action === "stop") {
				recordingStopped = true;
				return Response.json({ success: true, data: { status: "UPLOADING" } });
			}
			if (!recordingStopped) {
				return Response.json({ success: true, data: { status: "RECORDING" } });
			}
			return Response.json({
				success: true,
				data: {
					status: "UPLOADED",
					download_url: {
						links: [
							{
								download_urls: {
									[ALICE_FILE]: { download_url: "https://tracks.example/alice" },
									[BOB_FILE]: { download_url: "https://tracks.example/bob" },
								},
							},
						],
					},
				},
			});
		},
		"https://tracks.example/alice": () => new Response("abcd", { headers: { "Content-Length": "4" } }),
		"https://tracks.example/bob": () => new Response("abcde", { headers: { "Content-Length": "5" } }),
		...overrides,
	};
}

async function seed_processing_meeting(env: Env, args?: { aliceName?: string }) {
	await seed_grant(env);
	await seed_grant(env, {
		id: "grant-proc",
		phase: "processing",
		destinationPathPrefix: "/meetings/meeting-1",
		token: "psg_processing_seeded",
	});
	await seed_meeting(env, {
		status: "processing",
		processingGrantId: "grant-proc",
		providerRecordingId: "rec-1",
		providerSessionId: "sess-1",
		recordingStartedAt: 1000,
		closedAt: 200000,
		processingGeneration: 1,
	});
	await seed_participant(env, {
		meetingId: "meeting-1",
		displayName: args?.aliceName ?? "Alice Prime",
		providerParticipantId: ALICE_PROVIDER_ID,
		acceptedAt: 1,
	});
	await seed_participant(env, {
		meetingId: "meeting-1",
		displayName: "Bob Echo",
		providerParticipantId: BOB_PROVIDER_ID,
		acceptedAt: 1,
	});
}

function markdown_put_body(calls: { url: string; method: string; bodyText: string | null }[]) {
	const put = calls.find((call) => call.method === "PUT" && call.url.includes("transcript_markdown"));
	return put?.bodyText ?? "";
}

const PROCESS_PARAMS = { kind: "process_meeting" as const, meetingId: "meeting-1", generation: 1 };

describe("council_run_processing", () => {
	test("attributes each phrase to the participant whose provider id names the track file", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting?.status).toBe("ready");

		// One artifact set: two audio tracks, the diagnostic provider transcript, and the Markdown.
		const artifacts = await env.COUNCIL_DB.prepare(
			"SELECT kind, status FROM meeting_artifacts ORDER BY kind",
		).all<{ kind: string; status: string }>();
		expect(artifacts.results.map((row) => `${row.kind}:${row.status}`)).toEqual([
			"provider_transcript:finalized",
			"track_audio:finalized",
			"track_audio:finalized",
			"transcript_markdown:finalized",
		]);

		// The name -> phrase binding is the whole product. Crossed pairs must not exist.
		const markdown = markdown_put_body(mock.calls);
		expect(markdown).toContain(`**Alice Prime:** ${ALICE_PHRASE}`);
		expect(markdown).toContain(`**Bob Echo:** ${BOB_PHRASE}`);
		expect(markdown).not.toContain(`**Alice Prime:** ${BOB_PHRASE.split(" ")[0]}`);
		expect(markdown).not.toContain(`**Bob Echo:** ${ALICE_PHRASE.split(" ")[0]}`);

		// Meeting order from the filename timestamps: Alice's track started 10 s before Bob's.
		expect(markdown.indexOf("Alice Prime")).toBeLessThan(markdown.indexOf("Bob Echo"));

		// The provider transcript is stored as a diagnostic file, never merged into the Markdown.
		expect(markdown).not.toContain("hello world");
		const diagnosticPut = mock.calls.find((call) => call.method === "PUT" && call.url.includes("provider_transcript"));
		expect(diagnosticPut?.bodyText).toContain("hello world");

		expect(counter.runs).toBe(2);

		// The terminal projection is the page's signal the run finished: the newest revision must
		// carry `ready`.
		const projected = await env.COUNCIL_DB.prepare(
			"SELECT payload FROM projection_outbox ORDER BY revision DESC LIMIT 1",
		).first<{ payload: string }>();
		expect((JSON.parse(projected?.payload ?? "{}") as { status: string }).status).toBe("ready");

		// Every upload target lands strictly inside the meeting's sealed folder.
		const createTargets = mock.calls.filter((call) => call.url.includes("/service-uploads/create-target"));
		expect(createTargets.length).toBeGreaterThan(0);
		for (const call of createTargets) {
			expect(String(call.bodyJson?.path).startsWith("/meetings/meeting-1/")).toBe(true);
		}
	});

	test("a refused recording read or stop costs poll attempts, never the meeting", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let reads = 0;
		let stopAttempts = 0;
		let recordingStopped = false;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						stopAttempts += 1;
						// The first stop is refused: the poll must retry it on a later attempt.
						if (stopAttempts === 1) {
							return Response.json({ success: false }, { status: 500 });
						}
						recordingStopped = true;
						return Response.json({ success: true, data: { status: "UPLOADING" } });
					}
					reads += 1;
					// The first read is refused: it must cost one poll attempt, not skip the stop.
					if (reads === 1) {
						return Response.json({ success: false }, { status: 500 });
					}
					if (!recordingStopped) {
						return Response.json({ success: true, data: { status: "RECORDING" } });
					}
					return Response.json({
						success: true,
						data: {
							status: "UPLOADED",
							download_url: {
								links: [
									{
										download_urls: {
											[ALICE_FILE]: { download_url: "https://tracks.example/alice" },
											[BOB_FILE]: { download_url: "https://tracks.example/bob" },
										},
									},
								],
							},
						},
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");
		expect(stopAttempts).toBe(2);
	});

	test("a recording that never leaves RECORDING fails with the stop refusal as the reason", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					// Every stop is refused and the recording stays RECORDING for the whole poll budget.
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						return Response.json({ success: false }, { status: 500 });
					}
					return Response.json({ success: true, data: { status: "RECORDING" } });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/never stopped/u);
		const failed = await env.COUNCIL_DB.prepare("SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
			failure_reason: string;
		}>();
		expect(failed?.status).toBe("failed");
		// The operator must see the stop refusal, not a track-files message pointing at the wrong step.
		expect(failed?.failure_reason).toContain("never stopped");

		// The failure is projected — the page shows the reason — and the reserved envelope goes back.
		const projected = await env.COUNCIL_DB.prepare(
			"SELECT payload FROM projection_outbox ORDER BY revision DESC LIMIT 1",
		).first<{ payload: string }>();
		const payload = JSON.parse(projected?.payload ?? "{}") as { status: string; failureReason: string | null };
		expect(payload.status).toBe("failed");
		expect(payload.failureReason).toContain("never stopped");
		const release = mock.calls.find((call) => call.url.includes("/service-uploads/release"));
		expect(release?.bodyJson).toEqual({ idempotencyKey: "council-uploads-meeting-1" });
	});

	test("a recording seen RECORDING once and then unreadable still reports the stop refusal", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let reads = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						return Response.json({ success: false }, { status: 500 });
					}
					reads += 1;
					// Only the first read answers, and it shows RECORDING. Every later read is refused,
					// so that one observation must survive to the exhaustion message.
					if (reads === 1) {
						return Response.json({ success: true, data: { status: "RECORDING" } });
					}
					return Response.json({ success: false }, { status: 500 });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/never stopped/u);
		const failed = await env.COUNCIL_DB.prepare("SELECT failure_reason FROM meetings WHERE id = 'meeting-1'").first<{
			failure_reason: string;
		}>();
		expect(failed?.failure_reason).toContain("never stopped");
	});

	test("a recording that stopped but never published files reports the missing files, not the stop", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let reads = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						return Response.json({ success: false }, { status: 500 });
					}
					reads += 1;
					// The first read shows RECORDING; every later read shows UPLOADING with no files
					// for the whole budget. The later definitive observation must replace the earlier
					// one — a sticky RECORDING flag would blame the stop instead of the missing files.
					if (reads === 1) {
						return Response.json({ success: true, data: { status: "RECORDING" } });
					}
					return Response.json({ success: true, data: { status: "UPLOADING" } });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/never published/u);
	});

	test("a crashed run replays onto the same artifact set: no second upload, no second transcription", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let failedOnce = false;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/finalize": (call) => {
					// Fail the Markdown finalize exactly once: the crash lands after every track upload.
					const targetKey = String(call.bodyJson?.targetKey);
					if (targetKey.startsWith("transcript_markdown") && !failedOnce) {
						failedOnce = true;
						return Response.json({ message: "boom" }, { status: 500 });
					}
					return Response.json({ state: "committed", path: "/meetings/meeting-1/f", nodeId: `node-${targetKey}`, actualBytes: 1 });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/finalize refused/u);
		const failed = await env.COUNCIL_DB.prepare("SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
			failure_reason: string;
		}>();
		expect(failed?.status).toBe("failed");
		expect(failed?.failure_reason).toContain("finalize");

		// Operator redrive must bump the generation. Same-generation `failed -> processing` would
		// dispatch a delivered outbox row whose Workflow instance is already terminal.
		const failedMeeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(failedMeeting).not.toBeNull();
		const redriven = await council_request_processing_redrive(env, failedMeeting!, Date.now());
		expect(redriven._yay?.started).toBe(true);
		const after = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(after).toEqual({ status: "processing", processing_generation: 2 });
		const outcome = await council_run_processing(env, test_step(), { ...PROCESS_PARAMS, generation: 2 });
		expect(outcome).toBe("ready");

		// The replay found the finalized track artifacts and skipped their uploads and transcriptions.
		const trackPuts = mock.calls.filter((call) => call.method === "PUT" && call.url.includes("track_audio"));
		expect(trackPuts.length).toBe(2);
		expect(counter.runs).toBe(2);

		const artifacts = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_artifacts").first<{ n: number }>();
		expect(artifacts?.n).toBe(4);

		// The failure gave the envelope back, so the redrive could not reuse the released
		// reservation: it reserved a fresh envelope under a new generation-scoped key, and the
		// transcript's retried target was minted under that key.
		const reserveKeys = mock.calls
			.filter((call) => call.url.includes("/service-uploads/reserve"))
			.map((call) => String(call.bodyJson?.idempotencyKey));
		expect(reserveKeys[0]).toBe("council-uploads-meeting-1");
		expect(reserveKeys.at(-1)).toMatch(/^council-uploads-meeting-1-g2-r[0-9a-f-]{36}$/u);
		const retriedTargets = mock.calls.filter(
			(call) =>
				call.url.includes("/service-uploads/create-target") &&
				String(call.bodyJson?.targetKey).startsWith("transcript_markdown"),
		);
		expect(String(retriedTargets.at(-1)?.bodyJson?.idempotencyKey)).toBe(reserveKeys.at(-1));
	});

	test("a hostile display name cannot smuggle HTML into the Markdown", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env, { aliceName: "<img src=x onerror=alert(1)>" });

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		// Every `<` in the rendered Markdown must carry the backslash escape; the app renders stored
		// Markdown with raw HTML passthrough, so one unescaped `<img` becomes a live element.
		const markdown = markdown_put_body(mock.calls);
		expect(markdown).toContain("\\<img");
		expect(markdown.replaceAll("\\<", "").includes("<")).toBe(false);
	});

	test("a session that never reaches ENDED still processes when a recording id exists", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(
			processing_fetch_overrides({
				"/sessions/sess-1": () =>
					Response.json({ success: true, data: { status: "LIVE", settings: { transcribe_on_end: true } } }),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");
		expect(mock.calls.filter((call) => call.url.includes("/active-session/kick-all")).length).toBeGreaterThan(0);
	});

	test("a recording stopped within seconds finishes ready with the explicit empty transcript", async () => {
		const { env } = make_test_env();
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, {
			status: "processing",
			processingGrantId: "grant-proc",
			providerRecordingId: "rec-1",
			providerSessionId: "sess-1",
			recordingStartedAt: 1000,
			closedAt: 3000,
			processingGeneration: 1,
		});

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		expect(markdown_put_body(mock.calls)).toContain("_No speech was recorded._");
		const artifacts = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_artifacts").first<{ n: number }>();
		expect(artifacts?.n).toBe(1);
		// The provider was never polled: its track files may never exist for a too-short recording.
		expect(mock.calls.some((call) => call.url.includes("/recordings/rec-1"))).toBe(false);
	});

	test("reaching ready releases the reserved envelope with the stored reserve key", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		// The envelope was reserved when the meeting opened; ready is the moment the unused bytes go
		// back to the workspace. The release replays the reservation's own stored idempotency key.
		const release = mock.calls.find((call) => call.url.includes("/service-uploads/release"));
		expect(release?.bodyJson).toEqual({ idempotencyKey: "council-uploads-meeting-1" });
	});

	test("a stale generation is a no-op", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 2 });

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("stale");
		expect(mock.calls.length).toBe(0);
		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting?.status).toBe("processing");
	});
});

describe("council_run_deletion", () => {
	test("deletes files, clears PII, supersedes pending projections, and leaves a bounded tombstone", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, {
			status: "deleting",
			processingGrantId: "grant-proc",
			providerRecordingId: "rec-1",
			processingGeneration: 2,
		});
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			displayName: "Alice Prime",
			providerParticipantId: ALICE_PROVIDER_ID,
		});
		await env.COUNCIL_DB.prepare(
			"UPDATE meeting_participants SET email_hmac = 'a1b2', provider_token_encrypted = 'enc' WHERE id = ?",
		)
			.bind(participant.id)
			.run();
		await seed_room_session(env, { meetingId: "meeting-1", participantId: participant.id, role: "guest" });
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES ('hash', 'meeting-1', 'user-1', 'grant-1', ?, 0)",
		)
			.bind(FUTURE)
			.run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_tracks (id, meeting_id, file_name, transcript_json, status, created_at, updated_at)
			VALUES ('track-1', 'meeting-1', ?, '[]', 'transcribed', 0, 0)`,
		)
			.bind(ALICE_FILE)
			.run();
		for (const [index, kind] of (["track_audio", "transcript_markdown"] as const).entries()) {
			await env.COUNCIL_DB.prepare(
				`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, node_id, status, created_at, updated_at)
				VALUES (?, 'meeting-1', ?, ?, 'f', ?, 'finalized', 0, 0)`,
			)
				.bind(`artifact-${index}`, kind, `${kind}:f`, `node-${index}`)
				.run();
		}
		// One undelivered projection write, as if a delivery failed earlier. The delete supersedes it.
		await env.COUNCIL_DB.prepare("UPDATE meetings SET projection_revision = 1 WHERE id = 'meeting-1'").run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at)
			VALUES ('proj-1', 'meeting-1', 1, 'write', '{}', 'pending', 0, 0, 0)`,
		).run();

		const outcome = await council_run_deletion(env, test_step(), {
			kind: "delete_meeting",
			meetingId: "meeting-1",
			generation: 2,
		});
		expect(outcome).toBe("deleted");

		// The meeting folder is archived once, with everything inside it. No file is deleted by key:
		// stored files are real files, and deleting one in this product means archiving it.
		const archiveCalls = mock.calls.filter((call) => call.url.includes("/service-uploads/archive-destination"));
		expect(archiveCalls).toHaveLength(1);
		expect(mock.calls.filter((call) => call.url.includes("/service-uploads/delete"))).toHaveLength(0);
		// The archive must spend the sealed processing grant, not the interactive one — only the
		// sealed grant carries the file scope for this folder.
		expect(archiveCalls[0]!.headers.get("Authorization")).toBe("Bearer psg_processing_seeded");
		const artifactStates = await env.COUNCIL_DB.prepare("SELECT DISTINCT status FROM meeting_artifacts").all<{
			status: string;
		}>();
		expect(artifactStates.results.map((row) => row.status)).toEqual(["deleted"]);

		// The live upload reservation was released too, refunding whatever was never finalized. It
		// runs before the archive so the placeholder files of unfinished uploads are gone by then.
		const release = mock.calls.find((call) => call.url.includes("/service-uploads/release"));
		expect(release?.bodyJson).toEqual({ idempotencyKey: "council-uploads-meeting-1" });
		expect(mock.calls.indexOf(release!)).toBeLessThan(mock.calls.indexOf(archiveCalls[0]!));

		// The stale pending write was superseded and the terminal delete was delivered after it.
		const projections = await env.COUNCIL_DB.prepare(
			"SELECT revision, operation, status FROM projection_outbox ORDER BY revision",
		).all<{ revision: number; operation: string; status: string }>();
		expect(projections.results).toEqual([
			{ revision: 1, operation: "write", status: "superseded" },
			{ revision: 2, operation: "delete", status: "delivered" },
		]);
		const deleteVersioned = mock.calls.find((call) => call.url.includes("/plugin-data/delete-versioned"));
		expect(deleteVersioned?.bodyJson?.revision).toBe(2);

		// PII and secrets are gone; the tombstone remains, bounded in time.
		const cleared = await env.COUNCIL_DB.prepare(
			"SELECT display_name, email_hmac, provider_token_encrypted FROM meeting_participants",
		).first<{ display_name: string; email_hmac: string | null; provider_token_encrypted: string | null }>();
		expect(cleared).toEqual({ display_name: "", email_hmac: null, provider_token_encrypted: null });
		const sessions = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM room_sessions").first<{ n: number }>();
		expect(sessions?.n).toBe(0);
		const tickets = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_tickets").first<{ n: number }>();
		expect(tickets?.n).toBe(0);
		const track = await env.COUNCIL_DB.prepare("SELECT transcript_json FROM meeting_tracks").first<{
			transcript_json: string | null;
		}>();
		expect(track?.transcript_json).toBeNull();

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, title, service_grant_id, processing_grant_id, tombstone_expires_at FROM meetings WHERE id = 'meeting-1'",
		).first<{
			status: string;
			title: string;
			service_grant_id: string | null;
			processing_grant_id: string | null;
			tombstone_expires_at: number | null;
		}>();
		expect(meeting?.status).toBe("deleted_tombstone");
		expect(meeting?.title).toBe("");
		expect(meeting?.service_grant_id).toBeNull();
		expect(meeting?.processing_grant_id).toBeNull();
		// Eight days: late provider webhooks must refuse against the tombstone for as long as their
		// retries can arrive, and the row must not outlive that window by much.
		expect(meeting?.tombstone_expires_at).toBeGreaterThan(Date.now() + 7 * 24 * 60 * 60 * 1000);
		expect(meeting?.tombstone_expires_at).toBeLessThan(Date.now() + 9 * 24 * 60 * 60 * 1000);

		// The sealed processing grant died with the meeting; the shared interactive grant survives.
		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1"]);
	});

	test("an archive refusal fails the delete visibly instead of pretending the folder is gone", async () => {
		const { env } = make_test_env();
		// The documented refusal: a member locked a file inside the meeting folder.
		const mock = install_fetch({
			"/service-uploads/archive-destination": () =>
				Response.json({ message: "This item is read-only." }, { status: 409 }),
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, node_id, status, created_at, updated_at)
			VALUES ('artifact-1', 'meeting-1', 'transcript_markdown', 'transcript_markdown:f', 'f', 'node-1', 'finalized', 0, 0)`,
		).run();

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toThrow(/Archiving the meeting folder/u);

		const meeting = await env.COUNCIL_DB.prepare("SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
			failure_reason: string;
		}>();
		expect(meeting?.status).toBe("delete_failed");
		expect(meeting?.failure_reason).toContain("Archiving the meeting folder");
		// The host's own reason has to survive the hop, or the stored failure names no cause and
		// nobody can tell the member what to clear before deleting again.
		expect(meeting?.failure_reason).toContain("This item is read-only.");
		// The artifact keeps its finalized state: nothing may read as cleaned up while the folder is
		// still in the tree, so the retried delete archives it for real.
		const artifact = await env.COUNCIL_DB.prepare("SELECT status FROM meeting_artifacts").first<{ status: string }>();
		expect(artifact?.status).toBe("finalized");
	});

	test("an archive conflict is not retried by the Workflow step", async () => {
		const { env } = make_test_env();
		let archiveCalls = 0;
		const mock = install_fetch({
			"/service-uploads/archive-destination": () => {
				archiveCalls += 1;
				return Response.json({ message: "This item is read-only." }, { status: 409 });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, retrying_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toBeInstanceOf(NonRetryableError);

		expect(archiveCalls).toBe(1);
		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting?.status).toBe("delete_failed");
	});

	test("a meeting that stored nothing still archives the folder its first upload created", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", processingGeneration: 2 });

		const outcome = await council_run_deletion(env, test_step(), {
			kind: "delete_meeting",
			meetingId: "meeting-1",
			generation: 2,
		});
		expect(outcome).toBe("deleted");
		expect(mock.calls.filter((call) => call.url.includes("/service-uploads/archive-destination"))).toHaveLength(1);
	});
});
