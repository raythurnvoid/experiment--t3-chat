/**
 * The scheduled pass. Everything here is a backstop for a path that normally completes inline:
 * expired short-lived rows are deleted, deadlines are enforced whatever the host did, lost
 * handoffs are re-driven, and tombstones finally reach true zero. Every sweep is bounded so one
 * bad row cannot make the cron the slowest part of the system.
 */

import type { Env } from "./env.ts";
import {
	council_close_meeting,
	council_request_meeting_delete,
	council_request_processing_redrive,
	council_start_processing,
} from "./lifecycle.ts";
import { council_get_meeting, council_get_service_grant, council_transition_meeting } from "./db.ts";
import { council_dispatch_outbox, type council_EventOutboxRow } from "./outbox.ts";
import { council_workflow_instance_id } from "./consumer.ts";
import { council_deliver_projections, council_project_meeting } from "./projection.ts";

/** A created meeting that is never opened expires after a day. */
export const council_UNOPENED_MEETING_TTL_MS = 24 * 60 * 60 * 1000;

/** Guest email HMACs live two hours past the join, then the retry window is over. */
const EMAIL_HMAC_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * How long one verified webhook body is remembered so a retried delivery is recognised as a
 * duplicate. Eight days is the window a tombstoned meeting already gets, so a webhook row never
 * outlives the meeting it could have been about.
 */
const WEBHOOK_EVENT_TTL_MS = 8 * 24 * 60 * 60 * 1000;
/** A handoff older than this without an observed instance is treated as lost and re-driven. */
const HANDOFF_STALE_MS = 15 * 60 * 1000;
/** A failed delete retries after this long, so a transient outage does not alert forever. */
const DELETE_RETRY_MS = 60 * 60 * 1000;
/** A failed processing attempt retries on the same slow clock as a failed delete. */
const PROCESSING_RETRY_MS = DELETE_RETRY_MS;
const SWEEP_LIMIT = 25;

