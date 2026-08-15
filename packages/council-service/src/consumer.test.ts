import { describe, expect, test } from "vitest";

import { council_consume_batch, council_handle_queue_message, council_DLQ_NAME } from "./consumer.ts";
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
