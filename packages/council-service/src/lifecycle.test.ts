import { afterEach, describe, expect, test } from "vitest";

import {
	council_close_meeting,
	council_request_meeting_delete,
	council_request_processing_redrive,
	council_seal_meeting_grant,
	council_start_processing,
} from "./lifecycle.ts";
import { council_get_meeting } from "./db.ts";
import { council_project_meeting } from "./projection.ts";
import type { Env } from "./env.ts";
import { install_fetch, make_test_env, seed_grant, seed_meeting } from "../test/env.ts";

const NOW = 100_000_000_000;
const SEEDED_AT = NOW - 24 * 60 * 60 * 1000;

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

/** The sealed processing grant is a separate row from the meeting's interactive pin. */
async function seed_sealed_grant(env: Env) {
	await seed_grant(env, { id: "grant-2", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
}

async function read_meeting_row(env: Env) {
	return await env.COUNCIL_DB.prepare(
		"SELECT status, processing_generation, closed_at, updated_at FROM meetings WHERE id = 'meeting-1'",
	).first<{ status: string; processing_generation: number; closed_at: number | null; updated_at: number }>();
}

async function read_outbox_rows(env: Env) {
	const rows = await env.COUNCIL_DB.prepare(
		"SELECT kind, generation, status FROM event_outbox WHERE meeting_id = 'meeting-1' ORDER BY generation",
	).all<{ kind: string; generation: number; status: string }>();
	return rows.results;
}

describe("council_close_meeting", () => {
	test("a meeting id with no row answers not_found", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;

		const closed = await council_close_meeting(env, "no-such-meeting", NOW);
		// `handle_close` maps exactly this name to a 404, so the name is part of the route contract.
		expect(closed._nay?.name).toBe("not_found");
	});

	test("a meeting already past close answers its settled status without acting", async () => {
		// The docblock promises idempotency for these four. A host can press End twice, and the page
		// close route filters no status at all, so every one of them reaches this function for real.
		const settled = ["closed", "processing", "ready", "failed"] as const;
		restoreFetch = install_fetch().restore;

		const answered: { asked: string; answered: string; updatedAt: number }[] = [];
		for (const status of settled) {
			const { env, queueSent } = make_test_env();
			await seed_grant(env);
			await seed_sealed_grant(env);
			await seed_meeting(env, {
				status,
				processingGrantId: "grant-2",
				providerRecordingId: "rec-1",
				createdAt: SEEDED_AT,
			});

			const closed = await council_close_meeting(env, "meeting-1", NOW);
			const row = await read_meeting_row(env);
			answered.push({
				asked: status,
				answered: closed._yay?.status ?? `refused:${closed._nay?.name}`,
				updatedAt: row?.updated_at ?? -1,
			});
			expect(queueSent).toEqual([]);
		}

		// Comparing the whole table at once names the status that regressed instead of only the first.
		expect(answered).toEqual(
			settled.map((status) => ({ asked: status, answered: status, updatedAt: SEEDED_AT })),
		);
	});

	test("closing a meeting that never opened is a conflict and writes nothing", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "created", createdAt: SEEDED_AT });

		const closed = await council_close_meeting(env, "meeting-1", NOW);
		expect(closed._nay?.name).toBe("conflict");
		expect(closed._nay?.message).toBe("Meeting is not open");

		// A refused close must leave the row exactly as it found it: the transition is the only
		// writer that runs before this branch returns.
		const row = await read_meeting_row(env);
		expect(row).toEqual({ status: "created", processing_generation: 0, closed_at: null, updated_at: SEEDED_AT });
		expect(queueSent).toEqual([]);
	});

	test("closing an open meeting stamps closed_at and settles at ready with no recording", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// No provider meeting and no recording: the close skips the provider block, so this test is
		// about the two writes the close owns by itself.
		await seed_meeting(env, {
			status: "open",
			providerMeetingId: null,
			providerRecordingId: null,
			openedAt: SEEDED_AT,
			createdAt: SEEDED_AT,
		});

		const closed = await council_close_meeting(env, "meeting-1", NOW);
		expect(closed._yay?.status).toBe("ready");

		// `closed_at` is the only record of when admission shut, and the projection hands it to the
		// plugin page as `closedAt`.
		const row = await read_meeting_row(env);
		expect(row?.closed_at).toBe(NOW);
		expect(row?.status).toBe("ready");
	});

	test("a close whose projection enqueue collides still answers the settled status", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, {
			status: "open",
			providerMeetingId: null,
			providerRecordingId: null,
			createdAt: SEEDED_AT,
		});
		// A concurrent state change already wrote revision 1, so the close's own enqueue hits the
		// UNIQUE (meeting_id, revision) index and its batch throws.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO projection_outbox (id, meeting_id, revision, operation, payload, status, attempts, created_at, updated_at)
			VALUES ('p-collide', 'meeting-1', 1, 'write', '{}', 'delivered', 0, 0, 0)`,
		).run();

		// Positive control: the seeded row really collides — the enqueue throws and its batch rolls
		// back, so the close below still runs into the same collision.
		await expect(council_project_meeting(env, "meeting-1", NOW)).rejects.toThrow(/UNIQUE constraint/u);

		// The close committed before the projection ran. A throw here would turn that committed
		// close into a bodyless 500 through `handle_close`.
		const closed = await council_close_meeting(env, "meeting-1", NOW);
		expect(closed._nay).toBeUndefined();
		expect(closed._yay?.status).toBe("ready");
	});
});

describe("council_seal_meeting_grant", () => {
	test("sealing claims the write scope from the grant it seals from", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "created", createdAt: SEEDED_AT });
		const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		if (!meeting) {
			throw new Error("The fixture did not seed a meeting");
		}

		const sealed = await council_seal_meeting_grant(env, meeting, NOW);
		expect(sealed._nay).toBeUndefined();

		// The control for the pin below: without it, a seal that never reached Convex would pass a pin
		// on a call that never happened.
		const verifyLive = mock.calls.filter((call) => call.url.includes("/service-grants/verify-live"));
		expect(verifyLive.length).toBe(1);

		// Sealing hands the pipeline authority to write this meeting's files, so the claim is the write
		// pair: a member who lost `content.write` must not be able to start that. It must not widen to
		// `files:write` either — the host refuses a claim wider than the interactive grant being
		// verified, and an interactive grant never holds `files:write`, so that claim would refuse
		// every open.
		expect(verifyLive[0]?.bodyJson?.scopes).toEqual(["plugin_data:read", "plugin_data:write"]);
	});
});

describe("council_start_processing", () => {
	test("does nothing for a meeting that is not closed", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_sealed_grant(env);
		// Everything except the status says "hand this to the pipeline". The cron selects rows and
		// then re-reads them, so a row that moved in between arrives here exactly like this one.
		await seed_meeting(env, {
			status: "open",
			providerRecordingId: "rec-1",
			processingGrantId: "grant-2",
			createdAt: SEEDED_AT,
		});

		const started = await council_start_processing(env, "meeting-1", NOW);
		expect(started._yay?.started).toBe(false);

		// The outbox insert shares a batch with an UPDATE that pins `status = 'closed'`, so a lost
		// precondition leaves the meeting alone but still queues work nobody asked for.
		expect(await read_outbox_rows(env)).toEqual([]);
		expect(queueSent).toEqual([]);
		const row = await read_meeting_row(env);
		expect(row?.status).toBe("open");
	});

	test("does nothing for a closed meeting that has no recording", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_sealed_grant(env);
		await seed_meeting(env, {
			status: "closed",
			providerRecordingId: null,
			processingGrantId: "grant-2",
			closedAt: SEEDED_AT,
			createdAt: SEEDED_AT,
		});

		const started = await council_start_processing(env, "meeting-1", NOW);
		expect(started._yay?.started).toBe(false);

		// Without this precondition the meeting would enter `processing` with nothing to process and
		// wait for a pipeline run that can only fail.
		const row = await read_meeting_row(env);
		expect(row).toEqual({
			status: "closed",
			processing_generation: 0,
			closed_at: SEEDED_AT,
			updated_at: SEEDED_AT,
		});
		expect(await read_outbox_rows(env)).toEqual([]);
		expect(queueSent).toEqual([]);
	});
});

describe("council_request_processing_redrive", () => {
	test("does nothing for a meeting that is neither failed nor processing", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_sealed_grant(env);
		await seed_meeting(env, {
			status: "ready",
			providerRecordingId: "rec-1",
			processingGrantId: "grant-2",
			processingGeneration: 2,
			createdAt: SEEDED_AT,
		});
		const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");

		const redriven = await council_request_processing_redrive(env, meeting!, NOW);
		expect(redriven._yay?.started).toBe(false);

		// A finished meeting has its files. Redriving it would run the whole pipeline again over the
		// same destination folder under a new generation.
		const row = await read_meeting_row(env);
		expect(row?.status).toBe("ready");
		expect(row?.processing_generation).toBe(2);
		expect(await read_outbox_rows(env)).toEqual([]);
		expect(queueSent).toEqual([]);
	});
});

describe("council_request_meeting_delete", () => {
	test("a tombstoned meeting is never resurrected: no new generation and no delete outbox row", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// The delete workflow clears `processing_grant_id` when it tombstones, so a tombstone carries
		// no sealed grant. `handle_delete` skips the reseal for exactly this status and hands the row
		// straight here, so a member pressing Delete a second time arrives with this shape.
		await seed_meeting(env, {
			status: "deleted_tombstone",
			processingGrantId: null,
			processingGeneration: 3,
			createdAt: SEEDED_AT,
		});
		const tombstoned = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		expect(tombstoned?.status).toBe("deleted_tombstone");

		const requested = await council_request_meeting_delete(env, tombstoned!, NOW);

		// The early return is the only barrier. This function writes with raw SQL, so the empty exit
		// list `deleted_tombstone: []` in the transition table cannot stop it: without the guard the
		// UPDATE matches, the row goes back to `deleting`, and the generation bumps.
		const row = await read_meeting_row(env);
		expect(row).toEqual({
			status: "deleted_tombstone",
			processing_generation: 3,
			closed_at: null,
			updated_at: SEEDED_AT,
		});

		expect(requested._yay?.status).toBe("deleted_tombstone");
		expect(await read_outbox_rows(env)).toEqual([]);
		expect(queueSent).toEqual([]);
	});

	test("a ready meeting starts one delete generation and dispatches it", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_sealed_grant(env);
		await seed_meeting(env, {
			status: "ready",
			processingGrantId: "grant-2",
			processingGeneration: 3,
			createdAt: SEEDED_AT,
		});
		const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");

		const requested = await council_request_meeting_delete(env, meeting!, NOW);
		expect(requested._yay?.status).toBe("deleting");

		// The positive control for the tombstone test above: the same fixture and the same call do
		// bump a generation when the status allows it, so that test's frozen row means something.
		const row = await read_meeting_row(env);
		expect(row).toEqual({ status: "deleting", processing_generation: 4, closed_at: null, updated_at: NOW });
		expect(await read_outbox_rows(env)).toEqual([
			{ kind: "delete_meeting", generation: 4, status: "handoff_pending" },
		]);
		expect(queueSent).toHaveLength(1);
	});

	test("a delete whose handoff is still queued is re-dispatched without a new generation", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_sealed_grant(env);
		await seed_meeting(env, {
			status: "deleting",
			processingGrantId: "grant-2",
			processingGeneration: 2,
			createdAt: SEEDED_AT,
		});
		// `handoff_pending` is the window between the Queue send and the consumer creating the
		// instance. The instance does not exist yet on purpose: asking Workflow.get about it answers
		// "missing", so only the outbox status can tell a queued handoff from an abandoned one.
		await env.COUNCIL_DB.prepare(
			`INSERT INTO event_outbox (id, meeting_id, kind, generation, status, attempts, created_at, updated_at)
			VALUES ('outbox-1', 'meeting-1', 'delete_meeting', 2, 'handoff_pending', 1, ?, ?)`,
		)
			.bind(SEEDED_AT, SEEDED_AT)
			.run();
		const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");

		const requested = await council_request_meeting_delete(env, meeting!, NOW);
		expect(requested._yay?.status).toBe("deleting");

		// Bumping here would start a second delete workflow over the same files while the first one
		// is still on its way to the consumer.
		const row = await read_meeting_row(env);
		expect(row).toEqual({
			status: "deleting",
			processing_generation: 2,
			closed_at: null,
			updated_at: SEEDED_AT,
		});
		expect(await read_outbox_rows(env)).toEqual([
			{ kind: "delete_meeting", generation: 2, status: "handoff_pending" },
		]);
		// The re-send is the point: a lost Queue message gets another chance without a new generation.
		expect(queueSent).toEqual([{ outboxId: "outbox-1" }]);
	});
});
