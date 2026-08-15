/**
 * The D1 event outbox between accepted work and the Queue. A row is written in the same
 * transaction as the state that requires the work, then a dispatcher sends a pointer message and
 * records `handoff_pending`. The row is terminal only after the Queue consumer has observed the
 * expected Workflow instance and recorded it, so a lost send, a lost ack, or a crashed consumer
 * all leave a row the scheduled reconciliation can see and re-drive.
 */

import type { D1Database } from "./cf.ts";
import type { Env } from "./env.ts";

export type council_EventOutboxRow = {
	id: string;
	meeting_id: string;
	kind: "process_meeting" | "delete_meeting";
	generation: number;
	status: "pending" | "handoff_pending" | "delivered" | "dead";
	attempts: number;
	workflow_instance_id: string | null;
	created_at: number;
	updated_at: number;
};

/**
 * The statement that records one work item. Returned unrun so the caller can put it in the same
 * atomic batch as the state change that requires the work. `INSERT OR IGNORE` because one
 * (meeting, kind, generation) is one work item however many events ask for it.
 */
export function council_outbox_insert_statement(
	db: D1Database,
	args: { meetingId: string; kind: council_EventOutboxRow["kind"]; generation: number; now: number },
) {
	return db
		.prepare(
			`INSERT OR IGNORE INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
		)
		.bind(crypto.randomUUID(), args.meetingId, args.kind, args.generation, args.now, args.now);
}

export async function council_get_outbox_row(db: D1Database, outboxId: string) {
	return await db.prepare("SELECT * FROM event_outbox WHERE id = ?").bind(outboxId).first<council_EventOutboxRow>();
}

/**
 * Send one outbox row's pointer to the Queue. Called after the commit that created the row, and
 * again by the scheduled reconciliation for rows whose send was lost. A failed send leaves the
 * row `pending`; only a successful send moves it to `handoff_pending`. Sending twice is safe —
 * the consumer's Workflow-id handoff is idempotent.
 */
export async function council_dispatch_outbox(env: Env, args: { meetingId: string; kind: string; now: number }) {
	const row = await env.COUNCIL_DB.prepare(
		"SELECT * FROM event_outbox WHERE meeting_id = ? AND kind = ? AND status IN ('pending', 'handoff_pending') ORDER BY generation DESC LIMIT 1",
	)
		.bind(args.meetingId, args.kind)
		.first<council_EventOutboxRow>();
	if (!row) {
		return;
	}

	try {
		await env.COUNCIL_EVENTS.send({ outboxId: row.id });
	} catch (error) {
		console.warn("Queue send failed; the outbox row stays pending for reconciliation", {
			outboxId: row.id,
			error: String(error),
		});
		return;
	}
	await env.COUNCIL_DB.prepare(
		"UPDATE event_outbox SET status = 'handoff_pending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
	)
		.bind(args.now, row.id)
		.run();
}
