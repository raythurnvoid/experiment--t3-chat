import { afterEach, describe, expect, test } from "vitest";

import { council_page_auth, council_verify_host_actor_grant, council_verify_meeting_grant } from "./grants.ts";
import { council_encrypt } from "./crypto.ts";
import { council_get_meeting, type council_ParticipantRow } from "./db.ts";
import { install_fetch, make_test_env, seed_grant, seed_meeting, seed_participant, FUTURE } from "../test/env.ts";

/** A well-formed page token: the module refuses anything else before it reaches Convex. */
const PAGE_TOKEN = `plu_${"a".repeat(64)}`;
const CLIENT_IP = "1.2.3.4";
/** One millisecond past the module's own liveness window, so the next call has to ask Convex again. */
const PAST_LIVENESS_WINDOW_MS = 60 * 1000 + 1;
/** The host's page-session lifetime, which is the ceiling the module puts on one exchange result. */
const HOST_PAGE_SESSION_TTL_MS = 30 * 60 * 1000;

/** What the host answers a live page token, so a test can script when it stops answering that. */
const EXCHANGE_ANSWER = {
	token: "psg_interactive_test_token",
	expiresAt: FUTURE,
	scopes: ["plugin_data:read", "plugin_data:write"],
	principalKey: "principal-1",
	actorUserId: "user-1",
	organizationId: "org-1",
	workspaceId: "ws-1",
	installationId: "inst-1",
};

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

function count_grants(env: ReturnType<typeof make_test_env>["env"]) {
	return env.COUNCIL_DB.prepare("SELECT COUNT(*) AS n FROM service_grants").first<{ n: number }>();
}

function calls_to(mock: ReturnType<typeof install_fetch>, path: string) {
	return mock.calls.filter((call) => call.url.includes(path)).length;
}

