/**
 * Shared meeting lifecycle steps used by more than one entrypoint: the page close route, the room
 * host close, and the deadline cron all close a meeting the same way.
 */

import type { Env } from "./env.ts";
import type { council_MeetingRow } from "./db.ts";
import { council_get_meeting, council_transition_meeting } from "./db.ts";
import { council_encrypt } from "./crypto.ts";
import {
	council_provider_get_active_session,
	council_provider_kick_all,
	council_provider_stop_recording,
} from "./provider.ts";
import { council_convex_seal_processing } from "./convex-api.ts";
import { council_verify_grant } from "./grants.ts";
import { council_outbox_insert_statement, council_dispatch_outbox } from "./outbox.ts";
import { council_project_meeting } from "./projection.ts";
import { council_workflow_instance_id } from "./consumer.ts";
import { Result } from "./result.ts";

/**
 * Close admission and, when a recording exists, hand the meeting to the processing pipeline.
 * Idempotent: a meeting already past `closed` answers success without acting.
 *
 * Order matters and is deliberate:
 * 1. The D1 transition closes admission first — whatever the provider does next, no new join
 *    token can be minted once this commits.
 * 2. The provider session is ended best-effort. A failure here is not a failed close; everyone
 *    leaving ends the session anyway and the recording has its own `max_seconds` cap.
 * 3. With a recording, the meeting enters `processing` and the outbox row exists in one atomic
 *    batch. The sealed grant already exists — the open claimed it — so a crash leaves either a
 *    closed meeting the cron can re-drive or a fully handed-off one.
 */
export async function council_close_meeting(env: Env, meetingId: string, now: number) {
	const db = env.COUNCIL_DB;
	const meeting = await council_get_meeting(db, meetingId);
	if (!meeting) {
		return Result<never>({ _nay: { name: "not_found", message: "Not found" } });
	}
	// `recorded` rides every success answer so the room can tell the host the truth about the
	// recording instead of guessing from its own stage. Once the close commits, the guarded write
	// in `handle_start_recording` refuses, so the id read after the transition is final.
	if (["closed", "processing", "ready", "failed"].includes(meeting.status)) {
		return Result({ _yay: { status: meeting.status, recorded: meeting.provider_recording_id !== null } });
	}

	const closedNow = await council_transition_meeting(db, {
		meetingId,
		from: ["open", "recording_start_unknown"],
		to: "closed",
		now,
		set: { closed_at: now },
	});
	if (!closedNow) {
		return Result<never>({ _nay: { name: "conflict", message: "Meeting is not open" } });
	}

	// A start-recording call only needs the row to be open, so it can attach its recording id after
	// the read above and before this transition commits. The transition is what shuts that door: once
	// the row is `closed`, the guarded write in `handle_start_recording` refuses and stops its own
	// recording. So read the id again here. Without this, a recording that landed in that gap is
	// never stopped and the meeting settles at `ready` with no transcript.
	const closedMeeting = await council_get_meeting(db, meetingId);
	const providerRecordingId = closedMeeting?.provider_recording_id ?? null;

	// Best-effort provider session end. Capture the session id while the meeting still has an
	// active session — the pipeline needs it later and the sessions list filter cannot be trusted.
	if (meeting.provider_meeting_id) {
		try {
			const active = await council_provider_get_active_session(env, meeting.provider_meeting_id);
			if (!active._nay && active._yay.sessionId) {
				await db
					.prepare("UPDATE meetings SET provider_session_id = ? WHERE id = ? AND provider_session_id IS NULL")
					.bind(active._yay.sessionId, meetingId)
					.run();
			}
			const kicked = await council_provider_kick_all(env, meeting.provider_meeting_id);
			if (kicked._nay) {
				console.warn("Provider kick-all refused; participants end the session by leaving", {
					meetingId,
				});
			}
			// The provider does not stop a track recording when the session ends — it runs to its
			// max_seconds cap and publishes no track files until stopped. Stop it here so processing
			// can start now; the pipeline repeats this stop durably, so a failure only delays it.
			if (providerRecordingId) {
				const stopped = await council_provider_stop_recording(env, providerRecordingId);
				if (stopped._nay) {
					console.warn("Stopping the recording at close failed; the pipeline retries the stop", {
						meetingId,
					});
				}
			}
		} catch (error) {
			console.warn("Provider session end failed; participants end the session by leaving", {
				meetingId,
				error: String(error),
			});
		}
	}

	if (providerRecordingId) {
		const handed = await council_start_processing(env, meetingId, now);
		if (handed._nay) {
			// The meeting stays `closed`; the scheduled reconciliation retries the handoff.
			console.warn("Handing the meeting to processing failed; the meeting stays closed for retry", {
				meetingId,
				reason: handed._nay.message,
			});
		}
	} else {
		// No recording means nothing to process. Settle the meeting now: nothing else ever
		// transitions a closed meeting without a recording, and the plugin page polls `closed` as a
		// transitional state.
		await council_transition_meeting(db, {
			meetingId,
			from: ["closed"],
			to: "ready",
			now,
		});
	}

	// The enqueue inside can throw on the UNIQUE (meeting_id, revision) index when a concurrent
	// state change projected first. The close itself is already committed, so answer the caller
	// instead of throwing: the winner re-read the row, so a state at least as new is already on its
	// way, and the meeting's next state change re-projects the full row anyway. Without this, one
	// collision turns a committed close into a bodyless 500 through `handle_close` and aborts the
	// deadline sweep for every meeting after this one.
	try {
		await council_project_meeting(env, meetingId, now);
	} catch (error) {
		console.warn("Projecting the close failed; the next state change re-projects it", {
			meetingId,
			error: String(error),
		});
	}
	const after = await council_get_meeting(db, meetingId);
	return Result({ _yay: { status: after?.status ?? "closed", recorded: providerRecordingId !== null } });
}

