import { afterEach, describe, expect, test } from "vitest";

import { council_run_scheduled } from "./cleanup.ts";
import { council_project_meeting } from "./projection.ts";
import { council_UNOPENED_MEETING_TTL_MS } from "./routes-page.ts";
import {
	FUTURE,
	install_fetch,
	make_test_env,
	seed_grant,
	seed_meeting,
	seed_participant,
} from "../test/env.ts";

const NOW = 100_000_000_000;
const HOUR = 60 * 60 * 1000;

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

describe("council_run_scheduled expiry sweeps", () => {
	test("expired tickets, sessions, cached page tokens, old windows, and stale email HMACs go; live ones stay", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "created", createdAt: NOW - HOUR });

		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES ('t-old', 'meeting-1', 'user-1', 'grant-1', ?, 0), ('t-live', 'meeting-1', 'user-1', 'grant-1', ?, 0)",
		)
			.bind(NOW - 1, FUTURE)
			.run();
		await env.COUNCIL_DB.prepare(
			"INSERT INTO room_sessions (token_hash, meeting_id, participant_id, role, csrf_token_hash, expires_at, created_at) VALUES ('s-old', 'meeting-1', 'p1', 'guest', 'c1', ?, 0), ('s-live', 'meeting-1', 'p1', 'guest', 'c2', ?, 0)",
		)
			.bind(NOW - 1, FUTURE)
			.run();
		await env.COUNCIL_DB.prepare(
			"INSERT INTO page_token_cache (token_hash, organization_id, workspace_id, installation_id, actor_user_id, service_grant_id, expires_at, created_at) VALUES ('pt-old', 'org-1', 'ws-1', 'inst-1', 'user-1', 'grant-1', ?, 0), ('pt-live', 'org-1', 'ws-1', 'inst-1', 'user-1', 'grant-1', ?, 0)",
		)
			.bind(NOW - 1, FUTURE)
			.run();
		await env.COUNCIL_DB.prepare(
			"INSERT INTO rate_limit_windows (bucket_key, window_start, count) VALUES ('b-old', ?, 3), ('b-recent', ?, 3)",
		)
			.bind(NOW - 3 * HOUR, NOW - 10 * 60 * 1000)
			.run();

		// One join older than the two-hour retry window, one recent.
		const oldGuest = await seed_participant(env, { meetingId: "meeting-1", displayName: "Old" });
		const newGuest = await seed_participant(env, { meetingId: "meeting-1", displayName: "New" });
		await env.COUNCIL_DB.prepare("UPDATE meeting_participants SET email_hmac = 'h', created_at = ? WHERE id = ?")
			.bind(NOW - 3 * HOUR, oldGuest.id)
			.run();
		await env.COUNCIL_DB.prepare("UPDATE meeting_participants SET email_hmac = 'h', created_at = ? WHERE id = ?")
			.bind(NOW - 10 * 60 * 1000, newGuest.id)
			.run();

		// An expired grant no meeting references anymore.
		await seed_grant(env, { id: "grant-old", expiresAt: NOW - 1 });

		await council_run_scheduled(env, NOW);

		const tickets = await env.COUNCIL_DB.prepare("SELECT token_hash FROM meeting_tickets").all<{ token_hash: string }>();
		expect(tickets.results.map((row) => row.token_hash)).toEqual(["t-live"]);
		const sessions = await env.COUNCIL_DB.prepare("SELECT token_hash FROM room_sessions").all<{ token_hash: string }>();
		expect(sessions.results.map((row) => row.token_hash)).toEqual(["s-live"]);
		const cache = await env.COUNCIL_DB.prepare("SELECT token_hash FROM page_token_cache").all<{ token_hash: string }>();
		expect(cache.results.map((row) => row.token_hash)).toEqual(["pt-live"]);
		const windows = await env.COUNCIL_DB.prepare("SELECT bucket_key FROM rate_limit_windows").all<{ bucket_key: string }>();
		expect(windows.results.map((row) => row.bucket_key)).toEqual(["b-recent"]);

		const hmacs = await env.COUNCIL_DB.prepare(
			"SELECT display_name, email_hmac FROM meeting_participants ORDER BY display_name DESC",
		).all<{ display_name: string; email_hmac: string | null }>();
		expect(hmacs.results).toEqual([
			{ display_name: "Old", email_hmac: null },
			{ display_name: "New", email_hmac: "h" },
		]);

		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1"]);
	});

	test("a created meeting nobody opened expires after a day; a fresh one stays", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { id: "m-stale", code: "a".repeat(64), status: "created", createdAt: NOW - council_UNOPENED_MEETING_TTL_MS - 1 });
		await seed_meeting(env, { id: "m-lost", code: "b".repeat(64), status: "create_unknown", createdAt: NOW - council_UNOPENED_MEETING_TTL_MS - 1 });
		await seed_meeting(env, { id: "m-fresh", code: "c".repeat(64), status: "created", createdAt: NOW - HOUR });

		await council_run_scheduled(env, NOW);

		const statuses = await env.COUNCIL_DB.prepare("SELECT id, status FROM meetings ORDER BY id").all<{
			id: string;
			status: string;
		}>();
		expect(statuses.results).toEqual([
			{ id: "m-fresh", status: "created" },
			{ id: "m-lost", status: "expired" },
			{ id: "m-stale", status: "expired" },
		]);
		// The expiry parks nothing in the projection outbox. The meeting's grant dies on the same
		// 24-hour clock as this TTL, so an enqueued `expired` write could never deliver, and no
		// sweep ever deletes an expired meeting to purge the row (only a member delete would).
		const projected = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM projection_outbox").first<{ n: number }>();
		expect(projected?.n).toBe(0);
	});
});

