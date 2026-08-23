/**
 * The long-running work behind a meeting: turn a finished provider session into workspace files,
 * and tear a deleted meeting down to a bounded tombstone. Runs inside a Cloudflare Workflow, so
 * every step is idempotent and returns a small serializable value — a replayed step must land on
 * the same durable state, and file bytes only ever move as streams.
 */

import { NonRetryableError } from "cloudflare:workflows";

import type { Env } from "./env.ts";
import type { WorkflowStep } from "./cf.ts";
import type { council_WorkflowParams } from "./consumer.ts";
import {
	council_get_meeting,
	council_get_service_grant,
	council_transition_meeting,
	type council_ArtifactRow,
	type council_MeetingRow,
	type council_ParticipantRow,
} from "./db.ts";
import { council_decrypt } from "./crypto.ts";
import {
	council_provider_download_track,
	council_provider_fetch_transcript,
	council_provider_find_session,
	council_provider_get_recording,
	council_provider_get_session,
	council_provider_kick_all,
	council_provider_stop_recording,
} from "./provider.ts";
import {
	council_convex_uploads_archive_destination,
	council_convex_uploads_create_target,
	council_convex_uploads_finalize,
} from "./convex-api.ts";
import { council_read_stream_with_limit } from "./http.ts";
import {
	council_render_summary_markdown,
	council_summarize_meeting,
	council_SUMMARY_FAILURE_PREFIX,
	council_transcribe_track,
	council_TRACK_TRANSCRIBE_MAX_BYTES,
	type council_MeetingSummary,
} from "./ai.ts";
import {
	council_attribute_tracks,
	council_parse_track_file_name,
	council_provider_transcript_has_real_identity,
	council_render_transcript_markdown,
	type council_Track,
	type council_TrackSegment,
} from "./tracks.ts";
import { council_deliver_projections, council_enqueue_projection, council_project_meeting } from "./projection.ts";

/** A recording shorter than this holds no usable speech; the meeting finishes with an empty
 * transcript instead of waiting for track files that may never appear. */
const TOO_SHORT_RECORDING_MS = 5 * 1000;

const SESSION_POLL_LIMIT = 40;
const RECORDING_POLL_LIMIT = 40;
const TRANSCRIPT_POLL_LIMIT = 10;
const POLL_SLEEP = "30 seconds";

/**
 * The host allows 16 upload targets per run; transcript, summary, and provider diagnostic take three.
 */
const UPLOADED_TRACKS_MAX = 13;

/** Written into `summary.md` when the model keeps failing. See `store_summary_markdown` for why. */
const SUMMARY_FALLBACK: council_MeetingSummary = {
	overview: "The summary could not be generated for this meeting.",
	topics: [],
	decisions: [],
	actionItems: [],
};

function target_key(kind: string, fileName: string) {
	return `${kind}:${fileName}`;
}

/**
 * The text a failed run stores in `meetings.failure_reason`: the thrown message, and nothing in
 * front of it.
 *
 * A step error crosses the Workflow RPC boundary, and the platform does not promise to hand it
 * back as the same class. When it does not, `error instanceof Error` is false here and
 * `String(error)` prints `"<ClassName>: <message>"` instead of the message alone.
 * `store_summary_markdown` reads this column back on the next generation and only recognizes a
 * summary failure when the text BEGINS with `council_SUMMARY_FAILURE_PREFIX`. A leading class name
 * would hide it, the fallback summary would never be stored, and the hourly cron would redrive the
 * meeting until its sealed grant died. So strip that class name here, at the one place that writes
 * the column, and both catches below store the same shape.
 */
function failure_reason(error: unknown) {
	return String(error instanceof Error ? error.message : error)
		.replace(/^[\w$]*Error:\s*/u, "")
		.slice(0, 200);
}

// #region processing

export async function council_run_processing(env: Env, step: WorkflowStep, params: council_WorkflowParams) {
	const db = env.COUNCIL_DB;

	const loaded = await step.do("load-meeting", async () => {
		const meeting = await council_get_meeting(db, params.meetingId);
		if (!meeting || meeting.status !== "processing" || meeting.processing_generation !== params.generation) {
			return null;
		}
		return { ok: true };
	});
	if (!loaded) {
		return "stale";
	}

	try {
		await run_processing_steps(env, step, params);
		return "ready";
	} catch (error) {
		// The step retry budget is spent. Fail visibly: the page tells the member the meeting failed,
		// the hourly cron (and `council_request_processing_redrive`) start a NEW generation after
		// repair, and nothing pretends an artifact exists. The reason stored below is for an operator.
		// `failure_sentence` in `routes-page.ts` picks what the member reads from the status alone.
		// The generation condition keeps this write off a row a redrive already handed to the next
		// generation while this run was in flight.
		const now = Date.now();
		await council_transition_meeting(db, {
			meetingId: params.meetingId,
			from: ["processing"],
			to: "failed",
			now,
			set: { failure_reason: failure_reason(error) },
			expectedProcessingGeneration: params.generation,
		});
		// Nothing to hand back: an upload that never finished leaves an empty file in the workspace,
		// which a member can delete like any other file. A later redrive re-uses the same targets.
		await council_project_meeting(env, params.meetingId, now);
		throw error;
	}
}

/**
 * The host resolves an upload BY the request's idempotency key: the key names one upload run (the
 * meeting), and `targetKey` names one file inside it. Both calls this service makes — create-target
 * and finalize — must present the meeting's own key, or the host answers `Not found`.
 *
 * The key is derived from the meeting id, so it survives a crash without being stored anywhere. A
 * redrive keeps the same key on purpose: a target that never finished uploading is re-used, so the
 * workspace is not charged a second time for the same file.
 */
function meeting_upload_key(meeting: { id: string }) {
	return `council-uploads-${meeting.id}`;
}

