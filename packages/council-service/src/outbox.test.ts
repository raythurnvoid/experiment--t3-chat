import { describe, expect, test } from "vitest";

import { council_dispatch_outbox, type council_EventOutboxRow } from "./outbox.ts";
import { make_test_env } from "../test/env.ts";
import type { Env } from "./env.ts";

const NOW = 100_000_000_000;

async function seed_outbox(
	env: Env,
	args: {
		id: string;
		generation: number;
		status?: council_EventOutboxRow["status"];
		kind?: council_EventOutboxRow["kind"];
		meetingId?: string;
	},
) {
	await env.COUNCIL_DB.prepare(
		`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 0, 0, 0)`,
	)
		.bind(
			args.id,
			args.meetingId ?? "meeting-1",
			args.kind ?? "process_meeting",
			args.generation,
			args.status ?? "pending",
		)
		.run();
}

describe("council_dispatch_outbox", () => {
	test("sends the newest generation when an older one is still undispatched", async () => {
		const { env, queueSent } = make_test_env();
		// A redrive bumps the generation and inserts a new row while the previous generation's row can
		// still be sitting there with a lost send. Oldest-first would dispatch that superseded row and
		// leave the work the redrive actually asked for waiting for the fifteen-minute cron.
		await seed_outbox(env, { id: "o-g1", generation: 1 });
		await seed_outbox(env, { id: "o-g2", generation: 2 });

		await council_dispatch_outbox(env, { meetingId: "meeting-1", kind: "process_meeting", now: NOW });

		expect(queueSent).toEqual([{ outboxId: "o-g2" }]);
		const rows = await env.COUNCIL_DB.prepare("SELECT id, status FROM event_outbox ORDER BY id").all<{
			id: string;
			status: string;
		}>();
		expect(rows.results).toEqual([
			{ id: "o-g1", status: "pending" },
			{ id: "o-g2", status: "handoff_pending" },
		]);
	});

	test("leaves a row the consumer delivered while the send was in flight alone", async () => {
		const queueSent: { outboxId: string }[] = [];
		const { env } = make_test_env();
		// The Queue can hand the message to the consumer before `send` even returns here. The consumer
		// then records `delivered` on the row. Writing `handoff_pending` over that would flap a
		// finished row backwards, and the stale-handoff sweep would re-drive work that is already done.
		env.COUNCIL_EVENTS = {
			send: async (body) => {
				queueSent.push(body);
				await env.COUNCIL_DB.prepare(
					"UPDATE event_outbox SET status = 'delivered', workflow_instance_id = 'council-process_meeting-meeting-1-g1' WHERE id = ?",
				)
					.bind(body.outboxId)
					.run();
			},
		};
		await seed_outbox(env, { id: "o-1", generation: 1 });

		await council_dispatch_outbox(env, { meetingId: "meeting-1", kind: "process_meeting", now: NOW });

		expect(queueSent).toEqual([{ outboxId: "o-1" }]);
		const row = await env.COUNCIL_DB.prepare("SELECT status FROM event_outbox WHERE id = 'o-1'").first<{
			status: string;
		}>();
		expect(row?.status).toBe("delivered");
	});
});
