import { afterEach, describe, expect, test } from "vitest";

import worker from "./index.ts";
import { council_close_meeting } from "./lifecycle.ts";
import { council_RATE_LIMITS } from "./db.ts";
import { council_encrypt, council_sha256_hex } from "./crypto.ts";
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

	test("a guest cannot take the host's participant row by sending the host's attempt key", async () => {
		const { env } = make_test_env();
		await seed_grant(env, { actorUserId: "user-a" });
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		// The attack: the opener's user id is published to the plugin page as `createdBy`, so a guest
		// can send the exact key the host's own row will use. Read the answer without asserting it —
		// the point of this test is what the HOST gets afterwards.
		const squat = await worker.fetch(
			room_post(
				"/room/api/guest-session",
				{
					meetingId: "meeting-1",
					code: "a".repeat(64),
					displayName: "Squatter",
					joinAttemptId: "host-user-a",
				},
				{ "CF-Connecting-IP": "1.2.3.4" },
			),
			env,
		);
		const squatted = (await squat.json()) as { participant?: { id: string } };

		const ticket = "d".repeat(64);
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES (?, 'meeting-1', 'user-a', 'grant-1', ?, 0)",
		)
			.bind(await council_sha256_hex(ticket), FUTURE)
			.run();

		const response = await worker.fetch(room_post("/room/api/session", { ticket }), env);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { participant: { id: string; role: string; displayName: string } };
		expect(body.participant.role).toBe("host");
		expect(body.participant.id).not.toBe(squatted.participant?.id);
		// The row behind the session is the host's own: empty name, host role, and the only row on
		// the reserved key.
		expect(body.participant.displayName).toBe("");
		const stored = await env.COUNCIL_DB.prepare(
			"SELECT id, role FROM meeting_participants WHERE meeting_id = 'meeting-1' AND join_attempt_id = ?",
		)
			.bind("host-user-a")
			.all<{ id: string; role: string }>();
		expect(stored.results).toEqual([{ id: body.participant.id, role: "host" }]);
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
			meeting: { id: string; status: string; recordingStarted: boolean };
			participant: { role: string; displayName: string };
		};
		expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/u);
		expect(body.meeting.id).toBe("meeting-1");
		// The room page reads this on boot to decide whether Start recording is still offered.
		expect(body.meeting.recordingStarted).toBe(false);
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

	test("a resume naming another meeting is refused and leaves the live session untouched", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		// The visitor is in meeting-1 and then opens a room link for meeting-2. One `__Host-` cookie
		// covers both meetings, so without the meeting check the resume below hands back meeting-1
		// and the visitor rejoins the meeting they came from.
		await seed_meeting(env, { id: "meeting-2", code: "b".repeat(64), status: "open", deadlineAt: FUTURE });
		const ticket = "d".repeat(64);
		await env.COUNCIL_DB.prepare(
			"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES (?, 'meeting-1', 'user-1', 'grant-1', ?, 0)",
		)
			.bind(await council_sha256_hex(ticket), FUTURE)
			.run();

		const first = await worker.fetch(room_post("/room/api/session", { ticket }), env);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { csrfToken: string };
		const cookieValue = (first.headers.get("Set-Cookie") ?? "").split(";")[0].split("=")[1];
		const cookie = { Cookie: `__Host-council_session=${cookieValue}` };

		const read_session = () =>
			env.COUNCIL_DB.prepare("SELECT csrf_token_hash, expires_at FROM room_sessions WHERE meeting_id = 'meeting-1'")
				.first<{ csrf_token_hash: string; expires_at: number }>();
		const before = await read_session();

		const wrongMeeting = await worker.fetch(room_post("/room/api/session", { meetingId: "meeting-2" }, cookie), env);
		expect(wrongMeeting.status).toBe(401);

		// The refusal has to happen before the CSRF rotation. A page opened for another meeting must
		// not invalidate the CSRF token the page that owns this session is still using.
		const after = await read_session();
		expect(after?.csrf_token_hash).toBe(before?.csrf_token_hash);
		expect(after?.expires_at).toBe(before?.expires_at);

		// Control: the same cookie still resumes its own meeting, so the check refuses the mismatch
		// rather than refusing every resume.
		const ownMeeting = await worker.fetch(room_post("/room/api/session", { meetingId: "meeting-1" }, cookie), env);
		expect(ownMeeting.status).toBe(200);
		const ownBody = (await ownMeeting.json()) as { csrfToken: string; meeting: { id: string } };
		expect(ownBody.meeting.id).toBe("meeting-1");
		expect(ownBody.csrfToken).not.toBe(firstBody.csrfToken);
	});

	test("a session POST with no ticket and no cookie is unauthorized", async () => {
		const { env } = make_test_env();
		const response = await worker.fetch(room_post("/room/api/session", {}), env);
		expect(response.status).toBe(401);
	});
});

