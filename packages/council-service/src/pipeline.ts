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
	council_convex_uploads_release,
	council_convex_uploads_remint,
	council_convex_uploads_reserve,
} from "./convex-api.ts";
import { council_read_stream_with_limit, council_transcribe_track, council_TRACK_TRANSCRIBE_MAX_BYTES } from "./ai.ts";
import {
	council_attribute_tracks,
	council_parse_track_file_name,
	council_provider_transcript_has_real_identity,
	council_render_transcript_markdown,
	type council_Track,
	type council_TrackSegment,
} from "./tracks.ts";
import {
	council_deliver_projections,
	council_enqueue_projection,
	council_project_meeting,
} from "./projection.ts";

/** A recording shorter than this holds no usable speech; the meeting finishes with an empty
 * transcript instead of waiting for track files that may never appear. */
const TOO_SHORT_RECORDING_MS = 5 * 1000;

const SESSION_POLL_LIMIT = 40;
const RECORDING_POLL_LIMIT = 40;
const TRANSCRIPT_POLL_LIMIT = 10;
const POLL_SLEEP = "30 seconds";

/** The reservation allows 16 targets; the transcript and the provider diagnostic take two. */
const UPLOADED_TRACKS_MAX = 14;

function target_key(kind: string, fileName: string) {
	return `${kind}:${fileName}`;
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
		await run_processing_steps(env, step, params.meetingId);
		return "ready";
	} catch (error) {
		// The step retry budget is spent. Fail visibly: the page shows the reason, the hourly cron
		// (and `council_request_processing_redrive`) start a NEW generation after repair, and
		// nothing pretends an artifact exists.
		const now = Date.now();
		await council_transition_meeting(db, {
			meetingId: params.meetingId,
			from: ["processing"],
			to: "failed",
			now,
			set: { failure_reason: String(error instanceof Error ? error.message : error).slice(0, 200) },
		});
		// `failed` is terminal for uploads: the envelope goes back to the workspace. Release keeps
		// committed files and freezes new targets, so a later redrive can only replay already
		// committed work.
		const released = await release_upload_reservation(env, params.meetingId);
		if (released._nay) {
			console.warn("Releasing the upload reservation after failure did not succeed", {
				meetingId: params.meetingId,
				reason: released._nay.message,
			});
		}
		await council_project_meeting(env, params.meetingId, now);
		throw error;
	}
}

/**
 * Release the meeting's upload byte envelope with the reservation's own stored idempotency key.
 * The reserve body was persisted at open exactly as it was sent, and release identifies the
 * reservation by that key. Safe to replay: an already-released reservation answers success.
 */
/**
 * The host resolves the reservation BY the request's idempotency key: the key names one
 * reservation (the meeting), and `targetKey` names one file inside it. Every create-target,
 * remint, and finalize call must present the meeting's own stored reserve key, or the host
 * answers `Not found`.
 */
function meeting_reserve_key(meeting: { reserve_body: string | null }) {
	if (!meeting.reserve_body) {
		throw new Error("Meeting has no stored reserve body");
	}
	return (JSON.parse(meeting.reserve_body) as { idempotencyKey: string }).idempotencyKey;
}

async function release_upload_reservation(env: Env, meetingId: string) {
	const meeting = await council_get_meeting(env.COUNCIL_DB, meetingId);
	if (!meeting || !meeting.reservation_id || !meeting.reserve_body || !meeting.processing_grant_id) {
		return { _yay: { skipped: true as const }, _nay: undefined };
	}
	const grant = await council_get_service_grant(env.COUNCIL_DB, meeting.processing_grant_id);
	if (!grant) {
		return { _yay: { skipped: true as const }, _nay: undefined };
	}
	const token = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);
	const reserveBody = JSON.parse(meeting.reserve_body) as { idempotencyKey: string };
	return await council_convex_uploads_release(env, token, { idempotencyKey: reserveBody.idempotencyKey });
}