async function run_processing_steps(env: Env, step: WorkflowStep, params: council_WorkflowParams) {
	const db = env.COUNCIL_DB;
	const meeting = await council_get_meeting(db, params.meetingId);
	if (!meeting) {
		throw new Error("Meeting row disappeared while processing");
	}
	const grantToken = await processing_grant_token(env, meeting);

	// A recording the host stopped within seconds holds no speech. Skip the provider polling —
	// its track files may never materialize — and finish with the explicit empty transcript.
	const tooShort =
		meeting.recording_started_at !== null &&
		meeting.closed_at !== null &&
		meeting.closed_at - meeting.recording_started_at < TOO_SHORT_RECORDING_MS;

	let trackFileNames: string[] = [];
	if (tooShort) {
		await stop_short_recording(env, step, meeting);
	} else {
		await resolve_session(env, step, meeting);
		trackFileNames = await discover_tracks(env, step, meeting);

		// Deterministic order: earliest track first, by the filename timestamp, so replays and the
		// upload budget below pick the same tracks every run. The tie-break compares code units, not
		// `localeCompare`: locale collation is decided by the runtime's ICU data, and if that ever
		// changed between a run and its redrive the redrive would choose a different first thirteen,
		// ask for targets nobody minted, and hit the 16-target cap. `tracks.ts` compares the same way.
		trackFileNames.sort((left, right) => {
			const byTime =
				(council_parse_track_file_name(left)?.recordedAtMs ?? 0) -
				(council_parse_track_file_name(right)?.recordedAtMs ?? 0);
			if (byTime !== 0) {
				return byTime;
			}
			return left < right ? -1 : left > right ? 1 : 0;
		});

		// Only a peer audio track may take an upload slot. `transcribe_track` and `tracks.ts` both
		// refuse anything else, and this pipeline declares every stored track as `audio/webm`, so a
		// video or screen-share file would be stored under a lying content type and would push a
		// real audio track out of the budget. Track recording writes per-participant audio only
		// today — `council_provider_start_track_recording` sends no `layers` on purpose — so this
		// filter normally drops nothing. It keeps the budget and the declared type honest if the
		// provider ever starts publishing other files.
		const audioFileNames = trackFileNames.filter((fileName) => {
			const parsed = council_parse_track_file_name(fileName);
			return parsed?.streamKind === "peer" && parsed.mediaKind === "audio";
		});
		const storedFileNames = new Set(audioFileNames.slice(0, UPLOADED_TRACKS_MAX));

		// The host allows at most 16 upload targets per run. Transcript, summary, and provider
		// diagnostic use three. Every track is still transcribed, but raw audio past the remaining
		// budget is not archived.
		if (audioFileNames.length > UPLOADED_TRACKS_MAX) {
			console.warn("More tracks than the upload target budget; extra raw audio is not stored", {
				meetingId: meeting.id,
				trackCount: audioFileNames.length,
				uploadBudget: UPLOADED_TRACKS_MAX,
			});
		}
		for (const [index, fileName] of trackFileNames.entries()) {
			if (storedFileNames.has(fileName)) {
				await step.do(`track-upload-${index}`, async () => {
					return await upload_track(env, meeting, grantToken, fileName);
				});
			}
			await step.do(`track-transcribe-${index}`, async () => {
				return await transcribe_track(env, meeting, fileName);
			});
		}

		await fetch_provider_transcript(env, step, meeting, grantToken);
	}

	await step.do("render-markdown", async () => {
		return await render_and_upload_markdown(env, meeting, grantToken, tooShort);
	});

	// One attempt already has a strict 13-call ceiling, so keep the retry budget at one. The delay is
	// what the retry is for: a Workers AI blip needs time to pass, and two back-to-back calls just
	// fail twice. A model answer that keeps failing is handled inside `store_summary_markdown`, not
	// here: it reads the previous run's stored `failure_reason`, and once that reason says the summary
	// itself already failed, it stores the fixed fallback text instead of failing the run again.
	await step.do("store-summary", { retries: { limit: 1, delay: "30 seconds", backoff: "constant" } }, async () => {
		return await store_summary_markdown(env, meeting, tooShort);
	});

	await step.do("upload-summary", async () => {
		return await upload_summary_markdown(env, meeting, grantToken);
	});

	await step.do("finalize", async () => {
		const now = Date.now();
		await council_transition_meeting(db, {
			meetingId: meeting.id,
			from: ["processing"],
			to: "ready",
			now,
			expectedProcessingGeneration: params.generation,
		});
		await council_project_meeting(env, meeting.id, now);
		return { done: true };
	});
}

async function processing_grant_token(env: Env, meeting: council_MeetingRow) {
	if (!meeting.processing_grant_id) {
		throw new Error("Meeting is processing without a sealed grant");
	}
	const grant = await council_get_service_grant(env.COUNCIL_DB, meeting.processing_grant_id);
	if (!grant) {
		throw new Error("The sealed processing grant row is missing");
	}
	return await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);
}

/**
 * Stop the recording of a meeting too short to process, because nothing else will.
 *
 * Every other meeting stops its recording inside `discover_tracks`, which repeats the request until
 * the provider obeys. A too-short meeting skips that whole block, so the only stop it ever gets is
 * the best-effort one at close, and `council_close_meeting` swallows a refusal there. Without this
 * step one refused request is the end of it: the recording keeps running to its `max_seconds` cap,
 * and the workspace pays for the hour.
 *
 * Read the status first. On the normal path close's stop already worked, so a second stop would ask
 * the provider to end a recording that is no longer running, and a refusal of that would fail a
 * meeting that is otherwise fine. Only a recording still in RECORDING is stopped here.
 *
 * Throw when the provider refuses. The step's own retries cover a blip, and a run that spends them
 * fails visibly, so the hourly redrive cron starts a new generation and asks again. That is the same
 * treatment `discover_tracks` gives a recording that never stopped. A Workflow replay returns this
 * step's cached result without running the callback again, so a replay can neither stop twice nor
 * skip the stop.
 */
async function stop_short_recording(env: Env, step: WorkflowStep, meeting: council_MeetingRow) {
	if (!meeting.provider_recording_id) {
		return;
	}
	const recordingId = meeting.provider_recording_id;

	await step.do("stop-short-recording", async () => {
		const recording = await council_provider_get_recording(env, recordingId);
		if (recording._nay) {
			throw new Error("Reading the recording of a too-short meeting failed");
		}
		if (recording._yay.status !== "RECORDING") {
			return { stopped: false, status: recording._yay.status };
		}
		const stopped = await council_provider_stop_recording(env, recordingId);
		if (stopped._nay) {
			throw new Error("The recording never stopped; the provider refused every stop request");
		}
		return { stopped: true, status: recording._yay.status };
	});
}