describe("council_page_auth", () => {
	test("a page that keeps polling reuses its grant instead of minting one a minute", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		const now = Date.now();

		const first = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now);
		expect(first._nay).toBeUndefined();

		// The plugin page polls every five seconds and never stops, so this is the second poll after
		// the liveness window closed, not a new visitor.
		const second = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + PAST_LIVENESS_WINDOW_MS);
		expect(second._nay).toBeUndefined();

		// One open tab must leave one grant behind, not one per minute for as long as it stays open.
		expect((await count_grants(env))?.n).toBe(1);
		expect(second._yay?.serviceGrantId).toBe(first._yay?.serviceGrantId);

		// The second call still asked Convex whether the grant may act. Without this the test would
		// also pass for a fix that only made the cached answer last longer, which is the wrong fix:
		// a member whose access was taken away would keep the page working.
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(1);
		expect(calls_to(mock, "/service-grants/exchange")).toBe(1);

		// The only check on what this service claims when it asks. Three of the four fields are
		// compared exactly at the host, so a wrong one is refused there. `scopes` is the field that
		// decides who keeps the page. The host refuses a claim the grant no longer holds, and it also
		// refuses one whose permission the member behind the grant has lost: `plugin_data:write` needs
		// `content.write` from that member. So this list has to say what page auth really does, which
		// is read. The test below is the member that makes the difference visible.
		//
		// It has to stay honest in the other direction too. A claim narrower than what the call spends
		// is answered 200 and nothing else would notice that the check stopped covering the rest.
		const verifyLive = mock.calls.find((call) => call.url.includes("/service-grants/verify-live"));
		expect(verifyLive?.bodyJson).toEqual({
			installationId: "inst-1",
			phase: "interactive",
			destinationPathPrefix: null,
			scopes: ["plugin_data:read"],
		});

		// Reuse re-checks the grant; it never renews it. A stolen token has to stop working on its
		// own 24 hours after the exchange that minted it.
		const grant = await env.COUNCIL_DB.prepare("SELECT expires_at FROM service_grants").first<{ expires_at: number }>();
		expect(grant?.expires_at).toBe(FUTURE);
	});

	test("a member who lost access loses the page on the next minute boundary", async () => {
		const { env } = make_test_env();
		let revoked = false;
		const refuse = () => Response.json({ message: "Unauthorized" }, { status: 401 });
		const mock = install_fetch({
			"/service-grants/exchange": () =>
				revoked
					? refuse()
					: Response.json({
							token: "psg_interactive_test_token",
							expiresAt: FUTURE,
							scopes: ["plugin_data:read", "plugin_data:write"],
							principalKey: "principal-1",
							actorUserId: "user-1",
							organizationId: "org-1",
							workspaceId: "ws-1",
							installationId: "inst-1",
						}),
			// What the host answers once the actor is no longer a live member: `resolve_principal`
			// re-reads the membership on every call, so the grant it already minted stops resolving.
			"/service-grants/verify-live": () => (revoked ? refuse() : Response.json({ live: true })),
		});
		restoreFetch = mock.restore;
		const now = Date.now();

		expect((await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now))._nay).toBeUndefined();
		revoked = true;

		// Inside the window the last answer still stands, which is what it did before grants were
		// reused at all.
		expect((await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + 30_000))._nay).toBeUndefined();

		const past = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + PAST_LIVENESS_WINDOW_MS);
		expect(past._yay).toBeUndefined();
		expect(past._nay?.name).toBe("unauthorized");

		// The refusal must be this service's own answer about the grant, not a second exchange that
		// happened to be refused too. Both routes are scripted to 401 here, so the name alone cannot
		// tell the two apart.
		expect(calls_to(mock, "/service-grants/exchange")).toBe(1);
	});

	test("a member moved to a read-only role keeps the page", async () => {
		const { env } = make_test_env();
		const mock = install_fetch({
			// What the host answers a member an admin has moved to the `viewer` role. They are still in
			// the workspace, so the grant, the installation and the phase all still check out, and only
			// the content permission behind a scope is gone. `plugins_service_http_verify_live` maps
			// `plugin_data:write` to `content.write` and answers 409 for a claim that carries it, while
			// the same call claiming only `plugin_data:read` is answered 200.
			"/service-grants/verify-live": (call) => {
				const scopes = call.bodyJson?.scopes;
				if (Array.isArray(scopes) && scopes.includes("plugin_data:write")) {
					return Response.json(
						{ message: "This grant's member can no longer use the scopes it needs" },
						{ status: 409 },
					);
				}
				return Response.json({ live: true });
			},
		});
		restoreFetch = mock.restore;
		const now = Date.now();

		expect((await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now))._nay).toBeUndefined();

		// The page is where this member reads their meeting list and watches a meeting they are already
		// in. Losing `content.write` must cost them the actions that write, not the page itself, and
		// every one of those actions asks again for the write scope before it acts.
		const past = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + PAST_LIVENESS_WINDOW_MS);
		expect(past._nay).toBeUndefined();

		// The control. Without it this test would also pass for a page that stopped asking Convex at
		// all, which is the fix that hands a removed member the page forever.
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(1);
	});

	test("a page token the host rotated away stops buying authority one page session later", async () => {
		const { env } = make_test_env();
		let rotated = false;
		const mock = install_fetch({
			// What the host does when the page refreshes its session: it keeps the same session but
			// rotates the plaintext token, so the old one stops resolving at the exchange right away.
			"/service-grants/exchange": () =>
				rotated ? Response.json({ message: "Unauthorized" }, { status: 401 }) : Response.json(EXCHANGE_ANSWER),
			// The grant this service already holds is untouched by that rotation, so asking about the
			// grant can never notice it. Only presenting the token again can.
			"/service-grants/verify-live": () => Response.json({ live: true }),
		});
		restoreFetch = mock.restore;
		const now = Date.now();

		expect((await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now))._nay).toBeUndefined();
		rotated = true;

		// The mapping is bound to the page session, not to the grant's own 24 hours.
		const mapping = await env.COUNCIL_DB.prepare("SELECT expires_at FROM page_token_cache").first<{
			expires_at: number;
		}>();
		expect(mapping?.expires_at).toBe(now + HOST_PAGE_SESSION_TTL_MS);

		// Inside the session the mapping still answers. That is the burst of page polling the cache
		// exists for, and it is the control for the assertion below.
		const inSession = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + HOST_PAGE_SESSION_TTL_MS - 1);
		expect(inSession._nay).toBeUndefined();

		// Past it the mapping is gone, so the call must present the token to the host again — and the
		// host refuses the rotated one. Re-checking the grant more often, or holding the cached answer
		// longer, would both leave this call allowed.
		const pastSession = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + HOST_PAGE_SESSION_TTL_MS + 1);
		expect(pastSession._yay).toBeUndefined();
		expect(pastSession._nay?.name).toBe("unauthorized");
	});

	test("a page token whose grant is over exchanges for a new one", async () => {
		const { env } = make_test_env();
		const now = Date.now();
		const mock = install_fetch({
			"/service-grants/exchange": () =>
				Response.json({
					token: "psg_interactive_test_token",
					// A grant with seconds left, so the second call below is past its end.
					expiresAt: now + 1_000,
					scopes: ["plugin_data:read", "plugin_data:write"],
					principalKey: "principal-1",
					actorUserId: "user-1",
					organizationId: "org-1",
					workspaceId: "ws-1",
					installationId: "inst-1",
				}),
		});
		restoreFetch = mock.restore;

		const first = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now);
		const second = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + PAST_LIVENESS_WINDOW_MS);
		expect(second._nay).toBeUndefined();

		// Nothing is left to re-check once a grant is past its own expiry, so the page exchanges for
		// fresh authority rather than being handed a dead grant.
		expect(second._yay?.serviceGrantId).not.toBe(first._yay?.serviceGrantId);
		expect(calls_to(mock, "/service-grants/exchange")).toBe(2);
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(0);
		expect((await count_grants(env))?.n).toBe(2);
	});

	test("a grant sealed under a rotated secret exchanges for a new one instead of throwing", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		const now = Date.now();

		const first = await council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now);
		expect(first._nay).toBeUndefined();

		// What rotating COUNCIL_ROOM_COOKIE_SECRET leaves behind. The row is still well-formed base64,
		// but it was sealed under the key before the rotation, so it no longer decrypts. The exchange
		// above minted exactly one grant, so this rewrites that one.
		await env.COUNCIL_DB.prepare("UPDATE service_grants SET token_encrypted = ?")
			.bind(await council_encrypt("the-secret-before-the-rotation", "psg_interactive_test_token"))
			.run();

		// The whole point: rotating the secret is routine hygiene and the only recovery from a
		// suspected leak, so it must not take the page down. Without the guard this call rejects with
		// WebCrypto's OperationError, nothing above catches it, and every privileged route answers 500.
		const second = council_page_auth(env, PAGE_TOKEN, CLIENT_IP, now + PAST_LIVENESS_WINDOW_MS);
		await expect(second).resolves.toBeDefined();
		const resolved = await second;
		expect(resolved._nay).toBeUndefined();

		// The recovery is the re-exchange: a new grant, sealed under the current secret, replaces the
		// one nothing can read. Answering `bad_grant` here would refuse instead, and the page would
		// stay broken until every stale grant aged out.
		expect(resolved._yay?.serviceGrantId).not.toBe(first._yay?.serviceGrantId);
		expect(calls_to(mock, "/service-grants/exchange")).toBe(2);
	});
});

