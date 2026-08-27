import { afterEach, describe, expect, test, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";

import { council_run_deletion, council_run_processing } from "./pipeline.ts";
import { council_SUMMARY_FAILURE_PREFIX } from "./ai.ts";
import { council_COMPOSITE_AUDIO_FILE_NAME, council_COMPOSITE_VIDEO_FILE_NAME } from "./tracks.ts";
import { council_request_meeting_delete, council_request_processing_redrive } from "./lifecycle.ts";
import { council_get_meeting } from "./db.ts";
import type { D1Database, D1PreparedStatement, WorkflowStep } from "./cf.ts";
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
let restoreSleep: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
	restoreSleep?.();
	restoreSleep = null;
});

/**
 * Run every `setTimeout` at zero delay and record the delay each caller asked for. The finalize
 * poll waits 500 ms and then doubles, so an artifact that never settles costs twenty-seven real
 * seconds. A test that has to reach the later attempts installs this and asserts the recorded
 * delays instead. Nothing else in a pipeline run sets a timer, so the recorded list is the poll's
 * own backoff. Call `restore()` in afterEach.
 */
function install_instant_sleep() {
	const delays: number[] = [];
	const original = globalThis.setTimeout;

	globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
		delays.push(ms ?? 0);
		return original(callback, 0, ...rest);
	}) as typeof globalThis.setTimeout;

	return {
		delays,
		restore: () => {
			globalThis.setTimeout = original;
		},
	};
}

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
 *
 * A step that passes its own `retries` config gets exactly that budget, like the platform does, so
 * a test can prove the config on the step is real and was not dropped.
 */
