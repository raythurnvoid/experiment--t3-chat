/**
 * The Plan 2 display-safe projection of a meeting. The current Council page still reads the
 * Worker, not this document. D1 stays authoritative, and nothing here is ever read back for a
 * service decision. Every change is a new monotonic revision in a durable outbox, delivered in
 * order through the receiver-enforced `write-versioned`/`delete-versioned` routes, so a crash
 * between the D1 commit and the delivery loses nothing and a replay applies nothing twice.
 */

import type { D1Database } from "./cf.ts";
import type { Env } from "./env.ts";
import type { council_ArtifactRow, council_MeetingRow } from "./db.ts";
import { council_get_meeting, council_get_service_grant } from "./db.ts";
import { council_decrypt } from "./crypto.ts";
import { council_convex_data_delete_versioned, council_convex_data_write_versioned } from "./convex-api.ts";
import { Result } from "./result.ts";

export const council_PROJECTION_COLLECTION = "meetings";

/**
 * The bounded member-visible document. No code, no ticket, no email, no token, no provider URL —
 * the page needs none of them, and the store must never hold an admission secret.
 *
 * It carries no `failure_reason` either. That column holds the message the pipeline threw, which is
 * written for an operator: it names internal Convex routes, HTTP statuses and upload target keys.
 * Nothing is lost by leaving it out. The pipeline drops the failure category before it stores the
 * text, so the column carries no failure code, and a member-facing sentence can only be chosen by
 * `status` — which is in this document. The column stays in D1, where an operator reads it by
 * meeting id and `store_summary_markdown` reads it back for its own retry decision.
 */
export function council_projection_value(
	meeting: council_MeetingRow,
	artifacts: Pick<council_ArtifactRow, "kind" | "node_id" | "file_name" | "status">[],
) {
	return {
		meetingId: meeting.id,
		title: meeting.title,
		status: meeting.status,
		createdBy: meeting.created_by_user_id,
		createdAt: meeting.created_at,
		openedAt: meeting.opened_at,
		closedAt: meeting.closed_at,
		deadlineAt: meeting.deadline_at,
		participantCount: meeting.participant_count,
		artifacts: artifacts
			.filter((artifact) => artifact.status === "finalized" && artifact.node_id !== null)
			.map((artifact) => ({ kind: artifact.kind, fileNodeId: artifact.node_id, fileName: artifact.file_name })),
	};
}

/**
 * Record the next projection revision durably, in the same D1 batch as nothing else — the caller
 * has already committed the state change this projects. Returns the new revision. Two concurrent
 * enqueues for one meeting write the same revision: the loser's batch throws on the UNIQUE
 * (meeting_id, revision) index. Every current caller re-reads the meeting after its own state
 * change, so a lost enqueue is either a duplicate of the winner's row or is re-projected by the
 * loser's retry or the meeting's next state change.
 */
export async function council_enqueue_projection(
	db: D1Database,
	args: {
		meeting: council_MeetingRow;
		operation: "write" | "delete";
		payload: unknown;
		now: number;
	},
) {
	const revision = args.meeting.projection_revision + 1;
	await db.batch([
		db
			.prepare("UPDATE meetings SET projection_revision = ? WHERE id = ? AND projection_revision = ?")
			.bind(revision, args.meeting.id, args.meeting.projection_revision),
		db
			.prepare(
				`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				args.meeting.id,
				revision,
				args.operation,
				args.operation === "write" ? JSON.stringify(args.payload) : "",
				args.now,
				args.now,
			),
	]);
	return revision;
}

type ProjectionOutboxRow = {
	id: string;
	meeting_id: string;
	revision: number;
	operation: "write" | "delete";
	payload: string;
	status: "pending" | "delivered" | "superseded";
	attempts: number;
};

/**
 * Deliver every pending revision for one meeting, in revision order, stopping at the first
 * failure so order is never violated. A revision the receiver reports as already applied (conflict)
 * is marked delivered — the receiver's idempotency is the truth. Called inline after a state
 * change and again by the scheduled reconciliation.
 */
export async function council_deliver_projections(env: Env, meetingId: string, now: number) {
	const db = env.COUNCIL_DB;
	const meeting = await council_get_meeting(db, meetingId);
	if (!meeting) {
		return Result({ _yay: { delivered: 0 } });
	}
	const grantId = meeting.processing_grant_id ?? meeting.service_grant_id;
	if (!grantId) {
		return Result<never>({ _nay: { name: "no_grant", message: "Meeting has no grant to deliver projections with" } });
	}
	const grant = await council_get_service_grant(db, grantId);
	if (!grant) {
		return Result<never>({ _nay: { name: "no_grant", message: "Meeting grant row is missing" } });
	}
	// A rotated COUNCIL_ROOM_COOKIE_SECRET or a corrupted grant row makes the stored token
	// undecryptable. Answer with a deferral instead of throwing, so one sick grant cannot abort a
	// caller that sweeps many meetings.
	let psgToken: string;
	try {
		psgToken = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);
	} catch {
		return Result<never>({ _nay: { name: "bad_grant", message: "Meeting grant token cannot be decrypted" } });
	}

	const pending = await db
		.prepare("SELECT * FROM projection_outbox WHERE meeting_id = ? AND status = 'pending' ORDER BY revision ASC")
		.bind(meetingId)
		.all<ProjectionOutboxRow>();

	let delivered = 0;
	for (const row of pending.results) {
		const sent =
			row.operation === "write"
				? await council_convex_data_write_versioned(env, psgToken, {
						collection: council_PROJECTION_COLLECTION,
						key: meeting.id,
						revision: row.revision,
						value: JSON.parse(row.payload) as unknown,
					})
				: await council_convex_data_delete_versioned(env, psgToken, {
						collection: council_PROJECTION_COLLECTION,
						key: meeting.id,
						revision: row.revision,
					});

		if (sent._nay && sent._nay.name !== "conflict") {
			// Leave the row pending for the scheduled retry. Order matters, so nothing after it goes out.
			await db
				.prepare("UPDATE projection_outbox SET attempts = attempts + 1, updated_at = ? WHERE id = ?")
				.bind(now, row.id)
				.run();
			return Result<never>({ _nay: sent._nay });
		}

		await db
			.prepare("UPDATE projection_outbox SET status = 'delivered', updated_at = ? WHERE id = ?")
			.bind(now, row.id)
			.run();
		delivered += 1;
	}

	return Result({ _yay: { delivered } });
}

/** Enqueue-and-attempt in one call, for route handlers that just changed a meeting's state. */
export async function council_project_meeting(env: Env, meetingId: string, now: number) {
	const db = env.COUNCIL_DB;
	const meeting = await council_get_meeting(db, meetingId);
	if (!meeting) {
		return;
	}
	const artifacts = await db
		.prepare("SELECT * FROM meeting_artifacts WHERE meeting_id = ?")
		.bind(meetingId)
		.all<council_ArtifactRow>();
	await council_enqueue_projection(db, {
		meeting,
		operation: "write",
		payload: council_projection_value(meeting, artifacts.results),
		now,
	});
	// Delivery is best effort here; the scheduled reconciliation owns the retry. A failure must not
	// fail the user-facing route whose state change is already durable.
	const deliveredResult = await council_deliver_projections(env, meetingId, now);
	if (deliveredResult._nay) {
		console.warn("Projection delivery deferred to reconciliation", {
			meetingId,
			reason: deliveredResult._nay.message,
		});
	}
}