describe("council_handle_room_api method", () => {
	test("a wrong method is refused as one, not as an unauthenticated or unknown call", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});
		const headers = {
			Origin: ROOM_ORIGIN,
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};

		// Everything else about this call is right: a real route, this Worker's own origin, a live
		// session cookie and the CSRF token that matches it. `/room/api/state` also reads no body, so
		// there is nothing a GET could be missing. The method is the only thing left to refuse.
		const wrongMethod = await worker.fetch(
			new Request(`${ROOM_ORIGIN}/room/api/state`, { method: "GET", headers }),
			env,
		);
		expect(wrongMethod.status).toBe(405);

		// The control that makes the assertion above about the method and nothing else: the same
		// request as a POST is served. Without it a 405 could be hiding a refusal for another reason.
		const rightMethod = await worker.fetch(room_post("/room/api/state", {}, headers), env);
		expect(rightMethod.status).toBe(200);
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

	test("a cross-site Origin is refused before the guest door spends a rate-limit token", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const body = {
			meetingId: "meeting-1",
			code: "a".repeat(64),
			displayName: "Casey Guest",
			joinAttemptId: "attempt-1",
		};
		const ip_buckets = async () =>
			(
				await env.COUNCIL_DB.prepare(
					"SELECT bucket_key FROM rate_limit_windows WHERE bucket_key LIKE 'guest_join_ip:%'",
				).all<{ bucket_key: string }>()
			).results.map((row) => row.bucket_key);

		// Everything a real guest sends, posted from another site. The guest door spends its
		// `guest_join_ip` token before it even reads the body, so a refusal inside the handler would
		// still charge this address. Fifty of these would then lock every guest behind it out of every
		// meeting for the rest of the window. Only a refusal before the routing leaves the bucket
		// untouched.
		const forged = await worker.fetch(
			room_post("/room/api/guest-session", body, { "CF-Connecting-IP": "1.2.3.4", Origin: "https://evil.example" }),
			env,
		);
		expect(forged.status).toBe(401);
		await expect(ip_buckets()).resolves.toEqual([]);

		// Control: the same body from a caller the check allows does reach the guest door and does
		// spend the token. Without this, an empty table above would also pass if the bucket were never
		// spent here at all.
		const allowed = await worker.fetch(
			room_post("/room/api/guest-session", body, { "CF-Connecting-IP": "1.2.3.4", Origin: ROOM_ORIGIN }),
			env,
		);
		expect(allowed.status).toBe(200);
		await expect(ip_buckets()).resolves.toEqual(["guest_join_ip:1.2.3.4"]);
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

		// The installation bucket is spent below the code check, and it has to stay there. It is keyed
		// on the workspace's installation, so a guessing loop that reached it would lock every
		// legitimate guest of every meeting in that workspace out for the rest of the window.
		const installationBucket = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM rate_limit_windows WHERE bucket_key = 'guest_join_installation:inst-1'",
		).first<{ n: number }>();
		expect(installationBucket?.n).toBe(0);
	});

	test("a meeting that is not open refuses guests and names the real reason", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		// One meeting per state a code-holding guest can hit: not opened yet, expired, ended, open
		// but past its deadline, and still running but no longer admitting anyone.
		await seed_meeting(env, { status: "created" });
		await seed_meeting(env, { id: "meeting-2", code: "b".repeat(64), status: "expired" });
		await seed_meeting(env, { id: "meeting-3", code: "c".repeat(64), status: "closed" });
		await seed_meeting(env, { id: "meeting-4", code: "d".repeat(64), status: "open", deadlineAt: 1 });
		await seed_meeting(env, {
			id: "meeting-5",
			code: "e".repeat(64),
			status: "recording_start_unknown",
			deadlineAt: FUTURE,
		});

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

		// `recording_start_unknown` stops the recording and stops admitting people; it does not end
		// the meeting. This guest's colleagues are in the room at this moment, and the cron will not
		// close it until the deadline. Telling them it is over makes them stop trying.
		const stoppedAdmitting = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ meetingId: "meeting-5", code: "e".repeat(64) }), {
				"CF-Connecting-IP": "1.2.3.4",
			}),
			env,
		);
		expect(stoppedAdmitting.status).toBe(409);
		expect(((await stoppedAdmitting.json()) as { message: string }).message).toBe(
			"This meeting is still running, but it stopped letting new people in. You cannot join it anymore.",
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

	test("one address is refused once it passes the IP limit, across several meetings", async () => {
		const { env } = make_test_env();
		await seed_grant(env);

		// Spread the attempts over several meetings on purpose. `guest_join_code` is keyed on the code
		// hash and its limit is lower than the IP limit, so sending every attempt to one meeting would
		// be refused by the code bucket first and this test would pass for the wrong bucket. Keep each
		// meeting one attempt clear of the code limit, and read both numbers from the limits so the
		// split still holds when either one is re-weighed.
		const ipLimit = council_RATE_LIMITS.guest_join_ip.limit;
		const attemptsPerMeeting = council_RATE_LIMITS.guest_join_code.limit - 1;
		const meetingCount = Math.ceil((ipLimit + 1) / attemptsPerMeeting);
		const meeting_code = (index: number) => String.fromCharCode(97 + index).repeat(64);

		for (let index = 0; index < meetingCount; index++) {
			await seed_meeting(env, {
				id: `meeting-${index + 1}`,
				code: meeting_code(index),
				status: "open",
				deadlineAt: FUTURE,
			});
		}

		for (let attempt = 0; attempt < ipLimit; attempt++) {
			const index = attempt % meetingCount;
			const response = await worker.fetch(
				room_post(
					"/room/api/guest-session",
					guest_body({
						meetingId: `meeting-${index + 1}`,
						code: meeting_code(index),
						joinAttemptId: `attempt-${attempt}`,
					}),
					{ "CF-Connecting-IP": "9.9.9.9" },
				),
				env,
			);
			expect(response.status).toBe(200);
		}

		const refused = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ joinAttemptId: "attempt-over-limit" }), {
				"CF-Connecting-IP": "9.9.9.9",
			}),
			env,
		);
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);

		// Prove the refusal was about the address and not about the meeting. The same meeting and the
		// same code from a second address still get in, which no per-code or per-installation bucket
		// would allow. Without this the test cannot tell the three buckets apart, because all three
		// answer 429 with the same body.
		const otherAddress = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ joinAttemptId: "attempt-other-address" }), {
				"CF-Connecting-IP": "8.8.8.8",
			}),
			env,
		);
		expect(otherAddress.status).toBe(200);
	});

	test("without the trusted edge IP header the guest route refuses in production", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(room_post("/room/api/guest-session", guest_body()), env);
		expect(response.status).toBe(400);
	});

	test("a joinAttemptId in the host's reserved namespace is refused and writes nothing", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(
			room_post("/room/api/guest-session", guest_body({ joinAttemptId: "host-user-a" }), {
				"CF-Connecting-IP": "1.2.3.4",
			}),
			env,
		);
		expect(response.status).toBe(400);
		// The status alone would still pass if the row had been written before the refusal, so read
		// the table: the reserved key must stay free for the host's own row.
		const squatted = await env.COUNCIL_DB.prepare(
			"SELECT COUNT(*) AS n FROM meeting_participants WHERE join_attempt_id = ?",
		)
			.bind("host-user-a")
			.first<{ n: number }>();
		expect(squatted?.n).toBe(0);
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

	test("a close during the verify-live round trip is refused before any provider effect", async () => {
		const { env } = make_test_env();
		let resolveVerify!: (response: Response) => void;
		const verifyResponse = new Promise<Response>((resolve) => {
			resolveVerify = resolve;
		});
		const mock = install_fetch({
			"/service-grants/verify-live": () => verifyResponse,
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

		// The join read the meeting as open, then went out to Convex. The host presses End meeting
		// inside that round trip, which lasts as long as a network call. The admission claim below is
		// the first thing after it that can still see the close.
		const joining = worker.fetch(room_post("/room/api/join", {}, headers), env);
		await expect.poll(() => mock.calls.filter((call) => call.url.includes("/verify-live")).length).toBe(1);
		await env.COUNCIL_DB.prepare("UPDATE meetings SET status = 'closed' WHERE id = 'meeting-1'").run();
		resolveVerify(Response.json({ live: true }));

		const response = await joining;
		expect(response.status).toBe(409);
		// The claim is the backstop before the provider, not the last line: the late-answer guard after
		// Add Participant refuses with 409 too. So only the provider call count says which one refused,
		// and a claim that let this join through would put a person in a room the host already ended.
		expect(mock.calls.filter((call) => call.method === "POST" && call.url.includes("/participants")).length).toBe(0);
	});

	test("a pinned grant sealed under a rotated secret is refused, not answered with a 500", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		// What rotating COUNCIL_ROOM_COOKIE_SECRET leaves behind: still well-formed base64, but the
		// current key cannot open it. Rotation is routine hygiene and the only recovery from a
		// suspected leak, so it must refuse this join, not break the route.
		await env.COUNCIL_DB.prepare("UPDATE service_grants SET token_encrypted = ? WHERE id = 'grant-1'")
			.bind(await council_encrypt("the-secret-before-the-rotation", "psg_seeded_test_token"))
			.run();
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "guest",
		});

		// The `catch` stands in for the Worker runtime, which turns an uncaught rejection into a 500.
		// Without the guard in `council_verify_grant` the decrypt rejects and this is what the guest
		// gets, so the assertion below reads as the finding itself: 500 where 409 belongs.
		const response = await worker
			.fetch(
				room_post(
					"/room/api/join",
					{},
					{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
				),
				env,
			)
			.catch(() => new Response(null, { status: 500 }));
		expect(response.status).toBe(409);
		expect(mock.calls.some((call) => call.url.includes("/participants"))).toBe(false);
	});

	test("one guest session cannot spend the Convex verify budget: the 21st join in ten minutes is refused", async () => {
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

		// The first join mints the token and the rest replay it, so every one of these is a request the
		// guest can repeat for free.
		const limit = council_RATE_LIMITS.room_join_participant.limit;
		for (let attempt = 0; attempt < limit; attempt++) {
			const response = await worker.fetch(room_post("/room/api/join", {}, headers), env);
			expect(response.status).toBe(200);
		}
		const refused = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);

		// This is the assertion that matters: the outbound Convex call is what the bucket exists to
		// bound. A limiter placed after the verify still answers 429, but leaves this at limit + 1.
		// This fixture is a guest, and a guest press buys exactly one call. The host door costs more;
		// the test below owns that number.
		expect(mock.calls.filter((call) => call.url.includes("/service-grants/verify-live")).length).toBe(limit);
	});

	test("a host session gets the same twenty presses, and each one costs two verify calls", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		// The ordinary host: the member who opened the meeting is the one standing in the room, so the
		// session's pinned grant and the meeting's pinned grant are the same row.
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			role: "host",
			displayName: "Ada Host",
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

		const limit = council_RATE_LIMITS.room_join_participant.limit;
		for (let attempt = 0; attempt < limit; attempt++) {
			const response = await worker.fetch(room_post("/room/api/join", {}, headers), env);
			expect(response.status).toBe(200);
		}
		const refused = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(refused.status).toBe(429);

		// The bucket counts presses, not Convex calls, and the two doors do not cost the same. A host
		// press checks the meeting's pinned grant and then the grant this room session pinned, so the
		// same twenty presses buy forty outbound actions where a guest buys twenty. `council_RATE_LIMITS`
		// says that; this is what holds it true, and the guest test above cannot, because its fixture
		// never takes the host path.
		expect(mock.calls.filter((call) => call.url.includes("/service-grants/verify-live")).length).toBe(limit * 2);
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
		await env.COUNCIL_DB.prepare("UPDATE meetings SET status = 'closed' WHERE id = 'meeting-1'").run();
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

	test("a late attempt keeps the provider participant the winning attempt stored", async () => {
		const { env } = make_test_env();
		let addCalls = 0;
		let resolveLateAdd!: (response: Response) => void;
		const lateAdd = new Promise<Response>((resolve) => {
			resolveLateAdd = resolve;
		});
		// The provider dedupes on `custom_participant_id`, so both attempts for this row are answered
		// with the same provider participant.
		const mock = install_fetch({
			"/participants": (call) => {
				if (call.method !== "POST") {
					return Response.json({ success: true, data: { action: "delete" } });
				}
				addCalls += 1;
				return addCalls === 1
					? lateAdd
					: Response.json({ success: true, data: { id: "prov-shared", token: "wonheader.wonpayload.wonsig" } });
			},
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

		const late = worker.fetch(room_post("/room/api/join", {}, headers), env);
		await expect.poll(() => addCalls).toBe(1);
		// Age the first attempt's lease so the retry below can take it over, which is what puts two
		// attempts on one participant row.
		await env.COUNCIL_DB.prepare("UPDATE meeting_participants SET admission_attempt_started_at = 0 WHERE id = ?")
			.bind(participant.id)
			.run();

		const winner = await worker.fetch(room_post("/room/api/join", {}, headers), env);
		expect(winner.status).toBe(200);
		resolveLateAdd(Response.json({ success: true, data: { id: "prov-shared", token: "wonheader.wonpayload.wonsig" } }));

		const lateResponse = await late;
		expect(lateResponse.status).toBe(200);
		// Deleting the stored participant would kick the winner out of the provider room while the row
		// keeps handing out their token, so nobody could rejoin for the rest of the meeting.
		expect(mock.calls.some((call) => call.method === "DELETE" && call.url.includes("/participants/prov-shared"))).toBe(
			false,
		);
		const stored = await env.COUNCIL_DB.prepare("SELECT provider_participant_id FROM meeting_participants WHERE id = ?")
			.bind(participant.id)
			.first<{ provider_participant_id: string | null }>();
		expect(stored?.provider_participant_id).toBe("prov-shared");
	});

	test("a participant who already holds a token can rejoin a recording_start_unknown meeting", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		// The provider never answered Start recording, so the meeting stopped recording and stopped
		// admitting new people. Everyone already in the call keeps talking, because the provider room
		// is untouched. Then the host reloads, or their laptop sleeps and the socket drops.
		await seed_meeting(env, { status: "recording_start_unknown", deadlineAt: FUTURE });
		const participant = await seed_participant(env, {
			meetingId: "meeting-1",
			role: "host",
			displayName: "Ada Host",
			providerParticipantId: "prov-host",
			providerTokenEncrypted: await council_encrypt(env.COUNCIL_ROOM_COOKIE_SECRET, "held-provider-token"),
			acceptedAt: 1,
		});
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
		});

		const response = await worker.fetch(
			room_post(
				"/room/api/join",
				{},
				{ Cookie: `__Host-council_session=${session.sessionToken}`, "X-Council-Csrf": session.csrfToken },
			),
			env,
		);
		// Refusing here would lock the host out of a call their own guests are still in, and ending
		// the meeting for everyone would be their only way out.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ authToken: "held-provider-token" });
		// The replay hands back the stored token and mints nothing.
		expect(mock.calls.some((call) => call.url.includes("/participants"))).toBe(false);
	});

	test("a session with no token is still refused in a recording_start_unknown meeting", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "recording_start_unknown", deadlineAt: FUTURE });
		// This guest is still in the lobby: they have a room session but were never admitted, so they
		// hold no provider token. A meeting that cannot record must not take anyone new. But the call
		// is still up, so the refusal has to say that and not announce an end that did not happen.
		const participant = await seed_participant(env, { meetingId: "meeting-1", displayName: "Casey Guest" });
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
		expect(await response.json()).toEqual({
			message: "This meeting is still running, but it stopped letting new people in. You cannot join it anymore.",
		});
		expect(mock.calls.some((call) => call.url.includes("/participants"))).toBe(false);
	});

	test("a meeting that stops admitting during the verify-live round trip says so, not that it ended", async () => {
		const { env } = make_test_env();
		let resolveVerify!: (response: Response) => void;
		const verifyResponse = new Promise<Response>((resolve) => {
			resolveVerify = resolve;
		});
		const mock = install_fetch({
			"/service-grants/verify-live": () => verifyResponse,
		});
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

		// The join read the meeting as open, then went out to Convex. Inside that round trip the host
		// presses Start recording and the provider answer is lost, so the meeting moves on. The
		// admission claim below then refuses, because it only claims an open row, and the route
		// re-reads the meeting to name the reason.
		const joining = worker.fetch(room_post("/room/api/join", {}, headers), env);
		await expect.poll(() => mock.calls.filter((call) => call.url.includes("/verify-live")).length).toBe(1);
		await env.COUNCIL_DB.prepare(
			"UPDATE meetings SET status = 'recording_start_unknown' WHERE id = 'meeting-1'",
		).run();
		resolveVerify(Response.json({ live: true }));

		const response = await joining;
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			message: "This meeting is still running, but it stopped letting new people in. You cannot join it anymore.",
		});
		// Nobody was added: the refusal is the claim's, not a late answer from the provider.
		expect(mock.calls.some((call) => call.method === "POST" && call.url.includes("/participants"))).toBe(false);
	});

	test("a meeting that stops admitting during Add Participant says so, not that it ended", async () => {
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

		// Same lost Start recording answer, one step later: it lands while this join is talking to the
		// provider. The guest is still refused and their provider participant is deleted, but the
		// meeting they were joining is up and their colleagues are in it.
		const joining = worker.fetch(room_post("/room/api/join", {}, headers), env);
		await expect
			.poll(() => mock.calls.filter((call) => call.method === "POST" && call.url.includes("/participants")).length)
			.toBe(1);
		await env.COUNCIL_DB.prepare(
			"UPDATE meetings SET status = 'recording_start_unknown' WHERE id = 'meeting-1'",
		).run();
		resolveAdd(Response.json({ success: true, data: { id: "prov-too-late", token: "late.late.late" } }));

		const response = await joining;
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			message: "This meeting stopped letting new people in before the join finished.",
		});
		// The slot and the provider participant are still released, exactly as for a closed meeting.
		expect(mock.calls.some((call) => call.method === "DELETE" && call.url.endsWith("/participants/prov-too-late"))).toBe(
			true,
		);
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
		// Name the cap. "A join is already in progress" would invite a retry that can never succeed.
		expect(await response.json()).toEqual({ message: "This meeting is full. It allows 25 participants." });

		// The cap counts slots, never attempts: the refused join must not consume one.
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT participant_count FROM meetings WHERE id = 'meeting-1'",
		).first<{
			participant_count: number;
		}>();
		expect(meeting?.participant_count).toBe(25);
	});
});