function retrying_step(limit = 5): WorkflowStep {
	return {
		do: (async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
			const fn = (callback ?? configOrCallback) as () => Promise<unknown>;
			const declared =
				callback === undefined ? undefined : (configOrCallback as { retries?: { limit?: number } }).retries?.limit;
			const attempts = declared ?? limit;
			let last: unknown;
			for (let attempt = 0; attempt <= attempts; attempt++) {
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

/**
 * A Workflow replay hands back each step's cached result WITHOUT running its callback again. Both
 * fakes above run every callback on every call, so they cannot tell a value that travels in the
 * step result apart from one the pipeline keeps in a local variable. This fake caches by step name
 * and answers a second pass from that cache, so the second run is a real replay.
 *
 * Re-use the same instance for both runs: the cache IS the instance's step history.
 */
function replaying_step(): WorkflowStep {
	const cached = new Map<string, string | undefined>();
	return {
		do: (async (name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
			if (!cached.has(name)) {
				const result = await ((callback ?? configOrCallback) as () => Promise<unknown>)();
				cached.set(name, result === undefined ? undefined : JSON.stringify(result));
			}
			const stored = cached.get(name);
			return stored === undefined ? undefined : JSON.parse(stored);
		}) as WorkflowStep["do"],
		sleep: async () => {},
	};
}

/**
 * A step error crosses the Workflow RPC boundary, and the platform does not promise to hand it back
 * as the same class. This fake models that: the value the run's catch sees is not an `Error` in this
 * realm, so `String()` of it prints the class name before the message.
 */
function rpc_boundary_step(): WorkflowStep {
	return {
		do: (async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
			const fn = (callback ?? configOrCallback) as () => Promise<unknown>;
			try {
				const result = await fn();
				return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
			} catch (error) {
				const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
				throw { toString: () => text };
			}
		}) as WorkflowStep["do"],
		sleep: async () => {},
	};
}

// Real M0-measured filename shape: {prefix}_{addParticipantDataId}_{peerId}_peer_audio_{unixMs}.webm
const ALICE_PROVIDER_ID = "aaa011ac-fa6a-4acb-8b0a-32eaf9a401aa";
const BOB_PROVIDER_ID = "aaabcb4c-4fcd-47eb-9abf-70324357174f";
// Keep an uppercase letter in Alice's peer id. The provider names these files and Council never
// checks their case, while the app refuses an upload path whose file name is not already lowercase.
// So `upload_artifact` lowercases the name when it builds the path, and only a fixture that really
// carries an uppercase letter can catch that step going missing.
const ALICE_FILE = `council_${ALICE_PROVIDER_ID}_Peer1_peer_audio_1755200000000.webm`;
const BOB_FILE = `council_${BOB_PROVIDER_ID}_peer2_peer_audio_1755200010000.webm`;

const ALICE_PHRASE = "The purple hedgehog articulated its quarterly forecast";
const BOB_PHRASE = "Nineteen copper kettles whistled in dissent";

/** Whisper mock keyed by decoded audio byte length, so each phrase is bound to exactly one
 * track's bytes and a crossed-wire bug in the pipeline would surface as a crossed name/phrase pair. */
function make_whisper_mock(counter: { runs: number; summaryRuns?: number; summaryInputs?: unknown[] }): Env["AI"] {
	return {
		run: async (model: string, input: unknown) => {
			counter.runs += 1;
			if (model === "@cf/meta/llama-3.1-8b-instruct-fast") {
				counter.summaryRuns = (counter.summaryRuns ?? 0) + 1;
				counter.summaryInputs?.push(input);
				return {
					response: {
						overview: "The group reviewed the quarterly forecast.",
						topics: ["Quarterly forecast"],
						decisions: [],
						actionItems: [],
					},
				};
			}
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

/** Whisper works, but the summary model answers this meeting badly every single time — the shape a
 * schema-invalid model answer or a broken Workers AI account has. */
function failing_summary_mock(counter: { runs: number; summaryRuns: number }): Env["AI"] {
	const whisper = make_whisper_mock(counter);
	return {
		run: async (model: string, input: unknown) => {
			if (model === "@cf/meta/llama-3.1-8b-instruct-fast") {
				counter.summaryRuns += 1;
				return { response: { overview: "" } };
			}
			return await whisper.run(model, input);
		},
	};
}

/** Whisper works, and the summary model answers badly exactly once — the shape a Workers AI blip
 * has, not a model that cannot answer this meeting at all. */
function blipping_summary_mock(counter: { runs: number; summaryRuns: number }): Env["AI"] {
	const whisper = make_whisper_mock(counter);
	return {
		run: async (model: string, input: unknown) => {
			if (model === "@cf/meta/llama-3.1-8b-instruct-fast" && counter.summaryRuns === 0) {
				counter.summaryRuns += 1;
				return { response: { overview: "" } };
			}
			return await whisper.run(model, input);
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
		"/sessions/sess-1": () =>
			Response.json({ success: true, data: { status: "ENDED", settings: { transcribe_on_end: true } } }),
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

/**
 * A track download past `council_TRACK_TRANSCRIBE_MAX_BYTES`. The 60-minute meeting ceiling puts a
 * full-length recording right next to that cap, so this is a real track, not a freak one.
 *
 * One megabyte is enqueued 25 times rather than built once at full size: the cap counts bytes, and
 * a 25 MB buffer would only make the test slow.
 */
function oversized_track_response() {
	const megabyte = new Uint8Array(1024 * 1024);
	let sent = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= 25) {
				controller.close();
				return;
			}
			sent += 1;
			controller.enqueue(megabyte);
		},
	});
	return new Response(stream, { headers: { "Content-Length": String(25 * 1024 * 1024) } });
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

function summary_put_body(calls: { url: string; method: string; bodyText: string | null }[]) {
	const put = calls.find((call) => call.method === "PUT" && call.url.includes("summary_markdown"));
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

		// One artifact set: two audio tracks, the diagnostic provider transcript, and two Markdown files.
		const artifacts = await env.COUNCIL_DB.prepare("SELECT kind, status FROM meeting_artifacts ORDER BY kind").all<{
			kind: string;
			status: string;
		}>();
		expect(artifacts.results.map((row) => `${row.kind}:${row.status}`)).toEqual([
			"provider_transcript:finalized",
			"summary_markdown:finalized",
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

		// The stamps are offsets from the earliest track, not the raw filename clock. Alice's file
		// starts ten seconds before Bob's, and Whisper put her first words one second into her own
		// track and his half a second into his.
		expect(markdown).toContain(`- \`0:01\` **Alice Prime:** ${ALICE_PHRASE}`);
		expect(markdown).toContain(`- \`0:10\` **Bob Echo:** ${BOB_PHRASE}`);

		// The provider transcript is stored as a diagnostic file, never merged into the Markdown.
		expect(markdown).not.toContain("hello world");
		const diagnosticPut = mock.calls.find((call) => call.method === "PUT" && call.url.includes("provider_transcript"));
		expect(diagnosticPut?.bodyText).toContain("hello world");

		expect(counter.runs).toBe(3);
		expect(counter.summaryRuns).toBe(1);
		expect(summary_put_body(mock.calls)).toContain("— Meeting summary");

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

	test("stores the mixed composite files and attributes speech to Meeting", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let recordingStopped = false;
		const mock = install_fetch(
			processing_fetch_overrides({
				// Ten bytes so Whisper throws if this video is sent to the model. Four-byte audio is
				// Alice's phrase. A crossed download would fail this test instead of looking ready.
				"https://tracks.example/composite-video": () =>
					new Response("videobytes", { headers: { "Content-Length": "10" } }),
				"https://tracks.example/composite-audio": () =>
					new Response("abcd", { headers: { "Content-Length": "4" } }),
				"/recordings/rec-1": (call) => {
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
							recording_duration: 790,
							download_url: "https://tracks.example/composite-video",
							audio_download_url: "https://tracks.example/composite-audio",
						},
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		const artifacts = await env.COUNCIL_DB.prepare("SELECT kind, status FROM meeting_artifacts ORDER BY kind").all<{
			kind: string;
			status: string;
		}>();
		expect(artifacts.results.map((row) => `${row.kind}:${row.status}`)).toEqual([
			"provider_transcript:finalized",
			"summary_markdown:finalized",
			"track_audio:finalized",
			"track_audio:finalized",
			"transcript_markdown:finalized",
		]);
		// Host budget is 16 targets. Composite uses two recording files plus the three documents.
		const artifactNames = await env.COUNCIL_DB.prepare(
			"SELECT file_name FROM meeting_artifacts ORDER BY file_name",
		).all<{ file_name: string }>();
		expect(artifactNames.results.map((row) => row.file_name)).toEqual([
			"provider-transcript.json",
			"recording-audio.m4a",
			"recording.mp4",
			"summary.md",
			"transcript.md",
		]);
		expect(artifactNames.results).toHaveLength(5);

		const markdown = markdown_put_body(mock.calls);
		expect(markdown).toContain(`**Meeting:** ${ALICE_PHRASE}`);
		expect(markdown).not.toContain("**Alice Prime:**");
		expect(markdown).not.toContain("**Bob Echo:**");
		expect(markdown).not.toContain("could not be transcribed");

		const track_status = async (fileName: string) =>
			(
				await env.COUNCIL_DB.prepare("SELECT status FROM meeting_tracks WHERE file_name = ?")
					.bind(fileName)
					.first<{ status: string }>()
			)?.status;
		expect(await track_status(council_COMPOSITE_VIDEO_FILE_NAME)).toBe("discovered");
		expect(await track_status(council_COMPOSITE_AUDIO_FILE_NAME)).toBe("transcribed");

		const trackTargets = mock.calls.filter(
			(call) =>
				call.url.includes("/service-uploads/create-target") &&
				String(call.bodyJson?.targetKey).startsWith("track_audio:"),
		);
		expect(trackTargets.map((call) => call.bodyJson?.contentType).sort()).toEqual(["audio/mp4", "video/mp4"]);

		expect(counter.runs).toBe(2);
		expect(counter.summaryRuns).toBe(1);
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
		const failed = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{
			status: string;
			failure_reason: string;
		}>();
		expect(failed?.status).toBe("failed");
		// The operator must see the stop refusal, not a track-files message pointing at the wrong step.
		expect(failed?.failure_reason).toContain("never stopped");

		// The failure is projected, so the page can say the meeting failed. The stop refusal itself
		// stays in D1: `council_projection_value` leaves `failure_reason` out, because every workspace
		// member can read that document and the column is written for an operator. Search the whole
		// payload text, not one key, so the operator words are caught under any key name.
		const projected = await env.COUNCIL_DB.prepare(
			"SELECT payload FROM projection_outbox ORDER BY revision DESC LIMIT 1",
		).first<{ payload: string }>();
		const payload = JSON.parse(projected?.payload ?? "{}") as { status: string };
		expect(payload.status).toBe("failed");
		expect(projected?.payload).not.toContain("never stopped");
		// A failed run hands nothing back: the workspace keeps whatever the uploads already charged.
		expect(mock.calls.find((call) => call.url.includes("/service-uploads/release"))).toBeUndefined();
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

	test("a hung UPLOADING recording with duration 0 finishes ready from the provider transcript", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						return Response.json({ success: true, data: { status: "UPLOADING", recording_duration: 0 } });
					}
					return Response.json({ success: true, data: { status: "UPLOADING", recording_duration: 0 } });
				},
				"https://transcript.example/t1": () =>
					Response.json([
						{
							startTime: 1000,
							endTime: 2500,
							sentence: "hello world",
							peerData: { id: "TEST", displayName: "Alice Prime" },
						},
					]),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		const markdown = markdown_put_body(mock.calls);
		expect(markdown).toContain("hello world");
		expect(markdown).toContain("Alice Prime");
		expect(markdown).toContain("This text is the provider's own transcript");
		expect(markdown).not.toContain("_No speech was recorded._");
		expect(counter.runs).toBe(1);
		const tracks = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_tracks").first<{ n: number }>();
		expect(tracks?.n).toBe(0);
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

	test("waits for the uploaded recording before choosing its track files", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let reads = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						return Response.json({ success: true, data: { status: "UPLOADING" } });
					}
					reads += 1;
					const downloadUrls = {
						[ALICE_FILE]: { download_url: "https://tracks.example/alice" },
						...(reads === 1 ? {} : { [BOB_FILE]: { download_url: "https://tracks.example/bob" } }),
					};
					return Response.json({
						success: true,
						data: {
							status: reads === 1 ? "UPLOADING" : "UPLOADED",
							download_url: { links: [{ download_urls: downloadUrls }] },
						},
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");
		expect(reads).toBeGreaterThan(1);
		expect(counter.runs).toBe(3);
		const trackArtifacts = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM meeting_artifacts WHERE kind = 'track_audio'",
		).first<{ n: number }>();
		expect(trackArtifacts?.n).toBe(2);
	});

	test("a status that is not UPLOADED never ends the poll, whatever the provider calls it", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let reads = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						return Response.json({ success: true, data: { status: "UPLOADING" } });
					}
					reads += 1;
					// `STOPPED` is not one of the provider's recording statuses, and a status the poll
					// does not know says nothing about whether the file list is complete. Treating one
					// as terminal publishes `transcript.md` with no speech in it, and no redrive can
					// repair that: the finalized transcript and the stored summary are both skipped.
					if (reads === 1) {
						return Response.json({ success: true, data: { status: "STOPPED" } });
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

		const markdown = markdown_put_body(mock.calls);
		expect(markdown).not.toContain("_No speech was recorded._");
		expect(markdown).toContain(ALICE_PHRASE);
		expect(markdown).toContain(BOB_PHRASE);
		const trackArtifacts = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM meeting_artifacts WHERE kind = 'track_audio'",
		).first<{ n: number }>();
		expect(trackArtifacts?.n).toBe(2);
	});

	test("an ERRORED recording fails the run on the first read instead of burning the poll budget", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let reads = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": () => {
					reads += 1;
					return Response.json({ success: true, data: { status: "ERRORED" } });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, retrying_step(), PROCESS_PARAMS)).rejects.toThrow(/ERRORED/u);

		// The provider already said the recording failed, so its track files will never appear.
		// Polling for twenty minutes, or spending the step's retries, would only delay the reason.
		expect(reads).toBe(1);
		const failed = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; failure_reason: string }>();
		expect(failed?.status).toBe("failed");
		// The operator must read the provider's own failure, not a message about slow uploads.
		expect(failed?.failure_reason).toContain("ERRORED");
	});

	test("a crashed run reuses the stored summary bytes without a second model call", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let failedOnce = false;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/finalize": (call) => {
					// Fail the summary finalize exactly once, after the model answer is stored in D1.
					const targetKey = String(call.bodyJson?.targetKey);
					if (targetKey.startsWith("summary_markdown") && !failedOnce) {
						failedOnce = true;
						return Response.json({ message: "boom" }, { status: 500 });
					}
					return Response.json({
						state: "committed",
						path: "/meetings/meeting-1/f",
						nodeId: `node-${targetKey}`,
						actualBytes: 1,
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/finalize refused/u);
		const failed = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{
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

		// The replay found finalized tracks and the D1 summary, so it skipped transcription and AI.
		const trackPuts = mock.calls.filter((call) => call.method === "PUT" && call.url.includes("track_audio"));
		expect(trackPuts.length).toBe(2);
		expect(counter.runs).toBe(3);
		expect(counter.summaryRuns).toBe(1);
		const summaryPuts = mock.calls.filter((call) => call.method === "PUT" && call.url.includes("summary_markdown"));
		expect(summaryPuts).toHaveLength(2);
		expect(new Set(summaryPuts.map((call) => call.bodyText)).size).toBe(1);

		const artifacts = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_artifacts").first<{
			n: number;
		}>();
		expect(artifacts?.n).toBe(5);

		// The redrive keeps the meeting's own upload key. The summary target the failed run left
		// pending is re-used, so the workspace is not charged a second time for the same file.
		const targetKeys = mock.calls
			.filter(
				(call) =>
					call.url.includes("/service-uploads/create-target") &&
					String(call.bodyJson?.targetKey).startsWith("summary_markdown"),
			)
			.map((call) => String(call.bodyJson?.idempotencyKey));
		expect(targetKeys.length).toBeGreaterThan(1);
		expect(new Set(targetKeys)).toEqual(new Set(["council-uploads-meeting-1"]));
	});

	test("a redrive leaves a finalized transcript.md alone instead of writing it again", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);
		// The generation before this one finished transcript.md and then failed on something later.
		// The member may already have opened that file, so a redrive must not replace its bytes. The
		// summary has the same guard, and a test above covers that half.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, node_id, status, created_at, updated_at)
			VALUES ('artifact-transcript', 'meeting-1', 'transcript_markdown', 'transcript_markdown:transcript.md', 'transcript.md', 'node-transcript', 'finalized', 0, 0)`,
		).run();
		await env.COUNCIL_DB.prepare("UPDATE meetings SET processing_generation = 2 WHERE id = 'meeting-1'").run();

		const outcome = await council_run_processing(env, test_step(), { ...PROCESS_PARAMS, generation: 2 });
		expect(outcome).toBe("ready");

		const created = mock.calls
			.filter((call) => call.url.includes("/service-uploads/create-target"))
			.map((call) => String(call.bodyJson?.targetKey));
		expect(created).not.toContain("transcript_markdown:transcript.md");
		// Only the transcript was already finished, so the rest of the run still does its work.
		expect(created).toContain("summary_markdown:summary.md");
	});

	test("a redrive replays the stored create-target body instead of building a new one", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let failedOnce = false;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/finalize": (call) => {
					// Fail the transcript finalize exactly once, after its target was minted.
					const targetKey = String(call.bodyJson?.targetKey);
					if (targetKey.startsWith("transcript_markdown") && !failedOnce) {
						failedOnce = true;
						return Response.json({ message: "boom" }, { status: 500 });
					}
					return Response.json({
						state: "committed",
						path: "/meetings/meeting-1/f",
						nodeId: `node-${targetKey}`,
						actualBytes: 1,
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/finalize refused/u);

		// The title is the transcript's first heading, so a longer one changes how many bytes the
		// second run would compute for the same file.
		await env.COUNCIL_DB.prepare("UPDATE meetings SET title = ? WHERE id = 'meeting-1'")
			.bind("A considerably longer meeting title than the first run had")
			.run();
		const failedMeeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		await council_request_processing_redrive(env, failedMeeting!, Date.now());
		const outcome = await council_run_processing(env, test_step(), { ...PROCESS_PARAMS, generation: 2 });
		expect(outcome).toBe("ready");

		// The host answers a replayed idempotency key only for an identical body, so the redrive has
		// to send the first run's bytes back rather than whatever it would compute today.
		const transcriptCreateBodies = mock.calls
			.filter(
				(call) =>
					call.url.includes("/service-uploads/create-target") &&
					String(call.bodyJson?.targetKey).startsWith("transcript_markdown"),
			)
			.map((call) => call.bodyText);
		expect(transcriptCreateBodies).toHaveLength(2);
		expect(transcriptCreateBodies[1]).toBe(transcriptCreateBodies[0]);
	});

	test("a replayed instance reaches ready again from its cached step results", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const step = replaying_step();
		expect(await council_run_processing(env, step, PROCESS_PARAMS)).toBe("ready");
		const artifacts = await env.COUNCIL_DB.prepare(
			"SELECT kind, target_key, status FROM meeting_artifacts ORDER BY target_key",
		).all<{ kind: string; target_key: string; status: string }>();
		const callsBeforeReplay = mock.calls.length;

		// The same instance again. The platform answers every step from its history and runs no
		// callback, so a replay must land on the same durable state without touching the provider,
		// the model, or the host a second time.
		expect(await council_run_processing(env, step, PROCESS_PARAMS)).toBe("ready");

		expect(mock.calls.length).toBe(callsBeforeReplay);
		expect(counter.runs).toBe(3);
		const replayedArtifacts = await env.COUNCIL_DB.prepare(
			"SELECT kind, target_key, status FROM meeting_artifacts ORDER BY target_key",
		).all<{ kind: string; target_key: string; status: string }>();
		expect(replayedArtifacts.results).toEqual(artifacts.results);
	});

	test("a replayed poll still blames the stop refusal, because the status travels in the step result", async () => {
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

		const step = replaying_step();
		await expect(council_run_processing(env, step, PROCESS_PARAMS)).rejects.toThrow(/never stopped/u);

		// The replay runs no callback at all, so the last status the provider really answered is only
		// still known because it travelled inside the step result. Held in a local variable instead, it
		// would be gone here and the operator would read a message blaming the wrong step.
		const replayed = await council_run_processing(env, step, PROCESS_PARAMS).catch((error: unknown) =>
			String(error instanceof Error ? error.message : error),
		);
		expect(replayed).toContain("never stopped");
	});

	test("a summary failure survives the redrive and the next generation stores the fallback", async () => {
		const counter = { runs: 0, summaryRuns: 0 };
		const { env } = make_test_env({ AI: failing_summary_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		// Generation 1 writes the reason for real: no earlier generation failed on the summary, so the
		// bad answer fails the run and the catch stores whatever message reached it.
		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/invalid overview/u);
		const failed = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; failure_reason: string }>();
		expect(failed?.status).toBe("failed");
		// `startsWith`, not `toContain`: the next generation reads this column with `startsWith`, so a
		// message carrying anything in front of the prefix is a message it cannot recognize.
		expect(failed?.failure_reason.startsWith(council_SUMMARY_FAILURE_PREFIX)).toBe(true);

		// The redrive is what carries the reason across the generation. It moves failed -> processing
		// and bumps the generation, and it must leave the column alone on the way.
		const failedMeeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		const redriven = await council_request_processing_redrive(env, failedMeeting!, Date.now());
		expect(redriven._yay?.started).toBe(true);
		const carried = await env.COUNCIL_DB.prepare(
			"SELECT processing_generation, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ processing_generation: number; failure_reason: string }>();
		expect(carried?.processing_generation).toBe(2);
		expect(carried?.failure_reason.startsWith(council_SUMMARY_FAILURE_PREFIX)).toBe(true);

		// Only now is the fallback allowed: the model is asked once more, answers badly again, and the
		// meeting finishes on the fixed text instead of being redriven every hour forever.
		expect(await council_run_processing(env, test_step(), { ...PROCESS_PARAMS, generation: 2 })).toBe("ready");
		expect(counter.summaryRuns).toBe(2);
		expect(summary_put_body(mock.calls)).toContain("The summary could not be generated for this meeting");
	});

	test("a summary failure that lost its class at the step boundary is still stored as a summary failure", async () => {
		const counter = { runs: 0, summaryRuns: 0 };
		const { env } = make_test_env({ AI: failing_summary_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const thrown = await council_run_processing(env, rpc_boundary_step(), PROCESS_PARAMS).then(
			() => "the run did not fail",
			(error: unknown) => String(error),
		);
		// The fixture is half the test: what reaches the catch is no longer an `Error` here, and
		// printing it puts the class name in front of the message.
		expect(thrown).toBe("Error: Meeting summary had an invalid overview");

		const failed = await env.COUNCIL_DB.prepare("SELECT failure_reason FROM meetings WHERE id = 'meeting-1'").first<{
			failure_reason: string;
		}>();
		// Whatever the boundary did to the class, the stored reason must still BEGIN with the prefix:
		// it is the only thing that tells the next generation this meeting failed on its summary.
		expect(failed?.failure_reason.startsWith(council_SUMMARY_FAILURE_PREFIX)).toBe(true);
		expect(failed?.failure_reason).toBe("Meeting summary had an invalid overview");
	});

	test("stores the fallback summary once the summary already failed a generation ago", async () => {
		const counter = { runs: 0, summaryRuns: 0 };
		const { env } = make_test_env({ AI: failing_summary_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);
		// The previous generation failed on the summary model itself, and the hourly cron redrove the
		// meeting. That stored reason is what allows the fallback; a high generation number does not,
		// because a redrive bumps it for every kind of failure.
		await env.COUNCIL_DB.prepare(
			"UPDATE meetings SET processing_generation = 4, failure_reason = 'Meeting summary had an invalid overview' WHERE id = 'meeting-1'",
		).run();

		// Keep the thrown message as the outcome. A run that throws here is the defect itself: the
		// meeting goes back to failed and the cron redrives it again an hour later, forever.
		const outcome = await council_run_processing(env, test_step(), { ...PROCESS_PARAMS, generation: 4 }).catch(
			(error: unknown) => String(error instanceof Error ? error.message : error),
		);

		expect(outcome).toBe("ready");
		// Asked once, because an operator may have fixed whatever else failed. The bad answer then
		// stores the fixed text, so the meeting reaches ready and the cron stops selecting it.
		expect(counter.summaryRuns).toBe(1);
		expect(summary_put_body(mock.calls)).toContain("The summary could not be generated for this meeting");
		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting?.status).toBe("ready");
	});

	test("one bad summary answer at a high generation asks the model again instead of giving up", async () => {
		const counter = { runs: 0, summaryRuns: 0 };
		const { env } = make_test_env({ AI: blipping_summary_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);
		// Three earlier generations failed for an unrelated reason an operator has since fixed. The
		// generation number is high, but the summary model has never failed this meeting.
		await env.COUNCIL_DB.prepare(
			"UPDATE meetings SET processing_generation = 4, failure_reason = 'Upload target refused: Server Error' WHERE id = 'meeting-1'",
		).run();

		const outcome = await council_run_processing(env, retrying_step(), { ...PROCESS_PARAMS, generation: 4 });

		expect(outcome).toBe("ready");
		// The step's own retry asks a second time, and that good answer is what reaches the file. A
		// single blip must not spend the member's summary on the fixed text.
		expect(counter.summaryRuns).toBe(2);
		expect(summary_put_body(mock.calls)).toContain("The group reviewed the quarterly forecast");
		expect(summary_put_body(mock.calls)).not.toContain("The summary could not be generated");
	});

	test("the store-summary step spends its own single retry, not the workflow default", async () => {
		const counter = { runs: 0, summaryRuns: 0 };
		const { env } = make_test_env({ AI: failing_summary_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, retrying_step(), PROCESS_PARAMS)).rejects.toThrow();

		// One attempt already spends up to 13 model calls, so the step declares `retries.limit: 1`:
		// the first call plus one retry, never the six a step without its own budget would take.
		expect(counter.summaryRuns).toBe(2);
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

		// This run read no track file and no provider transcript, so it cannot say the meeting was
		// silent. It can only say the recording was too short to process.
		expect(markdown_put_body(mock.calls)).toContain(
			"_The recording was too short to process, so no transcript was produced._",
		);
		// The member opens both documents from the same folder, so `summary.md` must answer the same
		// way. The overview is model text, so the renderer escapes its punctuation; match the words
		// on either side of the escaped comma instead of the whole sentence.
		const summary = summary_put_body(mock.calls);
		expect(summary).toContain("The recording was too short to process");
		expect(summary).toContain("so there was nothing to summarize");
		expect(summary).not.toContain("No speech was recorded");
		const artifacts = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_artifacts").first<{
			n: number;
		}>();
		expect(artifacts?.n).toBe(2);
		// The track-file poll is still skipped: those files may never exist for a too-short recording.
		// The stop is not part of that poll, and no other code path ever sends it for this meeting, so
		// exactly two calls remain — one status read to see the recording is still running, then one stop.
		expect(mock.calls.filter((call) => call.url.includes("/recordings/rec-1")).map((call) => call.method)).toEqual([
			"GET",
			"PUT",
		]);
	});

	test("a too-short recording whose stop is refused fails the run instead of leaving it running", async () => {
		const { env } = make_test_env();
		// Close already tried this stop once, best effort, and only logged the refusal. This run is the
		// last thing that can stop the recording, so a refusal here must not pass quietly: the
		// recording would keep running to its max_seconds cap and the workspace would pay for it.
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT" && call.bodyJson?.action === "stop") {
						return Response.json({ success: false }, { status: 500 });
					}
					return Response.json({ success: true, data: { status: "RECORDING" } });
				},
			}),
		);
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

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/never stopped/u);

		expect(
			mock.calls.filter((call) => call.url.includes("/recordings/rec-1") && call.method === "PUT"),
		).toHaveLength(1);
		const failed = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(failed?.status).toBe("failed");
		expect(failed?.failure_reason).toContain("never stopped");
	});

	test("a too-short recording that close already stopped finishes ready and is not stopped again", async () => {
		const { env } = make_test_env();
		// The ordinary too-short path. `council_close_meeting` already stopped this recording, so by
		// the time the pipeline runs the provider has it out of RECORDING. The two tests above both
		// answer RECORDING, which is the case where close's stop never landed. Answer UPLOADED here,
		// and refuse every stop the way the provider refuses one against a recording that is no
		// longer running, so a second stop fails the run instead of passing unnoticed.
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
					if (call.method === "PUT") {
						return Response.json({ success: false }, { status: 500 });
					}
					return Response.json({ success: true, data: { status: "UPLOADED" } });
				},
			}),
		);
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

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).resolves.toBe("ready");

		// One status read and nothing else. A run that sends the stop anyway fails, and the hourly
		// redrive cron then repeats that same failure for the six days the sealed grant lives.
		expect(mock.calls.filter((call) => call.url.includes("/recordings/rec-1")).map((call) => call.method)).toEqual([
			"GET",
		]);
	});

	test("a provider transcript too big to read never blocks the meeting", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		// One line whose sentence alone is past the provider module's read cap.
		const oversized = JSON.stringify([{ sentence: "x".repeat(5 * 1024 * 1024), peerData: { id: "TEST" } }]);
		const mock = install_fetch(
			processing_fetch_overrides({ "https://transcript.example/t1": () => new Response(oversized) }),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		// The diagnostic is the only thing missing. The transcript and the summary are the product,
		// and a diagnostic Council cannot read must never cost the member those.
		const artifacts = await env.COUNCIL_DB.prepare("SELECT kind, status FROM meeting_artifacts ORDER BY kind").all<{
			kind: string;
			status: string;
		}>();
		expect(artifacts.results.map((row) => `${row.kind}:${row.status}`)).toEqual([
			"summary_markdown:finalized",
			"track_audio:finalized",
			"track_audio:finalized",
			"transcript_markdown:finalized",
		]);
	});

	test("a speaker id the provider left empty is not matched to a participant who never joined", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		// `peerData.id` is placeholder garbage today, and an empty string is one more shape of it.
		const mock = install_fetch(
			processing_fetch_overrides({
				"https://transcript.example/t1": () => Response.json([{ sentence: "hello world", peerData: { id: "" } }]),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);
		// Somebody who asked to join and was never admitted. Their row carries no provider id, so they
		// are in no provider session, and no speaker id may ever be matched to them.
		await seed_participant(env, { meetingId: "meeting-1", displayName: "Carol Never", acceptedAt: null });

		const logged: unknown[][] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logged.push(args);
		});
		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		consoleLog.mockRestore();
		expect(outcome).toBe("ready");

		// This log line is the whole signal that says the provider fixed its speaker identity, and an
		// operator moves the transcript off the track files when it turns true. Answering true here
		// would say a transcript that named nobody had named everybody.
		const identityCheck = logged.find((entry) => entry[0] === "Provider transcript identity check")?.[1] as
			| { hasRealIdentity: boolean }
			| undefined;
		expect(identityCheck?.hasRealIdentity).toBe(false);
	});

	test("every upload call carries the meeting's own key, and nothing is released at ready", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		// The host resolves an upload by this key, and it is derived from the meeting id, not stored.
		const uploadKeys = mock.calls
			.filter((call) => call.url.includes("/service-uploads/") && !call.url.includes("archive-destination"))
			.map((call) => String(call.bodyJson?.idempotencyKey));
		expect(uploadKeys.length).toBeGreaterThan(0);
		expect(new Set(uploadKeys)).toEqual(new Set(["council-uploads-meeting-1"]));
		// There is no envelope to hand back: a stored file keeps its charged bytes.
		expect(mock.calls.some((call) => call.url.includes("/service-uploads/release"))).toBe(false);
	});

	test("sets the lock and collaboration flags for every stored artifact", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(processing_fetch_overrides());
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await council_run_processing(env, test_step(), PROCESS_PARAMS);

		const targets = mock.calls.filter((call) => call.url.includes("/service-uploads/create-target"));
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			expect(target.bodyJson?.readOnly).toBe(true);
			const kind = String(target.bodyJson?.targetKey).split(":", 1)[0];
			expect(target.bodyJson?.nonCollaborative).toBe(kind !== "track_audio");
		}
	});

	test("uses the filename tie-break before keeping thirteen raw tracks", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const timestamp = 1755200000000;
		const providerIds = [
			ALICE_PROVIDER_ID,
			BOB_PROVIDER_ID,
			...Array.from({ length: 12 }, (_, index) => `unknown-${index}`),
		];
		const fileNames = providerIds.map(
			(providerId, index) => `council_${providerId}_peer${index}_peer_audio_${timestamp}.webm`,
		);
		let recordingStopped = false;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/recordings/rec-1": (call) => {
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
										download_urls: Object.fromEntries(
											[...fileNames]
												.reverse()
												.map((fileName) => [fileName, { download_url: `https://tracks.example/${fileName}` }]),
										),
									},
								],
							},
						},
					});
				},
				"https://tracks.example/": () => new Response("abcd", { headers: { "Content-Length": "4" } }),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await council_run_processing(env, test_step(), PROCESS_PARAMS);

		const storedTrackTargets = mock.calls
			.filter(
				(call) =>
					call.url.includes("/service-uploads/create-target") &&
					String(call.bodyJson?.targetKey).startsWith("track_audio:"),
			)
			.map((call) => String(call.bodyJson?.targetKey).slice("track_audio:".length));
		// Written out, not recomputed with the pipeline's own comparator: the point of the tie-break is
		// that this exact set is chosen on every run, whatever the runtime's collation data says.
		expect(storedTrackTargets).toEqual([
			`council_${ALICE_PROVIDER_ID}_peer0_peer_audio_${timestamp}.webm`,
			`council_${BOB_PROVIDER_ID}_peer1_peer_audio_${timestamp}.webm`,
			`council_unknown-0_peer2_peer_audio_${timestamp}.webm`,
			`council_unknown-10_peer12_peer_audio_${timestamp}.webm`,
			`council_unknown-11_peer13_peer_audio_${timestamp}.webm`,
			`council_unknown-1_peer3_peer_audio_${timestamp}.webm`,
			`council_unknown-2_peer4_peer_audio_${timestamp}.webm`,
			`council_unknown-3_peer5_peer_audio_${timestamp}.webm`,
			`council_unknown-4_peer6_peer_audio_${timestamp}.webm`,
			`council_unknown-5_peer7_peer_audio_${timestamp}.webm`,
			`council_unknown-6_peer8_peer_audio_${timestamp}.webm`,
			`council_unknown-7_peer9_peer_audio_${timestamp}.webm`,
			`council_unknown-8_peer10_peer_audio_${timestamp}.webm`,
		]);
		const artifacts = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_artifacts").first<{
			n: number;
		}>();
		expect(artifacts?.n).toBe(16);
	});

	// Three separate conditions refuse a file here, and each one is refused twice: the upload filter
	// drops it before it can take a slot, and `transcribe_track` drops it again before Whisper. One
	// file per condition, each wrong in one field only. A single file wrong in several fields would
	// leave every condition but one deletable with the suite still green. `tracks.test.ts` splits the
	// same two-field guard the same way. None of these files exists today: composite start writes
	// the mixed files, and older track recordings write per-participant audio only. These rows are
	// the file shapes the guards exist to refuse.
	test("a track file that is not a readable peer audio name is never uploaded and never transcribed", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		// Earlier than Alice's track, so the old order would have handed it the first slot.
		const videoFile = `council_${ALICE_PROVIDER_ID}_peer1_peer_video_1755199990000.webm`;
		// Wrong stream, right media. Deleting the peer-stream half of either guard shows up here only.
		const screenShareFile = `council_${ALICE_PROVIDER_ID}_peer2_screenshare_audio_1755199991000.webm`;
		// A name the parser refuses outright: a merged file carries none of the five trailing fields,
		// so nothing in it says whose speech it holds.
		const unreadableFile = "council_meeting-1_merged.webm";
		let recordingStopped = false;
		const mock = install_fetch(
			processing_fetch_overrides({
				// All three downloads work, and all three carry the byte length the Whisper mock answers
				// for. What must stop these files is the pipeline's own rule, at the assertions below —
				// not a refused download and not a model that rejects the fixture's bytes.
				"https://tracks.example/video": () => new Response("abcd", { headers: { "Content-Length": "4" } }),
				"https://tracks.example/screenshare": () => new Response("abcd", { headers: { "Content-Length": "4" } }),
				"https://tracks.example/unreadable": () => new Response("abcd", { headers: { "Content-Length": "4" } }),
				"/recordings/rec-1": (call) => {
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
											[videoFile]: { download_url: "https://tracks.example/video" },
											[screenShareFile]: { download_url: "https://tracks.example/screenshare" },
											[unreadableFile]: { download_url: "https://tracks.example/unreadable" },
											[ALICE_FILE]: { download_url: "https://tracks.example/alice" },
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

		// Every stored track is declared `audio/webm`, and both `transcribe_track` and the attribution
		// module refuse anything that is not a peer audio track. Storing one of these would put a lying
		// content type in the workspace and spend a slot no transcript can ever use.
		const trackTargets = mock.calls.filter(
			(call) =>
				call.url.includes("/service-uploads/create-target") &&
				String(call.bodyJson?.targetKey).startsWith("track_audio:"),
		);
		expect(trackTargets).toHaveLength(1);
		// The app refuses an upload path whose file name is not lowercase, and this provider name
		// carries an uppercase letter, so the stored path must be the lowercased name.
		expect(trackTargets[0]?.bodyJson?.path).toBe(`/meetings/meeting-1/${ALICE_FILE.toLowerCase()}`);

		// `transcribe_track` downloads the file before it calls Whisper, so a download that never
		// happened is what proves the refusal came before the model call.
		expect(mock.calls.some((call) => call.url === "https://tracks.example/video")).toBe(false);
		expect(mock.calls.some((call) => call.url === "https://tracks.example/screenshare")).toBe(false);
		expect(mock.calls.some((call) => call.url === "https://tracks.example/unreadable")).toBe(false);

		// Each refused row still ends in a definite state, so nothing waits for it forever.
		const track_status = async (fileName: string) =>
			(
				await env.COUNCIL_DB.prepare("SELECT status FROM meeting_tracks WHERE file_name = ?")
					.bind(fileName)
					.first<{ status: string }>()
			)?.status;
		expect(await track_status(videoFile)).toBe("rejected");
		expect(await track_status(screenShareFile)).toBe("rejected");
		expect(await track_status(unreadableFile)).toBe("rejected");
	});

	test("a track too big to transcribe is counted in the documents instead of read as silence", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(
			processing_fetch_overrides({
				"https://tracks.example/alice": () => oversized_track_response(),
				"https://tracks.example/bob": () => oversized_track_response(),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		// Both tracks are refused before Whisper, and both raw audio files still upload, so the member
		// ends this run holding two real recordings.
		const tracks = await env.COUNCIL_DB.prepare("SELECT status FROM meeting_tracks ORDER BY file_name").all<{
			status: string;
		}>();
		expect(tracks.results.map((row) => row.status)).toEqual(["rejected", "rejected"]);
		expect(counter.runs).toBe(0);
		const trackArtifacts = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM meeting_artifacts WHERE kind = 'track_audio' AND status = 'finalized'",
		).first<{ n: number }>();
		expect(trackArtifacts?.n).toBe(2);

		// So neither document may answer that nothing was said. `transcript.md` is finalized and a
		// `meeting_summaries` row exists, which means no redrive ever rewrites either of them: whatever
		// this run stored is what the member keeps.
		const markdown = markdown_put_body(mock.calls);
		expect(markdown).not.toContain("_No speech was recorded._");
		expect(markdown).toContain("2 recorded tracks could not be transcribed, so any speech in them is missing below.");
		const summary = summary_put_body(mock.calls);
		expect(summary).toContain(
			"2 recorded tracks could not be transcribed, so any speech in them is missing from this summary.",
		);
		// The Processing note above is the end of the file; the Overview is the line the member reads
		// first, and it answers the same question `transcript.md` just answered. Both refused tracks
		// reach `council_summarize_meeting` as the dropped count, so this run must not call the
		// meeting silent there either.
		expect(summary).not.toContain("No speech was recorded");
		expect(summary).toContain("No other speech was recorded");
	});

	test("a track download without a Content-Length is refused instead of uploaded unsized", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(
			processing_fetch_overrides({
				// The presigned PUT is signed over a sized body, so a stream of unknown length cannot
				// be uploaded at all. Guessing a size would store a truncated or padded recording.
				"https://tracks.example/alice": () => new Response("abcd"),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(
			/refusing an unsized upload/u,
		);
		const failed = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; failure_reason: string }>();
		expect(failed?.status).toBe("failed");
		expect(failed?.failure_reason).toContain("refusing an unsized upload");
	});

	test("a create-target that answers released fails the run before anything is uploaded", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(
			processing_fetch_overrides({
				// The host gave this upload run up. `test/env.ts` only ever answers pending or
				// committed, so this state has to be scripted here.
				"/service-uploads/create-target": () => Response.json({ state: "released" }),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(
			/released before this artifact committed/u,
		);
		// Nothing may be PUT against a target the host no longer holds, and no row may claim the
		// file exists.
		expect(mock.calls.some((call) => call.url.startsWith("https://uploads.example/"))).toBe(false);
		const finalized = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM meeting_artifacts WHERE status = 'finalized'",
		).first<{ n: number }>();
		expect(finalized?.n).toBe(0);
	});

	test("a finalize that answers released fails the run instead of marking the artifact stored", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const mock = install_fetch(
			processing_fetch_overrides({
				// The upload was given up on while this step was finalizing it, so the target holds no
				// file. `test/env.ts` always answers committed, so script the released state here.
				"/service-uploads/finalize": () => Response.json({ state: "released" }),
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(
			/released before this artifact committed/u,
		);
		const finalized = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM meeting_artifacts WHERE status = 'finalized'",
		).first<{ n: number }>();
		expect(finalized?.n).toBe(0);
	});

	test("a finalize that answers pending is polled with backoff until the storage event settles", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const sleep = install_instant_sleep();
		restoreSleep = sleep.restore;
		let transcriptFinalizes = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				// The ordinary first answer in production: the PUT landed, but the R2 event has not
				// reached the host yet, so the target has no canonical key and finalize says pending.
				// `test/env.ts` answers committed on the very first call, so a poll that runs more than
				// once only ever happens when a test scripts it. Keep the pending answers on one
				// target, so the recorded sleeps belong to that target's poll alone.
				"/service-uploads/finalize": (call) => {
					const targetKey = String(call.bodyJson?.targetKey);
					if (!targetKey.startsWith("transcript_markdown")) {
						return Response.json({
							state: "committed",
							path: `/meetings/meeting-1/${targetKey}`,
							nodeId: `node-${targetKey}`,
							actualBytes: 1,
						});
					}
					transcriptFinalizes += 1;
					if (transcriptFinalizes <= 3) {
						return Response.json({
							state: "pending",
							path: `/meetings/meeting-1/${targetKey}`,
							nodeId: null,
							actualBytes: null,
						});
					}
					return Response.json({
						state: "committed",
						path: `/meetings/meeting-1/${targetKey}`,
						nodeId: "node-settled-transcript",
						actualBytes: 4242,
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).resolves.toBe("ready");

		// Three pending answers and the settled one. A poll that gave up after the first answer would
		// fail every ordinary upload, because pending is how an upload normally starts.
		expect(transcriptFinalizes).toBe(4);
		// One wait per pending answer: 500 ms, then double.
		expect(sleep.delays).toEqual([500, 1000, 2000]);

		// The row takes the settled answer's own node and byte count. Nothing may claim the file
		// exists on the strength of the earlier pending answers.
		const artifact = await env.COUNCIL_DB.prepare(
			"SELECT status, node_id, bytes FROM meeting_artifacts WHERE target_key LIKE 'transcript_markdown%'",
		).first<{ status: string; node_id: string; bytes: number }>();
		expect(artifact?.status).toBe("finalized");
		expect(artifact?.node_id).toBe("node-settled-transcript");
		expect(artifact?.bytes).toBe(4242);
	});

	test("a finalize that never settles gives the artifact back to the step instead of storing it", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		const sleep = install_instant_sleep();
		restoreSleep = sleep.restore;
		let finalizeCalls = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				// The storage event never arrives. The poll is bounded on purpose: running out hands
				// the artifact to the step's own retry later, instead of waiting inside one attempt.
				"/service-uploads/finalize": (call) => {
					finalizeCalls += 1;
					return Response.json({
						state: "pending",
						path: `/meetings/meeting-1/${String(call.bodyJson?.targetKey)}`,
						nodeId: null,
						actualBytes: null,
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(
			/never settled; the step will retry/u,
		);

		// Eight attempts, doubling to a five-second cap. The run stops at the first artifact, so this
		// is one artifact's whole poll. There are eight waits, not seven: only a settled answer
		// breaks out of the loop, so the last pending answer is still followed by its wait before the
		// step gives up.
		expect(finalizeCalls).toBe(8);
		expect(sleep.delays).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000, 5000]);

		// Nothing may read as stored while the host never confirmed the bytes, and the failure is
		// visible so the hourly redrive can start a new generation.
		const finalized = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM meeting_artifacts WHERE status = 'finalized'",
		).first<{ n: number }>();
		expect(finalized?.n).toBe(0);
		const failed = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; failure_reason: string }>();
		expect(failed?.status).toBe("failed");
		expect(failed?.failure_reason).toContain("never settled");
	});

	test("each artifact is PUT to the exact URL and headers its own create-target call answered", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		// Mirror the host exactly: it mints the signed URL inside the call that answers `pending`, so
		// the deadline it returns is always that call's own. `create_upload_target` signs one for a
		// fresh target, and remints host-side before answering a replayed pending target. A used-up
		// URL therefore never reaches the service, and the service never asks for a second one.
		const minted = new Map<string, { uploadUrl: string; contentType: string }>();
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/create-target": (call) => {
					const targetKey = String(call.bodyJson?.targetKey);
					const contentType = String(call.bodyJson?.contentType);
					// A distinct URL per call, so a PUT to any earlier answer would not match below.
					const uploadUrl = `https://uploads.example/mint-${minted.size + 1}/${encodeURIComponent(targetKey)}`;
					minted.set(targetKey, { uploadUrl, contentType });
					return Response.json({
						state: "pending",
						path: String(call.bodyJson?.path),
						nodeId: `node-${targetKey}`,
						uploadUrl,
						headers: { "Content-Type": contentType },
						uploadUrlExpiresAt: Date.now() + 15 * 60 * 1000,
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, test_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		// Both tracks, the transcript, the summary, and the provider transcript.
		expect(minted.size).toBe(5);
		for (const [targetKey, answer] of minted) {
			const puts = mock.calls.filter((call) => call.method === "PUT" && call.url === answer.uploadUrl);
			expect(puts, targetKey).toHaveLength(1);
			// Exactly the returned headers: the signed URL was computed over them, so a header the
			// service picked itself would make R2 refuse the PUT.
			expect(puts[0]!.headers.get("Content-Type"), targetKey).toBe(answer.contentType);
		}

		// No host answer can hand back a URL that needs replacing, so nothing asks for one.
		expect(mock.calls.filter((call) => call.url.includes("/service-uploads/remint"))).toHaveLength(0);
	});

	test("a plan refusal fails the run at once instead of spending the step's retries", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let createCalls = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/create-target": () => {
					createCalls += 1;
					return Response.json(
						{ message: "This workspace's plan does not include plugin service file storage" },
						{ status: 403 },
					);
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, retrying_step(), PROCESS_PARAMS)).rejects.toBeInstanceOf(
			NonRetryableError,
		);

		// The plan cannot change while the step retries, so asking twice only makes the member wait.
		expect(createCalls).toBe(1);
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; failure_reason: string }>();
		expect(meeting?.status).toBe("failed");
		// An operator reads this column in D1, and it has to name the plan. The page never shows this
		// text: `failure_sentence` in `routes-page.ts` picks one sentence per status, and the `failed`
		// one sends the member to a workspace admin. This column is what that admin then needs.
		expect(meeting?.failure_reason).toContain("This workspace's plan does not include plugin service file storage");
	});

	test("a full workspace fails the run at once too", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let createCalls = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/create-target": () => {
					createCalls += 1;
					return Response.json({ message: "This workspace has used its plugin service storage" }, { status: 403 });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, retrying_step(), PROCESS_PARAMS)).rejects.toBeInstanceOf(
			NonRetryableError,
		);

		// The storage counter only counts up, so a retry cannot find room that the first call missed.
		expect(createCalls).toBe(1);
	});

	test("an over-cap recording 400 fails that file and still finishes the rest of the run", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let recordingStopped = false;
		const createKeys: string[] = [];
		const mock = install_fetch(
			processing_fetch_overrides({
				"https://tracks.example/composite-video": () =>
					new Response("videobytes", {
						headers: { "Content-Length": String(2 * 1024 * 1024 * 1024 + 1) },
					}),
				"https://tracks.example/composite-audio": () =>
					new Response("abcd", { headers: { "Content-Length": "4" } }),
				"/recordings/rec-1": (call) => {
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
							recording_duration: 790,
							download_url: "https://tracks.example/composite-video",
							audio_download_url: "https://tracks.example/composite-audio",
						},
					});
				},
				"/service-uploads/create-target": (call) => {
					const targetKey = String(call.bodyJson?.targetKey ?? "unknown");
					createKeys.push(targetKey);
					if (Number(call.bodyJson?.size) > 2 * 1024 * 1024 * 1024) {
						return Response.json({ message: "File too large" }, { status: 400 });
					}
					return Response.json({
						state: "pending",
						path: String(call.bodyJson?.path),
						nodeId: `node-${targetKey}`,
						uploadUrl: `https://uploads.example/${encodeURIComponent(targetKey)}`,
						headers: { "Content-Type": String(call.bodyJson?.contentType) },
						uploadUrlExpiresAt: Date.now() + 15 * 60 * 1000,
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		const outcome = await council_run_processing(env, retrying_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		const video = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason, bytes FROM meeting_artifacts WHERE file_name = ?",
		)
			.bind(council_COMPOSITE_VIDEO_FILE_NAME)
			.first<{ status: string; failure_reason: string; bytes: number }>();
		expect(video).toEqual({
			status: "failed",
			failure_reason: "recording too large to store: 1 MiB over the limit",
			bytes: 2 * 1024 * 1024 * 1024 + 1,
		});

		const others = await env.COUNCIL_DB.prepare(
			"SELECT file_name, status FROM meeting_artifacts WHERE file_name != ? ORDER BY file_name",
		)
			.bind(council_COMPOSITE_VIDEO_FILE_NAME)
			.all<{ file_name: string; status: string }>();
		expect(others.results.map((row) => `${row.file_name}:${row.status}`)).toEqual([
			"provider-transcript.json:finalized",
			"recording-audio.m4a:finalized",
			"summary.md:finalized",
			"transcript.md:finalized",
		]);

		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting?.status).toBe("ready");

		const videoCreates = createKeys.filter((key) => key.includes(council_COMPOSITE_VIDEO_FILE_NAME));
		expect(videoCreates).toHaveLength(1);

		await env.COUNCIL_DB.prepare("UPDATE meetings SET status = 'processing' WHERE id = 'meeting-1'").run();
		const afterRedrive = await council_run_processing(env, retrying_step(), PROCESS_PARAMS);
		expect(afterRedrive).toBe("ready");
		expect(createKeys.filter((key) => key.includes(council_COMPOSITE_VIDEO_FILE_NAME))).toHaveLength(1);
	});

	test("a stored over-cap create-target body stays permanent even if this download looks small", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let recordingStopped = false;
		let createCalls = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"https://tracks.example/composite-video": () =>
					new Response("videobytes", {
						headers: { "Content-Length": "4" },
					}),
				"https://tracks.example/composite-audio": () =>
					new Response("abcd", { headers: { "Content-Length": "4" } }),
				"/recordings/rec-1": (call) => {
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
							recording_duration: 790,
							download_url: "https://tracks.example/composite-video",
							audio_download_url: "https://tracks.example/composite-audio",
						},
					});
				},
				"/service-uploads/create-target": (call) => {
					if (String(call.bodyJson?.targetKey ?? "").includes(council_COMPOSITE_VIDEO_FILE_NAME)) {
						createCalls += 1;
					}
					if (Number(call.bodyJson?.size) > 2 * 1024 * 1024 * 1024) {
						return Response.json({ message: "File too large" }, { status: 400 });
					}
					return Response.json({
						state: "pending",
						path: String(call.bodyJson?.path),
						nodeId: `node-${String(call.bodyJson?.targetKey ?? "unknown")}`,
						uploadUrl: `https://uploads.example/${encodeURIComponent(String(call.bodyJson?.targetKey ?? "unknown"))}`,
						headers: { "Content-Type": String(call.bodyJson?.contentType) },
						uploadUrlExpiresAt: Date.now() + 15 * 60 * 1000,
					});
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		// An earlier attempt stored the create-target body with the over-cap size. The host refuses
		// that stored body forever. A later download that reports a small Content-Length must not
		// turn this back into a retry: the next create-target still sends the stored size.
		const storedSize = 2 * 1024 * 1024 * 1024 + 1;
		const uploadBody = JSON.stringify({
			idempotencyKey: "council-uploads-meeting-1",
			targetKey: `track_audio:${council_COMPOSITE_VIDEO_FILE_NAME}`,
			path: `/meetings/meeting-1/${council_COMPOSITE_VIDEO_FILE_NAME}`,
			contentType: "video/mp4",
			size: storedSize,
			readOnly: true,
			nonCollaborative: false,
		});
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, status, upload_body, created_at, updated_at)
			VALUES ('pre-video', 'meeting-1', 'track_audio', ?, ?, 'pending', ?, 0, 0)`,
		)
			.bind(`track_audio:${council_COMPOSITE_VIDEO_FILE_NAME}`, council_COMPOSITE_VIDEO_FILE_NAME, uploadBody)
			.run();

		const outcome = await council_run_processing(env, retrying_step(), PROCESS_PARAMS);
		expect(outcome).toBe("ready");

		const video = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meeting_artifacts WHERE file_name = ?",
		)
			.bind(council_COMPOSITE_VIDEO_FILE_NAME)
			.first<{ status: string; failure_reason: string }>();
		expect(video).toEqual({
			status: "failed",
			failure_reason: "recording too large to store: 1 MiB over the limit",
		});
		expect(createCalls).toBe(1);
	});

	test("a File too large 400 for a recording under the cap still retries", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let createCalls = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/create-target": () => {
					createCalls += 1;
					return Response.json({ message: "File too large" }, { status: 400 });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		// The fixture tracks are a few bytes. The host saying File too large for those is not the
		// over-cap case. Treating it as permanent would abandon a good recording after one bad answer.
		await expect(council_run_processing(env, retrying_step(), PROCESS_PARAMS)).rejects.toBeInstanceOf(Error);
		expect(createCalls).toBeGreaterThan(1);
		const failed = await env.COUNCIL_DB.prepare(
			"SELECT status FROM meeting_artifacts WHERE file_name = ?",
		)
			.bind(ALICE_FILE)
			.first<{ status: string }>();
		expect(failed?.status).not.toBe("failed");
	});

	test("a create-target 400 that is not the over-cap message still retries", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let createCalls = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/create-target": () => {
					createCalls += 1;
					return Response.json({ message: "Path must be absolute and normalized" }, { status: 400 });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, retrying_step(), PROCESS_PARAMS)).rejects.toBeInstanceOf(Error);
		expect(createCalls).toBeGreaterThan(1);
	});

	test("a create-target server error still retries", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		let createCalls = 0;
		const mock = install_fetch(
			processing_fetch_overrides({
				"/service-uploads/create-target": () => {
					createCalls += 1;
					return Response.json({ message: "Server Error" }, { status: 500 });
				},
			}),
		);
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		// The control for the two tests above: a refusal that CAN clear must keep its retries, or the
		// fail-fast branch would be turning every upload hiccup into a failed meeting.
		await expect(council_run_processing(env, retrying_step(2), PROCESS_PARAMS)).rejects.not.toBeInstanceOf(
			NonRetryableError,
		);
		expect(createCalls).toBeGreaterThan(1);
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

	test("a run redriven away mid-flight fails without stomping the live generation", async () => {
		const { env } = make_test_env();
		// The stale-generation guard above runs once, at the start. `WorkflowBinding.get` can relabel
		// a transport error as instance-not-found (see `workflow_instance_is_missing` in
		// `lifecycle.ts`), and the redrive then starts generation 2 while generation 1 is still
		// running. When generation 1 later fails, its catch must not write `failed` over the row that
		// now belongs to generation 2.
		const mock = install_fetch({
			...processing_fetch_overrides(),
			"/recordings/rec-1": async () => {
				// The redrive lands mid-run: the row moves to generation 2 before generation 1's read
				// answers with the provider's own terminal failure.
				await env.COUNCIL_DB.prepare(
					"UPDATE meetings SET processing_generation = 2 WHERE id = 'meeting-1'",
				).run();
				return Response.json({ success: true, data: { status: "ERRORED" } });
			},
		});
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).rejects.toThrow(/ERRORED/u);

		const after = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number; failure_reason: string | null }>();
		expect(after).toEqual({ status: "processing", processing_generation: 2, failure_reason: null });
	});

	test("a finalize that lost the row to a redrive does not write ready over the new generation", async () => {
		const counter = { runs: 0 };
		const { env } = make_test_env({ AI: make_whisper_mock(counter) });
		// The redrive lands at the last possible moment: the summary PUT is the final call this run
		// makes before finalize, so every artifact is already uploaded when generation 2 takes the
		// row. Finalize's `ready` write must no-op instead of reporting generation 2's meeting done.
		const mock = install_fetch({
			...processing_fetch_overrides(),
			"uploads.example/summary_markdown": async () => {
				await env.COUNCIL_DB.prepare("UPDATE meetings SET processing_generation = 2 WHERE id = 'meeting-1'").run();
				return new Response(null, { status: 200 });
			},
		});
		restoreFetch = mock.restore;
		await seed_processing_meeting(env);

		// The stale run still reports its own word; only the terminal write is gated.
		await expect(council_run_processing(env, test_step(), PROCESS_PARAMS)).resolves.toBe("ready");

		const after = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number; failure_reason: string | null }>();
		expect(after).toEqual({ status: "processing", processing_generation: 2, failure_reason: null });
	});
});

/**
 * Wrap the test D1 so the `DELETE FROM service_grants` statement rejects once and then works.
 * The atomic-sweep regression tests need this failure shape: a delete run whose sweep dies exactly
 * on the grant delete, followed by a recovery that must still delete the grant.
 */
function failing_grant_delete_db(db: D1Database): D1Database {
	let refusals = 1;
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
		...statement,
		bind: (...values: unknown[]) => wrap(statement.bind(...values)),
		run: async () => {
			if (refusals > 0) {
				refusals -= 1;
				throw new Error("D1 lost the grant delete statement");
			}
			return statement.run();
		},
	});
	return {
		...db,
		prepare: (query) => {
			const statement = db.prepare(query);
			return query.includes("DELETE FROM service_grants") ? wrap(statement) : statement;
		},
	};
}

/**
 * Wrap the test D1 so the first `UPDATE meetings SET status ...` statement rejects and every later
 * one works: one short D1 incident that lands exactly on the tombstone status write, whatever
 * statement shape carries it. If that write were separate from the sweep batch, only the status
 * write would be lost: the meeting would stay `deleting` with its grants swept and its
 * `destination_path` erased, and no recovery door could ever finish the delete.
 */
function failing_status_write_db(db: D1Database): D1Database {
	let refusals = 1;
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
		...statement,
		bind: (...values: unknown[]) => wrap(statement.bind(...values)),
		run: async () => {
			if (refusals > 0) {
				refusals -= 1;
				throw new Error("D1 lost the meetings status write");
			}
			return statement.run();
		},
	});
	return {
		...db,
		prepare: (query) => {
			const statement = db.prepare(query);
			return query.startsWith("UPDATE meetings SET status") ? wrap(statement) : statement;
		},
	};
}

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
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_summaries (meeting_id, markdown, created_at) VALUES ('meeting-1', 'private summary', 0)",
		).run();
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

		// Nothing is released first: an upload that never finished left a real empty file in the
		// folder, and the archive above takes it away with everything else.
		expect(mock.calls.some((call) => call.url.includes("/service-uploads/release"))).toBe(false);

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
		const summaries = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_summaries").first<{
			n: number;
		}>();
		expect(summaries?.n).toBe(0);

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

	test("a delete that dies on the grant delete still deletes the grant on the redrive", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		// Fail the grant DELETE once. If the sweep were not atomic, the first run would null
		// `processing_grant_id` and keep the grant row, and the redrive below would re-read the
		// nulled column, skip the delete, and tombstone the meeting with the sealed grant — a
		// still-live write token — surviving until the expiry sweep.
		env.COUNCIL_DB = failing_grant_delete_db(env.COUNCIL_DB);
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-proc", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toThrow(/lost the grant delete/u);
		const failed = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(failed?.status).toBe("delete_failed");

		// The hourly cron redrives a delete_failed meeting through this same request helper.
		const requested = await council_request_meeting_delete(env, failed!, Date.now());
		expect(requested._nay).toBeUndefined();
		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 3 }),
		).resolves.toBe("deleted");

		// The sealed processing grant died with the meeting even across the failure and redrive.
		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1"]);
	});

	test("a delete that loses only its tombstone write rolls the sweep back and stays recoverable", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		// One D1 refusal that lands exactly on the tombstone status write. If the sweep committed
		// while only that write was lost, the meeting would keep saying `deleting` with its grants
		// already swept and `destination_path` erased: the redrive could not deliver the delete
		// projection, the hourly sweep would skip a row with no sealed grant, and the page delete
		// could not re-seal over an empty path. The tombstone rides the sweep batch, so losing it
		// rolls the sweep back too.
		env.COUNCIL_DB = failing_status_write_db(env.COUNCIL_DB);
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-proc", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toThrow(/lost the meetings status write/u);

		// The lost tombstone write took the whole sweep down with it: the sealed grant survived,
		// and the row keeps every field the redrive needs.
		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1", "grant-proc"]);
		const failed = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(failed?.destination_path).toBe("/meetings/meeting-1");
		expect(failed?.processing_grant_id).toBe("grant-proc");
		expect(failed?.status).toBe("delete_failed");

		// The hourly cron redrives a delete_failed meeting through this same request helper, and
		// the new generation finds everything intact and tombstones for real.
		const requested = await council_request_meeting_delete(env, failed!, Date.now());
		expect(requested._nay).toBeUndefined();
		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 3 }),
		).resolves.toBe("deleted");
		const after = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(after?.status).toBe("deleted_tombstone");
		const remaining = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(remaining.results.map((row) => row.id)).toEqual(["grant-1"]);
	});

	test("a replay after a crash inside the sweep still deletes the sealed grant", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		env.COUNCIL_DB = failing_grant_delete_db(env.COUNCIL_DB);
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-proc", processingGeneration: 2 });

		// One replaying step for both runs: the second run is the engine replaying the same
		// instance, so the completed steps answer from cache and only the sweep runs again.
		const step = replaying_step();
		await expect(
			council_run_deletion(env, step, { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toThrow(/lost the grant delete/u);
		// An evicted worker never runs the catch that moved the meeting to delete_failed here, so
		// the engine replays the instance while the row still says deleting. Put the status back to
		// model that crash instead of the handled failure the throw above produced.
		await env.COUNCIL_DB.prepare("UPDATE meetings SET status = 'deleting' WHERE id = 'meeting-1'").run();

		await expect(
			council_run_deletion(env, step, { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).resolves.toBe("deleted");

		// The meeting row is read again outside any step on the replay, so a sweep that had already
		// nulled `processing_grant_id` before dying would hand the replay a NULL grant id and the
		// grant row would survive as a live write token. The atomic sweep makes that state
		// impossible: either nothing committed, or the grant is already gone.
		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1"]);
	});

	test("a sweep replayed by a stale generation does not strip the row the live generation owns", async () => {
		const { env } = make_test_env();
		// A redrive can bump the generation while a delete run is still in flight (the transport
		// relabel described at `workflow_instance_is_missing` in `lifecycle.ts`). The stale run's
		// sweep then lands on a row the new generation owns, and it must not strip the grants and
		// `destination_path` that generation needs to finish its own delete. The bump lands in the
		// projection delivery: the last call this run makes before the sweep.
		const mock = install_fetch({
			"/api/v1/plugin-data/delete-versioned": async (call) => {
				await env.COUNCIL_DB.prepare("UPDATE meetings SET processing_generation = 3 WHERE id = 'meeting-1'").run();
				return Response.json({ deleted: true, revision: call.bodyJson?.revision ?? 1 });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-proc", processingGeneration: 2 });

		// The gated statements no-op instead of throwing, so the stale run still reports its own
		// word — the same treatment every other stale terminal write gets.
		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).resolves.toBe("deleted");

		// The stale sweep did not strip the live generation's row.
		const after = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(after?.processing_grant_id).toBe("grant-proc");
		expect(after?.service_grant_id).toBe("grant-1");
		expect(after?.destination_path).toBe("/meetings/meeting-1");
		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1", "grant-proc"]);
		// And the tombstone write no-opped: the row still belongs to generation 3, mid-delete.
		expect(after?.status).toBe("deleting");
		expect(after?.processing_generation).toBe(3);
		expect(after?.tombstone_expires_at).toBeNull();
	});

	test("a delete redriven away mid-flight fails without stomping the live generation", async () => {
		const { env } = make_test_env();
		// The deletion twin of the processing mid-flight test: generation 3 takes the row before
		// generation 2's archive step fails, and generation 2's catch must not write
		// `delete_failed` over the row the live generation owns.
		const mock = install_fetch({
			"/service-uploads/archive-destination": async () => {
				await env.COUNCIL_DB.prepare("UPDATE meetings SET processing_generation = 3 WHERE id = 'meeting-1'").run();
				return Response.json({ message: "This item is read-only." }, { status: 409 });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toThrow(/Archiving the meeting folder/u);

		const after = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number; failure_reason: string | null }>();
		expect(after).toEqual({ status: "deleting", processing_generation: 3, failure_reason: null });
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

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, failure_reason FROM meetings WHERE id = 'meeting-1'",
		).first<{
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

	test("an archive refused for a dead grant is not retried either", async () => {
		const { env } = make_test_env();
		let archiveCalls = 0;
		// The other refusal that cannot clear. This step spends the meeting's own grant, so a host
		// deleting an older meeting whose grant already expired gets the host's 401. Retrying asks
		// the same dead grant again and leaves the meeting in `deleting` with no visible failure.
		const mock = install_fetch({
			"/service-uploads/archive-destination": () => {
				archiveCalls += 1;
				return Response.json({ message: "Unauthenticated" }, { status: 401 });
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

	test("deleting a meeting whose recording is still running stops the recording", async () => {
		const { env } = make_test_env();
		// A host can delete an `open` meeting: the route refuses only `processing`. So the host who
		// deletes a meeting to stop its recording arrives here with the provider still recording, and
		// this run is the last thing that can stop it — close and the processing pipeline, the two
		// paths that normally send the stop, never run for a meeting deleted straight from `open`.
		const mock = install_fetch({
			"/recordings/rec-1": (call) => {
				if (call.method === "PUT" && call.bodyJson?.action === "stop") {
					return Response.json({ success: true, data: { status: "UPLOADING" } });
				}
				return Response.json({ success: true, data: { status: "RECORDING" } });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, {
			status: "deleting",
			processingGrantId: "grant-proc",
			providerRecordingId: "rec-1",
			recordingStartedAt: 1000,
			processingGeneration: 2,
		});

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).resolves.toBe("deleted");

		// Kick-all empties the room but leaves the track recording running to its max_seconds cap, so
		// the stop is the call that actually ends it. Assert the request the provider received.
		const stops = mock.calls.filter(
			(call) => call.url.includes("/recordings/rec-1") && call.method === "PUT" && call.bodyJson?.action === "stop",
		);
		expect(stops).toHaveLength(1);
		expect(mock.calls.some((call) => call.url.includes("/active-session/kick-all"))).toBe(true);
	});

	test("a refused stop fails the delete instead of reporting a meeting whose recording runs on", async () => {
		const { env } = make_test_env();
		// The provider reports the recording as still running and then refuses every stop. Nothing
		// runs after this delete, so a quiet success would report the meeting gone while its
		// recording keeps going to the max_seconds cap and its track files sit in provider storage.
		const mock = install_fetch({
			"/recordings/rec-1": (call) => {
				if (call.method === "PUT") {
					return Response.json({ success: false }, { status: 500 });
				}
				return Response.json({ success: true, data: { status: "RECORDING" } });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", providerRecordingId: "rec-1", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toThrow(/never stopped/u);

		// The failure is visible and the hourly `delete_failed` cron re-drives it, so the delete is
		// delayed rather than lost. Nothing was archived: the run stopped before that step.
		const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(meeting?.status).toBe("delete_failed");
		expect(meeting?.failure_reason).toContain("never stopped");
		expect(mock.calls.some((call) => call.url.includes("/service-uploads/archive-destination"))).toBe(false);
	});

	test("a recording that already stopped is not stopped a second time", async () => {
		const { env } = make_test_env();
		// The ordinary delete, weeks after close and the pipeline already stopped this recording. The
		// provider refuses a stop against a recording that is no longer running, so a delete that
		// sent one anyway would fail for every finished meeting. Refuse every PUT to prove none is
		// sent, the way the too-short processing test does.
		const mock = install_fetch({
			"/recordings/rec-1": (call) => {
				if (call.method === "PUT") {
					return Response.json({ success: false }, { status: 500 });
				}
				return Response.json({ success: true, data: { status: "UPLOADED" } });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", providerRecordingId: "rec-1", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).resolves.toBe("deleted");

		expect(mock.calls.filter((call) => call.url.includes("/recordings/rec-1")).map((call) => call.method)).toEqual([
			"GET",
		]);
	});

	test("a recording the provider already dropped does not block the delete", async () => {
		const { env } = make_test_env();
		// The mainline late delete: the provider keeps a recording for seven days, so a meeting
		// deleted after that answers 404 on the read. The delete must go on without a stop — refuse
		// every PUT to prove none is sent against a recording that is not there.
		const mock = install_fetch({
			"/recordings/rec-1": (call) => {
				if (call.method === "PUT") {
					return Response.json({ success: false }, { status: 500 });
				}
				return Response.json({ success: false }, { status: 404 });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", providerRecordingId: "rec-1", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, test_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).resolves.toBe("deleted");

		expect(mock.calls.filter((call) => call.url.includes("/recordings/rec-1")).map((call) => call.method)).toEqual([
			"GET",
		]);
	});

	test("a read that fails once still stops the running recording on the retry", async () => {
		const { env } = make_test_env();
		// A transient 500 says nothing like the seven-day 404: the recording may well still be
		// running. Skipping the stop on it would report the meeting deleted while the recording runs
		// to its max_seconds cap — the one thing the host pressed delete for.
		let reads = 0;
		let stops = 0;
		const mock = install_fetch({
			"/recordings/rec-1": (call) => {
				if (call.method === "PUT" && call.bodyJson?.action === "stop") {
					stops += 1;
					return Response.json({ success: true, data: { status: "UPLOADING" } });
				}
				reads += 1;
				if (reads === 1) {
					return Response.json({ success: false }, { status: 500 });
				}
				return Response.json({ success: true, data: { status: "RECORDING" } });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", providerRecordingId: "rec-1", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, retrying_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).resolves.toBe("deleted");

		// The refused read spent one step retry, and the retry re-read and sent exactly one stop.
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(stops).toBe(1);
	});

	test("a read that keeps failing fails the delete instead of skipping the stop", async () => {
		const { env } = make_test_env();
		let stops = 0;
		const mock = install_fetch({
			"/recordings/rec-1": (call) => {
				if (call.method === "PUT") {
					stops += 1;
					return Response.json({ success: true, data: { status: "UPLOADING" } });
				}
				return Response.json({ success: false }, { status: 500 });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "deleting", providerRecordingId: "rec-1", processingGeneration: 2 });

		await expect(
			council_run_deletion(env, retrying_step(), { kind: "delete_meeting", meetingId: "meeting-1", generation: 2 }),
		).rejects.toThrow(/Reading the recording/u);

		// The recording may still be running, and nothing after this delete would ever stop it. The
		// visible failure hands the meeting to the hourly delete_failed cron instead of reporting it
		// deleted with the recording running on.
		const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(meeting?.status).toBe("delete_failed");
		expect(stops).toBe(0);
	});
});
