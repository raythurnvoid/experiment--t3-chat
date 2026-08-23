import { afterEach, describe, expect, test } from "vitest";

import { council_run_scheduled, council_UNOPENED_MEETING_TTL_MS } from "./cleanup.ts";
import { council_project_meeting } from "./projection.ts";
import {
	FUTURE,
	install_fetch,
	make_test_env,
	seed_grant,
	seed_meeting,
	seed_participant,
	seed_room_session,
} from "../test/env.ts";

const NOW = 100_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

		// Separate the two reasons the sweep spares a grant, so neither can be deleted unnoticed.
		// `grant-old` is the only one that is both expired and unreferenced, so it is the only one that
		// goes. `grant-meeting-pinned` is expired but a meeting still points at it, and
		// `grant-live-free` is live with nothing pointing at it.
		await seed_grant(env, { id: "grant-old", expiresAt: NOW - 1 });
		await seed_grant(env, { id: "grant-meeting-pinned", expiresAt: NOW - 1 });
		await seed_meeting(env, {
			id: "m-pin",
			code: "p".repeat(64),
			status: "ready",
			serviceGrantId: "grant-meeting-pinned",
			createdAt: NOW - HOUR,
		});
		await seed_grant(env, { id: "grant-live-free" });

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
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1", "grant-live-free", "grant-meeting-pinned"]);
	});

	test("a webhook event past its eight-day window goes, even when it names no meeting", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;

		// Neither row names a meeting. That is what the handler stores for an event it cannot map to
		// one, and for a delivery that arrives after its meeting was swept. The tombstone sweep at the
		// end of the pass matches rows BY meeting id, so it never sees either of these.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO webhook_events (id, webhook_id, body_sha256, event_type, meeting_id, received_at, handled_at)
			VALUES ('w-old', 'wh-1', 'sha-old', 'recording.statusUpdate', NULL, ?, ?), ('w-recent', 'wh-1', 'sha-recent', 'recording.statusUpdate', NULL, ?, ?)`,
		)
			.bind(NOW - 8 * DAY - 1, NOW - 8 * DAY - 1, NOW - 8 * DAY + 1, NOW - 8 * DAY + 1)
			.run();

		await council_run_scheduled(env, NOW);

		const events = await env.COUNCIL_DB.prepare("SELECT id FROM webhook_events ORDER BY id").all<{ id: string }>();
		expect(events.results.map((row) => row.id)).toEqual(["w-recent"]);
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

	test("an expired grant a live host session still pins is skipped, and the pass keeps going", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// The grant that minted this host's room ticket. `resume_room_session` moves a session's
		// expiry five hours forward on every room page load and never looks at the pinned grant, so a
		// room tab loaded again every few hours carries the session past the grant's 24 hours.
		await seed_grant(env, { id: "grant-pinned", expiresAt: NOW - 1 });
		await seed_grant(env, { id: "grant-loose", expiresAt: NOW - 1 });
		await seed_meeting(env, { status: "open", deadlineAt: NOW - 1 });
		const host = await seed_participant(env, { meetingId: "meeting-1", role: "host", displayName: "Host" });
		await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: host.id,
			role: "host",
			actorServiceGrantId: "grant-pinned",
		});

		await expect(council_run_scheduled(env, NOW)).resolves.toBeUndefined();

		// The pinned grant stays. The expired grant nothing points at still goes, so one skipped row
		// does not stop the sweep.
		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1", "grant-pinned"]);
		const sessions = await env.COUNCIL_DB.prepare("SELECT actor_service_grant_id FROM room_sessions").all<{
			actor_service_grant_id: string | null;
		}>();
		expect(sessions.results.map((row) => row.actor_service_grant_id)).toEqual(["grant-pinned"]);
		// Deadline enforcement runs after the grant sweep, so the closed meeting is the proof that the
		// throw no longer takes the rest of the pass with it. An unrecorded meeting settles past
		// `closed` to `ready` in the same pass.
		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting).toEqual({ status: "ready" });
	});

	test("an expired grant a live room ticket still pins is skipped, and the pass keeps going", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// Minting a room ticket only needs a grant with any time left, and the ticket then lives two
		// minutes on its own clock. A member who opens the host room in the last two minutes of a
		// 24-hour grant leaves exactly this row: a live ticket pointing at a dead grant.
		await seed_grant(env, { id: "grant-pinned", expiresAt: NOW - 1 });
		await seed_grant(env, { id: "grant-loose", expiresAt: NOW - 1 });
		await seed_meeting(env, { status: "open", deadlineAt: NOW - 1 });
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES ('t-pinning', 'meeting-1', 'user-1', 'grant-pinned', ?, ?)",
		)
			.bind(NOW + 60_000, NOW - 60_000)
			.run();

		await expect(council_run_scheduled(env, NOW)).resolves.toBeUndefined();

		// The pinned grant stays. The expired grant nothing points at still goes, so one skipped row
		// does not stop the sweep.
		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1", "grant-pinned"]);
		const tickets = await env.COUNCIL_DB.prepare("SELECT token_hash FROM meeting_tickets").all<{ token_hash: string }>();
		expect(tickets.results.map((row) => row.token_hash)).toEqual(["t-pinning"]);
		// Deadline enforcement runs after the grant sweep, so the closed meeting is the proof that the
		// DELETE did not throw and take the rest of the pass with it. An unrecorded meeting settles
		// past `closed` to `ready` in the same pass.
		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting).toEqual({ status: "ready" });
	});

	test("a finished delete's cleared grant ids do not stop the expired-grant sweep", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-loose", expiresAt: NOW - 1 });
		// What a finished delete leaves behind: the delete workflow clears both grant ids on the
		// tombstoned meeting. The sweep's subqueries drop their NULLs for exactly this row. Without
		// that, `NOT IN` over a set holding NULL matches nothing, and one finished delete would spare
		// every expired grant from then on.
		await seed_meeting(env, {
			id: "m-tombstone",
			code: "t".repeat(64),
			status: "deleted_tombstone",
			serviceGrantId: null,
			createdAt: NOW - HOUR,
		});

		await council_run_scheduled(env, NOW);

		const grants = await env.COUNCIL_DB.prepare("SELECT id FROM service_grants ORDER BY id").all<{ id: string }>();
		expect(grants.results.map((row) => row.id)).toEqual(["grant-1"]);
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

	test("a projection enqueue collision at a deadline close does not abort deadline enforcement", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { id: "m-collide", code: "a".repeat(64), status: "open", deadlineAt: NOW - 1 });
		// Seeded after m-collide on purpose: the deadline loop reaches it second, so it only closes
		// if m-collide's throw was contained.
		await seed_meeting(env, { id: "m-plain", code: "b".repeat(64), status: "open", deadlineAt: NOW - 1 });
		// A concurrent close already wrote revision 1 for m-collide, so the close's own enqueue hits
		// the UNIQUE (meeting_id, revision) index and its batch throws.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at)
			VALUES ('p-collide', 'm-collide', 1, 'write', '{}', 'delivered', 0, 0, 0)`,
		).run();

		// Positive control: the seeded row really collides — the enqueue throws and its batch rolls
		// back, so the deadline close below still runs into the same collision.
		await expect(council_project_meeting(env, "m-collide", NOW)).rejects.toThrow(/UNIQUE constraint/u);

		await expect(council_run_scheduled(env, NOW)).resolves.toBeUndefined();

		// Both closes committed and settled: the collision only lost m-collide's projection attempt.
		const statuses = await env.COUNCIL_DB.prepare(
			"SELECT id, status FROM meetings WHERE id IN ('m-collide', 'm-plain') ORDER BY id",
		).all<{ id: string; status: string }>();
		expect(statuses.results).toEqual([
			{ id: "m-collide", status: "ready" },
			{ id: "m-plain", status: "ready" },
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

	test("a stale handoff the DLQ marked dead while the sweep was asking stays dead", async () => {
		const { env, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 1 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g1', 'meeting-1', 'process_meeting', 1, 'handoff_pending', 1, 0, ?)`,
		)
			.bind(NOW - 16 * 60 * 1000)
			.run();
		// The instance was created and then failed terminally, so the message ran out of Queue
		// retries and the DLQ handler wrote `dead` on the row.
		workflow.instances.set("council-process_meeting-meeting-1-g1", { status: "errored" });
		const workflowGet = env.COUNCIL_WORKFLOW.get;
		env.COUNCIL_WORKFLOW.get = async (instanceId) => {
			// The DLQ handler commits while this pass is still waiting on the Workflow service.
			await env.COUNCIL_DB.prepare(
				"UPDATE event_outbox SET status = 'dead', updated_at = ? WHERE id = 'o-g1' AND status = 'handoff_pending'",
			)
				.bind(NOW)
				.run();
			return await workflowGet(instanceId);
		};

		await council_run_scheduled(env, NOW);

		const row = await env.COUNCIL_DB.prepare("SELECT status FROM event_outbox WHERE id = 'o-g1'").first<{
			status: string;
		}>();
		expect(row?.status).toBe("dead");
		// Why writing `delivered` over it would matter: the dead-generation sweep at the tail of this
		// same pass is what gives the meeting a new generation, and it only ever matches `dead` rows.
		// A resurrected row would leave this meeting processing forever with nothing running.
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ processing_generation: number }>();
		expect(meeting?.processing_generation).toBe(2);
	});

	test("a stale handoff the consumer delivered while the sweep was asking is not flapped back to pending", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 1 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g1', 'meeting-1', 'process_meeting', 1, 'handoff_pending', 1, 0, ?)`,
		)
			.bind(NOW - 16 * 60 * 1000)
			.run();
		// No instance is seeded, so the sweep's `get` answers not_found: it asked before the consumer
		// created the instance. The consumer then creates it and records `delivered` on the row, and
		// this pass's revert lands afterwards.
		const workflowGet = env.COUNCIL_WORKFLOW.get;
		env.COUNCIL_WORKFLOW.get = async (instanceId) => {
			await env.COUNCIL_DB.prepare(
				"UPDATE event_outbox SET status = 'delivered', workflow_instance_id = ?, updated_at = ? WHERE id = 'o-g1' AND status = 'handoff_pending'",
			)
				.bind(instanceId, NOW)
				.run();
			return await workflowGet(instanceId);
		};

		await council_run_scheduled(env, NOW);

		// Flapping a finished row back to pending would make the next pass re-send a message for work
		// that already ran.
		const row = await env.COUNCIL_DB.prepare("SELECT status FROM event_outbox WHERE id = 'o-g1'").first<{
			status: string;
		}>();
		expect(row?.status).toBe("delivered");
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
		// Seal a live grant, so the hourly clock is the only thing that can hold this retry back. With
		// no sealed grant the dead-grant skip above would refuse the retry too, and the test would
		// still pass with the clock gone.
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "delete_failed", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - HOUR / 2).run();

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "delete_failed", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});

	test("an expired tombstone reaches true zero: the meeting row and every trace of it", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_meeting(env, { status: "deleted_tombstone", serviceGrantId: null });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET tombstone_expires_at = ? WHERE id = 'meeting-1'").bind(NOW - 1).run();
		await seed_participant(env, { meetingId: "meeting-1", displayName: "" });
		// A second tombstone one millisecond short of its eight-day window. Both rows belong in the
		// same test: with only the expired one the comparison is exercised in one direction, and a
		// sweep that erased every tombstone on its next pass would look correct.
		await seed_meeting(env, { id: "m-waiting", code: "w".repeat(64), status: "deleted_tombstone", serviceGrantId: null });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET tombstone_expires_at = ? WHERE id = 'm-waiting'").bind(NOW + 1).run();
		// A webhook row this pass received a moment ago. The eight-day TTL sweep runs at the top of
		// the same pass, so a row dated 0 would already be gone before the tombstone sweep below is
		// reached, and this test would pass with that sweep deleted. `webhook_events.meeting_id` has
		// no foreign key either, so no cascade covers it.
		await env.COUNCIL_DB.prepare(
			"INSERT INTO webhook_events (id, webhook_id, body_sha256, event_type, meeting_id, received_at) VALUES ('w-1', 'wh-1', 'sha', 'recording.statusUpdate', 'meeting-1', ?)",
		)
			.bind(NOW)
			.run();
		await env.COUNCIL_DB.prepare(
			"INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at) VALUES ('o-1', 'meeting-1', 'delete_meeting', 1, 'delivered', 1, 0, 0)",
		).run();
		await env.COUNCIL_DB.prepare(
			"INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at) VALUES ('p-1', 'meeting-1', 1, 'delete', '', 'delivered', 0, 0, 0)",
		).run();

		await council_run_scheduled(env, NOW);

		for (const [table, column] of [
			["meetings", "id"],
			["meeting_participants", "meeting_id"],
			["webhook_events", "meeting_id"],
			["event_outbox", "meeting_id"],
			["projection_outbox", "meeting_id"],
		]) {
			const count = await env.COUNCIL_DB.prepare(
				`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = 'meeting-1'`,
			).first<{ n: number }>();
			expect(count?.n, table).toBe(0);
		}

		// The tombstone still inside its window is untouched, so the sweep erases by the deadline and
		// not by the status.
		const left = await env.COUNCIL_DB.prepare("SELECT id FROM meetings").all<{ id: string }>();
		expect(left.results.map((row) => row.id)).toEqual(["m-waiting"]);
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

	test("a fresh failed processing waits out the hour before retrying", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// A live sealed grant, so the hourly clock is the only thing that can hold this retry back.
		// Without the clock a failed meeting would be re-driven on every cron pass instead of hourly.
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "failed", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - HOUR / 2).run();

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "failed", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
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

	test("a processing meeting that settles while the redrive asks Workflow is left alone", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'dead', 8, 0, 0)`,
		).run();

		// A `dead` outbox row is not proof the instance never started: `createBatch` can start it and
		// the ack can still fall into the DLQ. So generation 2 may be running right now, and it can
		// reach its finalize step and settle the meeting while this pass waits on the Workflow
		// service. The redrive holds the meeting row as it read it before that round trip.
		const workflowGet = env.COUNCIL_WORKFLOW.get;
		env.COUNCIL_WORKFLOW.get = async (id) => {
			await env.COUNCIL_DB.prepare("UPDATE meetings SET status = 'ready' WHERE id = 'meeting-1'").run();
			return await workflowGet(id);
		};

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "ready", processing_generation: 2 });
		// The queue is the assertion that matters. The row above reads the same either way, because
		// the guarded UPDATE matches nothing whether or not the refusal follows it. Without the
		// refusal the pass dispatches generation 3 over a meeting that already finished.
		expect(queueSent.length).toBe(0);
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

	test("a processing meeting whose lost failure write left a delivered row gets a NEW generation after an hour", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();
		// The consumer delivered the row and the run failed terminally, but the catch's one D1 write
		// of `failed` was lost. Nothing else ever moves this shape: the DLQ never wrote `dead`, close
		// no-ops for `processing`, and the page delete answers 409 while it lasts.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();
		workflow.instances.set("council-process_meeting-meeting-1-g2", { status: "errored" });

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

	test("a processing meeting whose current outbox is delivered does not bump while its instance runs", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();
		// Every healthy long pipeline run sits at exactly processing + delivered past the hour. The
		// Workflow.get guard is the only thing between this sweep and starting N+1 over live work.
		workflow.instances.set("council-process_meeting-meeting-1-g2", { status: "running" });

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});

	test("a processing meeting with a fresh delivered row waits out the hour before redriving", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "processing", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - HOUR / 2).run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'process_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();
		// The instance is already terminal, so the clock is the only thing holding the redrive back.
		// Without the clock every meeting inside its first processing hour would cost a Workflow.get
		// on every pass, because processing + delivered is what a healthy run looks like.
		workflow.instances.set("council-process_meeting-meeting-1-g2", { status: "errored" });

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "processing", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});

	test("a deleting meeting whose lost delete_failed write left a delivered row gets a NEW generation after an hour", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();
		// The delete workflow's catch records `delete_failed` with one D1 write; losing it strands
		// the meeting in `deleting` with a delivered row and a terminal instance.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'delete_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();
		workflow.instances.set("council-delete_meeting-meeting-1-g2", { status: "errored" });

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

	test("a deleting meeting whose current outbox is delivered does not bump while its instance runs", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - 2 * HOUR).run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'delete_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();
		workflow.instances.set("council-delete_meeting-meeting-1-g2", { status: "running" });

		await council_run_scheduled(env, NOW);

		// Bumping here would start a second delete workflow over the same files while the first one
		// is still running.
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "deleting", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});

	test("a deleting meeting with a fresh delivered row waits out the hour before redriving", async () => {
		const { env, queueSent, workflow } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-p", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "deleting", processingGrantId: "grant-p", processingGeneration: 2 });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET updated_at = ? WHERE id = 'meeting-1'").bind(NOW - HOUR / 2).run();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('o-g2', 'meeting-1', 'delete_meeting', 2, 'delivered', 1, 0, 0)`,
		).run();
		// The instance is already terminal, so the clock is the only thing holding the redrive back.
		workflow.instances.set("council-delete_meeting-meeting-1-g2", { status: "errored" });

		await council_run_scheduled(env, NOW);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(meeting).toEqual({ status: "deleting", processing_generation: 2 });
		expect(queueSent.length).toBe(0);
	});
});