/**
 * Seal a live interactive grant into a fresh processing-phase grant scoped to the meeting's own
 * folder, and store it as a new grant row. Used at open (so processing authority exists before any
 * guest joins) and again at delete (the open-time seal may be past its fixed six-day life by then).
 * Open re-pins and seals from the requesting member's current grant (the create-time pin lives 24
 * hours and open can happen near the end of that window). Delete passes `fromGrantId` the same way,
 * because a delete can come weeks later. Returns the new grant row id; the caller decides where to
 * point it.
 */
export async function council_seal_meeting_grant(env: Env, meeting: council_MeetingRow, now: number, fromGrantId?: string) {
	const grantId = fromGrantId ?? meeting.service_grant_id;
	if (!grantId) {
		return Result<never>({ _nay: { name: "no_grant", message: "Meeting has no pinned grant" } });
	}
	// Sealing hands the pipeline authority to write this meeting's files, so claim the write scope:
	// a member who lost `content.write` must not be able to start that. The claim stops at the
	// plugin-data pair even though the sealed grant carries `files:write`, because the host also
	// refuses a claim wider than the grant being verified, and an interactive grant never holds
	// `files:write`.
	const verified = await council_verify_grant(env, grantId, now, ["plugin_data:read", "plugin_data:write"]);
	if (verified._nay) {
		return verified;
	}
	const sealed = await council_convex_seal_processing(env, verified._yay.token, {
		destinationPathPrefix: meeting.destination_path,
	});
	if (sealed._nay) {
		return sealed;
	}

	const processingGrantId = crypto.randomUUID();
	const encrypted = await council_encrypt(env.COUNCIL_ROOM_COOKIE_SECRET, sealed._yay.token);
	await env.COUNCIL_DB.prepare(
		`INSERT INTO service_grants (id, organization_id, workspace_id, installation_id, actor_user_id, principal_key, phase, destination_path_prefix, token_encrypted, scopes, expires_at, created_at, updated_at)
		SELECT ?, organization_id, workspace_id, installation_id, actor_user_id, principal_key, 'processing', ?, ?, ?, ?, ?, ? FROM service_grants WHERE id = ?`,
	)
		.bind(
			processingGrantId,
			meeting.destination_path,
			encrypted,
			JSON.stringify(sealed._yay.scopes),
			sealed._yay.expiresAt,
			now,
			now,
			grantId,
		)
		.run();
	return Result({ _yay: { processingGrantId, token: sealed._yay.token } });
}

