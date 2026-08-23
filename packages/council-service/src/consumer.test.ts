import { describe, expect, test } from "vitest";

import {
	council_consume_batch,
	council_handle_dlq_message,
	council_handle_queue_message,
	council_DLQ_NAME,
} from "./consumer.ts";
import { council_dispatch_outbox, council_outbox_insert_statement } from "./outbox.ts";
import type { QueueMessage } from "./cf.ts";
import { make_test_env, seed_grant, seed_meeting } from "../test/env.ts";

async function seed_outbox(
	env: ReturnType<typeof make_test_env>["env"],
	args?: Partial<{ id: string; kind: string; generation: number; status: string }>,
) {
	const id = args?.id ?? "outbox-1";
	await env.COUNCIL_DB.prepare(
		`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
		VALUES (?, 'meeting-1', ?, ?, ?, 0, 0, 0)`,
	)
		.bind(id, args?.kind ?? "process_meeting", args?.generation ?? 1, args?.status ?? "handoff_pending")
		.run();
	return id;
}

function make_message(outboxId: string, attempts = 0): QueueMessage<unknown> & { acked: boolean; retried: boolean } {
	const message = {
		id: "msg-1",
		attempts,
		body: { outboxId },
		acked: false,
		retried: false,
		ack: () => {
			message.acked = true;
		},
		retry: () => {
			message.retried = true;
		},
	};
	return message;
}

describe("council_handle_queue_message", () => {
	test("creates the deterministic instance, persists the association, then acks", async () => {
		const { env, workflow } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const outboxId = await seed_outbox(env);

		const verdict = await council_handle_queue_message(make_message(outboxId), env, 999);
		expect(verdict.type).toBe("ack");

		expect([...workflow.instances.keys()]).toEqual(["council-process_meeting-meeting-1-g1"]);
		const row = await env.COUNCIL_DB.prepare("SELECT status, workflow_instance_id FROM event_outbox WHERE id = ?")
			.bind(outboxId)
			.first<{ status: string; workflow_instance_id: string }>();
		expect(row).toEqual({ status: "delivered", workflow_instance_id: "council-process_meeting-meeting-1-g1" });
		const meeting = await env.COUNCIL_DB.prepare("SELECT processing_workflow_id FROM meetings WHERE id = 'meeting-1'").first<{
			processing_workflow_id: string;
		}>();
		expect(meeting?.processing_workflow_id).toBe("council-process_meeting-meeting-1-g1");
	});

	test("a failed handoff retries and records nothing as delivered", async () => {
		const { env, workflow } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const outboxId = await seed_outbox(env);
		workflow.failCreate = true;

		const verdict = await council_handle_queue_message(make_message(outboxId), env, 999);
		expect(verdict.type).toBe("retry");

		const row = await env.COUNCIL_DB.prepare("SELECT status FROM event_outbox WHERE id = ?")
			.bind(outboxId)
			.first<{ status: string }>();
		expect(row?.status).toBe("handoff_pending");
	});

	test("a duplicate delivery finds the existing instance instead of starting a second one", async () => {
		const { env, workflow } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const outboxId = await seed_outbox(env);

		expect((await council_handle_queue_message(make_message(outboxId), env, 999)).type).toBe("ack");
		expect((await council_handle_queue_message(make_message(outboxId, 1), env, 999)).type).toBe("ack");
		expect(workflow.instances.size).toBe(1);
	});

	test("a delivered or missing outbox row acks without touching the workflow service", async () => {
		const { env, workflow } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const deliveredId = await seed_outbox(env, { id: "outbox-done", status: "delivered" });

		expect((await council_handle_queue_message(make_message(deliveredId), env, 999)).type).toBe("ack");
		expect((await council_handle_queue_message(make_message("outbox-missing"), env, 999)).type).toBe("ack");
		expect(workflow.instances.size).toBe(0);
	});
});

describe("council_consume_batch", () => {
	test("a DLQ message marks the outbox row dead for operator redrive", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const outboxId = await seed_outbox(env);

		const message = make_message(outboxId, 5);
		await council_consume_batch({ queue: council_DLQ_NAME, messages: [message] }, env, 999);
		expect(message.acked).toBe(true);

		const row = await env.COUNCIL_DB.prepare("SELECT status FROM event_outbox WHERE id = ?")
			.bind(outboxId)
			.first<{ status: string }>();
		expect(row?.status).toBe("dead");
	});

	test("main-queue messages ack on success and retry on handoff failure", async () => {
		const { env, workflow } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const outboxId = await seed_outbox(env);

		workflow.failCreate = true;
		const failing = make_message(outboxId);
		await council_consume_batch({ queue: "bonobo-council-events", messages: [failing] }, env, 999);
		expect(failing.retried).toBe(true);
		expect(failing.acked).toBe(false);

		workflow.failCreate = false;
		const succeeding = make_message(outboxId, 1);
		await council_consume_batch({ queue: "bonobo-council-events", messages: [succeeding] }, env, 999);
		expect(succeeding.acked).toBe(true);
	});
});

describe("council_outbox_insert_statement", () => {
	test("one (meeting, kind, generation) stays one work item however many events ask for it", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const args = { meetingId: "meeting-1", kind: "process_meeting" as const, generation: 1, now: 100 };

		await council_outbox_insert_statement(env.COUNCIL_DB, args).run();
		const first = await env.COUNCIL_DB.prepare("SELECT id FROM event_outbox").first<{ id: string }>();
		// The dispatcher has already sent this row's pointer and the consumer may already be starting
		// its Workflow. That is the state the second insert below must not touch.
		await env.COUNCIL_DB.prepare("UPDATE event_outbox SET status = 'handoff_pending', attempts = 1 WHERE id = ?")
			.bind(first?.id)
			.run();

		// The provider redelivers the same webhook, so the same statement runs a second time.
		await council_outbox_insert_statement(env.COUNCIL_DB, { ...args, now: 200 }).run();

		// A second insert that replaced the row instead of ignoring it would hand back a fresh id with
		// `pending` and zero attempts, and the next dispatch would re-send a generation whose Workflow
		// is already running.
		const rows = await env.COUNCIL_DB.prepare("SELECT id, status, attempts FROM event_outbox").all<{
			id: string;
			status: string;
			attempts: number;
		}>();
		expect(rows.results).toEqual([{ id: first?.id, status: "handoff_pending", attempts: 1 }]);
	});
});

describe("a delivered outbox row is terminal", () => {
	test("neither a re-dispatch nor a DLQ message reopens it", async () => {
		const { env, queueSent } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		const outboxId = await seed_outbox(env, { status: "delivered" });

		// Both calls reach a delivered row on a normal day. The scheduled pass re-dispatches rows it
		// believes are still waiting, and a message whose retries ran out lands in the DLQ after the
		// consumer's own handoff already succeeded.
		await council_dispatch_outbox(env, { meetingId: "meeting-1", kind: "process_meeting", now: 999 });
		await council_handle_dlq_message(make_message(outboxId, 5), env, 999);

		const row = await env.COUNCIL_DB.prepare("SELECT status FROM event_outbox WHERE id = ?")
			.bind(outboxId)
			.first<{ status: string }>();
		expect(row?.status).toBe("delivered");
		expect(queueSent).toEqual([]);
	});
});