describe("council_verify_meeting_grant", () => {
	test("claims the write scope for the three actions that go through it", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		await seed_grant(env);
		await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
		const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
		if (!meeting) {
			throw new Error("The fixture did not seed a meeting");
		}

		const result = await council_verify_meeting_grant(env, meeting, Date.now());
		expect(result._nay).toBeUndefined();
		// The control for the assertion below: without it a function that never reached Convex would
		// pass too, and the test would say nothing about what was claimed.
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(1);

		// The open retry, the room join and start recording all reach Convex through this function, and
		// all three end in a write. `council_page_auth` claims only `plugin_data:read`, which is what
		// keeps a member moved to `viewer` on the page. That narrow claim must not spread here, or the
		// same member could start a recording nobody is allowed to keep.
		const verifyLive = mock.calls.find((call) => call.url.includes("/service-grants/verify-live"));
		expect(verifyLive?.bodyJson?.scopes).toEqual(["plugin_data:read", "plugin_data:write"]);
	});
});

/**
 * The rows the room path hands `council_verify_host_actor_grant`: an open meeting on `inst-1` with
 * `grant-1` pinned, and the host's own participant row. Read both back from D1 instead of writing
 * the objects by hand, so a fixture cannot carry a shape the schema would not produce.
 */
async function host_actor_rows(env: ReturnType<typeof make_test_env>["env"], joinAttemptId?: string) {
	await seed_grant(env);
	await seed_meeting(env, { status: "open", deadlineAt: FUTURE });
	const seeded = await seed_participant(env, {
		meetingId: "meeting-1",
		role: "host",
		displayName: "Ada Host",
		joinAttemptId,
	});
	const meeting = await council_get_meeting(env.COUNCIL_DB, "meeting-1");
	const participant = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_participants WHERE id = ?")
		.bind(seeded.id)
		.first<council_ParticipantRow>();
	if (!meeting || !participant) {
		throw new Error("The fixture did not seed a meeting and its host participant");
	}
	return { meeting, participant };
}