/**
 * Move a closed meeting with a recording into `processing`, with the outbox row in the same
 * atomic batch. Idempotent per generation. The sealed grant was claimed when the meeting opened,
 * so nothing here talks to Convex.
 */
export async function council_start_processing(env: Env, meetingId: string, now: number) {
	const db = env.COUNCIL_DB;
	const meeting = await council_get_meeting(db, meetingId);
	if (!meeting || meeting.status !== "closed" || !meeting.provider_recording_id) {
		return Result({ _yay: { started: false as const } });
	}
	// The open claimed the processing grant before any admission. A closed, recorded meeting
	// without one cannot exist through the supported flow.
	if (!meeting.processing_grant_id) {
		return Result<never>({ _nay: { name: "no_grant", message: "Meeting has no sealed processing grant" } });
	}

	const generation = meeting.processing_generation + 1;
	await db.batch([
		db
			.prepare(
				`UPDATE meetings SET status = 'processing', processing_generation = ?, updated_at = ? WHERE id = ? AND status = 'closed'`,
			)
			.bind(generation, now, meetingId),
		council_outbox_insert_statement(db, { meetingId, kind: "process_meeting", generation, now }),
	]);
	await council_dispatch_outbox(env, { meetingId, kind: "process_meeting", now });
	return Result({ _yay: { started: true as const } });
}

/**
 * Start a new processing generation for a meeting whose previous attempt is terminal.
 *
 * Copy the delete-failed repair: bump `processing_generation` and insert a fresh outbox row. The
 * Queue consumer acks `delivered` and `dead` without starting anything, and the Workflow instance
 * id is pinned to the generation, so moving `failed -> processing` on the same generation would
 * dispatch a row that never runs.
 *
 * Two cases:
 * - `failed`: the previous instance finished. Always bump.
 * - `processing` with a settled (`dead` or `delivered`) outbox row for the current generation:
 *   bump only when that generation's Workflow instance is missing or already terminal. A `dead`
 *   row after `createBatch` succeeded can mean the instance is still running, and a `delivered`
 *   row usually means exactly that; bumping would start N+1. A `delivered` row with a terminal
 *   instance means the run's `failed` write was lost, and nothing else ever moves that meeting.
 */
export async function council_request_processing_redrive(env: Env, meeting: council_MeetingRow, now: number) {
	const db = env.COUNCIL_DB;
	if (meeting.status !== "failed" && meeting.status !== "processing") {
		return Result({ _yay: { started: false as const } });
	}

	if (meeting.status === "processing") {
		const orphaned = await settled_generation_has_no_instance(env, {
			meetingId: meeting.id,
			kind: "process_meeting",
			generation: meeting.processing_generation,
		});
		if (!orphaned) {
			return Result({ _yay: { started: false as const } });
		}
	}

	const generation = meeting.processing_generation + 1;
	const moved = await db.batch([
		db
			.prepare(
				"UPDATE meetings SET status = 'processing', processing_generation = ?, updated_at = ? WHERE id = ? AND status = ?",
			)
			.bind(generation, now, meeting.id, meeting.status),
		council_outbox_insert_statement(db, { meetingId: meeting.id, kind: "process_meeting", generation, now }),
	]);
	if (moved[0].meta.changes !== 1) {
		return Result<never>({ _nay: { name: "conflict", message: "Meeting changed state; retry the redrive" } });
	}
	await council_dispatch_outbox(env, { meetingId: meeting.id, kind: "process_meeting", now });
	return Result({ _yay: { started: true as const } });
}

/**
 * Start the delete workflow for a meeting in any state. Idempotent: a meeting already deleting or
 * tombstoned answers success without a new generation, unless the current delete outbox is settled
 * (`dead`, or `delivered` with the run's `delete_failed` write lost) and that generation's
 * Workflow instance is gone.
 */