/** Find and persist the ended provider session, polling because session state is eventually
 * consistent and only the SESSION's own status says the call is over. */
async function resolve_session(env: Env, step: WorkflowStep, meeting: council_MeetingRow) {
	if (!meeting.provider_meeting_id) {
		throw new Error("Meeting has no provider meeting id");
	}
	const providerMeetingId = meeting.provider_meeting_id;

	for (let attempt = 0; attempt < SESSION_POLL_LIMIT; attempt++) {
		const outcome = await step.do(`resolve-session-${attempt}`, async () => {
			let sessionId = meeting.provider_session_id;
			if (!sessionId) {
				const found = await council_provider_find_session(env, providerMeetingId);
				if (found._nay || !found._yay.sessionId) {
					return { ended: false };
				}
				sessionId = found._yay.sessionId;
				await env.COUNCIL_DB.prepare(
					"UPDATE meetings SET provider_session_id = ? WHERE id = ? AND provider_session_id IS NULL",
				)
					.bind(sessionId, meeting.id)
					.run();
				meeting.provider_session_id = sessionId;
			}
			const session = await council_provider_get_session(env, sessionId);
			if (session._nay) {
				return { ended: false };
			}
			return { ended: session._yay.status === "ENDED" };
		});
		if (outcome.ended) {
			return;
		}
		// Close already kicked once. Repeat here: a refused kick or a still-LIVE session after the
		// first kick would otherwise burn the whole poll budget waiting, and the stop loop below
		// never runs. A refused kick is one missed attempt, not a workflow error.
		await step.do(`kick-session-${attempt}`, async () => {
			const kicked = await council_provider_kick_all(env, providerMeetingId);
			return { kicked: kicked._nay === undefined };
		});
		await step.sleep(`resolve-session-sleep-${attempt}`, POLL_SLEEP);
	}
	// The session never reached ENDED. If a recording id exists, stop it anyway: tracks publish
	// after stop, not after ENDED. A meeting with no recording has nothing left to discover.
	if (meeting.provider_recording_id) {
		return;
	}
	throw new Error("The provider session never reached ENDED");
}

/** Poll the recording until its track file list exists, then record every discovered track. */
async function discover_tracks(env: Env, step: WorkflowStep, meeting: council_MeetingRow) {
	if (!meeting.provider_recording_id) {
		return [];
	}
	const recordingId = meeting.provider_recording_id;

	// The provider does not stop a track recording when the session ends — without a stop it runs
	// to its max_seconds cap and the poll below times out against a RECORDING status. Close already
	// tried this stop best-effort; this poll repeats it until the recording leaves RECORDING, so a
	// refused read or refused stop only costs one attempt out of the poll budget instead of
	// erroring the workflow.
	let lastStatus: string | null = null;
	for (let attempt = 0; attempt < RECORDING_POLL_LIMIT; attempt++) {
		const outcome = await step.do(`discover-tracks-${attempt}`, async () => {
			const recording = await council_provider_get_recording(env, recordingId);
			if (recording._nay) {
				return { done: false, fileNames: [] as string[], status: null };
			}
			if (recording._yay.status === "RECORDING") {
				const stopped = await council_provider_stop_recording(env, recordingId);
				if (stopped._nay) {
					console.warn("Stopping the recording refused; the next poll attempt retries it", {
						meetingId: meeting.id,
					});
				}
				return { done: false, fileNames: [] as string[], status: "RECORDING" };
			}
			// The provider may expose a partial file list while it is still uploading. `UPLOADED` is
			// the only status that means the list is complete, so wait for it and retries always
			// choose the same set.
			if (recording._yay.status === "UPLOADED") {
				const now = Date.now();
				for (const file of recording._yay.trackFiles) {
					await env.COUNCIL_DB.prepare(
						`INSERT OR IGNORE INTO meeting_tracks (id, meeting_id, file_name, status, created_at, updated_at)
						VALUES (?, ?, ?, 'discovered', ?, ?)`,
					)
						.bind(crypto.randomUUID(), meeting.id, file.fileName, now, now)
						.run();
				}
				return { done: true, fileNames: recording._yay.trackFiles.map((file) => file.fileName), status: "UPLOADED" };
			}
			return { done: false, fileNames: [] as string[], status: recording._yay.status };
		});
		if (outcome.done) {
			return outcome.fileNames;
		}
		// Keep the last status the provider really answered. It must travel in the step result: a
		// Workflow replay returns cached step results without running the callback, so a value set
		// inside the callback would be lost. A refused read reports null and keeps the older status.
		if (outcome.status !== null) {
			lastStatus = outcome.status;
		}
		// `ERRORED` is the provider's own terminal failure, so the track files this poll waits for
		// will never appear. Waiting out the whole budget would only delay the moment the page tells
		// the member the meeting failed, by twenty minutes. Throw outside the step: a throw inside it
		// would spend the step's retries on a call that answers the same way every time.
		if (lastStatus === "ERRORED") {
			throw new Error("The provider recording failed: its status is ERRORED");
		}
		await step.sleep(`discover-tracks-sleep-${attempt}`, POLL_SLEEP);
	}
	// Name the real blocker: a recording still RECORDING after the whole budget means the provider
	// refused every stop request, not that it was slow to publish files.
	throw new Error(
		lastStatus === "RECORDING"
			? "The recording never stopped; the provider refused every stop request"
			: "The provider never published the recording's track files",
	);
}

/**
 * Stream one track file into the workspace through the service upload path. Never buffers the
 * body: the provider stream pipes straight into the app upload PUT, with the platform's
 * FixedLengthStream carrying the known length so the presigned PUT sees a sized body.
 */
async function upload_track(env: Env, meeting: council_MeetingRow, grantToken: string, fileName: string) {
	const existing = await get_artifact(env, meeting.id, target_key("track_audio", fileName));
	if (existing?.status === "finalized") {
		return { nodeId: existing.node_id, skipped: true };
	}

	const recording = await council_provider_get_recording(env, meeting.provider_recording_id ?? "");
	if (recording._nay) {
		throw new Error("Reading the recording's track list failed");
	}
	const file = recording._yay.trackFiles.find((candidate) => candidate.fileName === fileName);
	if (!file) {
		throw new Error(`Track file ${fileName} disappeared from the recording`);
	}
	const download = await council_provider_download_track(file.downloadUrl);
	if (download._nay) {
		throw new Error(download._nay.message);
	}
	if (download._yay.contentLength === null) {
		throw new Error(`Track ${fileName} has no Content-Length; refusing an unsized upload`);
	}

	const uploaded = await upload_artifact(env, {
		meeting,
		grantToken,
		kind: "track_audio",
		targetKey: target_key("track_audio", fileName),
		fileName,
		contentType: "audio/webm",
		size: download._yay.contentLength,
		body: with_fixed_length(download._yay.stream, download._yay.contentLength),
		readOnly: true,
		nonCollaborative: false,
	});
	return { nodeId: uploaded.nodeId, skipped: false };
}