/**
 * Make sure the meeting's upload envelope is alive before any upload work. A normal run replays
 * the reservation made at open, and the host answers that replay idempotently. On an operator
 * redrive after a failure the envelope was already given back, and the host refuses a released
 * idempotency key forever — so reserve a fresh envelope under a new key, store it as the meeting's
 * reserve body, and clear the pending artifacts' stored upload bodies so they re-mint their
 * targets under the new key. Artifacts that already committed are skipped by their D1 status and
 * never touch the fresh envelope.
 */
async function ensure_upload_reservation(env: Env, meeting: council_MeetingRow, grantToken: string) {
	const db = env.COUNCIL_DB;
	// A meeting that never opened admission has no reservation; the too-short path still uploads
	// the empty transcript, so this only skips when there is truly nothing stored to replay.
	if (!meeting.reserve_body) {
		return { ensured: false as const };
	}
	const storedBody = JSON.parse(meeting.reserve_body) as {
		idempotencyKey: string;
		reservedBytes: number;
		expiresAt: number;
	};

	const replayed = await council_convex_uploads_reserve(env, grantToken, storedBody);
	if (!replayed._nay) {
		// Keep the recorded reservation id in sync. After a crash between the body rotation below
		// and its reserve call, this replay is the call that actually creates the fresh reservation.
		await db
			.prepare("UPDATE meetings SET reservation_id = ? WHERE id = ?")
			.bind(replayed._yay.reservationId, meeting.id)
			.run();
		return { ensured: true as const, rotated: false };
	}
	if (replayed._nay.name !== "conflict") {
		throw new Error(`Upload reservation is not available: ${replayed._nay.message}`);
	}

	// The failure handler released this key. Persist the exact fresh body before the call, like the
	// open does, so a crashed retry re-sends these stored bytes instead of minting yet another key.
	const freshBody = JSON.stringify({
		idempotencyKey: `council-uploads-${meeting.id}-g${meeting.processing_generation}-r${crypto.randomUUID()}`,
		reservedBytes: storedBody.reservedBytes,
		expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
	});
	await db
		.prepare("UPDATE meetings SET reserve_body = ? WHERE id = ? AND reserve_body = ?")
		.bind(freshBody, meeting.id, meeting.reserve_body)
		.run();
	// Pending artifacts persisted their create-target bodies with the released key; clear them so
	// the upload step re-persists against the fresh reservation. Finalized rows keep theirs.
	await db
		.prepare("UPDATE meeting_artifacts SET upload_body = NULL WHERE meeting_id = ? AND status = 'pending'")
		.bind(meeting.id)
		.run();

	const stored = await council_get_meeting(db, meeting.id);
	if (!stored?.reserve_body) {
		throw new Error("Meeting lost its stored reserve body");
	}
	const reserveBody = JSON.parse(stored.reserve_body) as {
		idempotencyKey: string;
		reservedBytes: number;
		expiresAt: number;
	};
	const reserved = await council_convex_uploads_reserve(env, grantToken, reserveBody);
	if (reserved._nay) {
		throw new Error(`Failed to reserve a fresh upload envelope: ${reserved._nay.message}`);
	}
	await db
		.prepare("UPDATE meetings SET reservation_id = ?, updated_at = ? WHERE id = ?")
		.bind(reserved._yay.reservationId, Date.now(), meeting.id)
		.run();
	return { ensured: true as const, rotated: true };
}

