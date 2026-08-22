import { afterEach, describe, expect, test } from "vitest";

import worker from "./index.ts";
import { council_close_meeting } from "./lifecycle.ts";
import { council_sha256_hex } from "./crypto.ts";
import {
	FUTURE,
	install_fetch,
	make_test_env,
	seed_grant,
	seed_meeting,
	seed_participant,
	seed_room_session,
} from "../test/env.ts";

const ROOM_ORIGIN = "https://council.example";

function room_post(path: string, body: unknown, headers?: Record<string, string>) {
	return new Request(`${ROOM_ORIGIN}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

describe("council_handle_room_api /room/api/session", () => {
	test("a ticket is one-time: the second claim is refused", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });
		const ticket = "d".repeat(64);
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES (?, 'meeting-1', 'user-1', 'grant-1', ?, 0)",
		)
			.bind(await council_sha256_hex(ticket), FUTURE)
			.run();

		const first = await worker.fetch(room_post("/room/api/session", { ticket }), env);
		expect(first.status).toBe(200);

		const second = await worker.fetch(room_post("/room/api/session", { ticket }), env);
		expect(second.status).toBe(401);
	});
});

describe("council_handle_room_api /room/api/session cookie", () => {
	test("the session cookie carries the exact __Host- contract attributes", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });
		const ticket = "d".repeat(64);
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES (?, 'meeting-1', 'user-1', 'grant-1', ?, 0)",
		)
			.bind(await council_sha256_hex(ticket), FUTURE)
			.run();

		const response = await worker.fetch(room_post("/room/api/session", { ticket }), env);
		expect(response.status).toBe(200);

		const setCookie = response.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toMatch(/^__Host-council_session=[0-9a-f]{64}; /u);
		expect(setCookie).toContain("Secure");
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("SameSite=Strict");
		expect(setCookie).not.toContain("Domain");

		const body = (await response.json()) as {
			csrfToken: string;
			meeting: { id: string; status: string };
			participant: { role: string; displayName: string };
		};
		expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/u);
		expect(body.meeting.id).toBe("meeting-1");
		expect(body.participant.role).toBe("host");
		expect(body.participant.displayName).toBe("");

		// Only hashes are stored: neither the cookie value nor the CSRF token is readable from D1.
		const stored = await env.COUNCIL_DB.prepare(
			"SELECT token_hash, actor_service_grant_id, csrf_token_hash FROM room_sessions",
		).first<{
			token_hash: string;
			actor_service_grant_id: string;
			csrf_token_hash: string;
		}>();
		const cookieValue = setCookie.split(";")[0].split("=")[1];
		expect(stored?.token_hash).not.toBe(cookieValue);
		expect(stored?.actor_service_grant_id).toBe("grant-1");
		expect(stored?.csrf_token_hash).not.toBe(body.csrfToken);
	});

	test("an expired ticket is refused", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });
		const ticket = "d".repeat(64);
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES (?, 'meeting-1', 'user-1', 'grant-1', 1, 0)",
		)
			.bind(await council_sha256_hex(ticket))
			.run();

		const response = await worker.fetch(room_post("/room/api/session", { ticket }), env);
		expect(response.status).toBe(401);
	});

	test("a live cookie without a ticket resumes the session and mints a new CSRF token", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const ticket = "d".repeat(64);
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES (?, 'meeting-1', 'user-1', 'grant-1', ?, 0)",
		)
			.bind(await council_sha256_hex(ticket), FUTURE)
			.run();

		const first = await worker.fetch(room_post("/room/api/session", { ticket }), env);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { csrfToken: string };
		const setCookie = first.headers.get("Set-Cookie") ?? "";
		const cookieValue = setCookie.split(";")[0].split("=")[1];

		const resumed = await worker.fetch(
			room_post("/room/api/session", {}, { Cookie: `__Host-council_session=${cookieValue}` }),
			env,
		);
		expect(resumed.status).toBe(200);
		const resumedBody = (await resumed.json()) as { csrfToken: string; participant: { role: string } };
		expect(resumedBody.participant.role).toBe("host");
		expect(resumedBody.csrfToken).not.toBe(firstBody.csrfToken);
		expect(resumedBody.csrfToken).toMatch(/^[0-9a-f]{64}$/u);
	});

	test("a session POST with no ticket and no cookie is unauthorized", async () => {
		const { env } = make_test_env();
		const response = await worker.fetch(room_post("/room/api/session", {}), env);
		expect(response.status).toBe(401);
	});
});

describe("council_handle_room_api CSRF", () => {
	test("a call with the cookie but a wrong or missing CSRF header is refused", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const missing = await worker.fetch(
			room_post("/room/api/state", {}, { Cookie: `__Host-council_session=${session.sessionToken}` }),
			env,
		);
		expect(missing.status).toBe(401);

		const wrong = await worker.fetch(
			room_post(
				"/room/api/state",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": "f".repeat(64) },
			),
			env,
		);
		expect(wrong.status).toBe(401);

		const right = await worker.fetch(
			room_post(
				"/room/api/state",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(right.status).toBe(200);
	});

	test("a forged cross-site Origin is refused even with a valid cookie and CSRF token", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/state",
				{},
				{
					Cookie: `__Host-council_session=${session.sessionToken}`,
					"X-Council-Csrf": session.csrfToken,
					Origin: "https://evil.example",
				},
			),
			env,
		);
		expect(response.status).toBe(401);
	});
});

describe("council_handle_room_api /room/api/guest-session", () => {
	const guest_body = (overrides?: Record<string, unknown>) => ({
		meetingId: "meeting-1",
		code: "a".repeat(64),
		displayName: "Casey Guest",
		email: "casey@example.com",
		joinAttemptId: "attempt-1",
		...overrides,
	});

	test("a wrong code is refused after burning the code bucket, and no participant exists", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ code: "f".repeat(64) }), { "CF-Connecting-IP": "1.2.3.4" }),
			env,
		);
		expect(response.status).toBe(401);
		const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_participants").first<{ n: number }>();
		expect(count?.n).toBe(0);
	});

	test("a meeting that is not open refuses guests and names the real reason", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		// One meeting per state a code-holding guest can hit: not opened yet, expired, ended, and
		// open but past its deadline.
		await seed_meeting(env, { status: "created" });
		await seed_meeting(env, { id: "meeting-2", code: "b".repeat(64), status: "expired" });
		await seed_meeting(env, { id: "meeting-3", code: "c".repeat(64), status: "closed" });
		await seed_meeting(env, { id: "meeting-4", code: "d".repeat(64), status: "open", deadlineAt: 1 });

		const notOpenYet = await worker.fetch(
			room_post("/room/api/guest-session", guest_body(), { "CF-Connecting-IP": "1.2.3.4" }),
			env,
		);
		expect(notOpenYet.status).toBe(409);
		expect(((await notOpenYet.json()) as { message: string }).message).toBe(
			"The meeting is not open yet. Ask the host to open it, then try again.",
		);

		const expired = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ meetingId: "meeting-2", code: "b".repeat(64) }), {
				"CF-Connecting-IP": "1.2.3.4",
			}),
			env,
		);
		expect(expired.status).toBe(409);
		expect(((await expired.json()) as { message: string }).message).toBe(
			"This meeting expired before it was opened. It cannot be joined anymore.",
		);

		const ended = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ meetingId: "meeting-3", code: "c".repeat(64) }), {
				"CF-Connecting-IP": "1.2.3.4",
			}),
			env,
		);
		expect(ended.status).toBe(409);
		expect(((await ended.json()) as { message: string }).message).toBe(
			"This meeting has ended. It cannot be joined anymore.",
		);

		const pastDeadline = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ meetingId: "meeting-4", code: "d".repeat(64) }), {
				"CF-Connecting-IP": "1.2.3.4",
			}),
			env,
		);
		expect(pastDeadline.status).toBe(409);
		expect(((await pastDeadline.json()) as { message: string }).message).toBe(
			"This meeting has ended. It cannot be joined anymore.",
		);
	});

	test("the same attempt with the same identity replays; a different identity conflicts", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const first = await worker.fetch(
			room_post("/room/api/guest-session", guest_body(), { "CF-Connecting-IP": "1.2.3.4" }),
			env,
		);
		expect(first.status).toBe(200);
		const replay = await worker.fetch(
			room_post("/room/api/guest-session", guest_body(), { "CF-Connecting-IP": "1.2.3.4" }),
			env,
		);
		expect(replay.status).toBe(200);
		const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_participants").first<{ n: number }>();
		expect(count?.n).toBe(1);

		const conflict = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ displayName: "Somebody Else" }), {
				"CF-Connecting-IP": "1.2.3.4",
			}),
			env,
		);
		expect(conflict.status).toBe(409);
	});

	test("no plaintext email is stored, only the keyed HMAC", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		await worker.fetch(room_post("/room/api/guest-session", guest_body(), { "CF-Connecting-IP": "1.2.3.4" }), env);
		const stored = await env.COUNCIL_DB.prepare("SELECT email_hmac FROM meeting_participants").first<{
			email_hmac: string;
		}>();
		expect(stored?.email_hmac).toMatch(/^[0-9a-f]{64}$/u);
		expect(stored?.email_hmac).not.toContain("casey");
	});

	test("the eleventh attempt from one IP inside ten minutes is refused with Retry-After", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		for (let attempt = 0; attempt < 10; attempt++) {
			const response = await worker.fetch(
				room_post("/room/api/guest-session", guest_body({ joinAttemptId: `attempt-${attempt}` }), {
					"CF-Connecting-IP": "9.9.9.9",
				}),
				env,
			);
			expect(response.status).toBe(200);
		}
		const refused = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ joinAttemptId: "attempt-11" }), {
				"CF-Connecting-IP": "9.9.9.9",
			}),
			env,
		);
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	test("without the trusted edge IP header the guest route refuses in production", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(room_post("/room/api/guest-session", guest_body()), env);
		expect(response.status).toBe(400);
	});
});

describe("council_handle_room_api /room/api/join", () => {
	test("mints the provider token, stores both ids, and a replay returns the same token without a second provider call", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1", displayName: "Casey Guest" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});
		const headers = {
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};

		const first = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { authToken: string };
		expect(firstBody.authToken.length).toBeGreaterThan(0);

		const row = await env.COUNCIL_DB.prepare(
			"SELECT provider_participant_id, provider_token_encrypted, accepted_at FROM meeting_participants WHERE id = ?",
		)
			.bind(participant.id)
			.first<{ provider_participant_id: string; provider_token_encrypted: string; accepted_at: number }>();
		expect(row?.provider_participant_id).toMatch(/^prov-/u);
		// Encrypted at rest, never the raw token.
		expect(row?.provider_token_encrypted).not.toContain(firstBody.authToken);
		expect(row?.accepted_at).not.toBeNull();

		const providerCallsBefore = mock.calls.filter((call) => call.url.includes("/participants")).length;
		const replay = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		const replayBody = (await replay.json()) as { authToken: string };
		expect(replayBody.authToken).toBe(firstBody.authToken);
		expect(mock.calls.filter((call) => call.url.includes("/participants")).length).toBe(providerCallsBefore);

		// One slot consumed, once.
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT participant_count FROM meetings WHERE id = 'meeting-1'",
		).first<{
			participant_count: number;
		}>();
		expect(meeting?.participant_count).toBe(1);
	});

	test("the host join stores the typed display name before Add Participant", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			role: "host",
			displayName: "",
		});
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
		});
		const headers = {
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};

		const refused = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(refused.status).toBe(400);

		const joined = await worker.fetch(room_post("/room/api/join", { displayName: "Ada Host" }, headers), env);
		expect(joined.status).toBe(200);
		const stored = await env.COUNCIL_DB.prepare("SELECT display_name FROM meeting_participants WHERE id = ?")
			.bind(participant.id)
			.first<{ display_name: string }>();
		expect(stored?.display_name).toBe("Ada Host");
		const added = mock.calls.find((call) => call.method === "POST" && call.url.includes("/participants"));
		expect(added?.bodyJson).toMatchObject({ name: "Ada Host" });
	});

	test("fails closed when verify-live refuses, before any provider effect", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/service-grants/verify-live": () => Response.json({ message: "Gone" }, { status: 409 }),
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/join",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(409);
		expect(mock.calls.some((call) => call.url.includes("/participants"))).toBe(false);
	});

	test("checks the exact host grant that minted the room session", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-b", actorUserId: "user-b", updatedAt: 1 });
		await seed_grant(env, { id: "grant-dead", actorUserId: "user-b", expiresAt: 1, updatedAt: 2 });
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			role: "host",
			displayName: "Ada Host",
			joinAttemptId: "host-user-b",
		});
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
			actorServiceGrantId: "grant-b",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/join",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(200);
		expect(mock.calls.some((call) => call.url.includes("/participants"))).toBe(true);
	});

	test("fails closed when the host actor grant is dead even if the opener pin is live", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-b", actorUserId: "user-b", expiresAt: 1 });
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			role: "host",
			displayName: "Ada Host",
			joinAttemptId: "host-user-b",
		});
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
			actorServiceGrantId: "grant-b",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/join",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(409);
		expect(((await response.json()) as { message: string }).message).toBe("The meeting's authority is no longer live");
		expect(mock.calls.some((call) => call.url.includes("/participants"))).toBe(false);
	});

	test("a provider refusal releases the reserved slot", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/participants": () => Response.json({ success: false }, { status: 400 }),
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE, participantCount: 3 });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/join",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(502);
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT participant_count FROM meetings WHERE id = 'meeting-1'",
		).first<{
			participant_count: number;
		}>();
		expect(meeting?.participant_count).toBe(3);
	});

	test("a thrown preset request releases the admission lease and slot", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch({
			"/presets": () => {
				throw new Error("preset network lost");
			},
		}).restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/join",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);

		expect(response.status).toBe(502);
		expect(
			await env.COUNCIL_DB.prepare(
				"SELECT accepted_at, admission_attempt_id, admission_attempt_started_at FROM meeting_participants WHERE id = ?",
			)
				.bind(participant.id)
				.first(),
		).toEqual({ accepted_at: null, admission_attempt_id: null, admission_attempt_started_at: null });
		expect(
			await env.COUNCIL_DB.prepare("SELECT participant_count FROM meetings WHERE id = 'meeting-1'").first(),
		).toEqual({ participant_count: 0 });
	});

	test("a second overlapping join cannot share or release the first attempt's slot", async () => {
		const { env } = make_test_env();
		let resolveAdd!: (response: Response) => void;
		const addResponse = new Promise<Response>((resolve) => {
			resolveAdd = resolve;
		});
		const mock = install_fetch({
			"/participants": () => addResponse,
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE, participantCount: 0 });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});
		const headers = {
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};

		const firstResponse = worker.fetch(room_post("/room/api/join", {}, headers), env);
		await expect.poll(() => mock.calls.filter((call) => call.url.includes("/participants")).length).toBe(1);
		const second = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(second.status).toBe(409);
		resolveAdd(
			Response.json({
				success: true,
				data: { id: "prov-owned", token: "tokenheader.tokenpayload.tokensig" },
			}),
		);
		const first = await firstResponse;
		expect(first.status).toBe(200);
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT participant_count FROM meetings WHERE id = 'meeting-1'",
		).first<{
			participant_count: number;
		}>();
		expect(meeting?.participant_count).toBe(1);
	});

	test("a lost answer keeps one slot and only one overlapping retry can own it", async () => {
		const { env } = make_test_env();
		let attempts = 0;
		let resolveRetry!: (response: Response) => void;
		const retryResponse = new Promise<Response>((resolve) => {
			resolveRetry = resolve;
		});
		const mock = install_fetch({
			"/participants": () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("socket dropped");
				}
				return retryResponse;
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE, participantCount: 3 });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});
		const headers = {
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};

		const lost = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(lost.status).toBe(502);
		const afterLost = await env.COUNCIL_DB.prepare(
			"SELECT participant_count FROM meetings WHERE id = 'meeting-1'",
		).first<{ participant_count: number }>();
		expect(afterLost?.participant_count).toBe(4);
		const held = await env.COUNCIL_DB.prepare(
			"SELECT accepted_at, provider_token_encrypted FROM meeting_participants WHERE id = ?",
		)
			.bind(participant.id)
			.first<{ accepted_at: number | null; provider_token_encrypted: string | null }>();
		expect(held?.accepted_at).not.toBeNull();
		expect(held?.provider_token_encrypted).toBeNull();

		const retrying = worker.fetch(room_post("/room/api/join", {}, headers), env);
		await expect.poll(() => attempts).toBe(2);
		const overlappingRetry = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(overlappingRetry.status).toBe(409);
		resolveRetry(
			Response.json({
				success: true,
				data: { id: "prov-retry", token: "tokenheader.tokenpayload.tokensig" },
			}),
		);
		const retried = await retrying;
		expect(retried.status).toBe(200);
		const afterRetry = await env.COUNCIL_DB.prepare(
			"SELECT participant_count FROM meetings WHERE id = 'meeting-1'",
		).first<{ participant_count: number }>();
		expect(afterRetry?.participant_count).toBe(4);
		expect(attempts).toBe(2);
	});

	test("deletes a participant and releases its slot when the meeting closes during Add Participant", async () => {
		const { env } = make_test_env();
		let resolveAdd!: (response: Response) => void;
		const addResponse = new Promise<Response>((resolve) => {
			resolveAdd = resolve;
		});
		const mock = install_fetch({
			"/participants": (call) =>
				call.method === "POST" ? addResponse : Response.json({ success: true, data: { action: "delete" } }),
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});
		const headers = {
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};

		const joining = worker.fetch(room_post("/room/api/join", {}, headers), env);
		await expect
			.poll(() => mock.calls.filter((call) => call.method === "POST" && call.url.includes("/participants")).length)
			.toBe(1);
		await env.COUNCIL_DB.prepare(
			"UPDATE meetings SET status = 'closed', deadline_at = NULL WHERE id = 'meeting-1'",
		).run();
		resolveAdd(
			Response.json({
				success: true,
				data: { id: "prov-too-late", token: "lateheader.latepayload.latesig" },
			}),
		);

		const response = await joining;
		expect(response.status).toBe(409);
		expect(
			mock.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/participants/prov-too-late")),
		).toBe(true);
		const stored = await env.COUNCIL_DB.prepare(
			"SELECT accepted_at, admission_attempt_id, provider_token_encrypted FROM meeting_participants WHERE id = ?",
		)
			.bind(participant.id)
			.first<{
				accepted_at: number | null;
				admission_attempt_id: string | null;
				provider_token_encrypted: string | null;
			}>();
		expect(stored).toEqual({ accepted_at: null, admission_attempt_id: null, provider_token_encrypted: null });
		expect(
			await env.COUNCIL_DB.prepare("SELECT participant_count FROM meetings WHERE id = 'meeting-1'").first<{
				participant_count: number;
			}>(),
		).toEqual({ participant_count: 0 });
	});

	test("the 26th accepted participant is refused", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, {
			status: "open",
			deadlineAt: FUTURE,
			participantCount: 25,
		});
		const participant = await seed_participant(env, { meetingId: "meeting-1", displayName: "Guest 26" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/join",
				{},
				{
					Cookie: `__Host-council_session=${session.sessionToken}`,
					"X-Council-Csrf": session.csrfToken,
				},
			),
			env,
		);
		expect(response.status).toBe(409);

		// The cap counts slots, never attempts: the refused join must not consume one.
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT participant_count FROM meetings WHERE id = 'meeting-1'",
		).first<{
			participant_count: number;
		}>();
		expect(meeting?.participant_count).toBe(25);
	});
});

describe("council_handle_room_api /room/api/host/start-recording", () => {
	async function seed_host_session(env: ReturnType<typeof make_test_env>["env"]) {
		const participant = await seed_participant(env, { meetingId: "meeting-1", role: "host", displayName: "Host" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
		});
		return {
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};
	}

	test("a guest cannot start the recording", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1", role: "guest" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/host/start-recording",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(403);
	});

	test("fails closed when the host actor grant is dead even if the opener pin is live", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-b", actorUserId: "user-b", expiresAt: 1 });
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			role: "host",
			displayName: "Host",
			joinAttemptId: "host-user-b",
		});
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
			actorServiceGrantId: "grant-b",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/host/start-recording",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(409);
		expect(((await response.json()) as { message: string }).message).toBe("The meeting's authority is no longer live");
		expect(mock.calls.some((call) => call.url.includes("/recordings/track"))).toBe(false);
	});

	test("starts recording with the exact live grant that minted the room session", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-b", actorUserId: "user-b", updatedAt: 1 });
		await seed_grant(env, { id: "grant-dead", actorUserId: "user-b", expiresAt: 1, updatedAt: 2 });
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			role: "host",
			displayName: "Host",
			joinAttemptId: "host-user-b",
		});
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
			actorServiceGrantId: "grant-b",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/host/start-recording",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(200);
		expect(mock.calls.some((call) => call.url.includes("/recordings/track"))).toBe(true);
	});

	test("starts the track recording with the meeting-length cap and stores the recording id", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);

		const response = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(response.status).toBe(200);

		const recordingCall = mock.calls.find((call) => call.url.includes("/recordings/track"));
		expect(recordingCall?.bodyJson).toEqual({ meeting_id: "pm-1", max_seconds: 3600 });

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT provider_recording_id, recording_started_at, status FROM meetings WHERE id = 'meeting-1'",
		).first<{ provider_recording_id: string; recording_started_at: number; status: string }>();
		expect(meeting?.provider_recording_id).toBe("rec-1");
		expect(meeting?.recording_started_at).not.toBeNull();
		expect(meeting?.status).toBe("open");
	});

	test("a second start is refused while a recording is already running", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE, providerRecordingId: "rec-1" });
		const headers = await seed_host_session(env);

		const response = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(response.status).toBe(409);
	});

	test("a lost provider answer moves the meeting to recording_start_unknown and never auto-retries", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/recordings/track": () => {
				throw new Error("socket dropped");
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);

		const response = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(response.status).toBe(502);

		const meeting = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(meeting?.status).toBe("recording_start_unknown");

		// A retry from the page is refused: two recordings could otherwise run at once.
		const retry = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(retry.status).toBe(409);
	});

	test("a close during the in-flight provider call refuses the late answer and stops the recording", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);

		// The host closes the meeting while the provider answer is still in the air. Close finds no
		// recording id in the row, so its own stop step does nothing — the late answer must not land
		// in the settled row, and the just-started recording must be stopped again.
		let closeStatus = 0;
		const mock = install_fetch({
			"/recordings/track": async () => {
				const closed = await worker.fetch(room_post("/room/api/host/close", {}, headers), env);
				closeStatus = closed.status;
				return Response.json({ success: true, data: { recording: { id: "rec-late" } } });
			},
			"/recordings/rec-late": () => Response.json({ success: true, data: { action: "stop" } }),
		});
		restoreFetch = mock.restore;

		const response = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(closeStatus).toBe(200);
		expect(response.status).toBe(409);
		// The two refusals say different things on purpose: here the meeting ended.
		expect(await response.json()).toEqual({ message: "The meeting is not open" });

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(meeting?.status).toBe("ready");
		expect(meeting?.provider_recording_id).toBeNull();

		const stopCall = mock.calls.find((call) => call.url.includes("/recordings/rec-late"));
		expect(stopCall?.method).toBe("PUT");
		expect(stopCall?.bodyJson).toEqual({ action: "stop" });
	});

	test("two overlapping starts keep exactly one recording and stop the other", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);

		// A second start from another host tab runs to completion while the first provider answer is
		// still in the air. Both provider recordings started, so the loser must stop its own.
		let trackCalls = 0;
		let second: Response | null = null;
		const mock = install_fetch({
			"/recordings/track": async () => {
				trackCalls += 1;
				if (trackCalls === 1) {
					second = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
					return Response.json({ success: true, data: { recording: { id: "rec-first" } } });
				}
				return Response.json({ success: true, data: { recording: { id: "rec-second" } } });
			},
			"/recordings/rec-first": () => Response.json({ success: true, data: { action: "stop" } }),
		});
		restoreFetch = mock.restore;

		const first = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(second?.status).toBe(200);
		expect(first.status).toBe(409);
		// Here the meeting is still open, so the host is told the other tab already started one.
		expect(await first.json()).toEqual({ message: "The recording is already running" });

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(meeting?.status).toBe("open");
		expect(meeting?.provider_recording_id).toBe("rec-second");

		const stopCall = mock.calls.find((call) => call.url.includes("/recordings/rec-first"));
		expect(stopCall?.method).toBe("PUT");
	});

	test("a failed attach write still stops the recording it could not store", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);
		const mock = install_fetch({
			"/recordings/track": () => Response.json({ success: true, data: { recording: { id: "rec-unstored" } } }),
			"/recordings/rec-unstored": () => Response.json({ success: true, data: { action: "stop" } }),
		});
		restoreFetch = mock.restore;

		// D1 fails on the one write that stores the recording id. Nothing else knows the id exists, so
		// `handle_start_recording` is the only place that can still stop it.
		const db = env.COUNCIL_DB;
		env.COUNCIL_DB = {
			...db,
			prepare: (query: string) => {
				const statement = db.prepare(query);
				if (!query.startsWith("UPDATE meetings SET provider_recording_id")) {
					return statement;
				}

				return {
					...statement,
					bind: (...values: unknown[]) => ({
						...statement.bind(...values),
						run: async () => {
							throw new Error("D1 is unavailable");
						},
					}),
				};
			},
		};

		const response = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(response.status).toBe(500);

		const stopCall = mock.calls.find((call) => call.url.includes("/recordings/rec-unstored"));
		expect(stopCall?.method).toBe("PUT");
		const meeting = await db
			.prepare("SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'")
			.first<{ status: string; provider_recording_id: string | null }>();
		expect(meeting).toEqual({ status: "open", provider_recording_id: null });
	});
});

describe("council_handle_room_api /room/api/host/close", () => {
	test("a guest cannot close the meeting", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1", role: "guest" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/host/close",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(403);
	});

	test("closing a recorded meeting hands it to processing with the grant the open sealed", async () => {
		const { env, queueSent } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		// The open already sealed processing authority; close only hands the work over.
		await seed_grant(env, { id: "grant-proc", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, {
			status: "open",
			deadlineAt: FUTURE,
			providerRecordingId: "rec-1",
			processingGrantId: "grant-proc",
		});
		const participant = await seed_participant(env, { meetingId: "meeting-1", role: "host", displayName: "Host" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/host/close",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { status: string }).status).toBe("processing");

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation, processing_grant_id, provider_session_id FROM meetings WHERE id = 'meeting-1'",
		).first<{
			status: string;
			processing_generation: number;
			processing_grant_id: string;
			provider_session_id: string;
		}>();
		expect(meeting?.status).toBe("processing");
		expect(meeting?.processing_generation).toBe(1);
		expect(meeting?.processing_grant_id).toBe("grant-proc");
		expect(meeting?.provider_session_id).toBe("sess-1");

		// Close never talks to the seal route: the authority already exists.
		expect(mock.calls.some((call) => call.url.includes("/seal-processing"))).toBe(false);

		const outbox = await env.COUNCIL_DB.prepare("SELECT kind, generation, status FROM event_outbox").first<{
			kind: string;
			generation: number;
			status: string;
		}>();
		expect(outbox).toEqual({ kind: "process_meeting", generation: 1, status: "handoff_pending" });
		expect(queueSent.length).toBe(1);
	});

	test("closing without a recording settles at ready with no processing work", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1", role: "host", displayName: "Host" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/host/close",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		// With no recording there is nothing to process, so close finishes the meeting directly.
		expect(((await response.json()) as { status: string }).status).toBe("ready");

		const outbox = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM event_outbox").first<{ n: number }>();
		expect(outbox?.n).toBe(0);
		expect(queueSent.length).toBe(0);
	});

	test("the host can close after the pin grant dies", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env, { expiresAt: 1 });
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1", role: "host", displayName: "Host" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/host/close",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { status: string }).status).toBe("ready");
	});

	// Call the close directly instead of through the route: the hook below has to fire on the close's
	// own read of the meeting, and going through the route would put earlier reads in front of it.
	test("a recording attached between the close's read and its transition is still stopped and processed", async () => {
		const { env, queueSent } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_grant(env, { id: "grant-proc", phase: "processing", destinationPathPrefix: "/meetings/meeting-1" });
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE, processingGrantId: "grant-proc" });

		// A start-recording call needs only an open row, so it can attach its id after the close read
		// the meeting and before the close transition commits. That is the window the guarded write in
		// `handle_start_recording` cannot close, because at that moment the row really is still open.
		const db = env.COUNCIL_DB;
		let attached = false;
		env.COUNCIL_DB = {
			...db,
			prepare: (query: string) => {
				const statement = db.prepare(query);
				if (attached || !query.includes("FROM meetings WHERE id")) {
					return statement;
				}

				return {
					...statement,
					bind: (...values: unknown[]) => {
						const bound = statement.bind(...values);
						return {
							...bound,
							first: async <T>() => {
								const row = await bound.first<T>();
								attached = true;
								await db.prepare("UPDATE meetings SET provider_recording_id = 'rec-late' WHERE id = 'meeting-1'").run();
								return row;
							},
						};
					},
				};
			},
		};

		const closed = await council_close_meeting(env, "meeting-1", Date.now());
		expect(closed._yay?.status).toBe("processing");

		// The recording must not be left running to its max_seconds cap, and the meeting must not
		// settle at `ready` with a transcript nobody will ever produce.
		expect(mock.calls.some((call) => call.url.endsWith("/recordings/rec-late") && call.method === "PUT")).toBe(true);
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string }>();
		expect(meeting).toEqual({ status: "processing", provider_recording_id: "rec-late" });
		expect(queueSent.length).toBe(1);
	});
});
