import { describe, expect, test } from "vitest";

import worker from "./index.ts";
import type { Env } from "./env.ts";
import { make_test_env, seed_grant, seed_meeting } from "../test/env.ts";
import { make_test_rsa } from "../test/rsa.ts";

const WEBHOOK_URL = "https://council.example/webhooks/realtimekit";

function webhook_request(bodyText: string, headers: Record<string, string>) {
	return new Request(WEBHOOK_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: bodyText,
	});
}

async function signed_env(overrides?: Partial<Env>) {
	const rsa = await make_test_rsa();
	const made = make_test_env({ REALTIMEKIT_WEBHOOK_PUBLIC_KEY: rsa.publicKeyPem, ...overrides });
	return { ...made, rsa };
}

describe("council_handle_webhook", () => {
	test("a verified event is stored with its outbox row and handed to the queue", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-1" } });
		const response = await worker.fetch(
			webhook_request(body, {
				"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
				"rtk-webhook-id": "wh-1",
				"rtk-uuid": "delivery-1",
			}),
			env,
		);
		expect(response.status).toBe(200);

		const event = await env.COUNCIL_DB.prepare("SELECT event_type, meeting_id FROM webhook_events").first<{
			event_type: string;
			meeting_id: string;
		}>();
		expect(event).toEqual({ event_type: "recording.statusUpdate", meeting_id: "meeting-1" });
		const outbox = await env.COUNCIL_DB.prepare("SELECT kind, generation, status FROM event_outbox").first<{
			kind: string;
			generation: number;
			status: string;
		}>();
		expect(outbox).toEqual({ kind: "process_meeting", generation: 1, status: "handoff_pending" });
		expect(queueSent.length).toBe(1);
	});

	test("a provider retry under a new delivery UUID is the same event: one row, one outbox entry", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-1" } });
		const signature = await rsa.sign(new TextEncoder().encode(body));
		for (const delivery of ["delivery-1", "delivery-2"]) {
			const response = await worker.fetch(
				webhook_request(body, { "rtk-signature": signature, "rtk-webhook-id": "wh-1", "rtk-uuid": delivery }),
				env,
			);
			expect(response.status).toBe(200);
		}

		const events = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<{ n: number }>();
		expect(events?.n).toBe(1);
		const outbox = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM event_outbox").first<{ n: number }>();
		expect(outbox?.n).toBe(1);
		expect(queueSent.length).toBe(1);
	});

	test("missing headers or a missing configured key refuse before anything is read", async () => {
		const { env, rsa } = await signed_env();
		const body = JSON.stringify({ event: "x" });
		const signature = await rsa.sign(new TextEncoder().encode(body));

		const noSignature = await worker.fetch(webhook_request(body, { "rtk-webhook-id": "wh-1" }), env);
		expect(noSignature.status).toBe(401);
		const noWebhookId = await worker.fetch(webhook_request(body, { "rtk-signature": signature }), env);
		expect(noWebhookId.status).toBe(401);

		// No key configured fails closed with a retryable status, never an unverified run.
		const { env: keylessEnv } = make_test_env();
		const noKey = await worker.fetch(
			webhook_request(body, { "rtk-signature": signature, "rtk-webhook-id": "wh-1" }),
			keylessEnv,
		);
		expect(noKey.status).toBe(503);
	});

	test("a verified event for an unknown meeting is recorded but creates no work", async () => {
		const { env, rsa, queueSent } = await signed_env();

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-unknown" } });
		const response = await worker.fetch(
			webhook_request(body, {
				"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
				"rtk-webhook-id": "wh-1",
			}),
			env,
		);
		expect(response.status).toBe(200);

		const event = await env.COUNCIL_DB.prepare("SELECT meeting_id, handled_at FROM webhook_events").first<{
			meeting_id: string | null;
			handled_at: number | null;
		}>();
		expect(event?.meeting_id).toBeNull();
		expect(event?.handled_at).not.toBeNull();
		const outbox = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM event_outbox").first<{ n: number }>();
		expect(outbox?.n).toBe(0);
		expect(queueSent.length).toBe(0);
	});

	test("a late webhook for a tombstoned meeting cannot revive it", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "deleted_tombstone", providerRecordingId: "rec-1", processingGeneration: 1 });

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-1" } });
		const response = await worker.fetch(
			webhook_request(body, {
				"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
				"rtk-webhook-id": "wh-1",
			}),
			env,
		);
		expect(response.status).toBe(200);

		const outbox = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM event_outbox").first<{ n: number }>();
		expect(outbox?.n).toBe(0);
		expect(queueSent.length).toBe(0);
	});

	test("the event row only ever lands through the atomic batch: a failed commit stores nothing", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });

		const realDb = env.COUNCIL_DB;
		env.COUNCIL_DB = {
			...realDb,
			batch: async () => {
				throw new Error("commit lost");
			},
		};

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-1" } });
		await worker.fetch(
			webhook_request(body, {
				"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
				"rtk-webhook-id": "wh-1",
			}),
			env,
		);

		const events = await realDb.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<{ n: number }>();
		expect(events?.n).toBe(0);
		const outbox = await realDb.prepare("SELECT COUNT(*) AS n FROM event_outbox").first<{ n: number }>();
		expect(outbox?.n).toBe(0);
		expect(queueSent.length).toBe(0);
	});

	test("a lost queue send leaves the outbox row pending for the reconciliation", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });
		env.COUNCIL_EVENTS = {
			send: async () => {
				throw new Error("queue down");
			},
		};

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-1" } });
		const response = await worker.fetch(
			webhook_request(body, {
				"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
				"rtk-webhook-id": "wh-1",
			}),
			env,
		);
		// Still 200: the D1 commit is the durable ack, delivery is the dispatcher's problem.
		expect(response.status).toBe(200);

		const outbox = await env.COUNCIL_DB.prepare("SELECT status FROM event_outbox").first<{ status: string }>();
		expect(outbox?.status).toBe("pending");
		expect(queueSent.length).toBe(0);
	});
	test("a tampered body fails the signature and is refused", async () => {
		const rsa = await make_test_rsa();
		const { env } = make_test_env({ REALTIMEKIT_WEBHOOK_PUBLIC_KEY: rsa.publicKeyPem });
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });

		const original = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-1" } });
		const signature = await rsa.sign(new TextEncoder().encode(original));
		const tampered = original.replace("pm-1", "pm-9");

		const response = await worker.fetch(
			webhook_request(tampered, { "rtk-signature": signature, "rtk-webhook-id": "wh-1" }),
			env,
		);
		expect(response.status).toBe(401);

		// A refused delivery stores nothing: no event row and no outbox work.
		const events = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<{ n: number }>();
		expect(events?.n).toBe(0);
	});
});