describe("council_run_scheduled deadline and seal enforcement", () => {
	test("a meeting past its deadline closes, and with a recording it moves into processing", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// The open already sealed the processing grant; the deadline path only hands the work over.
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, {
			id: "m-recorded",
			code: "a".repeat(64),
			status: "open",
			deadlineAt: NOW - 1,
			providerRecordingId: "rec-1",
			processingGrantId: "grant-proc",
		});
		await seed_meeting(env, { id: "m-plain", code: "b".repeat(64), status: "open", deadlineAt: NOW - 1 });
		// A meeting stuck in recording_start_unknown must close at its deadline too; nothing else
		// ever moves it.
		await seed_meeting(env, { id: "m-unknown", code: "c".repeat(64), status: "recording_start_unknown", deadlineAt: NOW - 1 });

		await council_run_scheduled(env, NOW);

		const statuses = await env.COUNCIL_DB.prepare("SELECT id, status FROM meetings ORDER BY id").all<{
			id: string;
			status: string;
		}>();
		expect(statuses.results).toEqual([
			// The unrecorded meetings settle at ready: closed is only a stop on the way to processing.
			{ id: "m-plain", status: "ready" },
			{ id: "m-recorded", status: "processing" },
			{ id: "m-unknown", status: "ready" },
		]);
		const outbox = await env.COUNCIL_DB.prepare("SELECT meeting_id, kind, status FROM event_outbox").all<{
			meeting_id: string;
			kind: string;
			status: string;
		}>();
		expect(outbox.results).toEqual([{ meeting_id: "m-recorded", kind: "process_meeting", status: "handoff_pending" }]);
		expect(queueSent.length).toBe(1);
	});

	test("a closed meeting whose handoff was lost is re-driven into processing by the pass", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", token: "psg_processing_seeded" });
		await seed_meeting(env, {
			status: "closed",
			closedAt: NOW - HOUR,
			providerRecordingId: "rec-1",
			processingGrantId: "grant-proc",
		});

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 1 });
		expect(queueSent.length).toBe(1);
		// The re-driven handoff projects `processing` like the inline close does, so the page does
		// not sit on the pre-close state for the whole pipeline run. Assert the payload, not just
		// the row: a projection enqueued before the seal would carry `closed`.
		const projected = await env.COUNCIL_DB.prepare(
			"SELECT payload FROM projection_outbox WHERE meeting_id = 'meeting-1'",
		).all<{ payload: string }>();
		expect(projected.results.length).toBe(1);
		expect((JSON.parse(projected.results[0].payload) as { status: string }).status).toBe("processing");
	});

	test("a closed meeting without a recording whose inline settle was lost settles to ready by the pass", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// The close crashed between the closed transition and the inline closed -> ready settle.
		await seed_meeting(env, {
			status: "closed",
			closedAt: NOW - HOUR,
			providerRecordingId: null,
		});

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting).toEqual({ status: "ready" });
	});

	test("a projection enqueue collision on one meeting does not abort the rest of the pass", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, {
			id: "m-collide",
			code: "a".repeat(64),
			status: "closed",
			closedAt: NOW - HOUR,
			providerRecordingId: null,
		});
		await seed_meeting(env, {
			id: "m-plain",
			code: "b".repeat(64),
			status: "closed",
			closedAt: NOW - HOUR,
			providerRecordingId: null,
		});
		// A concurrent close already wrote revision 1 for m-collide, so the sweep's own enqueue hits
		// the UNIQUE (meeting_id, revision) index and its batch throws.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at)
			VALUES ('p-collide', 'm-collide', 1, 'write', '{}', 'delivered', 0, 0, 0)`,
		).run();

		// Positive control: the seeded row really collides — the enqueue throws and its batch rolls
		// back. Without this the assertions below could go green while the collision never fires.
		await expect(council_project_meeting(env, "m-collide", NOW)).rejects.toThrow(/UNIQUE constraint/u);

		await expect(council_run_scheduled(env, NOW)).resolves.toBeUndefined();

		// Both settles committed: the collision only lost m-collide's projection attempt.
		const statuses = await env.COUNCIL_DB.prepare(
			"SELECT id, status FROM meetings WHERE id IN ('m-collide', 'm-plain') ORDER BY id",
		).all<{ id: string; status: string }>();
		expect(statuses.results).toEqual([
			{ id: "m-collide", status: "ready" },
			{ id: "m-plain", status: "ready" },
		]);
		// The rolled-back batch left m-collide's revision at 0; m-plain's enqueue committed revision 1.
		const revisions = await env.COUNCIL_DB.prepare(
			"SELECT id, projection_revision FROM meetings WHERE id IN ('m-collide', 'm-plain') ORDER BY id",
		).all<{ id: string; projection_revision: number }>();
		expect(revisions.results).toEqual([
			{ id: "m-collide", projection_revision: 0 },
			{ id: "m-plain", projection_revision: 1 },
		]);
	});
});

describe("council_run_scheduled outbox reconciliation", () => {
	test("a pending row's lost send is retried; a stale handoff is verified or reverted", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { id: "m-pending", code: "a".repeat(64), status: "processing", processingGeneration: 1 });
		await seed_meeting(env, { id: "m-found", code: "b".repeat(64), status: "processing", processingGeneration: 1 });
		await seed_meeting(env, { id: "m-lost", code: "c".repeat(64), status: "processing", processingGeneration: 1 });

		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at) VALUES
			('o-pending', 'm-pending', 'process_meeting', 1, 'pending', 0, 0, 0),
			('o-found', 'm-found', 'process_meeting', 1, 'handoff_pending', 1, 0, ?),
			('o-lost', 'm-lost', 'process_meeting', 1, 'handoff_pending', 1, 0, ?)`,
		)
			.bind(NOW - 16 * 60 * 1000, NOW - 16 * 60 * 1000)
			.run();
		// The instance for m-found exists; the instance for m-lost never appeared.
		workflow.instances.set("council-process_meeting-m-found-g1", {});

		await council_run_scheduled(env, NOW);

		expect(queueSent).toEqual([{ outboxId: "o-pending" }]);
		const rows = await env.COUNCIL_DB.prepare("SELECT id, status FROM event_outbox ORDER BY id").all<{
			id: string;
			status: string;
		}>();
		expect(rows.results).toEqual([
			{ id: "o-found", status: "delivered" },
			{ id: "o-lost", status: "pending" },
			{ id: "o-pending", status: "handoff_pending" },
		]);
	});

	test("an undecryptable grant token defers that meeting's projections without killing the pass", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "ready" });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET projection_revision = 1 WHERE id = 'meeting-1'").run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at)
			VALUES ('p-1', 'meeting-1', 1, 'write', '{"a":1}', 'pending', 0, 0, 0)`,
		).run();
		// A rotated COUNCIL_ROOM_COOKIE_SECRET or a corrupted row makes the stored token
		// undecryptable. That must defer this meeting's delivery, not abort the whole pass.
		await env.COUNCIL_DB.prepare("UPDATE service_grants SET token_encrypted = 'garbage' WHERE id = 'grant-1'").run();
		// A later sweep observable: an expired tombstone the tail of the pass must still purge.
		await seed_meeting(env, { id: "m-tomb", code: "b".repeat(64), status: "deleted_tombstone", serviceGrantId: null });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET tombstone_expires_at = ? WHERE id = 'm-tomb'").bind(NOW - 1).run();

		await expect(council_run_scheduled(env, NOW)).resolves.toBeUndefined();

		// The revision stays pending for a later pass; the pass tail still ran.
		const row = await env.COUNCIL_DB.prepare("SELECT status, updated_at FROM projection_outbox WHERE id = 'p-1'").first<{
			status: string;
			updated_at: number;
		}>();
		expect(row?.status).toBe("pending");
		// The deferral must also rotate this meeting to the back of the reconciliation window: the
		// window scans the oldest pending rows first, so 25 unrotated undeliverable meetings would
		// pin every slot and starve healthy retries forever.
		expect(row?.updated_at).toBe(NOW);
		const tomb = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meetings WHERE id = 'm-tomb'").first<{
			n: number;
		}>();
		expect(tomb?.n).toBe(0);
	});

	test("pending projection revisions are delivered in order", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "ready" });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET projection_revision = 2 WHERE id = 'meeting-1'").run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at) VALUES
			('p-1', 'meeting-1', 1, 'write', '{"a":1}', 'pending', 0, 0, 0),
			('p-2', 'meeting-1', 2, 'write', '{"a":2}', 'pending', 0, 0, 0)`,
		).run();

		await council_run_scheduled(env, NOW);

		const rows = await env.COUNCIL_DB.prepare("SELECT id, status FROM projection_outbox ORDER BY revision").all<{
			id: string;
			status: string;
		}>();
		expect(rows.results).toEqual([
			{ id: "p-1", status: "delivered" },
			{ id: "p-2", status: "delivered" },
		]);
		const writes = mock.calls.filter((call) => call.url.includes("/plugin-data/write-versioned"));
		expect(writes.map((call) => call.bodyJson?.revision)).toEqual([1, 2]);
	});

	test("a revision the receiver already applied is marked delivered, not retried forever", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			// The receiver's 409 means this exact revision (or a newer one) already landed — the
			// answer a crash between the send and the delivered-mark gets on replay.
			"/plugin-data/write-versioned": () => Response.json({ message: "Conflict" }, { status: 409 }),
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "ready" });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET projection_revision = 1 WHERE id = 'meeting-1'").run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at)
			VALUES ('p-1', 'meeting-1', 1, 'write', '{"a":1}', 'pending', 0, 0, 0)`,
		).run();

		await council_run_scheduled(env, NOW);

		// Treating the conflict as a failure would retry this revision forever: the receiver's
		// idempotency answer is the proof it landed.
		const row = await env.COUNCIL_DB.prepare("SELECT status FROM projection_outbox WHERE id = 'p-1'").first<{
			status: string;
		}>();
		expect(row?.status).toBe("delivered");
	});

	test("a refused revision stops that meeting's delivery so order is never violated", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/plugin-data/write-versioned": (call) =>
				call.bodyJson?.revision === 1
					? Response.json({ message: "unavailable" }, { status: 503 })
					: Response.json({ revision: call.bodyJson?.revision, byteSize: 1 }),
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "ready" });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET projection_revision = 2 WHERE id = 'meeting-1'").run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at) VALUES
			('p-1', 'meeting-1', 1, 'write', '{"a":1}', 'pending', 0, 0, 0),
			('p-2', 'meeting-1', 2, 'write', '{"a":2}', 'pending', 0, 0, 0)`,
		).run();

		await council_run_scheduled(env, NOW);

		// Revision 2 must never go out after 1 failed: a skipped-ahead write would make the
		// receiver's monotonic revision check refuse revision 1 forever.
		const writes = mock.calls.filter((call) => call.url.includes("/plugin-data/write-versioned"));
		expect(writes.map((call) => call.bodyJson?.revision)).toEqual([1]);
		const rows = await env.COUNCIL_DB.prepare(
			"SELECT id, status, attempts FROM projection_outbox ORDER BY revision",
		).all<{ id: string; status: string; attempts: number }>();
		expect(rows.results).toEqual([
			{ id: "p-1", status: "pending", attempts: 1 },
			{ id: "p-2", status: "pending", attempts: 0 },
		]);
	});
});