/** Transcribe one track with Workers AI Whisper, bounded read, results stored on the track row. */
async function transcribe_track(env: Env, meeting: council_MeetingRow, fileName: string) {
	const db = env.COUNCIL_DB;
	const track = await db
		.prepare("SELECT * FROM meeting_tracks WHERE meeting_id = ? AND file_name = ?")
		.bind(meeting.id, fileName)
		.first<{ id: string; status: string }>();
	if (!track) {
		throw new Error(`Track row for ${fileName} is missing`);
	}
	if (track.status !== "discovered") {
		return { skipped: true };
	}
	const now = Date.now();

	// A file that is not an audio peer track never reaches Whisper; the attribution module would
	// reject it anyway, and rejecting here saves the model call.
	const parsed = council_parse_track_file_name(fileName);
	if (!parsed || parsed.streamKind !== "peer" || parsed.mediaKind !== "audio") {
		// A row rejected here is never read again: `load_attributed_transcript` selects `transcribed`
		// rows only, so attribution never sees this file and cannot report it. The log is the only
		// place that names the file and why it was dropped, and the rendered documents only carry the
		// count. Say it here, at the rejection.
		console.warn("Track rejected before transcription: not an audio peer track", {
			meetingId: meeting.id,
			fileName,
		});
		await db
			.prepare("UPDATE meeting_tracks SET status = 'rejected', updated_at = ? WHERE id = ?")
			.bind(now, track.id)
			.run();
		return { rejected: true };
	}

	const recording = await council_provider_get_recording(env, meeting.provider_recording_id ?? "");
	if (recording._nay) {
		throw new Error("Reading the recording's track list failed");
	}
	const file = recording._yay.trackFiles.find((candidate) => candidate.fileName === fileName);
	if (!file) {
		throw new Error(`Track file ${fileName} disappeared from the recording`);
	}
	const download = await council_provider_download_track(file.downloadUrl);
	if (download._nay) {
		throw new Error(download._nay.message);
	}
	const bytes = await council_read_stream_with_limit(download._yay.stream, council_TRACK_TRANSCRIBE_MAX_BYTES);
	// One participant's whole share of the meeting goes missing here. A track inside the
	// `UPLOADED_TRACKS_MAX` budget already uploaded its raw audio next to the transcript the member
	// will read, so the speech is still there to listen to. A track past that budget was never
	// uploaded, so it leaves nothing behind at all. Name the file and the cap, the same way
	// `council_provider_fetch_transcript` does for its own over-cap read.
	if (bytes._nay) {
		console.warn("Track rejected before transcription: larger than the transcription cap", {
			meetingId: meeting.id,
			fileName,
			maxBytes: council_TRACK_TRANSCRIBE_MAX_BYTES,
		});
		await db
			.prepare("UPDATE meeting_tracks SET status = 'rejected', updated_at = ? WHERE id = ?")
			.bind(now, track.id)
			.run();
		return { rejected: true };
	}

	const segments = await council_transcribe_track(env, bytes._yay);
	if (segments._nay) {
		throw new Error(segments._nay.message);
	}
	await db
		.prepare("UPDATE meeting_tracks SET transcript_json = ?, status = 'transcribed', updated_at = ? WHERE id = ?")
		.bind(JSON.stringify(segments._yay), now, track.id)
		.run();
	return { segmentCount: segments._yay.length };
}

/** Poll and store the provider's own transcript as a diagnostic. Never the product artifact — its
 * speaker identity is placeholder garbage today — and never fatal when it stays absent. */
async function fetch_provider_transcript(
	env: Env,
	step: WorkflowStep,
	meeting: council_MeetingRow,
	grantToken: string,
) {
	if (!meeting.provider_session_id) {
		return;
	}
	const sessionId = meeting.provider_session_id;

	const existing = await get_artifact(env, meeting.id, target_key("provider_transcript", "provider-transcript.json"));
	if (existing?.status === "finalized") {
		return;
	}

	for (let attempt = 0; attempt < TRANSCRIPT_POLL_LIMIT; attempt++) {
		const outcome = await step.do(`provider-transcript-${attempt}`, async () => {
			const transcript = await council_provider_fetch_transcript(env, sessionId);
			if (transcript._nay || !transcript._yay.ready) {
				return { done: false };
			}

			const participants = await load_participants(env, meeting.id);
			// Drop a participant the provider never admitted, the same way `load_attributed_transcript`
			// does. A null id means this person is not in the provider's session at all, and the check
			// below asks whether every speaker id IS in that session. Substituting `""` would add a
			// member of no session to the known set, and an empty `peerData.id` — one more shape of the
			// placeholder identity the provider writes today — would then match it and report the
			// provider as fixed.
			const hasRealIdentity = council_provider_transcript_has_real_identity({
				speakerIds: transcript._yay.speakerIds,
				participants: participants
					.filter((participant) => participant.provider_participant_id !== null)
					.map((participant) => ({
						participantId: participant.id,
						providerParticipantId: participant.provider_participant_id as string,
						displayName: participant.display_name,
					})),
			});
			// The day the provider fixes the defect, this is what notices. Until then the file is
			// stored as a diagnostic and the Markdown transcript stays track-built.
			console.log("Provider transcript identity check", { meetingId: meeting.id, hasRealIdentity });

			const raw = new TextEncoder().encode(transcript._yay.rawJson);
			await upload_artifact(env, {
				meeting,
				grantToken,
				kind: "provider_transcript",
				targetKey: target_key("provider_transcript", "provider-transcript.json"),
				fileName: "provider-transcript.json",
				contentType: "application/json",
				size: raw.byteLength,
				body: raw,
				readOnly: true,
				nonCollaborative: true,
			});
			return { done: true };
		});
		if (outcome.done) {
			return;
		}
		await step.sleep(`provider-transcript-sleep-${attempt}`, POLL_SLEEP);
	}
	console.warn("The provider transcript never became ready; continuing without the diagnostic", {
		meetingId: meeting.id,
	});
}

