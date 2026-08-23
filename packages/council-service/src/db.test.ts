import { describe, expect, test } from "vitest";

import { council_rate_limit, council_RATE_LIMITS, council_transition_meeting } from "./db.ts";
import { council_max_participants } from "./env.ts";
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

	test("an expected generation guards the write the same way the status list does", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", processingGeneration: 2 });

		// The row belongs to generation 2 now, so generation 1's terminal write must not apply.
		const stale = await council_transition_meeting(env.COUNCIL_DB, {
			meetingId: "meeting-1",
			from: ["processing"],
			to: "failed",
			now: 123,
			expectedProcessingGeneration: 1,
		});
		expect(stale).toBe(false);
		const untouched = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(untouched?.status).toBe("processing");

		// The generation that owns the row still moves it.
		const moved = await council_transition_meeting(env.COUNCIL_DB, {
			meetingId: "meeting-1",
			from: ["processing"],
			to: "failed",
			now: 124,
			expectedProcessingGeneration: 2,
		});
		expect(moved).toBe(true);
	});

	test("requireNoRecording guards the write the same way the status list does", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: 456, providerRecordingId: "rec-1" });

		// A recording is attached, so the no-recording transition must not apply even though the
		// status matches.
		const refused = await council_transition_meeting(env.COUNCIL_DB, {
			meetingId: "meeting-1",
			from: ["open"],
			to: "recording_start_unknown",
			now: 123,
			requireNoRecording: true,
		});
		expect(refused).toBe(false);
		const untouched = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(untouched?.status).toBe("open");

		// With no recording attached the same transition still moves the row.
		await env.COUNCIL_DB.prepare("UPDATE meetings SET provider_recording_id = NULL WHERE id = 'meeting-1'").run();
		const moved = await council_transition_meeting(env.COUNCIL_DB, {
			meetingId: "meeting-1",
			from: ["open"],
			to: "recording_start_unknown",
			now: 124,
			requireNoRecording: true,
		});
		expect(moved).toBe(true);
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
		// Spend the bucket's own limit. This test is about the window length, and the test below owns
		// how large the limit has to be, so reading it here keeps the two from arguing.
		for (let attempt = 0; attempt < council_RATE_LIMITS.guest_join_ip.limit; attempt++) {
			const verdict = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_ip", key: "ip", now });
			expect(verdict.allowed).toBe(true);
		}
		const refused = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_ip", key: "ip", now });
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) {
			expect(refused.retryAfterSeconds).toBe(600);
		}
	});

	test("one office address can join a whole meeting before the guest IP bucket refuses", async () => {
		const { env } = make_test_env();
		const now = 0;
		// Everyone behind one office or conference-room NAT reaches the guest route from the same
		// egress IP, so this bucket has to outlast the participant cap instead of one person's
		// retries. A seat can also spend a second attempt: the limit runs before the code is checked,
		// so a mistyped code or a reload costs one.
		const seats = council_max_participants(env);
		expect(seats).toBe(25);
		for (let attempt = 0; attempt < seats * 2; attempt++) {
			const verdict = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_ip", key: "office-ip", now });
			expect(verdict.allowed).toBe(true);
		}

		// It is still an abuse limit: once that whole legitimate case is spent, the next attempt is
		// refused. Raising the participant cap has to raise `guest_join_ip` too, and this fails when
		// somebody raises one without the other.
		const refused = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_ip", key: "office-ip", now });
		expect(refused.allowed).toBe(false);
	});

	test("one meeting code can seat a whole meeting before the guest code bucket refuses", async () => {
		const { env } = make_test_env();
		const now = 0;
		// The twin of the test above. Every seat of one meeting presents the same code, so this bucket
		// is keyed on that one code and has to fit the participant cap the same way the IP bucket does,
		// with a second attempt per seat for a reload. The mistype half of the IP bucket's reason does
		// not carry over: a mistyped code hashes to a different key and never reaches this bucket.
		const seats = council_max_participants(env);
		expect(seats).toBe(25);
		for (let attempt = 0; attempt < seats * 2; attempt++) {
			const verdict = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_code", key: "code-hash", now });
			expect(verdict.allowed).toBe(true);
		}

		// `guest_join_code` states the same rule as `guest_join_ip`: raising the participant cap has to
		// raise this number too. Without this assertion the rule was pinned for one bucket and free for
		// its twin, and raising `guest_join_code` alone left the whole suite green.
		const refused = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_code", key: "code-hash", now });
		expect(refused.allowed).toBe(false);
	});
});