describe("council_run_scheduled delete retry and tombstones", () => {
	test("a failed delete retries after an hour with a NEW generation and outbox row", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// The retry only makes sense while the delete-time seal is alive — the workflow spends it.
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "delete_failed", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();
		// The original delete attempt's outbox row is long delivered; its workflow ran and failed.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'delete_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();

		await council_run_scheduled(env, NOW);

		// The retry must produce fresh work: generation 3, a new outbox row, and a queue send. Reusing
		// generation 2 would dispatch nothing — its row is delivered and its instance is terminal.
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "deleting", processing_generation: 3 });
		const fresh = await env.COUNCIL_DB.prepare(
			"SELECT status FROM event_outbox WHERE kind = 'delete_meeting' AND generation = 3",
		).first<{ status: string }>();
		expect(fresh?.status).toBe("handoff_pending");
		expect(queueSent.length).toBe(1);
	});

	test("a failed delete with a dead sealed grant is not retried", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1", expiresAt: 1 });
		await seed_meeting(env, { status: "delete_failed", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();

		await council_run_scheduled(env, NOW);

		// A retry generation would only fail again — the workflow has no live grant to spend. The
		// meeting stays delete_failed until a member's page delete seals fresh authority.
		const meeting = await env.COUNCIL_DB.prepare("SELECT status, updated_at FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
			updated_at: number;
		}>();
		expect(meeting?.status).toBe("delete_failed");
		expect(queueSent.length).toBe(0);
		// The skip must bump the retry clock. An unbumped dead-grant row stays eligible on every
		// pass and permanently occupies one of the sweep's 25 slots.
		expect(meeting?.updated_at).toBe(NOW);
	});

	test("a fresh delete_failed waits out the hour before retrying", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "delete_failed", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - HOUR / 2).run();

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting?.status).toBe("delete_failed");
		expect(queueSent.length).toBe(0);
	});

	test("an expired tombstone reaches true zero: the meeting row and every trace of it", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_meeting(env, { status: "deleted_tombstone", serviceGrantId: null });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET tombstone_expires_at = ? WHERE id = 'meeting-1'").bind(NOW - 1).run();
		await seed_participant(env, { meetingId: "meeting-1", displayName: "" });
		await env.COUNCIL_DB.prepare(
			"INSERT INTO webhook_events (id, webhook_id, body_sha256, event_type, meeting_id, received_at) VALUES ('w-1', 'wh-1', 'sha', 'recording.statusUpdate', 'meeting-1', 0)",
		).run();
		await env.COUNCIL_DB.prepare(
			"INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at) VALUES ('o-1', 'meeting-1', 'delete_meeting', 1, 'delivered', 1, 0, 0)",
		).run();
		await env.COUNCIL_DB.prepare(
			"INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at) VALUES ('p-1', 'meeting-1', 1, 'delete', '', 'delivered', 0, 0, 0)",
		).run();

		await council_run_scheduled(env, NOW);

		for (const table of ["meetings", "meeting_participants", "webhook_events", "event_outbox", "projection_outbox"]) {
			const count = await env.COUNCIL_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
			expect(count?.n, table).toBe(0);
		}
	});
});