async function load_attributed_transcript(env: Env, meeting: council_MeetingRow) {
	const db = env.COUNCIL_DB;
	const allRows = await db
		.prepare("SELECT * FROM meeting_tracks WHERE meeting_id = ?")
		.bind(meeting.id)
		.all<{ file_name: string; status: string; transcript_json: string | null }>();
	// Attribution reads transcribed rows only. A row `transcribe_track` rejected carries no speech
	// to attribute, and it must not move the meeting clock below either, so count it and keep it out
	// of everything else.
	const transcribedRows = allRows.results.filter((row) => row.status === "transcribed");
	const refusedTrackCount = allRows.results.filter((row) => row.status === "rejected").length;
	const participants = await load_participants(env, meeting.id);

	// The meeting clock zero is the earliest track start from the filename timestamps, so offsets
	// need no extra provider call and replay identically.
	const parsedStarts = transcribedRows
		.map((row) => council_parse_track_file_name(row.file_name)?.recordedAtMs)
		.filter((value): value is number => typeof value === "number");
	const clockZero = parsedStarts.length > 0 ? Math.min(...parsedStarts) : 0;

	const tracks: council_Track[] = transcribedRows.map((row) => {
		const recordedAtMs = council_parse_track_file_name(row.file_name)?.recordedAtMs ?? clockZero;
		return {
			fileName: row.file_name,
			startOffsetMs: recordedAtMs - clockZero,
			segments: row.transcript_json ? (JSON.parse(row.transcript_json) as council_TrackSegment[]) : [],
		};
	});

	const attribution = council_attribute_tracks({
		tracks,
		participants: participants
			.filter((participant) => participant.provider_participant_id !== null)
			.map((participant) => ({
				participantId: participant.id,
				providerParticipantId: participant.provider_participant_id as string,
				displayName: participant.display_name,
			})),
	});

	// Both counts are the same thing to a reader: a track that was recorded and whose speech is in
	// no document. Add them once here so the transcript and the summary cannot disagree.
	return { ...attribution, droppedTrackCount: refusedTrackCount + attribution.rejected.length };
}

/** Build the product artifact: the speaker-attributed Markdown transcript from the track files. */
async function render_and_upload_markdown(
	env: Env,
	meeting: council_MeetingRow,
	grantToken: string,
	recordingWasTooShort: boolean,
) {
	const existing = await get_artifact(env, meeting.id, target_key("transcript_markdown", "transcript.md"));
	if (existing?.status === "finalized") {
		return { skipped: true };
	}

	const attribution = await load_attributed_transcript(env, meeting);
	// Dropped, never guessed. These are the tracks attribution itself refused; the ones
	// `transcribe_track` refused earlier logged their own reason there. The track rows stay for
	// repair either way.
	if (attribution.rejected.length > 0) {
		console.warn("Tracks were rejected during attribution", {
			meetingId: meeting.id,
			rejected: attribution.rejected,
		});
	}

	const markdown = council_render_transcript_markdown({
		title: meeting.title,
		segments: attribution.segments,
		droppedTrackCount: attribution.droppedTrackCount,
		recordingWasTooShort,
	});
	const bytes = new TextEncoder().encode(markdown);
	await upload_artifact(env, {
		meeting,
		grantToken,
		kind: "transcript_markdown",
		targetKey: target_key("transcript_markdown", "transcript.md"),
		fileName: "transcript.md",
		contentType: "text/markdown",
		size: bytes.byteLength,
		body: bytes,
		readOnly: true,
		nonCollaborative: true,
	});
	return { segmentCount: attribution.segments.length, droppedTrackCount: attribution.droppedTrackCount };
}

/** Persist model output before creating its target, so every redrive uploads byte-identical text. */
async function store_summary_markdown(env: Env, meeting: council_MeetingRow, recordingWasTooShort: boolean) {
	const db = env.COUNCIL_DB;
	const existing = await db
		.prepare("SELECT meeting_id FROM meeting_summaries WHERE meeting_id = ?")
		.bind(meeting.id)
		.first<{ meeting_id: string }>();
	if (existing) {
		return { summaryStored: true };
	}

	const attribution = await load_attributed_transcript(env, meeting);
	// Both reasons for having no segments travel with them: the run skipped track discovery, or every
	// recorded track was dropped. `council_summarize_meeting` needs to tell those apart from a silent
	// room, and it is handed the same two values `render_and_upload_markdown` gave `transcript.md`, so
	// the two files answer this meeting the same way.
	const summarized = await council_summarize_meeting(env, {
		segments: attribution.segments,
		droppedTrackCount: attribution.droppedTrackCount,
		recordingWasTooShort,
	});
	// The summary is the only step that can fail forever. `cleanup.ts` sweeps every `failed` meeting
	// older than an hour into `council_request_processing_redrive` (`lifecycle.ts`), which always
	// starts a new generation, and no summary row exists yet, so the model is asked again from
	// scratch. A model that keeps answering badly would repeat that every hour for the six days the
	// sealed grant lives, and the meeting would never reach `ready` even though `transcript.md`
	// uploaded fine. The transcript is the product artifact; the summary is not worth holding it
	// back. So once a previous generation ALREADY failed on the summary, a second bad answer stores
	// a fixed text instead of failing the run, and the meeting finishes.
	//
	// The generation number cannot decide this: a redrive bumps it for every kind of failure, so a
	// meeting that failed three times on an upload would spend its very first model answer on the
	// fixed text. The stored reason of the previous run is what names the summary, and every summary
	// failure message starts with `council_SUMMARY_FAILURE_PREFIX` (see `ai.ts`, where that contract
	// is written down). The model is still asked first on every generation, because an operator may
	// have fixed whatever made it answer badly.
	if (summarized._nay) {
		const summaryFailedBefore = (meeting.failure_reason ?? "").startsWith(council_SUMMARY_FAILURE_PREFIX);
		if (!summaryFailedBefore) {
			throw new Error(summarized._nay.message);
		}
		console.warn("The summary model kept failing; storing the fallback summary instead", {
			meetingId: meeting.id,
			generation: meeting.processing_generation,
			reason: summarized._nay.message,
		});
	}

	const markdown = council_render_summary_markdown({
		title: meeting.title,
		createdAt: meeting.opened_at ?? meeting.created_at,
		summary: summarized._yay?.summary ?? SUMMARY_FALLBACK,
		sourceWasSplit: summarized._yay?.sourceWasSplit ?? false,
		sourceWasTruncated: summarized._yay?.sourceWasTruncated ?? false,
		droppedTrackCount: attribution.droppedTrackCount,
	});

	await db
		.prepare("INSERT OR IGNORE INTO meeting_summaries (meeting_id, markdown, created_at) VALUES (?, ?, ?)")
		.bind(meeting.id, markdown, Date.now())
		.run();
	// Read the stored winner after the idempotent insert. A retry must never upload model output
	// that lost a race with another attempt for the same meeting.
	const stored = await db
		.prepare("SELECT meeting_id FROM meeting_summaries WHERE meeting_id = ?")
		.bind(meeting.id)
		.first<{ meeting_id: string }>();
	if (!stored) {
		throw new Error(`${council_SUMMARY_FAILURE_PREFIX} was not stored`);
	}
	return { summaryStored: true };
}

