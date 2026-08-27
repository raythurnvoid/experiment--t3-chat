import { afterEach, describe, expect, test, vi } from "vitest";

import worker from "./index.ts";
import { council_encrypt } from "./crypto.ts";
import { council_RATE_LIMITS } from "./db.ts";
import { council_RECORDING_OVER_CAP_MEMBER_SENTENCE, type Env } from "./env.ts";
import { install_fetch, make_test_env, seed_grant, seed_meeting, FUTURE } from "../test/env.ts";

const WORKER_ORIGIN = "https://council.example";
const PLUGIN_ORIGIN = "https://plugin-origin.example";

/** A well-formed page token: page auth refuses anything else before it reaches Convex. */
const PAGE_TOKEN = `plu_${"a".repeat(64)}`;

function page_post(path: string, body: unknown, headers?: Record<string, string>) {
	return new Request(`${WORKER_ORIGIN}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${PAGE_TOKEN}`,
			Origin: PLUGIN_ORIGIN,
			// Cloudflare's edge sets this on every real request, and page auth needs it to key the
			// exchange limit. Send it here so these tests run the production shape.
			"CF-Connecting-IP": "1.2.3.4",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

describe("council_handle_page_api /api/meetings/create", () => {
	test("a meeting length past the pessimistic host-upload projection still creates", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { env } = make_test_env({ COUNCIL_MEETING_MAX_MINUTES: "60" });
		const mock = install_fetch();
		restoreFetch = mock.restore;

		try {
			const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
			expect(response.status).toBe(200);
			const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meetings").first<{ n: number }>();
			expect(count?.n).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				"COUNCIL_MEETING_MAX_MINUTES is too high for the host upload cap",
				expect.objectContaining({ maxMinutes: 60 }),
			);
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("maintenance blocks a create before it writes D1 or calls the provider", async () => {
		const { env } = make_test_env({ COUNCIL_MAINTENANCE: "true" });
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("300");
		await expect(response.json()).resolves.toEqual({ message: "Council is being upgraded. Try again shortly." });
		const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meetings").first<{ n: number }>();
		expect(count?.n).toBe(0);
		expect(mock.calls.map((call) => call.url)).toEqual([
			"https://convex.example/api/internal/plugins/service-grants/exchange",
		]);
	});

	test("a secret rotated inside the cached minute refuses the create instead of throwing", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		// Any page call mints the grant and the `page_token_cache` mapping that points at it.
		const warmed = await worker.fetch(page_post("/api/meetings/list", {}), env);
		expect(warmed.status).toBe(200);

		// What rotating COUNCIL_ROOM_COOKIE_SECRET leaves behind: still well-formed base64, sealed
		// under the key from before the rotation, so it no longer decrypts.
		await env.COUNCIL_DB.prepare("UPDATE service_grants SET token_encrypted = ?")
			.bind(await council_encrypt("the-secret-before-the-rotation", "psg_interactive_test_token"))
			.run();

		// The create runs inside the mapping's cached minute, so page auth answers from
		// `page_token_cache` without asking Convex and never touches the token. That makes the create
		// itself the first read of a token nothing can decrypt.
		const attempt = worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);

		// Assert it answers at all before asking what it answered. Without the guard the decrypt
		// rejects with WebCrypto's OperationError and nothing above catches it, so the route never
		// produces a response — and a test that went straight to `.status` would die on that
		// rejection instead of on an assertion, which proves nothing about the guard.
		await expect(attempt).resolves.toBeDefined();

		const response = await attempt;
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("60");
		await expect(response.json()).resolves.toEqual({
			message: "Council is reloading its credentials. Try again shortly.",
		});

		// Refused before any effect: no meeting row, and the provider was never called.
		const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meetings").first<{ n: number }>();
		expect(count?.n).toBe(0);
		expect(mock.calls.filter((call) => call.url.includes("/realtime/kit/"))).toEqual([]);
	});

	test("writes the D1 intent row before the provider request, then returns the one-time code", async () => {
		const { env } = make_test_env();
		let rowExistedAtProviderCall = false;
		const mock = install_fetch({
			"/realtime/kit/": async (call) => {
				if (call.url.endsWith("/meetings") && call.method === "POST") {
					const row = await env.COUNCIL_DB.prepare("SELECT status FROM meetings").first<{ status: string }>();
					rowExistedAtProviderCall = row?.status === "created";
					return Response.json({ success: true, data: { meeting: { id: "pm-1" } } });
				}
				return Response.json({ success: true, data: {} });
			},
		});
		restoreFetch = mock.restore;

		const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
		expect(response.status).toBe(200);
		expect(rowExistedAtProviderCall).toBe(true);

		const body = (await response.json()) as {
			meeting: { id: string; status: string };
			joinCode: string;
			guestUrl: string;
		};
		expect(body.meeting.status).toBe("created");
		// 256-bit code. The guest link carries only the meeting id in the shape the room client
		// reads (`?m=`); the code is never part of any URL, so sharing the link cannot leak it.
		expect(body.joinCode).toMatch(/^[0-9a-f]{64}$/u);
		expect(body.guestUrl).toBe(`${WORKER_ORIGIN}/room?m=${body.meeting.id}`);
		expect(body.guestUrl).not.toContain(body.joinCode);

		// Only the hash is stored.
		const stored = await env.COUNCIL_DB.prepare("SELECT code_hash, provider_meeting_id FROM meetings WHERE id = ?")
			.bind(body.meeting.id)
			.first<{ code_hash: string; provider_meeting_id: string }>();
		expect(stored?.code_hash).not.toBe(body.joinCode);
		expect(stored?.provider_meeting_id).toBe("pm-1");

		// The projection reservation went out before the provider create.
		const reserveIndex = mock.calls.findIndex((call) => call.url.includes("/plugin-data/reserve"));
		const providerIndex = mock.calls.findIndex((call) => call.url.endsWith("/meetings") && call.method === "POST");
		expect(reserveIndex).toBeGreaterThanOrEqual(0);
		expect(reserveIndex).toBeLessThan(providerIndex);
	});

	test("a lost provider answer lands in create_unknown and is never rolled back", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/realtime/kit/": (call) => {
				if (call.url.endsWith("/meetings") && call.method === "POST") {
					throw new Error("socket dropped");
				}
				return Response.json({ success: true, data: {} });
			},
		});
		restoreFetch = mock.restore;

		const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
		expect(response.status).toBe(502);
		const body = (await response.json()) as { meetingId: string; message: string };
		// The member reads this text in a focused alert. `create_unknown` has no operator repair —
		// `db.ts` lets that status move only to `expired` or `deleting` — so the alert must not send
		// the member looking for one, and must say what the card for this status already says.
		expect(body.message).not.toContain("operator");
		expect(body.message).toBe(
			"Council did not get an answer when it created the room, so this meeting cannot be opened. Delete it and create a new meeting.",
		);
		const stored = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = ?")
			.bind(body.meetingId)
			.first<{ status: string }>();
		expect(stored?.status).toBe("create_unknown");
	});

	test("an explicit provider refusal rolls the intent back and releases the reservation", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/realtime/kit/": (call) => {
				if (call.url.endsWith("/meetings") && call.method === "POST") {
					return Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 400 });
				}
				return Response.json({ success: true, data: {} });
			},
		});
		restoreFetch = mock.restore;

		const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
		expect(response.status).toBe(502);
		const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meetings").first<{ n: number }>();
		expect(count?.n).toBe(0);
		expect(mock.calls.some((call) => call.url.includes("/plugin-data/release-reservation"))).toBe(true);
	});

	test("a reserve permission refusal answers the member's own 403 sentence and rolls the intent back", async () => {
		const { env } = make_test_env();
		// What the host's reserve route answers a member an admin moved to `viewer`: create verifies no
		// grant of its own and spends the member's write permission through this door instead, so this
		// refusal is where that member first finds out.
		const mock = install_fetch({
			"/plugin-data/reserve": () => Response.json({ message: "Permission denied" }, { status: 403 }),
		});
		restoreFetch = mock.restore;

		const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
		expect(response.status).toBe(403);
		const body = (await response.json()) as { message: string };
		// The member reads this text in the plugin alert verbatim. The operator message names the
		// internal Convex route and its status; the alert must not.
		expect(body.message).not.toContain("/api/v1/");
		expect(body.message).toBe(
			"You do not have permission to create meetings in this workspace. Ask a workspace admin to review your access.",
		);

		// The intent row is taken back out — a `created` row nothing can finish would sit in the list
		// offering an Open button — and the provider was never called.
		const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meetings").first<{ n: number }>();
		expect(count?.n).toBe(0);
		expect(mock.calls.some((call) => call.url.includes("/realtime/kit/"))).toBe(false);
	});

	test("a full plugin-data store answers its own sentence, not the permission one", async () => {
		const { env } = make_test_env();
		// What the host's reserve route answers when Council's own store hit a ceiling. This must not
		// read as a permission problem: the ask-an-admin sentence would send an admin to review access
		// that is fine while the store stays full, and only deleting meetings actually clears it.
		const mock = install_fetch({
			"/plugin-data/reserve": () =>
				Response.json({ message: "This plugin has used its 16 MiB of storage" }, { status: 403 }),
		});
		restoreFetch = mock.restore;

		const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
		expect(response.status).toBe(403);
		const body = (await response.json()) as { message: string };
		// The member reads this text in the plugin alert verbatim; the internal route must not leak.
		expect(body.message).not.toContain("/api/v1/");
		expect(body.message).toBe(
			"Council's storage in this workspace is full, so it cannot save a new meeting. Delete meetings you no longer need and try again; freed space can take up to a day to come back.",
		);

		// Same rollback as every reserve refusal: the intent row is taken back out and the provider
		// was never called.
		const count = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meetings").first<{ n: number }>();
		expect(count?.n).toBe(0);
		expect(mock.calls.some((call) => call.url.includes("/realtime/kit/"))).toBe(false);
	});

	test("the sixth create in an hour is refused with Retry-After", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;

		for (let attempt = 0; attempt < 5; attempt++) {
			const ok = await worker.fetch(page_post("/api/meetings/create", { title: `Meeting ${attempt}` }), env);
			expect(ok.status).toBe(200);
		}
		const refused = await worker.fetch(page_post("/api/meetings/create", { title: "One too many" }), env);
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
	});

	test("a title above 200 UTF-8 bytes is refused before anything happens", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		// 70 three-byte characters: 210 bytes, only 70 JavaScript characters.
		const response = await worker.fetch(page_post("/api/meetings/create", { title: "€".repeat(70) }), env);
		expect(response.status).toBe(400);
		expect(mock.calls.some((call) => call.url.includes("/realtime/kit/"))).toBe(false);
	});

	test("without a bearer the route answers 401 before touching Convex", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		const response = await worker.fetch(
			new Request(`${WORKER_ORIGIN}/api/meetings/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: PLUGIN_ORIGIN },
				body: JSON.stringify({ title: "X" }),
			}),
			env,
		);
		expect(response.status).toBe(401);
		expect(mock.calls.length).toBe(0);
	});

	test("an exchange refusal answers a stable sentence instead of the internal Convex route", async () => {
		const { env } = make_test_env();
		// The refusal a member really hits during the coupled release: the exchange requires the new
		// read-only capability and answers 403 before minting anything.
		const mock = install_fetch({
			"/service-grants/exchange": () => Response.json({ message: "Permission denied" }, { status: 403 }),
		});
		restoreFetch = mock.restore;

		const response = await worker.fetch(page_post("/api/meetings/create", { title: "Standup" }), env);
		expect(response.status).toBe(401);
		const body = (await response.json()) as { message: string };
		// The exchange's own text names the internal route and its status for an operator. It must
		// stay in the log, never in the member's alert.
		expect(body.message).not.toContain("/api/internal/");
		expect(body.message).toBe(
			"Council is not authorized for this workspace. Ask a workspace admin to review the plugin's access.",
		);
	});

	test("a foreign origin gets no CORS read permission even though authority alone decides", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;

		const response = await worker.fetch(
			page_post("/api/meetings/create", { title: "X" }, { Origin: "https://evil.example" }),
			env,
		);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});

describe("council_handle_page_api page authentication", () => {
	const exchanges = (mock: ReturnType<typeof install_fetch>) =>
		mock.calls.filter((call) => call.url.includes("/api/internal/plugins/service-grants/exchange")).length;

	test("a bearer that only looks like a page token is refused without asking Convex", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;

		// The prefix alone used to be the whole local check, so a bearer like this crossed the network
		// and spent one Convex action before Convex refused it.
		const response = await worker.fetch(
			page_post("/api/meetings/list", {}, { Authorization: "Bearer plu_not-a-real-token" }),
			env,
		);
		// Assert this before the status. The stub answers every exchange successfully, so a bearer that
		// reached Convex would come back 200 here — a fixture answer, not what real Convex would say.
		// The call count is the part that does not depend on the stub.
		expect(exchanges(mock)).toBe(0);
		expect(response.status).toBe(401);
	});

	test("a flood of unknown page tokens from one address stops buying Convex exchanges", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		const limit = council_RATE_LIMITS.page_exchange_ip.limit;

		// Every bearer is well-formed and never seen before, so each one misses `page_token_cache` and
		// would otherwise buy one outbound Convex action — carrying the deployment's exchange secret,
		// for a caller who holds no account and no session at all.
		let last: Response | null = null;
		for (let attempt = 0; attempt <= limit; attempt += 1) {
			last = await worker.fetch(
				page_post("/api/meetings/list", {}, { Authorization: `Bearer plu_${attempt.toString(16).padStart(64, "0")}` }),
				env,
			);
		}

		expect(last?.status).toBe(429);
		// The bound is the point. The status alone would also pass for a limiter that counted the
		// exchanges only after spending them.
		expect(exchanges(mock)).toBe(limit);
	});
});

describe("council_handle_page_api /api/meetings/open", () => {
	test("opens a created meeting with the sixty-minute deadline after verify-live passes", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });

		const response = await worker.fetch(page_post("/api/meetings/open", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);

		const stored = await env.COUNCIL_DB.prepare(
			"SELECT status, opened_at, deadline_at FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; opened_at: number; deadline_at: number }>();
		expect(stored?.status).toBe("open");
		expect(stored && stored.deadline_at - stored.opened_at).toBe(60 * 60 * 1000);
		expect(mock.calls.some((call) => call.url.includes("/service-grants/verify-live"))).toBe(true);
	});

	test("fails closed when verify-live refuses", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			"/service-grants/verify-live": () =>
				Response.json({ message: "This grant is in another phase" }, { status: 409 }),
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });

		const response = await worker.fetch(page_post("/api/meetings/open", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(409);
		const stored = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(stored?.status).toBe("created");
	});

	test("a meeting of another installation reads as missing", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env, { installationId: "inst-other" });
		await seed_meeting(env, { installationId: "inst-other" });

		const response = await worker.fetch(page_post("/api/meetings/open", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(404);
	});

	test("opening seals the processing grant to the meeting folder", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });

		const response = await worker.fetch(page_post("/api/meetings/open", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);

		// File authority is claimed while the meeting opens, not when processing starts: the sealed
		// grant exists before any guest can join, so the pipeline never needs the member's page.
		const meeting = await env.COUNCIL_DB.prepare(
			"SELECT processing_grant_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ processing_grant_id: string | null }>();
		expect(meeting?.processing_grant_id).not.toBeNull();

		const grant = await env.COUNCIL_DB.prepare("SELECT phase, destination_path_prefix FROM service_grants WHERE id = ?")
			.bind(meeting?.processing_grant_id)
			.first<{ phase: string; destination_path_prefix: string }>();
		expect(grant).toEqual({ phase: "processing", destination_path_prefix: "/meetings/meeting-1" });

		// Opening books no storage. The workspace is charged per file, when the pipeline creates it.
		expect(mock.calls.some((call) => call.url.includes("/service-uploads/"))).toBe(false);
	});

	test("a lost open race cannot repoint the open meeting's grants to the loser", async () => {
		const { env } = make_test_env();
		// Sealing is one round trip to Convex, and the route holds the meeting row as it read it
		// before that call. A second tab pressing Open wins meanwhile: it opens the meeting and pins
		// both grant columns to itself before this loser's seal answers.
		const mock = install_fetch({
			"/service-grants/seal-processing": async (call) => {
				await env.COUNCIL_DB.prepare(
					"UPDATE meetings SET status = 'open', service_grant_id = 'grant-a', processing_grant_id = 'grant-processing-a' WHERE id = 'meeting-1'",
				).run();
				return Response.json({
					token: "psg_processing_test_token",
					expiresAt: FUTURE,
					scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
					principalKey: "principal-1",
					destinationPathPrefix: call.bodyJson?.destinationPathPrefix,
					actorUserId: "user-1",
					organizationId: "org-1",
					workspaceId: "ws-1",
					installationId: "inst-1",
				});
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		// The winner's grants must exist as rows: both meeting grant columns are ON DELETE RESTRICT
		// references, and the test database runs with foreign keys on.
		await seed_grant(env, { id: "grant-a" });
		await seed_grant(env, {
			id: "grant-processing-a",
			phase: "processing",
			destinationPathPrefix: "/meetings/meeting-1",
		});
		await seed_meeting(env, { status: "created" });

		const response = await worker.fetch(page_post("/api/meetings/open", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(409);

		// The winner's grants stand untouched. Grant writes that ran outside the guarded
		// `created -> open` UPDATE let this loser overwrite them while its own open answered 409:
		// joins then verified the loser's pin, the pipeline uploaded as the loser, and demoting the
		// loser later broke the winner's meeting.
		const stored = await env.COUNCIL_DB.prepare(
			"SELECT status, service_grant_id, processing_grant_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; service_grant_id: string; processing_grant_id: string }>();
		expect(stored).toEqual({
			status: "open",
			service_grant_id: "grant-a",
			processing_grant_id: "grant-processing-a",
		});
	});
});

describe("council_handle_page_api /api/meetings/room-ticket", () => {
	test("mints a one-time ticket and puts it in the URL fragment", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(page_post("/api/meetings/room-ticket", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { roomUrl: string };
		expect(body.roomUrl).toMatch(new RegExp(`^${WORKER_ORIGIN}/room\\?m=meeting-1#ticket=[0-9a-f]{64}$`, "u"));

		// Only the hash is stored, so a database read cannot open the room.
		const ticket = body.roomUrl.split("#ticket=")[1];
		const stored = await env.COUNCIL_DB.prepare(
			"SELECT token_hash, actor_service_grant_id FROM meeting_tickets",
		).first<{ token_hash: string; actor_service_grant_id: string }>();
		const exchanged = await env.COUNCIL_DB.prepare("SELECT service_grant_id FROM page_token_cache").first<{
			service_grant_id: string;
		}>();
		expect(stored?.token_hash).not.toBe(ticket);
		expect(stored?.actor_service_grant_id).toBe(exchanged?.service_grant_id);
	});

	test("a meeting that was never opened cannot mint a host ticket", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "created" });

		const response = await worker.fetch(page_post("/api/meetings/room-ticket", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(409);
		expect(((await response.json()) as { message: string }).message).toBe("Meeting is not joinable");
		// A `created` meeting has no deadline, so the room would refuse the join with "This meeting
		// has ended" for a meeting that never started. Nothing is minted here.
		const tickets = await env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM meeting_tickets").first<{ n: number }>();
		expect(tickets?.n).toBe(0);
	});

	test("refuses a ticket when the caller's grant is dead even if the pin is live", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const listed = await worker.fetch(page_post("/api/meetings/list", {}), env);
		expect(listed.status).toBe(200);
		const cached = await env.COUNCIL_DB.prepare("SELECT service_grant_id FROM page_token_cache").first<{
			service_grant_id: string;
		}>();
		await env.COUNCIL_DB.prepare("UPDATE service_grants SET expires_at = 1 WHERE id = ?")
			.bind(cached!.service_grant_id)
			.run();

		const response = await worker.fetch(page_post("/api/meetings/room-ticket", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(409);
	});

	test("the ticket mint claims the write scope, not the page's read-only claim", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(page_post("/api/meetings/room-ticket", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);

		// The control for the pin below: page auth answers this first call from the exchange, never
		// from verify-live, so the one recorded verify-live is the mint's own.
		const verifyLive = mock.calls.filter((call) => call.url.includes("/service-grants/verify-live"));
		expect(verifyLive.length).toBe(1);

		// The ticket admits the member to a recorded call whose files land in their workspace, so the
		// mint claims the write pair. Page auth claims only `plugin_data:read` — that keeps a member an
		// admin moved to `viewer` on the page — and this pin is what stops that narrow claim from
		// spreading here, where it would let that member into a room they may no longer write from.
		expect(verifyLive[0]?.bodyJson?.scopes).toEqual(["plugin_data:read", "plugin_data:write"]);
	});
});

