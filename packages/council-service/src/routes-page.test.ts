import { afterEach, describe, expect, test } from "vitest";

import worker from "./index.ts";
import type { Env } from "./env.ts";
import { install_fetch, make_test_env, seed_grant, seed_meeting, FUTURE } from "../test/env.ts";

const WORKER_ORIGIN = "https://council.example";
const PLUGIN_ORIGIN = "https://plugin-origin.example";

function page_post(path: string, body: unknown, headers?: Record<string, string>) {
	return new Request(`${WORKER_ORIGIN}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer plu_page_token",
			Origin: PLUGIN_ORIGIN,
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
		const body = (await response.json()) as { meetingId: string };
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
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_artifacts (id, meeting_id, kind, target_key, file_name, node_id, status, created_at, updated_at)
			VALUES ('a1', 'meeting-live', 'transcript_markdown', 'transcript_markdown:transcript.md', 'transcript.md', 'node-9', 'finalized', 0, 0)`,
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
	});
});