/** Upload the stored summary text. Reports like the other upload steps, so a Workflow trace can
 * tell this step apart from the store step above. */
async function upload_summary_markdown(env: Env, meeting: council_MeetingRow, grantToken: string) {
	const existing = await get_artifact(env, meeting.id, target_key("summary_markdown", "summary.md"));
	if (existing?.status === "finalized") {
		return { nodeId: existing.node_id, skipped: true };
	}
	const stored = await env.COUNCIL_DB.prepare("SELECT markdown FROM meeting_summaries WHERE meeting_id = ?")
		.bind(meeting.id)
		.first<{ markdown: string }>();
	if (!stored) {
		throw new Error(`${council_SUMMARY_FAILURE_PREFIX} was not stored before upload`);
	}
	const bytes = new TextEncoder().encode(stored.markdown);
	const uploaded = await upload_artifact(env, {
		meeting,
		grantToken,
		kind: "summary_markdown",
		targetKey: target_key("summary_markdown", "summary.md"),
		fileName: "summary.md",
		contentType: "text/markdown",
		size: bytes.byteLength,
		body: bytes,
		readOnly: true,
		nonCollaborative: true,
	});
	return { nodeId: uploaded.nodeId, skipped: false };
}

async function load_participants(env: Env, meetingId: string) {
	const rows = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_participants WHERE meeting_id = ?")
		.bind(meetingId)
		.all<council_ParticipantRow>();
	return rows.results;
}

async function get_artifact(env: Env, meetingId: string, targetKey: string) {
	return await env.COUNCIL_DB.prepare("SELECT * FROM meeting_artifacts WHERE meeting_id = ? AND target_key = ?")
		.bind(meetingId, targetKey)
		.first<council_ArtifactRow>();
}

function with_fixed_length(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
	// The platform's FixedLengthStream gives the PUT a sized body; without it the runtime would
	// send chunked encoding, which presigned URLs refuse. Absent in Node tests, present in Workers.
	const FixedLength = (
		globalThis as {
			FixedLengthStream?: new (length: number) => {
				readable: ReadableStream<Uint8Array>;
				writable: WritableStream<Uint8Array>;
			};
		}
	).FixedLengthStream;
	if (!FixedLength) {
		return stream;
	}
	const fixed = new FixedLength(length);
	void stream.pipeTo(fixed.writable);
	return fixed.readable;
}

const FINALIZE_POLL_ATTEMPTS = 8;

/**
 * The one door every artifact goes through: mint the idempotent upload target, PUT the body with
 * exactly the returned headers, then finalize until the storage event settles. The exact
 * create-target body is persisted before the first call — the host answers a replayed idempotency
 * key only for an identical body — so a replayed step converges on one artifact set.
 */