describe("council_verify_host_actor_grant", () => {
	test("verifies the pinned grant when the installation, the member and the phase all match", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		const { meeting, participant } = await host_actor_rows(env);

		const result = await council_verify_host_actor_grant(env, {
			meeting,
			participant,
			actorServiceGrantId: "grant-1",
			now: Date.now(),
		});
		expect(result._nay).toBeUndefined();
		// The control for the three refusals below. Without it they would all pass for a function that
		// refuses everything, and none of them would be about the lookup.
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(1);

		// A privileged action still claims the write scope. This one guards the room join and start
		// recording, which end in a recording nobody may keep unless the host can still write it, so
		// the narrower claim page auth uses must not spread here.
		const verifyLive = mock.calls.find((call) => call.url.includes("/service-grants/verify-live"));
		expect(verifyLive?.bodyJson?.scopes).toEqual(["plugin_data:read", "plugin_data:write"]);
	});

	test("refuses a host row whose attempt id is outside the reserved host- namespace", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		// No door writes this row today. `handle_session` is the only one that creates a host row and it
		// always keys it `host-<actorUserId>`, and `handle_guest_session` refuses a caller-supplied
		// attempt id starting with `host-`. The guard is the backstop behind those two.
		//
		// Use a near miss of the reserved prefix, not an unrelated string. The member this function
		// checks is cut out of the attempt id at exactly five characters, so `host_user-1` cuts to
		// `user-1` — the member the seeded grant really belongs to. An unrelated id would cut to
		// nonsense and be refused by the lookup instead, and the test would pass without the guard.
		const { meeting, participant } = await host_actor_rows(env, "host_user-1");

		const result = await council_verify_host_actor_grant(env, {
			meeting,
			participant,
			actorServiceGrantId: "grant-1",
			now: Date.now(),
		});
		expect(result._nay?.name).toBe("grant_dead");
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(0);
	});

	test("refuses a host session that pinned no actor grant", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		const { meeting, participant } = await host_actor_rows(env);

		// `handle_session` always copies the ticket's grant onto the session, so nothing produces this
		// today either. Fail closed anyway: with no grant named there is nothing to check, and the
		// meeting's own pin is somebody else's authority, not this host's.
		//
		// Read what this test does and does not prove before you touch the guard it covers. It pins the
		// answer, not the guard: deleting the `!args.actorServiceGrantId` check leaves this test green,
		// because the lookup then binds NULL as the id and SQL matches no row either way. No test of
		// this function can tell the two apart. The guard still earns its place — it says the invariant
		// out loud and skips a D1 round-trip that can only come back empty — so a green run after
		// deleting it is not evidence that it was dead.
		const result = await council_verify_host_actor_grant(env, {
			meeting,
			participant,
			actorServiceGrantId: null,
			now: Date.now(),
		});
		expect(result._nay?.name).toBe("grant_dead");
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(0);
	});

	test("refuses a grant from another installation, another member, or the processing phase", async () => {
		const { env } = make_test_env();
		const mock = install_fetch();
		restoreFetch = mock.restore;
		const { meeting, participant } = await host_actor_rows(env);
		const now = Date.now();
		// All three grants below are live and well-formed; only a tenancy column differs. This lookup is
		// the cross-tenant boundary of the host room path and `council_verify_grant` cannot stand in for
		// it: that function claims `phase: "interactive"` to Convex whatever the row says, and it never
		// looks at the installation or at which member the grant belongs to.
		await seed_grant(env, { id: "grant-other-installation", installationId: "inst-2" });
		await seed_grant(env, { id: "grant-other-member", actorUserId: "user-2" });
		await seed_grant(env, { id: "grant-processing", phase: "processing" });

		const otherInstallation = await council_verify_host_actor_grant(env, {
			meeting,
			participant,
			actorServiceGrantId: "grant-other-installation",
			now,
		});
		expect(otherInstallation._nay?.name).toBe("grant_dead");

		const otherMember = await council_verify_host_actor_grant(env, {
			meeting,
			participant,
			actorServiceGrantId: "grant-other-member",
			now,
		});
		expect(otherMember._nay?.name).toBe("grant_dead");

		const processing = await council_verify_host_actor_grant(env, {
			meeting,
			participant,
			actorServiceGrantId: "grant-processing",
			now,
		});
		expect(processing._nay?.name).toBe("grant_dead");

		// None of the three may reach Convex. A refusal that still spent an outbound action would be a
		// way to buy that work with a grant this meeting has no claim on.
		expect(calls_to(mock, "/service-grants/verify-live")).toBe(0);
	});
});