async function run_processing_steps(env: Env, step: WorkflowStep, meetingId: string) {
	const db = env.COUNCIL_DB;
	const preloaded = await council_get_meeting(db, meetingId);
	if (!preloaded) {
		throw new Error("Meeting row disappeared while processing");
	}
	const grantToken = await processing_grant_token(env, preloaded);

	await step.do("ensure-reservation", async () => {
		return await ensure_upload_reservation(env, preloaded, grantToken);
	});
	// The ensure step may have rotated the reserve body; every later step must read the meeting
	// with the body that is actually reserved, not the pre-step snapshot.
	const meeting = await council_get_meeting(db, meetingId);
	if (!meeting) {
		throw new Error("Meeting row disappeared while processing");
	}

	// A recording the host stopped within seconds holds no speech. Skip the provider polling —
	// its track files may never materialize — and finish with the explicit empty transcript.
	const tooShort =
		meeting.recording_started_at !== null &&
		meeting.closed_at !== null &&
		meeting.closed_at - meeting.recording_started_at < TOO_SHORT_RECORDING_MS;

	let trackFileNames: string[] = [];
	if (!tooShort) {
		await resolve_session(env, step, meeting);
		trackFileNames = await discover_tracks(env, step, meeting);

		// Deterministic order: earliest track first, by the filename timestamp, so replays and the
		// upload budget below pick the same tracks every run.
		trackFileNames.sort(
			(left, right) =>
				(council_parse_track_file_name(left)?.recordedAtMs ?? 0) -
				(council_parse_track_file_name(right)?.recordedAtMs ?? 0),
		);

		// The reservation allows at most 16 targets, and two are spent on the transcript and the
		// provider diagnostic. A 25-participant meeting can produce more tracks than the remaining
		// budget; every track is still transcribed — the attributed transcript stays complete — but
		// raw audio past the budget is not archived.
		if (trackFileNames.length > UPLOADED_TRACKS_MAX) {
			console.warn("More tracks than the reservation's target budget; extra raw audio is not stored", {
				meetingId: meeting.id,
				trackCount: trackFileNames.length,
				uploadBudget: UPLOADED_TRACKS_MAX,
			});
		}
		for (const [index, fileName] of trackFileNames.entries()) {
			if (index < UPLOADED_TRACKS_MAX) {
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
		return await render_and_upload_markdown(env, meeting, grantToken);
	});

	await step.do("finalize", async () => {
		const now = Date.now();
		await council_transition_meeting(db, {
			meetingId: meeting.id,
			from: ["processing"],
			to: "ready",
			now,
		});
		// Every artifact is committed, so the unused part of the envelope goes back to the
		// workspace now. Best effort: the reservation also expires on its own clock.
		const released = await release_upload_reservation(env, meeting.id);
		if (released._nay) {
			console.warn("Releasing the upload reservation after ready did not succeed", {
				meetingId: meeting.id,
				reason: released._nay.message,
			});
		}
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
	let stillRecording = false;
	for (let attempt = 0; attempt < RECORDING_POLL_LIMIT; attempt++) {
		const outcome = await step.do(`discover-tracks-${attempt}`, async () => {
			const recording = await council_provider_get_recording(env, recordingId);
			if (recording._nay) {
				return { done: false, fileNames: [] as string[], stillRecording: undefined };
			}
			if (recording._yay.status === "RECORDING") {
				const stopped = await council_provider_stop_recording(env, recordingId);
				if (stopped._nay) {
					console.warn("Stopping the recording refused; the next poll attempt retries it", {
						meetingId: meeting.id,
					});
				}
				return { done: false, fileNames: [] as string[], stillRecording: true };
			}
			if (recording._yay.trackFiles.length > 0) {
				const now = Date.now();
				for (const file of recording._yay.trackFiles) {
					await env.COUNCIL_DB.prepare(
						`INSERT OR IGNORE INTO meeting_tracks (id, meeting_id, file_name, status, created_at, updated_at)
						VALUES (?, ?, ?, 'discovered', ?, ?)`,
					)
						.bind(crypto.randomUUID(), meeting.id, file.fileName, now, now)
						.run();
				}
				return { done: true, fileNames: recording._yay.trackFiles.map((file) => file.fileName) };
			}
			// A terminal recording with zero tracks is the "nothing usable was captured" case, not a
			// wait-longer case.
			if (recording._yay.status === "UPLOADED" || recording._yay.status === "STOPPED") {
				return { done: true, fileNames: [] as string[] };
			}
			return { done: false, fileNames: [] as string[], stillRecording: false };
		});
		if (outcome.done) {
			return outcome.fileNames;
		}
		// Keep the last definitive observation outside the step. It must travel in the step result:
		// a Workflow replay returns cached step results without running the callback, so a closure
		// flag set inside the callback would be lost.
		if (outcome.stillRecording !== undefined) {
			stillRecording = outcome.stillRecording;
		}
		await step.sleep(`discover-tracks-sleep-${attempt}`, POLL_SLEEP);
	}
	// Name the real blocker: a recording still RECORDING after the whole budget means the provider
	// refused every stop request, not that it was slow to publish files.
	throw new Error(
		stillRecording
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
	if (bytes._nay) {
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
			const hasRealIdentity = council_provider_transcript_has_real_identity({
				speakerIds: transcript._yay.speakerIds,
				participants: participants.map((participant) => ({
					participantId: participant.id,
					providerParticipantId: participant.provider_participant_id ?? "",
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

/** Build the product artifact: the speaker-attributed Markdown transcript from the track files. */
async function render_and_upload_markdown(env: Env, meeting: council_MeetingRow, grantToken: string) {
	const existing = await get_artifact(env, meeting.id, target_key("transcript_markdown", "transcript.md"));
	if (existing?.status === "finalized") {
		return { skipped: true };
	}

	const db = env.COUNCIL_DB;
	const trackRows = await db
		.prepare("SELECT * FROM meeting_tracks WHERE meeting_id = ? AND status = 'transcribed'")
		.bind(meeting.id)
		.all<{ file_name: string; transcript_json: string | null }>();
	const participants = await load_participants(env, meeting.id);

	// The meeting clock zero is the earliest track start from the filename timestamps, so offsets
	// need no extra provider call and replay identically.
	const parsedStarts = trackRows.results
		.map((row) => council_parse_track_file_name(row.file_name)?.recordedAtMs)
		.filter((value): value is number => typeof value === "number");
	const clockZero = parsedStarts.length > 0 ? Math.min(...parsedStarts) : 0;

	const tracks: council_Track[] = trackRows.results.map((row) => {
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
	if (attribution.rejected.length > 0) {
		// Dropped, never guessed. Rejections are visible in logs and the track rows stay for repair.
		console.warn("Tracks were rejected during attribution", {
			meetingId: meeting.id,
			rejected: attribution.rejected,
		});
	}

	const markdown = council_render_transcript_markdown({ title: meeting.title, segments: attribution.segments });
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
	});
	return { segmentCount: attribution.segments.length, rejectedCount: attribution.rejected.length };
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
			idempotencyKey: meeting_reserve_key(args.meeting),
			targetKey: args.targetKey,
			// Strictly inside the sealed prefix, canonical lowercase file name.
			path: `${args.meeting.destination_path}/${args.fileName.toLowerCase()}`,
			contentType: args.contentType,
			size: args.size,
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
	};

	const target = await council_convex_uploads_create_target(env, args.grantToken, createBody);
	if (target._nay) {
		throw new Error(`Upload target refused: ${target._nay.message}`);
	}
	if (target._yay.state === "released") {
		throw new Error("The upload target was released before this artifact committed");
	}

	let committed: { nodeId: string; actualBytes: number | null } | null = null;
	if (target._yay.state === "committed") {
		// A replayed step whose earlier run already committed the bytes: nothing to upload.
		committed = target._yay;
	} else {
		let pending = target._yay;
		// The signed URL lives fifteen minutes. When a replay hands back a stale one, remint a
		// fresh URL for the same staging key — nothing is recharged and no second node appears.
		if (pending.uploadUrlExpiresAt <= Date.now()) {
			const fresh = await council_convex_uploads_remint(env, args.grantToken, {
				idempotencyKey: meeting_reserve_key(args.meeting),
				targetKey: args.targetKey,
			});
			if (fresh._nay) {
				throw new Error(`Upload remint refused: ${fresh._nay.message}`);
			}
			if (fresh._yay.state === "released") {
				throw new Error("The upload target was released before this artifact committed");
			}
			if (fresh._yay.state === "committed") {
				committed = fresh._yay;
			} else {
				pending = fresh._yay;
			}
		}

		if (!committed) {
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
			const finalizeBody = { idempotencyKey: meeting_reserve_key(args.meeting), targetKey: args.targetKey };
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
			if (meeting.provider_meeting_id) {
				try {
					await council_provider_kick_all(env, meeting.provider_meeting_id);
				} catch {
					// Nothing to end is fine.
				}
			}
			return { done: true };
		});

		await step.do("release-reservation", async () => {
			// The upload release runs before the archive on purpose. It deletes the placeholder files
			// of uploads that never finished, so the archive below only ever covers real stored files.
			// Do not release the projection reservation here. delete-versioned below still needs that
			// hold when the meeting never stored a document. Convex now also accepts a released
			// never-stored retry for the same key, but keeping the live reservation means a crash
			// between release and delete cannot spend a second slot.
			const grantId = meeting.processing_grant_id ?? meeting.service_grant_id;
			const grant = grantId ? await council_get_service_grant(db, grantId) : null;
			if (!grant) {
				return { released: false };
			}
			const token = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);

			// The upload byte envelope, when the meeting ever opened. This refunds whatever was never
			// finalized; the stored files keep their bytes, because the archive below keeps them.
			if (meeting.reservation_id && meeting.reserve_body) {
				const reserveBody = JSON.parse(meeting.reserve_body) as { idempotencyKey: string };
				const releasedUploads = await council_convex_uploads_release(env, token, {
					idempotencyKey: reserveBody.idempotencyKey,
				});
				if (releasedUploads._nay) {
					throw new Error(`Releasing the upload reservation failed: ${releasedUploads._nay.message}`);
				}
			}
			return { released: true };
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
				.prepare("UPDATE projection_outbox SET status = 'superseded', updated_at = ? WHERE meeting_id = ? AND status = 'pending'")
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
			const processingGrantId = meeting.processing_grant_id;
			// One atomic sweep: PII, sessions, tickets, transcripts, and grant references go
			// together, so a crash can only replay the whole sweep, never leave half of it.
			await db.batch([
				db
					.prepare(
						"UPDATE meeting_participants SET display_name = '', email_hmac = NULL, provider_token_encrypted = NULL WHERE meeting_id = ?",
					)
					.bind(meeting.id),
				db.prepare("DELETE FROM room_sessions WHERE meeting_id = ?").bind(meeting.id),
				db.prepare("DELETE FROM meeting_tickets WHERE meeting_id = ?").bind(meeting.id),
				db.prepare("UPDATE meeting_tracks SET transcript_json = NULL WHERE meeting_id = ?").bind(meeting.id),
				db
					.prepare(
						"UPDATE meetings SET title = '', destination_path = '', service_grant_id = NULL, processing_grant_id = NULL, updated_at = ? WHERE id = ?",
					)
					.bind(now, meeting.id),
			]);
			// The sealed processing grant belongs to this meeting alone; interactive grants are
			// shared through the page cache and the expiry sweeper owns them.
			if (processingGrantId) {
				await db.prepare("DELETE FROM service_grants WHERE id = ?").bind(processingGrantId).run();
			}
			await council_transition_meeting(db, {
				meetingId: meeting.id,
				from: ["deleting"],
				to: "deleted_tombstone",
				now,
				set: { tombstone_expires_at: now + 8 * 24 * 60 * 60 * 1000 },
			});
			return { done: true };
		});

		return "deleted";
	} catch (error) {
		const now = Date.now();
		await council_transition_meeting(db, {
			meetingId: meeting.id,
			from: ["deleting"],
			to: "delete_failed",
			now,
			set: {
				failure_reason: String(error instanceof Error ? error.message : error)
					.replace(/^NonRetryableError:\s*/u, "")
					.slice(0, 200),
			},
		});
		console.error("Meeting delete failed and needs operator attention; bytes stay charged", {
			meetingId: meeting.id,
		});
		throw error;
	}
}

// #endregion deletion