describe("council_handle_page_api /api/meetings/close and /api/meetings/delete", () => {
	test("close settles a meeting that never started recording straight to ready", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(page_post("/api/meetings/close", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);
		// With no recording there is nothing to process. `closed` must not be the final state: the
		// plugin page polls closed meetings as transitional, so a stuck one would poll forever.
		expect(((await response.json()) as { status: string }).status).toBe("ready");
		const stored = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(stored?.status).toBe("ready");
		expect(mock.calls.some((call) => call.url.includes("/plugin-data/write-versioned"))).toBe(true);
	});

	test("a second close answers the settled status and does no provider work at all", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const provider_calls = () => mock.calls.filter((call) => call.url.includes("/realtime/kit/")).length;

		const first = await worker.fetch(page_post("/api/meetings/close", { meetingId: "meeting-1" }), env);
		expect(first.status).toBe(200);
		const afterFirst = provider_calls();
		expect(afterFirst).toBeGreaterThan(0);

		// The page leaves the close button live while it polls, and the deadline cron closes the same
		// meeting on its own clock, so the same close really does arrive twice.
		const second = await worker.fetch(page_post("/api/meetings/close", { meetingId: "meeting-1" }), env);
		expect(second.status).toBe(200);
		expect(((await second.json()) as { status: string }).status).toBe("ready");

		// Zero provider work is the point, not the status. A guard that let the second close through
		// would kick everyone out of the provider room again, and members can still be in a room the
		// service has already settled.
		expect(provider_calls()).toBe(afterFirst);
	});

	test("refuses close when the caller's grant is dead even if the pin is live", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const listed = await worker.fetch(page_post("/api/meetings/list", {}), env);
		expect(listed.status).toBe(200);
		const cached = await env.COUNCIL_DB.prepare("SELECT service_grant_id FROM page_token_cache").first<{
			service_grant_id: string;
		}>();
		await env.COUNCIL_DB.prepare("UPDATE service_grants SET expires_at = 1 WHERE id = ?")
			.bind(cached!.service_grant_id)
			.run();

		const response = await worker.fetch(page_post("/api/meetings/close", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(409);
		const stored = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(stored?.status).toBe("open");
	});

	test("close claims the write scope, because the close is what starts the upload", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });

		const response = await worker.fetch(page_post("/api/meetings/close", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);

		// The control for the pin below: page auth answers this first call from the exchange, and
		// nothing downstream of the close verifies again, so the one recorded verify-live is the
		// route's own.
		const verifyLive = mock.calls.filter((call) => call.url.includes("/service-grants/verify-live"));
		expect(verifyLive.length).toBe(1);

		// A closed meeting with a recording is handed straight to the pipeline, which uploads into this
		// workspace, so the close claims the write pair. This is the fail-closed half of page auth's
		// read-only claim: a member an admin moved to `viewer` mid-meeting keeps the page but cannot
		// close their own meeting — the deadline sweep closes it instead. Narrowing this claim to read
		// would give them back a button that starts an upload they may not make.
		expect(verifyLive[0]?.bodyJson?.scopes).toEqual(["plugin_data:read", "plugin_data:write"]);
	});

	test("delete marks the meeting deleting and hands the work to the queue through the outbox", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "ready" });

		const response = await worker.fetch(page_post("/api/meetings/delete", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);

		const stored = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(stored?.status).toBe("deleting");
		const outbox = await env.COUNCIL_DB.prepare("SELECT kind, status FROM event_outbox").first<{
			kind: string;
			status: string;
		}>();
		expect(outbox?.kind).toBe("delete_meeting");
		expect(outbox?.status).toBe("handoff_pending");
		expect(queueSent.length).toBe(1);
	});

	test("delete seals fresh authority from the requester when the meeting's pinned grant is dead", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		// The create-time grant lives 24 hours; a delete can come weeks later. The requester's own
		// exchanged grant is the live authority the delete must seal from.
		await seed_grant(env, { expiresAt: 1 });
		await seed_meeting(env, { status: "ready" });

		const response = await worker.fetch(page_post("/api/meetings/delete", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);

		const stored = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_grant_id FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_grant_id: string | null }>();
		expect(stored?.status).toBe("deleting");
		const sealCall = mock.calls.find((call) => call.url.includes("/service-grants/seal-processing"));
		expect(sealCall?.bodyJson?.destinationPathPrefix).toBe("/meetings/meeting-1");
		const grant = await env.COUNCIL_DB.prepare("SELECT phase FROM service_grants WHERE id = ?")
			.bind(stored?.processing_grant_id)
			.first<{ phase: string }>();
		expect(grant?.phase).toBe("processing");
	});

	test("a delete whose meeting moved while the seal was in flight is refused instead of queueing work", async () => {
		const { env, queueSent } = make_test_env();
		// Sealing is one round trip to the host, and the route holds the meeting row as it read it
		// before that call. A second tab pressing Delete wins the transition meanwhile: it takes the
		// meeting to `deleting` on generation 1 and owns the delete from then on.
		const mock = install_fetch({
			"/service-grants/seal-processing": async (call) => {
				await env.COUNCIL_DB.prepare(
					"UPDATE meetings SET status = 'deleting', processing_generation = 1 WHERE id = 'meeting-1'",
				).run();
				return Response.json({
					token: "psg_processing_test_token",
					expiresAt: FUTURE,
					scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
					principalKey: "principal-1",
					destinationPathPrefix: call.bodyJson?.destinationPathPrefix,
					actorUserId: "user-1",
					organizationId: "org-1",
					workspaceId: "ws-1",
					installationId: "inst-1",
				});
			},
		});
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "ready" });

		const response = await worker.fetch(page_post("/api/meetings/delete", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(409);

		// The winner's state stands untouched. Without the guard this loser answers 200 and dispatches
		// its own generation, so one meeting would be handed to two delete workflows at once.
		const stored = await env.COUNCIL_DB.prepare(
			"SELECT status, processing_generation FROM meetings WHERE id = 'meeting-1'",
		).first<{ status: string; processing_generation: number }>();
		expect(stored).toEqual({ status: "deleting", processing_generation: 1 });
		expect(queueSent.length).toBe(0);
	});

	test("delete is refused while the meeting is processing", async () => {
		const { env, queueSent } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "processing", providerRecordingId: "rec-1" });

		const response = await worker.fetch(page_post("/api/meetings/delete", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(409);

		const stored = await env.COUNCIL_DB.prepare("SELECT status FROM meetings WHERE id = 'meeting-1'").first<{
			status: string;
		}>();
		expect(stored?.status).toBe("processing");
		expect(queueSent.length).toBe(0);
	});
});

