import { describe, expect, test } from "vitest";

import { council_rate_limit, council_transition_meeting } from "./db.ts";
import { make_test_env, seed_grant, seed_meeting } from "../test/env.ts";

describe("council_transition_meeting", () => {
	test("moves a meeting along an allowed edge and stamps updated_at", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });

		const moved = await council_transition_meeting(env.COUNCIL_DB, {
			meetingId: "meeting-1",
			from: ["created"],
			to: "open",
			now: 123,
			set: { opened_at: 123, deadline_at: 456 },
		});
		expect(moved).toBe(true);

		const row = await env.COUNCIL_DB.prepare("SELECT status, opened_at, deadline_at, updated_at FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
			opened_at: number;
			deadline_at: number;
			updated_at: number;
		}>();
		expect(row).toEqual({ status: "open", opened_at: 123, deadline_at: 456, updated_at: 123 });
	});

	test("changes nothing when the row is not in an expected source state", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "closed" });

		const moved = await council_transition_meeting(env.COUNCIL_DB, {
			meetingId: "meeting-1",
			from: ["created"],
			to: "open",
			now: 123,
		});
		expect(moved).toBe(false);

		const row = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(row?.status).toBe("closed");
	});

	test("throws on a pair the state machine does not allow", async () => {
		const { env } = make_test_env();
		await expect(
			council_transition_meeting(env.COUNCIL_DB, {
				meetingId: "meeting-1",
				from: ["ready"],
				to: "open",
				now: 123,
			}),
		).rejects.toThrow("ready -> open is not allowed");
	});

	test("create_unknown has no edge back into open: the lost provider answer never auto-retries", async () => {
		const { env } = make_test_env();
		await expect(
			council_transition_meeting(env.COUNCIL_DB, {
				meetingId: "meeting-1",
				from: ["create_unknown"],
				to: "open",
				now: 123,
			}),
		).rejects.toThrow("create_unknown -> open is not allowed");
	});
});

describe("council_rate_limit", () => {
	test("allows exactly the limit inside one fixed window, then refuses with Retry-After", async () => {
		const { env } = make_test_env();
		const now = 1_000_000;

		for (let attempt = 0; attempt < 5; attempt++) {
			const verdict = await council_rate_limit(env.COUNCIL_DB, { name: "meeting_create", key: "k", now });
			expect(verdict.allowed).toBe(true);
		}

		const refused = await council_rate_limit(env.COUNCIL_DB, { name: "meeting_create", key: "k", now });
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) {
			// The window is an hour; the refusal says exactly how long is left of it.
			expect(refused.retryAfterSeconds).toBeGreaterThan(0);
			expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3600);
		}
	});

	test("a new window is a new row, and other keys are unaffected", async () => {
		const { env } = make_test_env();
		const now = 1_000_000;
		for (let attempt = 0; attempt < 5; attempt++) {
			await council_rate_limit(env.COUNCIL_DB, { name: "meeting_create", key: "k", now });
		}
		const refused = await council_rate_limit(env.COUNCIL_DB, { name: "meeting_create", key: "k", now });
		expect(refused.allowed).toBe(false);

		const otherKey = await council_rate_limit(env.COUNCIL_DB, { name: "meeting_create", key: "other", now });
		expect(otherKey.allowed).toBe(true);

		const nextWindow = await council_rate_limit(env.COUNCIL_DB, {
			name: "meeting_create",
			key: "k",
			now: now + 60 * 60 * 1000,
		});
		expect(nextWindow.allowed).toBe(true);
	});

	test("guest windows are ten minutes", async () => {
		const { env } = make_test_env();
		const now = 0;
		for (let attempt = 0; attempt < 10; attempt++) {
			const verdict = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_ip", key: "ip", now });
			expect(verdict.allowed).toBe(true);
		}
		const refused = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_ip", key: "ip", now });
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) {
			expect(refused.retryAfterSeconds).toBe(600);
		}
	});
});