export async function council_request_meeting_delete(env: Env, meeting: council_MeetingRow, now: number) {
	const db = env.COUNCIL_DB;
	if (meeting.status === "deleted_tombstone") {
		return Result({ _yay: { status: meeting.status } });
	}
	if (meeting.status === "deleting") {
		const orphaned = await settled_generation_has_no_instance(env, {
			meetingId: meeting.id,
			kind: "delete_meeting",
			generation: meeting.processing_generation,
		});
		if (!orphaned) {
			await council_dispatch_outbox(env, { meetingId: meeting.id, kind: "delete_meeting", now });
			return Result({ _yay: { status: "deleting" as const } });
		}
	}
	const generation = meeting.processing_generation + 1;
	const moved = await db.batch([
		db
			.prepare(
				"UPDATE meetings SET status = 'deleting', processing_generation = ?, updated_at = ? WHERE id = ? AND status = ?",
			)
			.bind(generation, now, meeting.id, meeting.status),
		council_outbox_insert_statement(db, { meetingId: meeting.id, kind: "delete_meeting", generation, now }),
	]);
	if (moved[0].meta.changes !== 1) {
		return Result<never>({ _nay: { name: "conflict", message: "Meeting changed state; retry the delete" } });
	}
	await council_dispatch_outbox(env, { meetingId: meeting.id, kind: "delete_meeting", now });
	return Result({ _yay: { status: "deleting" as const } });
}

/**
 * A settled outbox row (`dead` or `delivered`) is not proof the generation's work resolved. A
 * `dead` row can follow a `createBatch` that did start the instance, with only the ack lost into
 * the DLQ. A `delivered` row normally means the run is live or finished well — but the run's
 * catch records `failed`/`delete_failed` with one D1 write, and if that write is lost the meeting
 * keeps its pre-terminal status forever while the row stays `delivered`. Bump only when that
 * generation's instance is missing or already terminal. A transport error on `get` is not "gone":
 * the instance may still be running.
 */
async function settled_generation_has_no_instance(
	env: Env,
	args: { meetingId: string; kind: "process_meeting" | "delete_meeting"; generation: number },
) {
	const current = await env.COUNCIL_DB.prepare(
		"SELECT status FROM event_outbox WHERE meeting_id = ? AND kind = ? AND generation = ?",
	)
		.bind(args.meetingId, args.kind, args.generation)
		.first<{ status: string }>();
	if (current?.status !== "dead" && current?.status !== "delivered") {
		return false;
	}

	const instanceId = council_workflow_instance_id({
		kind: args.kind,
		meetingId: args.meetingId,
		generation: args.generation,
	});
	try {
		const instance = await env.COUNCIL_WORKFLOW.get(instanceId);
		const snapshot = await instance.status();
		return snapshot.status === "complete" || snapshot.status === "errored" || snapshot.status === "terminated";
	} catch (error) {
		return workflow_instance_is_missing(error);
	}
}

/**
 * Decide whether a failed `get` means the instance was never created.
 *
 * `WorkflowBinding.get` calls the instance's `status()` inside a bare `catch` and rethrows
 * `new Error("instance.not_found")`, so the engine's descriptive text never reaches here. Through
 * `get`, the code is the only marker that ever arrives, and the first pattern is what matches it.
 *
 * `/does not exist/i` matches the engine's own wording. The engine builds `(instance.not_found)
 * Instance does not exist`, and a deployed runtime may surface that form instead of the bare code.
 *
 * `/not found/i` matches neither form. The engine writes `not_found` with an underscore, so the
 * spaced text appears in no Workflows error we can name. Keep it as defensive breadth, not as a
 * pattern with a known producer.
 *
 * Read a match as weak evidence, not as proof. That same bare `catch` also relabels a transport
 * failure as `instance.not_found`, and a false "gone" reaches `council_request_processing_redrive`
 * and bumps the generation. So widening these patterns can only make that more likely.
 */
function workflow_instance_is_missing(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return /instance\.not_found/i.test(message) || /not found/i.test(message) || /does not exist/i.test(message);
}
