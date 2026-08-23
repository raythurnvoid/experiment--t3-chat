/**
 * Provider webhook intake: `POST /webhooks/realtimekit`.
 *
 * The contract, in order: verify the RSA-SHA256 `rtk-signature` over the EXACT raw body bytes
 * before parsing anything; dedupe on (webhook configuration id, body SHA-256) because the
 * provider changes the delivery UUID on retry; store the verified event and the Queue-outbox
 * state in ONE D1 transaction; enqueue only after that commit. The 200 answer means "durably
 * stored", never "processed".
 *
 * Nobody is authenticated until that signature check passes, so the body is read under a byte cap
 * instead of being buffered whole.
 */

import type { Env } from "./env.ts";
import { council_sha256_hex, council_verify_rsa_signature } from "./crypto.ts";
import { council_json, council_read_stream_with_limit } from "./http.ts";
import { council_outbox_insert_statement, council_dispatch_outbox } from "./outbox.ts";

/**
 * The most body this route will hold. A provider event is a small JSON object, so this is the same
 * 64 KiB ceiling `council_read_json_body` puts on the service's other JSON commands.
 */
const WEBHOOK_MAX_BYTES = 64 * 1024;

/** How the provider names things inside event bodies, kept tolerant: shapes are M0-informed but
 * webhook bodies were never captured live, so every path is optional and misses degrade to an
 * event stored without a meeting. */
function extract_event_facts(body: unknown) {
	const record = (value: unknown) =>
		typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
	const root = record(body);
	const meeting = record(root?.meeting);
	const recording = record(root?.recording);
	const session = record(root?.session);

	const eventType = typeof root?.event === "string" ? root.event : "unknown";
	const providerMeetingId =
		[meeting?.id, root?.meeting_id, recording?.meeting_id, session?.associated_id].find(
			(value): value is string => typeof value === "string" && value.length > 0,
		) ?? null;
	return { eventType, providerMeetingId };
}

export async function council_handle_webhook(request: Request, env: Env, now: number): Promise<Response> {
	if (request.method !== "POST") {
		return council_json(405, { message: "Method not allowed" });
	}

	const signature = request.headers.get("rtk-signature");
	const webhookId = request.headers.get("rtk-webhook-id");
	if (!signature || !webhookId) {
		return council_json(401, { message: "Unauthorized" });
	}
	// No configured key refuses everything, fail closed: a deploy that forgot the key must never
	// run an unverified intake. 503 so the provider retries once the key is set.
	if (!env.REALTIMEKIT_WEBHOOK_PUBLIC_KEY) {
		return council_json(503, { message: "Webhook verification is not configured" });
	}

	// The signature covers the EXACT raw bytes. Nothing is parsed before this check passes.
	//
	// Read those bytes through a cap rather than with `request.arrayBuffer()`. This is the only route
	// in the Worker with no caller identity, and everything above it only proves two headers are
	// present, so any anonymous caller reaches this line. `arrayBuffer()` pulls the whole body into
	// the isolate first, and Cloudflare accepts bodies far larger than an isolate has memory for, so
	// the read itself is the door. `council_read_stream_with_limit` drops the reader the moment the
	// cap is passed, which keeps the raw bytes exact for the check below and refuses the rest.
	let bodyBytes = new Uint8Array(0);
	if (request.body) {
		const read = await council_read_stream_with_limit(request.body, WEBHOOK_MAX_BYTES);
		if (read._nay) {
			return council_json(413, { message: "Request body is too large" });
		}
		bodyBytes = read._yay;
	}

	const verified = await council_verify_rsa_signature({
		publicKeyPem: env.REALTIMEKIT_WEBHOOK_PUBLIC_KEY,
		signatureBase64: signature,
		bodyBytes,
	});
	if (!verified) {
		return council_json(401, { message: "Unauthorized" });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
	} catch {
		return council_json(400, { message: "Body is not valid JSON" });
	}
	const facts = extract_event_facts(parsed);
	const bodySha256 = await council_sha256_hex(new TextDecoder().decode(bodyBytes));

	const db = env.COUNCIL_DB;
	// The provider retries under a fresh delivery UUID; the body hash plus configuration id is the
	// identity of the event. An existing row answers 200 without any new work.
	const existing = await db
		.prepare("SELECT id FROM webhook_events WHERE webhook_id = ? AND body_sha256 = ?")
		.bind(webhookId, bodySha256)
		.first<{ id: string }>();
	if (existing) {
		return council_json(200, { received: true });
	}

	// Map the event onto a server-created meeting. A signature-valid event for a meeting this
	// service never created — or one already tombstoned — is recorded and refused, so a late
	// webhook cannot revive deleted state.
	const meeting = facts.providerMeetingId
		? await db
				.prepare("SELECT * FROM meetings WHERE provider_meeting_id = ?")
				.bind(facts.providerMeetingId)
				.first<{ id: string; status: string; provider_recording_id: string | null; processing_generation: number }>()
		: null;
	const actionable =
		meeting !== null &&
		meeting.status === "processing" &&
		meeting.provider_recording_id !== null;

	const statements = [
		db
			.prepare(
				`INSERT INTO webhook_events (id, webhook_id, body_sha256, event_type, meeting_id, received_at, handled_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				webhookId,
				bodySha256,
				facts.eventType,
				meeting?.id ?? null,
				now,
				actionable ? null : now,
			),
	];
	if (actionable) {
		statements.push(
			council_outbox_insert_statement(db, {
				meetingId: meeting.id,
				kind: "process_meeting",
				generation: meeting.processing_generation,
				now,
			}),
		);
	}

	try {
		await db.batch(statements);
	} catch (error) {
		// A failed commit means one of two very different things, and only one of them may answer 200.
		// A concurrent delivery of the SAME event can commit between the check above and this batch,
		// and the unique index then refuses this one — the event is stored, so 200 is right. Every
		// other failure (a D1 outage, a constraint broken by a genuinely new event) stored nothing,
		// and a 200 would tell the provider the event is durable and stop its retries, which loses a
		// recording-finished event in silence. So re-read the dedupe row and rethrow when it is not
		// there, and the request fails with a 5xx the provider retries.
		const stored = await db
			.prepare("SELECT id FROM webhook_events WHERE webhook_id = ? AND body_sha256 = ?")
			.bind(webhookId, bodySha256)
			.first<{ id: string }>();
		if (!stored) {
			throw error;
		}
		return council_json(200, { received: true });
	}

	// The Queue send happens only after the commit above; a lost send leaves a pending row the
	// scheduled reconciliation re-drives.
	if (actionable) {
		await council_dispatch_outbox(env, { meetingId: meeting.id, kind: "process_meeting", now });
	}
	return council_json(200, { received: true });
}