async function upload_artifact(
	env: Env,
	args: {
		meeting: council_MeetingRow;
		grantToken: string;
		kind: council_ArtifactRow["kind"];
		targetKey: string;
		fileName: string;
		contentType: string;
		size: number;
		body: ReadableStream<Uint8Array> | Uint8Array;
		readOnly: boolean;
		nonCollaborative: boolean;
	},
) {
	const db = env.COUNCIL_DB;
	const now = Date.now();
	await db
		.prepare(
			`INSERT OR IGNORE INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
		)
		.bind(crypto.randomUUID(), args.meeting.id, args.kind, args.targetKey, args.fileName, now, now)
		.run();
	let artifact = await get_artifact(env, args.meeting.id, args.targetKey);
	if (!artifact) {
		throw new Error(`Artifact row for ${args.targetKey} is missing`);
	}

	// Persist the exact create-target body once. A replayed step re-sends these stored bytes; a
	// body rebuilt from fresh values could differ and the host would answer 409.
	if (!artifact.upload_body) {
		const createBody = JSON.stringify({
			idempotencyKey: meeting_upload_key(args.meeting),
			targetKey: args.targetKey,
			// Strictly inside the sealed prefix, canonical lowercase file name.
			path: `${args.meeting.destination_path}/${args.fileName.toLowerCase()}`,
			contentType: args.contentType,
			size: args.size,
			readOnly: args.readOnly,
			nonCollaborative: args.nonCollaborative,
		});
		await db
			.prepare("UPDATE meeting_artifacts SET upload_body = ?, updated_at = ? WHERE id = ? AND upload_body IS NULL")
			.bind(createBody, now, artifact.id)
			.run();
		artifact = await get_artifact(env, args.meeting.id, args.targetKey);
	}
	if (!artifact?.upload_body) {
		throw new Error(`Artifact ${args.targetKey} lost its stored upload body`);
	}
	const createBody = JSON.parse(artifact.upload_body) as {
		idempotencyKey: string;
		targetKey: string;
		path: string;
		contentType: string;
		size: number;
		readOnly: boolean;
		nonCollaborative: boolean;
	};

	const target = await council_convex_uploads_create_target(env, args.grantToken, createBody);
	if (target._nay) {
		const message = `Upload target refused: ${target._nay.message}`;
		// Neither of these two clears itself. The plan does not change while the run is going, and the
		// storage counter only counts up, because deleting a stored file gives no bytes back. Retrying
		// asks the same question and gets the same answer, so it only delays the moment the page tells
		// the member the meeting failed. The hourly redrive starts a new generation once the plan is
		// raised or the ceiling is lifted. Network errors stay retryable because they are a plain Error.
		if (target._nay.name === "plan_required" || target._nay.name === "storage_full") {
			throw new NonRetryableError(message);
		}
		throw new Error(message);
	}
	if (target._yay.state === "released") {
		throw new Error("The upload target was released before this artifact committed");
	}

	let committed: { nodeId: string; actualBytes: number | null } | null = null;
	if (target._yay.state === "committed") {
		// A replayed step whose earlier run already committed the bytes: nothing to upload.
		committed = target._yay;
	} else {
		// The URL is always usable, so there is nothing to check before the PUT. The host mints it in
		// the very call that answers `pending`: a fresh target signs one, and a replayed target is
		// reminted on the host side before it answers. It never hands back the earlier run's URL.
		const pending = target._yay;

		// Exactly the returned headers: the signed URL was computed over them.
		const put = await fetch(pending.uploadUrl, {
			method: "PUT",
			headers: pending.headers,
			body: args.body as BodyInit,
		});
		if (!put.ok) {
			throw new Error(`Artifact PUT returned HTTP ${put.status}`);
		}

		// Finalize is the poll: `pending` means the storage event has not settled yet. Bounded
		// backoff inside the step; running out lets the step's own retry take over later.
		const finalizeBody = { idempotencyKey: meeting_upload_key(args.meeting), targetKey: args.targetKey };
		let delayMs = 500;
		for (let attempt = 0; attempt < FINALIZE_POLL_ATTEMPTS && !committed; attempt++) {
			const finalized = await council_convex_uploads_finalize(env, args.grantToken, finalizeBody);
			if (finalized._nay) {
				throw new Error(`Artifact finalize refused: ${finalized._nay.message}`);
			}
			if (finalized._yay.state === "committed") {
				committed = finalized._yay;
				break;
			}
			if (finalized._yay.state === "released") {
				throw new Error("The upload target was released before this artifact committed");
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			delayMs = Math.min(delayMs * 2, 5000);
		}
		if (!committed) {
			throw new Error(`The storage event for ${args.targetKey} never settled; the step will retry`);
		}
	}

	await db
		.prepare(
			"UPDATE meeting_artifacts SET status = 'finalized', node_id = ?, bytes = ?, updated_at = ? WHERE meeting_id = ? AND target_key = ?",
		)
		.bind(committed.nodeId, committed.actualBytes ?? args.size, Date.now(), args.meeting.id, args.targetKey)
		.run();
	return { nodeId: committed.nodeId };
}

// #endregion processing

// #region deletion

export async function council_run_deletion(env: Env, step: WorkflowStep, params: council_WorkflowParams) {
	const db = env.COUNCIL_DB;
	const meeting = await council_get_meeting(db, params.meetingId);
	if (!meeting || meeting.status !== "deleting") {
		return "stale";
	}

	try {
		await step.do("provider-cleanup", async () => {
			// Best effort: the session is normally long gone. The provider's own seven-day expiry is
			// the backstop for its stored files; the tombstone refuses late webhooks meanwhile.
			// Kick first, like close does: it is the cheap call that empties the room, and a refused
			// stop below must not leave people sitting in a meeting the host just deleted.
			if (meeting.provider_meeting_id) {
				try {
					await council_provider_kick_all(env, meeting.provider_meeting_id);
				} catch {
					// Nothing to end is fine.
				}
			}

			// Kick-all does not stop a track recording: the provider runs it to its max_seconds cap
			// instead. Close and the processing pipeline both stop it explicitly, but a meeting
			// deleted while it is still open reaches neither of them, so this is the last path that
			// can stop it. Without this, a host who deletes a meeting to stop the recording does not
			// stop it, and the provider keeps track files nobody fetches until its seven-day expiry.
			if (meeting.provider_recording_id) {
				// Read the status first. The provider refuses a stop against a recording that is no
				// longer running, and most deletes arrive long after close already stopped it, so an
				// unconditional stop would fail the delete of every normal meeting.
				//
				// Only a 404 skips the stop. The provider drops a recording after its seven-day
				// expiry, so an old meeting's recording is simply not there any more, and a delete
				// the host asked for must not be blocked by a record the provider no longer keeps.
				// Any other failed read throws instead: the recording may still be running, so the
				// step's retries re-read, and a spent budget fails the delete into `delete_failed`
				// visibly rather than reporting the meeting deleted with the recording running on.
				const recording = await council_provider_get_recording(env, meeting.provider_recording_id);
				if (recording._nay && recording._nay.name !== "not_found") {
					throw new Error("Reading the recording of a deleted meeting failed");
				}
				if (!recording._nay && recording._yay.status === "RECORDING") {
					const stopped = await council_provider_stop_recording(env, meeting.provider_recording_id);
					// The provider just said this recording is still running, so a refusal here is not
					// "nothing to end" the way a refused kick-all is. Throw: the step's own retries
					// cover a blip, and a spent budget fails the delete visibly, so the hourly
					// `delete_failed` cron asks again. Reporting the meeting deleted while its
					// recording runs on would be a lie about the one thing the host pressed for.
					if (stopped._nay) {
						throw new Error("The recording never stopped; the provider refused the stop request");
					}
				}
			}
			return { done: true };
		});

		await step.do("archive-files", async () => {
			// The meeting is going away, so its folder must leave the file tree. The files are real
			// stored files, and deleting a file in this product means archiving it, so the host
			// archives the folder with everything still inside it and a member can restore the set.
			// This runs even with no finalized artifact: a meeting that failed still leaves the empty
			// folder its first upload created.
			const grantId = meeting.processing_grant_id ?? meeting.service_grant_id;
			const grant = grantId ? await council_get_service_grant(db, grantId) : null;
			if (!grant) {
				return { archivedNodes: 0 };
			}
			const token = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);

			// A refusal stops the delete visibly instead of pretending the folder is gone. A member
			// lock or a restricted folder somebody nested in here reads as one, and the meeting can be
			// deleted again once they clear it.
			const archived = await council_convex_uploads_archive_destination(env, token);
			if (archived._nay) {
				const message = `Archiving the meeting folder failed: ${archived._nay.message}`;
				// A member lock or a dead grant will not clear itself. Retrying this step for a
				// minute leaves the meeting in `deleting` with no visible failure. Network errors
				// stay retryable because they are a plain Error.
				if (archived._nay.name === "conflict" || archived._nay.name === "unauthorized") {
					throw new NonRetryableError(message);
				}
				throw new Error(message);
			}

			await db
				.prepare(
					"UPDATE meeting_artifacts SET status = 'deleted', updated_at = ? WHERE meeting_id = ? AND status = 'finalized'",
				)
				.bind(Date.now(), meeting.id)
				.run();
			return { archivedNodes: archived._yay.archivedNodes };
		});

		await step.do("projection-delete", async () => {
			const now = Date.now();
			// The delete supersedes every undelivered older revision: order says nothing older than
			// the terminal delete may apply after it.
			await db
				.prepare(
					"UPDATE projection_outbox SET status = 'superseded', updated_at = ? WHERE meeting_id = ? AND status = 'pending'",
				)
				.bind(now, meeting.id)
				.run();
			const current = await council_get_meeting(db, meeting.id);
			if (current) {
				await council_enqueue_projection(db, { meeting: current, operation: "delete", payload: null, now });
			}
			const delivered = await council_deliver_projections(env, meeting.id, now);
			if (delivered._nay) {
				throw new Error(`Projection delete delivery failed: ${delivered._nay.message}`);
			}
			return { done: true };
		});

		await step.do("clear-pii-and-tombstone", async () => {
			const now = Date.now();
			// One atomic sweep, tombstone included: PII, sessions, tickets, transcripts, summaries,
			// grant references, the sealed grant row, and the status write to `deleted_tombstone` all
			// ride one batch, so a crash or a lost write can only replay the whole sweep, never leave
			// half of it. Half of it would poison the recovery paths. The meeting row is read again
			// outside any step on a replay, so a committed sweep whose grant delete never ran would
			// hand the replay a nulled grant column and the sealed grant — a still-live write token —
			// would survive until the expiry sweep. And a committed sweep whose tombstone write failed
			// would leave a `deleting` row with no grant and no destination path: the redrive could not
			// deliver the delete projection, the hourly sweep would skip a row with no sealed grant,
			// and the page delete could not re-seal over an empty path. With the tombstone in the
			// batch, a failed status write rolls the sweep back too, and the redrive finds everything
			// it needs.
			//
			// The gated statements are the grant-column UPDATE, the sealed-grant DELETE, and the
			// status write. They fire only while the row is still this generation's `deleting` row.
			// The PII, session, ticket, transcript, and summary statements stay ungated: a stale run
			// only erases what the live delete erases anyway. A redrive can bump the generation while
			// this run is in flight, and a replayed batch from the stale run must not strip the grants
			// and destination path the new generation needs. A gated statement that matches nothing is
			// a no-op, not an error, so the stale run still reports its own word like every other
			// stale terminal write in this file.
			const sweep = [
				db
					.prepare(
						"UPDATE meeting_participants SET display_name = '', email_hmac = NULL, provider_token_encrypted = NULL WHERE meeting_id = ?",
					)
					.bind(meeting.id),
				db.prepare("DELETE FROM room_sessions WHERE meeting_id = ?").bind(meeting.id),
				db.prepare("DELETE FROM meeting_tickets WHERE meeting_id = ?").bind(meeting.id),
				db.prepare("UPDATE meeting_tracks SET transcript_json = NULL WHERE meeting_id = ?").bind(meeting.id),
				db.prepare("DELETE FROM meeting_summaries WHERE meeting_id = ?").bind(meeting.id),
				db
					.prepare(
						"UPDATE meetings SET title = '', destination_path = '', service_grant_id = NULL, processing_grant_id = NULL, updated_at = ? WHERE id = ? AND status = 'deleting' AND processing_generation = ?",
					)
					.bind(now, meeting.id, params.generation),
			];
			// The sealed processing grant belongs to this meeting alone; interactive grants are
			// shared through the page cache and the expiry sweeper owns them. `ON DELETE RESTRICT`
			// on the meetings grant columns still allows this DELETE inside the batch: the batch
			// runs its statements in order, so the UPDATE above clears the references before the
			// DELETE executes. The EXISTS gate repeats the UPDATE's condition, so a stale batch whose
			// UPDATE no-opped skips this DELETE too instead of tripping RESTRICT on references it
			// never cleared.
			if (meeting.processing_grant_id) {
				sweep.push(
					db
						.prepare(
							"DELETE FROM service_grants WHERE id = ? AND EXISTS (SELECT 1 FROM meetings WHERE id = ? AND status = 'deleting' AND processing_generation = ?)",
						)
						.bind(meeting.processing_grant_id, meeting.id, params.generation),
				);
			}
			// The tombstone write is a raw statement because only a statement can ride the batch. It
			// mirrors the SQL `council_transition_meeting` would run for deleting -> deleted_tombstone
			// with expectedProcessingGeneration: same status condition, same generation condition,
			// same set columns. Last on purpose: it flips the status away from `deleting`, which the
			// gates above still check.
			sweep.push(
				db
					.prepare(
						"UPDATE meetings SET status = 'deleted_tombstone', updated_at = ?, tombstone_expires_at = ? WHERE id = ? AND status = 'deleting' AND processing_generation = ?",
					)
					.bind(now, now + 8 * 24 * 60 * 60 * 1000, meeting.id, params.generation),
			);
			await db.batch(sweep);
			return { done: true };
		});

		return "deleted";
	} catch (error) {
		// A delete redrive bumps the generation too, so the same condition as the processing catch
		// keeps a stale run's failure off a row the next delete generation already owns.
		const now = Date.now();
		await council_transition_meeting(db, {
			meetingId: meeting.id,
			from: ["deleting"],
			to: "delete_failed",
			now,
			set: { failure_reason: failure_reason(error) },
			expectedProcessingGeneration: params.generation,
		});
		console.error("Meeting delete failed and needs operator attention; bytes stay charged", {
			meetingId: meeting.id,
		});
		throw error;
	}
}

// #endregion deletion