describe("council_run_scheduled processing redrive", () => {
	test("a failed processing retries after an hour with a NEW generation and outbox row", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "failed", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 3 });
		const fresh = await env.COUNCIL_DB.prepare(
			"SELECT status FROM event_outbox WHERE kind = 'process_meeting' AND generation = 3",
		).first<{ status: string }>();
		expect(fresh?.status).toBe("handoff_pending");
		expect(queueSent.length).toBe(1);
	});

	test("a failed processing with a dead sealed grant is not retried", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, {
			id: "grant-p",
			phase: "processing",
			destinationPathPrefix: "/meetings/meeting-1",
			expiresAt: 1,
		});
		await seed_meeting(env, { status: "failed", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare("SELECT status, updated_at FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
			updated_at: number;
		}>();
		expect(meeting?.status).toBe("failed");
		expect(queueSent.length).toBe(0);
		expect(meeting?.updated_at).toBe(NOW);
	});

	test("a processing meeting whose current outbox is dead gets a NEW generation immediately", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'dead', 8, 0, 0)`,
		).run();

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 3 });
		const fresh = await env.COUNCIL_DB.prepare(
			"SELECT status FROM event_outbox WHERE kind = 'process_meeting' AND generation = 3",
		).first<{ status: string }>();
		expect(fresh?.status).toBe("handoff_pending");
		expect(queueSent.length).toBe(1);
	});

	test("a processing meeting whose current outbox is dead does not bump while its instance exists", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'dead', 8, 0, 0)`,
		).run();
		workflow.instances.set("council-process_meeting-meeting-1-g2", {});

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});

	test("a deleting meeting whose current outbox is dead gets a NEW generation immediately", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'delete_meeting', 2, 'dead', 8, 0, 0)`,
		).run();

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "deleting", processing_generation: 3 });
		const fresh = await env.COUNCIL_DB.prepare(
			"SELECT status FROM event_outbox WHERE kind = 'delete_meeting' AND generation = 3",
		).first<{ status: string }>();
		expect(fresh?.status).toBe("handoff_pending");
		expect(queueSent.length).toBe(1);
	});

	test("a deleting meeting whose current outbox is dead does not bump while its instance exists", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'delete_meeting', 2, 'dead', 8, 0, 0)`,
		).run();
		workflow.instances.set("council-delete_meeting-meeting-1-g2", {});

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "deleting", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});

	test("a processing meeting whose current outbox is dead bumps when that instance already finished", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'dead', 8, 0, 0)`,
		).run();
		workflow.instances.set("council-process_meeting-meeting-1-g2", { status: "complete" });

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 3 });
		expect(queueSent.length).toBe(1);
	});

	test("a processing meeting whose current outbox is dead does not bump when Workflow.get fails for another reason", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'dead', 8, 0, 0)`,
		).run();
		workflow.instances.set("council-process_meeting-meeting-1-g2", { status: "running" });
		workflow.failGet = new Error("workflow service down");

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});

	test("a deleting meeting whose current outbox is dead bumps when that instance already errored", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'delete_meeting', 2, 'dead', 8, 0, 0)`,
		).run();
		workflow.instances.set("council-delete_meeting-meeting-1-g2", { status: "errored" });

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "deleting", processing_generation: 3 });
		expect(queueSent.length).toBe(1);
	});
});