export async function council_run_scheduled(env: Env, now: number) {
	const db = env.COUNCIL_DB;

	// Expired short-lived rows. The window start is part of the rate-limit key, so old windows are
	// dead rows, never live counters.
	await db.prepare("DELETE FROM meeting_tickets WHERE expires_at <= ?").bind(now).run();
	await db.prepare("DELETE FROM room_sessions WHERE expires_at <= ?").bind(now).run();
	await db.prepare("DELETE FROM page_token_cache WHERE expires_at <= ?").bind(now).run();
	await db.prepare("DELETE FROM rate_limit_windows WHERE window_start <= ?").bind(now - 2 * 60 * 60 * 1000).run();
	// Webhook rows the tombstone sweep below never matches: an event the handler could not map to a
	// meeting is stored with `meeting_id = NULL`, and so is any delivery that arrives after its
	// meeting was swept. Nothing else deletes those, so without this they and the
	// `webhook_events_dedupe` index grow for the deployment's lifetime.
	//
	// Forgetting a row this old cannot replay work. The provider stops retrying a delivery long
	// before eight days. And if one did arrive again: a meeting that was swept no longer exists, so
	// the handler stores the event and does nothing, and a meeting that still exists is only
	// actionable while it is `processing`, where the outbox insert is `INSERT OR IGNORE` on
	// (meeting, kind, generation) and that row is already there.
	await db.prepare("DELETE FROM webhook_events WHERE received_at <= ?").bind(now - WEBHOOK_EVENT_TTL_MS).run();
	await db
		.prepare("UPDATE meeting_participants SET email_hmac = NULL WHERE email_hmac IS NOT NULL AND created_at <= ?")
		.bind(now - EMAIL_HMAC_TTL_MS)
		.run();
	// Expired grants that nothing points at anymore. Every reference to `service_grants` that is
	// `ON DELETE RESTRICT` has to be listed below. One referenced row makes this DELETE throw, no
	// grant is removed at all, and the throw ends the pass before deadline enforcement and every
	// sweep under it. `page_token_cache` is the one reference left out on purpose: it cascades, so
	// deleting a grant deletes the mapping that named it. Each subquery drops its own NULLs, because
	// `NOT IN` over a set holding NULL matches nothing and would quietly delete no grant at all.
	//
	// Two of them really collide. A host session pins the grant that minted its room ticket, and
	// `resume_room_session` moves that session's expiry five hours forward on every room page load,
	// with no ceiling and no look at the pinned grant. So a room tab that is loaded again every few
	// hours keeps the session alive past the grant's 24 hours.
	//
	// A ticket collides too. The first statement above only deletes a ticket whose OWN `expires_at`
	// has passed, and a ticket lives two minutes from the moment it was minted. Minting one needs a
	// grant with any time left at all, so a member who opens the host room in the last two minutes
	// of a 24-hour grant leaves a live ticket pinning a grant that is already dead. Consuming the
	// ticket does not help: the room marks it `consumed_at` and leaves the row for this sweep.
	await db
		.prepare(
			`DELETE FROM service_grants WHERE expires_at <= ?
			AND id NOT IN (SELECT service_grant_id FROM meetings WHERE service_grant_id IS NOT NULL)
			AND id NOT IN (SELECT processing_grant_id FROM meetings WHERE processing_grant_id IS NOT NULL)
			AND id NOT IN (SELECT actor_service_grant_id FROM room_sessions WHERE actor_service_grant_id IS NOT NULL)
			AND id NOT IN (SELECT actor_service_grant_id FROM meeting_tickets WHERE actor_service_grant_id IS NOT NULL)`,
		)
		.bind(now)
		.run();

	// Deadline enforcement: a meeting closes at its deadline whatever else happens.
	const pastDeadline = await db
		.prepare(
			"SELECT id FROM meetings WHERE status IN ('open', 'recording_start_unknown') AND deadline_at IS NOT NULL AND deadline_at <= ? LIMIT ?",
		)
		.bind(now, SWEEP_LIMIT)
		.all<{ id: string }>();
	for (const row of pastDeadline.results) {
		const closed = await council_close_meeting(env, row.id, now);
		if (closed._nay) {
			console.warn("Deadline close failed; the next pass retries", { meetingId: row.id });
		}
	}

	// A meeting that closed with a recording but never reached `processing` stays `closed`; retry the
	// handoff. It is a D1 transition plus an outbox write, so nothing here depends on a live grant. A
	// closed meeting without a recording settles to `ready` inline at close, so one that is still
	// `closed` here crashed before that settle — replay it, because nothing else ever transitions it.
	const closedPending = await db
		.prepare("SELECT id, provider_recording_id FROM meetings WHERE status = 'closed' LIMIT ?")
		.bind(SWEEP_LIMIT)
		.all<{ id: string; provider_recording_id: string | null }>();
	for (const row of closedPending.results) {
		try {
			if (row.provider_recording_id === null) {
				// Project only when this pass won the settle; a concurrent close or delete that won
				// instead projects its own newer state.
				const settled = await council_transition_meeting(db, { meetingId: row.id, from: ["closed"], to: "ready", now });
				if (settled) {
					await council_project_meeting(env, row.id, now);
				}
				continue;
			}
			const handed = await council_start_processing(env, row.id, now);
			if (handed._nay) {
				console.warn("Handing the meeting to processing failed; the meeting stays closed for retry", {
					meetingId: row.id,
					reason: handed._nay.message,
				});
			} else if (handed._yay.started) {
				// Project the re-driven handoff like the inline close does, so the page shows
				// `processing` instead of the pre-close state for the whole pipeline run.
				await council_project_meeting(env, row.id, now);
			}
		} catch (error) {
			// Contain the row so one bad row cannot abort the rest of the pass. A throw after the
			// settle committed only loses this projection attempt; the meeting's next state change
			// projects the full row again.
			console.warn("Closed sweep failed for this meeting", { meetingId: row.id, error: String(error) });
		}
	}

	// A created meeting nobody ever opened expires after a day. `create_unknown` expires on the
	// same clock — its provider meeting, if one exists, was never opened and dies with the account's
	// normal retention; automatic create retries stay forbidden.
	const stale = await db
		.prepare("SELECT id, status FROM meetings WHERE status IN ('created', 'create_unknown') AND created_at <= ? LIMIT ?")
		.bind(now - council_UNOPENED_MEETING_TTL_MS, SWEEP_LIMIT)
		.all<{ id: string; status: "created" | "create_unknown" }>();
	for (const row of stale.results) {
		const expired = await council_transition_meeting(db, { meetingId: row.id, from: [row.status], to: "expired", now });
		// The create projected `created` into the Plan-2 store, and that document now goes stale on
		// purpose: the meeting's interactive grant dies on the same 24-hour clock as this TTL and
		// the worker never renews it, so no authority remains to deliver an `expired` write, and an
		// enqueued row could never drain (no sweep ever deletes an expired meeting). The page
		// renders from D1, so members still see `expired`; a member delete heals the store.
		if (expired && row.status === "created") {
			console.warn("Expired meeting's store document stays stale: its grant died with the unopened TTL", {
				meetingId: row.id,
			});
		}
	}

	// Outbox reconciliation. Pending rows get their send retried; handoff_pending rows older than
	// the stale window are checked against the Workflow service and re-driven when the instance
	// never appeared.
	const pendingOutbox = await db
		.prepare("SELECT * FROM event_outbox WHERE status = 'pending' LIMIT ?")
		.bind(SWEEP_LIMIT)
		.all<council_EventOutboxRow>();
	for (const row of pendingOutbox.results) {
		await council_dispatch_outbox(env, { meetingId: row.meeting_id, kind: row.kind, now });
	}
	const staleHandoffs = await db
		.prepare("SELECT * FROM event_outbox WHERE status = 'handoff_pending' AND updated_at <= ? LIMIT ?")
		.bind(now - HANDOFF_STALE_MS, SWEEP_LIMIT)
		.all<council_EventOutboxRow>();
	for (const row of staleHandoffs.results) {
		const instanceId = council_workflow_instance_id({
			kind: row.kind,
			meetingId: row.meeting_id,
			generation: row.generation,
		});
		// Guard both writes on the status still being handoff_pending: the consumer can deliver the
		// row concurrently, and an unguarded revert here would flap a delivered row back to pending
		// for one redundant re-send.
		try {
			await env.COUNCIL_WORKFLOW.get(instanceId);
			await db
				.prepare(
					"UPDATE event_outbox SET status = 'delivered', workflow_instance_id = ?, updated_at = ? WHERE id = ? AND status = 'handoff_pending'",
				)
				.bind(instanceId, now, row.id)
				.run();
		} catch {
			// The instance never existed or fell out of retention. Back to pending; the next dispatch
			// re-sends and the consumer creates it again — createBatch is idempotent per id.
			await db
				.prepare("UPDATE event_outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'handoff_pending'")
				.bind(now, row.id)
				.run();
		}
	}

	// Projection reconciliation: deliver every meeting with pending revisions, in order, scanning
	// the meetings whose oldest pending row is oldest first.
	const pendingProjections = await db
		.prepare(
			"SELECT meeting_id FROM projection_outbox WHERE status = 'pending' GROUP BY meeting_id ORDER BY MIN(updated_at) LIMIT ?",
		)
		.bind(SWEEP_LIMIT)
		.all<{ meeting_id: string }>();
	for (const row of pendingProjections.results) {
		const delivered = await council_deliver_projections(env, row.meeting_id, now);
		if (delivered._nay) {
			// Rotate the deferred meeting to the back of the window. A meeting whose grant is dead
			// would otherwise keep its oldest-first slot forever, and 25 of them would starve every
			// healthy retry; rotated, a dead meeting costs one attempt per full rotation instead.
			await db
				.prepare("UPDATE projection_outbox SET updated_at = ? WHERE meeting_id = ? AND status = 'pending'")
				.bind(now, row.meeting_id)
				.run();
			console.warn("Projection reconciliation deferred", {
				meetingId: row.meeting_id,
				reason: delivered._nay.message,
			});
		}
	}

	// Failed deletes retry on a slow clock. The meeting keeps its `delete_failed` row until a later
	// run reaches the tombstone, and whatever that run did not finish stays with it: the workspace
	// folder when `archive-files` never got through, and the participant PII, tickets, sessions,
	// track transcripts and summary row when `clear-pii-and-tombstone` never ran. The stored bytes
	// stay charged meanwhile.
	const failedDeletes = await db
		.prepare("SELECT id FROM meetings WHERE status = 'delete_failed' AND updated_at <= ? LIMIT ?")
		.bind(now - DELETE_RETRY_MS, SWEEP_LIMIT)
		.all<{ id: string }>();
	for (const row of failedDeletes.results) {
		const meeting = await council_get_meeting(db, row.id);
		if (!meeting) {
			continue;
		}
		// The delete workflow spends the meeting's sealed processing grant. Once that grant is dead,
		// a retry generation can only fail again — skip it and say so; a member's next delete from
		// the page seals fresh authority and re-drives.
		const sealedGrant = meeting.processing_grant_id
			? await council_get_service_grant(db, meeting.processing_grant_id)
			: null;
		if (!sealedGrant || sealedGrant.expires_at <= now) {
			// Bump the retry clock so this dead row leaves the hourly window instead of occupying
			// one of its 25 slots forever; only a member's page delete can re-arm it for real.
			await db.prepare("UPDATE meetings SET updated_at = ? WHERE id = ?").bind(now, meeting.id).run();
			console.warn("Delete retry skipped: the sealed grant is dead; a page delete re-arms it", {
				meetingId: meeting.id,
			});
			continue;
		}
		// Hand the still-delete_failed meeting straight to the request helper. It moves the meeting
		// to deleting AND bumps the generation with a new outbox row in one batch. Pre-transitioning
		// here would skip that insert: the old generation's row is delivered and its workflow
		// instance already failed terminally, so nothing would ever run again.
		await council_request_meeting_delete(env, meeting, now);
	}

	// Failed processing retries on the same slow clock. The previous generation's outbox is
	// delivered or dead and its Workflow instance is terminal, so the helper bumps the generation
	// instead of flipping the status back to `processing` on the same generation.
	const failedProcessing = await db
		.prepare("SELECT id FROM meetings WHERE status = 'failed' AND updated_at <= ? LIMIT ?")
		.bind(now - PROCESSING_RETRY_MS, SWEEP_LIMIT)
		.all<{ id: string }>();
	for (const row of failedProcessing.results) {
		const meeting = await council_get_meeting(db, row.id);
		if (!meeting) {
			continue;
		}
		const sealedGrant = meeting.processing_grant_id
			? await council_get_service_grant(db, meeting.processing_grant_id)
			: null;
		// The delete branch above names the page delete because `handle_delete` seals a fresh grant.
		// Processing has no such route: no page call re-seals a processing grant, so this meeting can
		// never produce its files. Say that, and bump the clock so the dead row leaves the window.
		if (!sealedGrant || sealedGrant.expires_at <= now) {
			await db.prepare("UPDATE meetings SET updated_at = ? WHERE id = ?").bind(now, meeting.id).run();
			console.warn(
				"Processing retry skipped: the sealed grant is dead; this meeting can no longer be processed and only a page delete is left",
				{ meetingId: meeting.id },
			);
			continue;
		}
		await council_request_processing_redrive(env, meeting, now);
	}

	// A processing meeting whose current outbox row is settled is a candidate for a new generation.
	// Two rows land here. A `dead` row is the DLQ's mark. A `delivered` row belongs here too when
	// its run failed terminally but the catch's one `failed` write in `council_run_processing` was
	// lost — the meeting then sits in `processing` forever, because nothing else ever moves it. The
	// request helper still asks Workflow.get before bumping, so a running instance is left alone.
	// Only the delivered shape takes the hourly clock: every healthy pipeline run sits at exactly
	// processing + delivered, so an unclocked scan would ask Workflow.get about every running
	// meeting on every pass.
	const stuckProcessing = await db
		.prepare(
			`SELECT m.id FROM meetings m
			JOIN event_outbox o ON o.meeting_id = m.id AND o.kind = 'process_meeting' AND o.generation = m.processing_generation
			WHERE m.status = 'processing' AND (o.status = 'dead' OR (o.status = 'delivered' AND m.updated_at <= ?))
			LIMIT ?`,
		)
		.bind(now - PROCESSING_RETRY_MS, SWEEP_LIMIT)
		.all<{ id: string }>();
	for (const row of stuckProcessing.results) {
		const meeting = await council_get_meeting(db, row.id);
		if (!meeting) {
			continue;
		}
		await council_request_processing_redrive(env, meeting, now);
	}

	// A deleting meeting whose current outbox row is settled never finished: `dead` from the DLQ,
	// or `delivered` when the catch's one `delete_failed` write in the delete workflow was lost
	// after a terminal run. Bump only when that generation's instance is gone; an instance that
	// started before the DLQ write must finish. The delivered shape takes the hourly clock for the
	// same reason as processing above.
	const stuckDeleting = await db
		.prepare(
			`SELECT m.id FROM meetings m
			JOIN event_outbox o ON o.meeting_id = m.id AND o.kind = 'delete_meeting' AND o.generation = m.processing_generation
			WHERE m.status = 'deleting' AND (o.status = 'dead' OR (o.status = 'delivered' AND m.updated_at <= ?))
			LIMIT ?`,
		)
		.bind(now - DELETE_RETRY_MS, SWEEP_LIMIT)
		.all<{ id: string }>();
	for (const row of stuckDeleting.results) {
		const meeting = await council_get_meeting(db, row.id);
		if (!meeting) {
			continue;
		}
		await council_request_meeting_delete(env, meeting, now);
	}

	// Tombstones past their eight-day window reach true zero: the meeting row and its cascaded
	// participants, tracks, and artifacts disappear, and so do its webhook event rows.
	const expiredTombstones = await db
		.prepare("SELECT id FROM meetings WHERE status = 'deleted_tombstone' AND tombstone_expires_at <= ? LIMIT ?")
		.bind(now, SWEEP_LIMIT)
		.all<{ id: string }>();
	for (const row of expiredTombstones.results) {
		await db.prepare("DELETE FROM webhook_events WHERE meeting_id = ?").bind(row.id).run();
		await db.prepare("DELETE FROM event_outbox WHERE meeting_id = ?").bind(row.id).run();
		await db.prepare("DELETE FROM projection_outbox WHERE meeting_id = ?").bind(row.id).run();
		await db.prepare("DELETE FROM meetings WHERE id = ?").bind(row.id).run();
	}
}
