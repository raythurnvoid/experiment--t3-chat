/**
 * The Queue consumer: one message per batch, and its only slow-event job is to start one
 * deterministically named Workflow and acknowledge after that durable handoff. Retries go through
 * the Queue's own budget into the DLQ; the D1 outbox row plus the scheduled scanner retain repair
 * ownership until the expected instance was observed.
 */

import type { Env, council_QueueMessageBody } from "./env.ts";
import type { MessageBatch, QueueMessage } from "./cf.ts";
import { council_get_outbox_row } from "./outbox.ts";

export const council_DLQ_NAME = "bonobo-council-events-dlq";

export type council_WorkflowParams = {
	kind: "process_meeting" | "delete_meeting";
	meetingId: string;
	generation: number;
};

export function council_workflow_instance_id(params: council_WorkflowParams) {
	// Deterministic: the same work generation always names the same instance, so a duplicate
	// delivery finds the running instance instead of starting a second one.
	return `council-${params.kind}-${params.meetingId}-g${params.generation}`;
}

export type council_ConsumeVerdict = { type: "ack"; reason: string } | { type: "retry"; reason: string };

export async function council_handle_queue_message(
	message: QueueMessage<unknown>,
	env: Env,
	now: number,
): Promise<council_ConsumeVerdict> {
	const body = message.body as Partial<council_QueueMessageBody> | null;
	if (typeof body?.outboxId !== "string") {
		return { type: "ack", reason: "Message is not a Council outbox pointer" };
	}

	const row = await council_get_outbox_row(env.COUNCIL_DB, body.outboxId);
	if (!row) {
		return { type: "ack", reason: "Outbox row is gone" };
	}
	if (row.status === "delivered" || row.status === "dead") {
		return { type: "ack", reason: `Outbox row is already ${row.status}` };
	}

	const params: council_WorkflowParams = { kind: row.kind, meetingId: row.meeting_id, generation: row.generation };
	const instanceId = council_workflow_instance_id(params);

	// `createBatch` on an id that already exists is the idempotent half; `get` afterwards is the
	// proof half. The association is persisted BEFORE the ack, so a crash between them re-delivers
	// the message and this whole block replays harmlessly.
	try {
		try {
			await env.COUNCIL_WORKFLOW.createBatch([{ id: instanceId, params }]);
		} catch (error) {
			// An existing instance makes createBatch throw on some runtimes; get() below decides.
			console.log("Workflow createBatch answered with an error; verifying via get", {
				instanceId,
				error: String(error),
			});
		}
		await env.COUNCIL_WORKFLOW.get(instanceId);
	} catch (error) {
		return { type: "retry", reason: `Workflow handoff failed: ${String(error)}` };
	}

	await env.COUNCIL_DB.prepare(
		"UPDATE event_outbox SET status = 'delivered', workflow_instance_id = ?, updated_at = ? WHERE id = ?",
	)
		.bind(instanceId, now, row.id)
		.run();
	if (row.kind === "process_meeting") {
		await env.COUNCIL_DB.prepare("UPDATE meetings SET processing_workflow_id = ?, updated_at = ? WHERE id = ?")
			.bind(instanceId, now, row.meeting_id)
			.run();
	}
	return { type: "ack", reason: "Workflow instance observed and recorded" };
}

/** Mark a message that fell into the DLQ so an operator sees it and the redrive path owns it. */
export async function council_handle_dlq_message(message: QueueMessage<unknown>, env: Env, now: number) {
	const body = message.body as Partial<council_QueueMessageBody> | null;
	if (typeof body?.outboxId !== "string") {
		return;
	}
	const row = await council_get_outbox_row(env.COUNCIL_DB, body.outboxId);
	await env.COUNCIL_DB.prepare(
		"UPDATE event_outbox SET status = 'dead', updated_at = ? WHERE id = ? AND status != 'delivered'",
	)
		.bind(now, body.outboxId)
		.run();
	console.error("Council event landed in the DLQ; cron redrives a dead processing or delete generation when the instance is gone", {
		outboxId: body.outboxId,
		meetingId: row?.meeting_id ?? null,
		attempts: message.attempts,
	});
}

export async function council_consume_batch(batch: MessageBatch<unknown>, env: Env, now: number) {
	for (const message of batch.messages) {
		if (batch.queue === council_DLQ_NAME) {
			await council_handle_dlq_message(message, env, now);
			message.ack();
			continue;
		}

		const verdict = await council_handle_queue_message(message, env, now);
		console.log("Processed Council event message", {
			messageId: message.id,
			attempts: message.attempts,
			verdict,
		});
		if (verdict.type === "retry") {
			// Exponential-ish backoff, capped: the Workflow service being briefly down should not
			// burn the whole retry budget in seconds.
			message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
			continue;
		}
		message.ack();
	}
}