describe("council_handle_page_api /api/meetings/list and /api/meetings/get", () => {
	test("lists the installation's meetings without tombstones and get returns artifacts", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { id: "meeting-live", code: "d".repeat(64), status: "ready" });
		await seed_meeting(env, { id: "meeting-gone", code: "e".repeat(64), status: "deleted_tombstone" });
		// Keep a second installation's meeting in the fixture so the list has something it must not
		// return. With one installation the `installation_id = ?` filter can be deleted and the answer
		// does not change. Give that meeting a finalized artifact too: the companion artifacts query
		// is scoped the same way, and it only hands anything over together with the list filter.
		await seed_grant(env, { id: "grant-other", installationId: "inst-other" });
		await seed_meeting(env, {
			id: "meeting-other-tenant",
			code: "f".repeat(64),
			installationId: "inst-other",
			serviceGrantId: "grant-other",
			status: "ready",
		});
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, node_id, status, created_at, updated_at)
			VALUES ('a1', 'meeting-live', 'transcript_markdown', 'transcript_markdown:transcript.md', 'transcript.md', 'node-9', 'finalized', 0, 0),
			('a2', 'meeting-other-tenant', 'transcript_markdown', 'transcript_markdown:other.md', 'other.md', 'node-10', 'finalized', 0, 0)`,
		).run();

		const listResponse = await worker.fetch(page_post("/api/meetings/list", {}), env);
		const listBody = (await listResponse.json()) as {
			meetings: { id: string; artifacts: { kind: string; name: string; fileNodeId: string }[] }[];
		};
		expect(listBody.meetings.map((meeting) => meeting.id)).toEqual(["meeting-live"]);
		expect(listBody.meetings[0]?.artifacts).toEqual([
			{ kind: "transcript_markdown", name: "transcript.md", fileNodeId: "node-9" },
		]);

		// The room/page client reads `{meeting, artifacts}` with `name` + `fileNodeId` entries.
		const getResponse = await worker.fetch(page_post("/api/meetings/get", { meetingId: "meeting-live" }), env);
		const getBody = (await getResponse.json()) as {
			meeting: {
				id: string;
				status: string;
				deadlineAt: number | null;
				artifacts: { kind: string; name: string; fileNodeId: string }[];
			};
			artifacts: { kind: string; name: string; fileNodeId: string }[];
		};
		expect(getBody.meeting.id).toBe("meeting-live");
		expect(getBody.meeting.artifacts).toEqual(getBody.artifacts);
		expect(getBody.artifacts).toEqual([{ kind: "transcript_markdown", name: "transcript.md", fileNodeId: "node-9" }]);
		expect((listBody.meetings[0] as { recordingWarning: string | null }).recordingWarning).toBeNull();
	});

	test("a ready meeting with an over-cap video names the lost recording on list and get", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { id: "meeting-live", code: "d".repeat(64), status: "ready" });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, node_id, status, failure_reason, created_at, updated_at)
			VALUES
			('a1', 'meeting-live', 'transcript_markdown', 'transcript_markdown:transcript.md', 'transcript.md', 'node-9', 'finalized', NULL, 0, 0),
			('a2', 'meeting-live', 'track_audio', 'track_audio:recording.mp4', 'recording.mp4', NULL, 'failed', 'recording too large to store: 1 MiB over the limit', 0, 0)`,
		).run();

		const listResponse = await worker.fetch(page_post("/api/meetings/list", {}), env);
		const listBody = (await listResponse.json()) as {
			meetings: { recordingWarning: string | null; artifacts: { name: string }[] }[];
		};
		expect(listBody.meetings[0]?.recordingWarning).toBe(council_RECORDING_OVER_CAP_MEMBER_SENTENCE);
		expect(listBody.meetings[0]?.artifacts.map((artifact) => artifact.name)).toEqual(["transcript.md"]);

		const getResponse = await worker.fetch(page_post("/api/meetings/get", { meetingId: "meeting-live" }), env);
		const getBody = (await getResponse.json()) as {
			meeting: { recordingWarning: string | null };
		};
		expect(getBody.meeting.recordingWarning).toBe(listBody.meetings[0]?.recordingWarning);
	});

	test("a processing meeting with an over-cap video does not claim the other files were saved", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		await seed_grant(env);
		await seed_meeting(env, { id: "meeting-live", code: "d".repeat(64), status: "processing" });
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, node_id, status, failure_reason, created_at, updated_at)
			VALUES ('a2', 'meeting-live', 'track_audio', 'track_audio:recording.mp4', 'recording.mp4', NULL, 'failed', 'recording too large to store: 1 MiB over the limit', 0, 0)`,
		).run();

		const listResponse = await worker.fetch(page_post("/api/meetings/list", {}), env);
		const listBody = (await listResponse.json()) as {
			meetings: { recordingWarning: string | null }[];
		};
		expect(listBody.meetings[0]?.recordingWarning).toBeNull();
	});
});

describe("council_handle_page_api failure reasons", () => {
	const FAILED_SENTENCE =
		"Council could not finish saving this meeting's files. It keeps trying on its own for a few days; if the meeting still shows this, ask a workspace admin to look into it.";
	const DELETE_FAILED_SENTENCE =
		"Council could not finish deleting this meeting, so it is still here. Press Delete again to start a new attempt; if a file in the meeting's folder is read-only, clear that first.";

	/**
	 * Store what a real run really stores. Every string these tests use is copied from a `throw` in
	 * `pipeline.ts`, composed the way the two terminal catches compose it. A made-up reason would
	 * prove nothing: the whole defect is that the column holds producer text nobody sanitized.
	 */
	async function seed_failed_meeting(env: Env, status: string, reason: string) {
		await seed_grant(env);
		await seed_meeting(env, { status });
		await env.COUNCIL_DB.prepare("UPDATE meetings SET failure_reason = ? WHERE id = 'meeting-1'").bind(reason).run();
	}

	async function get_failure_reason(env: Env) {
		const response = await worker.fetch(page_post("/api/meetings/get", { meetingId: "meeting-1" }), env);
		expect(response.status).toBe(200);
		return ((await response.json()) as { meeting: { failureReason: string | null } }).meeting.failureReason;
	}

	test("a failed meeting gets a product sentence, not the step message that promises a retry", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		// `upload_artifact` throws this when the finalize poll runs out. The column is only written
		// once the step's whole retry budget is spent, so by the time a member reads it the promised
		// retry has already happened and failed — the card says "failed" and the text says "will
		// retry" in the same breath. It also names the internal upload target key.
		await seed_failed_meeting(
			env,
			"failed",
			"The storage event for transcript_markdown:transcript.md never settled; the step will retry",
		);

		const failureReason = await get_failure_reason(env);
		expect(failureReason).not.toContain("the step will retry");
		expect(failureReason).not.toContain("transcript_markdown:");
		expect(failureReason).toBe(FAILED_SENTENCE);
	});

	test("a plan refusal reaches the member without the internal Convex route or its status", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		// What `create_upload_target` stores for the host's plan door: the service prefix, then the
		// operator message `convex_post` builds for every refusal. Page auth already refuses to hand
		// that same message shape to a member; this is the identical text on the other route.
		await seed_failed_meeting(
			env,
			"failed",
			"Upload target refused: Convex /api/v1/files/service-uploads/create-target returned HTTP 403: This workspace's plan does not include plugin service file storage",
		);

		const failureReason = await get_failure_reason(env);
		expect(failureReason).not.toContain("/api/v1/");
		expect(failureReason).not.toContain("HTTP 403");
		// The stored text carries no failure code, so the page cannot tell this refusal apart from
		// any other one that ran out of retries. It therefore routes the member to an admin without
		// diagnosing the cause. The next test is what holds that line.
		expect(failureReason).toBe(FAILED_SENTENCE);
	});

	test("a refusal that is neither plan nor storage does not send the member to check the plan", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		// A revoked `content.write` grant. The host answers the same create-target route with 403
		// "Permission denied", which `convex-api.ts` names `unauthorized`, not `plan_required` or
		// `storage_full`. So `upload_artifact` throws a plain retryable Error and this reaches
		// `failed` once the retry budget is spent. The plan refusal above is fast-failed instead,
		// but it lands on the same status, which is why one sentence has to serve both. An admin
		// sent to the plan finds a healthy plan and stops looking, and the meeting stays broken.
		await seed_failed_meeting(
			env,
			"failed",
			"Upload target refused: Convex /api/v1/files/service-uploads/create-target returned HTTP 403: Permission denied",
		);

		const failureReason = await get_failure_reason(env);
		expect(failureReason).not.toContain("plan");
		expect(failureReason).not.toContain("storage");
		expect(failureReason).toBe(FAILED_SENTENCE);
	});

	test("a failed delete gets its own sentence, because pressing Delete again is what repairs it", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		// The documented refusal from the delete workflow's `archive-files` step: a member locked a
		// file inside the meeting folder, and the host's 409 rides in the same operator message.
		await seed_failed_meeting(
			env,
			"delete_failed",
			"Archiving the meeting folder failed: Convex /api/v1/files/service-uploads/archive-destination returned HTTP 409: This item is read-only.",
		);

		const failureReason = await get_failure_reason(env);
		expect(failureReason).not.toContain("/api/v1/");
		expect(failureReason).not.toContain("HTTP 409");
		expect(failureReason).toBe(DELETE_FAILED_SENTENCE);
		// A delete failure is not a processing failure. One shared sentence would tell a member to
		// wait for a redrive when the fix is in their own hands.
		expect(failureReason).not.toBe(FAILED_SENTENCE);
	});

	test("a meeting that failed and was redriven to ready carries no leftover reason", async () => {
		const { env } = make_test_env();
		restoreFetch = install_fetch().restore;
		// Nothing clears `failure_reason`: `store_summary_markdown` reads the previous run's text
		// back on the next generation, so the redrive leaves it in place on purpose. A meeting that
		// went on to succeed therefore still holds an operator string in D1.
		await seed_failed_meeting(env, "ready", "Artifact PUT returned HTTP 500");

		expect(await get_failure_reason(env)).toBeNull();

		// The list route builds the same view for up to a hundred meetings at a time, and the page
		// polls it, so a leak here ships far more often than one details request.
		const listed = await worker.fetch(page_post("/api/meetings/list", {}), env);
		const listBody = (await listed.json()) as { meetings: { failureReason: string | null }[] };
		expect(listBody.meetings.map((meeting) => meeting.failureReason)).toEqual([null]);
	});
});