describe("council_handle_room_api /room/api/state", () => {
	test("the poll body carries the status and whether the recording already started", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const participant = await seed_participant(env, { meetingId: "meeting-1", role: "host", displayName: "Host" });
		const session = await seed_room_session(env, {
			meetingId: "meeting-1",
			participantId: participant.id,
			role: "host",
		});
		const headers = {
			Cookie: `__Host-council_session=${session.sessionToken}`,
			"X-Council-Csrf": session.csrfToken,
		};

		const before = await worker.fetch(room_post("/room/api/state", {}, headers), env);
		expect(before.status).toBe(200);
		const beforeBody = (await before.json()) as { meeting: { status: string; recordingStarted: boolean } };
		// The room's poll reads both: the status ends the call, and the flag hides Start recording.
		expect(beforeBody.meeting.status).toBe("open");
		expect(beforeBody.meeting.recordingStarted).toBe(false);

		const started = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(started.status).toBe(200);

		const after = await worker.fetch(room_post("/room/api/state", {}, headers), env);
		const afterBody = (await after.json()) as { meeting: { status: string; recordingStarted: boolean } };
		expect(afterBody.meeting.recordingStarted).toBe(true);
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

	test("a start past the deadline of a still-open meeting names the deadline, not a closed meeting", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// Nothing ends the call at the deadline; the cron closes an open meeting up to fifteen
		// minutes later. A host pressing Start in that gap is in a live call, so "not open" would
		// be untrue — name the deadline as the reason instead.
		await seed_meeting(env, { status: "open", deadlineAt: 1 });
		const headers = await seed_host_session(env);

		const response = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			message: "The meeting passed its scheduled end, so recording can no longer start.",
		});
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

		// A retry from the page is refused: two recordings could otherwise run at once. No recording
		// is attached here, so the refusal names the dead-end state itself, not a running recording
		// and not an ended meeting — the call is still live.
		const retry = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(retry.status).toBe(409);
		expect(await retry.json()).toEqual({ message: "This meeting can no longer record." });
	});

	test("a provider refusal leaves the meeting open and the control usable", async () => {
		const { env } = make_test_env();
		let trackCalls = 0;
		const mock = install_fetch({
			// The provider answered and said no. That is not a lost answer: nothing started, and the
			// second call shows the host can still get a recording.
			"/recordings/track": () => {
				trackCalls += 1;
				return trackCalls === 1
					? Response.json({ success: false }, { status: 400 })
					: Response.json({ success: true, data: { recording: { id: "rec-after-refusal" } } });
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);

		const refused = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		// Never 502 here. The room page reads 502 on this route as the lost answer above: it closes
		// the recording control for good and tells the host that nothing will be saved and nobody
		// else can join. The row below says both are untrue after a refusal.
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({ message: "The provider refused to start the recording" });
		const afterRefusal = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(afterRefusal).toEqual({ status: "open", provider_recording_id: null });

		const retry = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(retry.status).toBe(200);
		const afterRetry = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(afterRetry).toEqual({ status: "open", provider_recording_id: "rec-after-refusal" });
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

	test("a lost answer never closes admission on a meeting whose recording another start attached", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);

		// The interleaving above, except the first tab's provider answer is LOST instead of
		// answered: the second tab attaches rec-second while the first call is in the air, then the
		// first call throws. The dead-end transition must not fire — its premise, "no recording id
		// was stored", is false here, and the meeting is recording fine.
		let trackCalls = 0;
		let second: Response | null = null;
		const mock = install_fetch({
			"/recordings/track": async () => {
				trackCalls += 1;
				if (trackCalls === 1) {
					second = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
					throw new Error("socket dropped");
				}
				return Response.json({ success: true, data: { recording: { id: "rec-second" } } });
			},
		});
		restoreFetch = mock.restore;

		const first = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(second?.status).toBe(200);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(meeting?.status).toBe("open");
		expect(meeting?.provider_recording_id).toBe("rec-second");

		// The loser is told what the other tab made true, the same answer the refused overlap above
		// gets. A 502 here would make the room close the recording control and announce that the
		// meeting will not be saved, while the attached recording is producing files.
		expect(first.status).toBe(409);
		expect(await first.json()).toEqual({ message: "The recording is already running" });
	});

	test("a start whose attach is refused by a concurrent lost-answer dead end names that dead end, not a closed meeting", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const headers = await seed_host_session(env);

		// The winner's provider call runs the loser's whole start — whose provider call throws and
		// moves the meeting to recording_start_unknown — before answering success. Attach then
		// refuses; the re-read must name that dead end the same way the pre-check does.
		let trackCalls = 0;
		let second: Response | null = null;
		const mock = install_fetch({
			"/recordings/track": async () => {
				trackCalls += 1;
				if (trackCalls === 1) {
					second = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
					return Response.json({ success: true, data: { recording: { id: "rec-first" } } });
				}
				throw new Error("socket dropped");
			},
			"/recordings/rec-first": () => Response.json({ success: true, data: { action: "stop" } }),
		});
		restoreFetch = mock.restore;

		const first = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(second?.status).toBe(502);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(meeting?.status).toBe("recording_start_unknown");
		expect(meeting?.provider_recording_id).toBeNull();

		const stopCall = mock.calls.find((call) => call.url.includes("/recordings/rec-first"));
		expect(stopCall?.method).toBe("PUT");

		expect(first.status).toBe(409);
		expect(await first.json()).toEqual({ message: "This meeting can no longer record." });
	});

	test("a lost answer after close does not claim the stopped recording is still running", async () => {
		const { env } = make_test_env();
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE, processingGrantId: "grant-1" });
		const headers = await seed_host_session(env);

		// The second tab attaches rec-second, then close stops that recording and keeps the id.
		// Then the first tab's provider call throws. The catch must not say the recording is
		// running: close already stopped it, and the meeting is no longer open.
		let trackCalls = 0;
		let secondStatus = 0;
		let closeStatus = 0;
		const mock = install_fetch({
			"/recordings/track": async () => {
				trackCalls += 1;
				if (trackCalls === 1) {
					const second = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
					secondStatus = second.status;
					const closed = await worker.fetch(room_post("/room/api/host/close", {}, headers), env);
					closeStatus = closed.status;
					throw new Error("socket dropped");
				}
				return Response.json({ success: true, data: { recording: { id: "rec-second" } } });
			},
			"/recordings/rec-second": () => Response.json({ success: true, data: { action: "stop" } }),
		});
		restoreFetch = mock.restore;

		const first = await worker.fetch(room_post("/room/api/host/start-recording", {}, headers), env);
		expect(secondStatus).toBe(200);
		expect(closeStatus).toBe(200);

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(meeting?.status).toBe("processing");
		expect(meeting?.provider_recording_id).toBe("rec-second");

		expect(first.status).toBe(409);
		expect(await first.json()).toEqual({ message: "The meeting is not open" });
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
		const body = (await response.json()) as { status: string; recorded: boolean };
		expect(body.status).toBe("processing");
		// The room prefers this flag over its own recording stage when telling the host whether
		// files are coming.
		expect(body.recorded).toBe(true);

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
		const body = (await response.json()) as { status: string; recorded: boolean };
		expect(body.status).toBe("ready");
		expect(body.recorded).toBe(false);

		const outbox = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM event_outbox").first<{ n: number }>();
		expect(outbox?.n).toBe(0);
		expect(queueSent.length).toBe(0);
	});

	test("closing an already-processing meeting repeats its answer with the recording truth", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// The idempotent branch reads the recording id from the row it already has, so a repeated
		// close still tells the room whether files are coming.
		await seed_meeting(env, { status: "processing", deadlineAt: FUTURE, providerRecordingId: "rec-1" });
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
		const body = (await response.json()) as { status: string; recorded: boolean };
		expect(body.status).toBe("processing");
		expect(body.recorded).toBe(true);
	});

	test("closing a recording_start_unknown meeting settles at ready with nothing to process", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		// The provider never answered Start recording, so no recording id was ever stored. The room
		// and the plugin page both tell the member that nothing was saved, and this close is what
		// has to keep making that true: no processing work, no artifacts, straight to ready.
		await seed_meeting(env, { status: "recording_start_unknown", deadlineAt: FUTURE });
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

		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT status, provider_recording_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; provider_recording_id: string | null }>();
		expect(meeting).toEqual({ status: "ready", provider_recording_id: null });
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
