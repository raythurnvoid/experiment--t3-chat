import { describe, expect, test } from "vitest";

import worker from "./index.ts";
import type { Env } from "./env.ts";
import { make_test_env, seed_grant, seed_meeting } from "../test/env.ts";
import { make_test_rsa } from "../test/rsa.ts";
import { council_sha256_hex } from "./crypto.ts";

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

		const event = await env.COUNCIL_DB.prepare("SELECT event_type, meeting_id, handled_at FROM webhook_events").first<{
			event_type: string;
			meeting_id: string;
			handled_at: number | null;
		}>();
		// `handled_at` stays null while the queued run is still outstanding. The column records
		// whether an event still owes a run, so an event that just created work may not be filed
		// as done.
		expect(event).toEqual({ event_type: "recording.statusUpdate", meeting_id: "meeting-1", handled_at: null });
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

	test("a wrong method is refused as one, not as an unauthorized delivery", async () => {
		const { env, rsa } = await signed_env();

		// Everything else about this delivery is right: the key is configured, and the signature
		// covers the body a GET carries, which is no bytes at all. So the method is the only thing
		// left to refuse, and 405 is the only answer that says so.
		const response = await worker.fetch(
			new Request(WEBHOOK_URL, {
				method: "GET",
				headers: {
					"rtk-signature": await rsa.sign(new TextEncoder().encode("")),
					"rtk-webhook-id": "wh-1",
				},
			}),
			env,
		);

		expect(response.status).toBe(405);
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

	test("a body past the cap is refused without being read to the end", async () => {
		const { env, rsa } = await signed_env();

		// Far more than an isolate can hold, offered a chunk at a time. `pulled` counts what the route
		// actually took, which is the difference between refusing the body and buffering it first.
		const chunkBytes = 16 * 1024;
		const offeredChunks = 1024;
		let pulled = 0;
		const body = new ReadableStream({
			pull(controller) {
				if (pulled >= offeredChunks) {
					controller.close();
					return;
				}
				pulled += 1;
				controller.enqueue(new Uint8Array(chunkBytes));
			},
		});

		// Both headers are present and a key is configured, so every short-circuit above the read lets
		// this through: this is what an anonymous caller can reach with two junk header values.
		// `duplex` is what Node's fetch requires to send a stream as a request body.
		const init = {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"rtk-signature": await rsa.sign(new TextEncoder().encode("{}")),
				"rtk-webhook-id": "wh-1",
			},
			body,
			duplex: "half",
		};
		const response = await worker.fetch(new Request(WEBHOOK_URL, init), env);

		// Assert the read before the answer, because the read is the gap. The route stopped near the
		// 64 KiB cap instead of draining the 16 MB on offer. The bound is four times the cap, because
		// the reader takes the chunk that passes it and Node reads a little ahead, and it is still 64
		// times less than the body offered. A route that buffers first lands on this line at 16 MB.
		expect(pulled * chunkBytes).toBeLessThan(256 * 1024);
		expect(response.status).toBe(413);

		const events = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<{ n: number }>();
		expect(events?.n).toBe(0);
	});

	test("the event lands on the meeting whose provider id it names, not on whichever meeting is first", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		// Two meetings, both ready for work, so a lookup that ignores the provider id has a wrong row
		// to land on. The event names the one seeded second, and the two carry different generations.
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });
		await seed_meeting(env, {
			id: "meeting-2",
			code: "b".repeat(64),
			providerMeetingId: "pm-2",
			status: "processing",
			providerRecordingId: "rec-2",
			processingGeneration: 7,
		});

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-2" } });
		const response = await worker.fetch(
			webhook_request(body, {
				"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
				"rtk-webhook-id": "wh-1",
			}),
			env,
		);
		expect(response.status).toBe(200);

		const event = await env.COUNCIL_DB.prepare("SELECT meeting_id FROM webhook_events").first<{
			meeting_id: string | null;
		}>();
		expect(event?.meeting_id).toBe("meeting-2");
		// The queued work carries the named meeting's own generation, so it cannot start a run for
		// the other meeting or under a generation that meeting never reached.
		const outbox = await env.COUNCIL_DB.prepare("SELECT meeting_id, generation FROM event_outbox").first<{
			meeting_id: string;
			generation: number;
		}>();
		expect(outbox).toEqual({ meeting_id: "meeting-2", generation: 7 });
		expect(queueSent.length).toBe(1);
	});

	test("a verified event for an unknown meeting is recorded but creates no work", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		// Seed a meeting this event does NOT name. With an empty meetings table every lookup comes
		// back empty, so the test could not tell a lookup keyed on the provider id from one that
		// takes whatever row happens to be there.
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });

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

	test("a meeting whose recording id has not landed yet creates no work", async () => {
		const { env, rsa, queueSent } = await signed_env();
		await seed_grant(env);
		// Still processing, but the provider has not named a recording yet. There is nothing to
		// fetch, so this event carries no work however valid the delivery is.
		await seed_meeting(env, { status: "processing", providerRecordingId: null, processingGeneration: 1 });

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
		// The event is still recorded against its meeting, and closed out, because no run is owed.
		const event = await env.COUNCIL_DB.prepare("SELECT meeting_id, handled_at FROM webhook_events").first<{
			meeting_id: string | null;
			handled_at: number | null;
		}>();
		expect(event?.meeting_id).toBe("meeting-1");
		expect(event?.handled_at).not.toBeNull();
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
		const request = webhook_request(body, {
			"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
			"rtk-webhook-id": "wh-1",
		});

		// Nothing was stored, so the delivery must not be acked. The Worker runtime turns an
		// uncaught throw into a 5xx, which is what makes the provider deliver this event again;
		// answering 200 here would drop a recording-finished event for good.
		await expect(worker.fetch(request, env)).rejects.toThrow("commit lost");

		const events = await realDb.prepare("SELECT COUNT(*) AS n FROM webhook_events").first<{ n: number }>();
		expect(events?.n).toBe(0);
		const outbox = await realDb.prepare("SELECT COUNT(*) AS n FROM event_outbox").first<{ n: number }>();
		expect(outbox?.n).toBe(0);
		expect(queueSent.length).toBe(0);
	});

	test("a duplicate that another delivery committed first is still acked once", async () => {
		const { env, rsa } = await signed_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1", processingGeneration: 1 });

		const body = JSON.stringify({ event: "recording.statusUpdate", meeting: { id: "pm-1" } });
		const bodySha256 = await council_sha256_hex(body);
		const realDb = env.COUNCIL_DB;
		let raced = false;
		env.COUNCIL_DB = {
			...realDb,
			batch: async (statements) => {
				// The other delivery of the same event commits in the gap between the dedupe read and
				// this batch, so the unique index refuses ours. This is the one failure that may answer
				// 200: the event really is stored.
				if (!raced) {
					raced = true;
					await realDb
						.prepare(
							`INSERT INTO webhook_events (id, webhook_id, body_sha256, event_type, meeting_id, received_at, handled_at)
							VALUES ('other-delivery', 'wh-1', ?, 'recording.statusUpdate', 'meeting-1', 0, NULL)`,
						)
						.bind(bodySha256)
						.run();
				}
				return await realDb.batch(statements);
			},
		};

		const response = await worker.fetch(
			webhook_request(body, {
				"rtk-signature": await rsa.sign(new TextEncoder().encode(body)),
				"rtk-webhook-id": "wh-1",
			}),
			env,
		);
		expect(response.status).toBe(200);

		const events = await realDb.prepare("SELECT id FROM webhook_events").all<{ id: string }>();
		expect(events.results.map((row) => row.id)).toEqual(["other-delivery"]);
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
