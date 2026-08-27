/**
 * The room-origin API: `POST /room/api/*`, called same-origin by the room page. No CORS — the
 * room page and this API share one origin. `council_handle_room_api` refuses every request whose
 * `Origin` is another site before it routes, and the CSRF token check guards the session routes on
 * top of that.
 *
 * The session model: a one-time ticket (host) or the meeting code (guest) is traded for a
 * `__Host-` cookie session plus a CSRF token. The cookie authenticates the browser; the CSRF
 * token, echoed in `X-Council-Csrf`, proves the caller is the page and not a cross-site form.
 */

import type { Env } from "./env.ts";
import { council_max_minutes, council_max_participants } from "./env.ts";
import {
	council_get_meeting,
	council_rate_limit,
	council_transition_meeting,
	type council_MeetingRow,
	type council_ParticipantRow,
} from "./db.ts";
import {
	council_decrypt,
	council_email_hmac,
	council_encrypt,
	council_random_token,
	council_sha256_hex,
} from "./crypto.ts";
import { council_json, council_read_json_body, council_read_string_field } from "./http.ts";
import { council_verify_host_actor_grant, council_verify_meeting_grant } from "./grants.ts";
import {
	council_PRESET_NAMES,
	council_provider_add_participant,
	council_provider_delete_participant,
	council_provider_ensure_preset,
	council_provider_start_recording,
	council_provider_stop_recording,
} from "./provider.ts";
import { council_close_meeting } from "./lifecycle.ts";
import { Result } from "./result.ts";

const SESSION_COOKIE_NAME = "__Host-council_session";
/** Long enough for a full meeting plus a margin; the meeting deadline closes admission earlier. */
const SESSION_TTL_MS = 5 * 60 * 60 * 1000;
/** How long a verified preset row is trusted before the provider detail is read again. */
const PRESET_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

// #region session plumbing

function session_cookie(sessionToken: string) {
	// `__Host-` requires Secure + Path=/ + no Domain; SameSite=Strict keeps the cookie off every
	// cross-site request, so a link from anywhere else arrives without a session.
	return `${SESSION_COOKIE_NAME}=${sessionToken}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function read_cookie(request: Request, name: string) {
	const header = request.headers.get("Cookie");
	if (!header) {
		return null;
	}
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) {
			return rest.join("=");
		}
	}
	return null;
}

async function create_room_session(
	env: Env,
	args: {
		meetingId: string;
		participantId: string;
		role: "host" | "guest";
		actorServiceGrantId: string | null;
		now: number;
	},
) {
	const sessionToken = council_random_token();
	const csrfToken = council_random_token();
	await env.COUNCIL_DB.prepare(
		`INSERT INTO room_sessions (token_hash, meeting_id, participant_id, role, actor_service_grant_id, csrf_token_hash, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			await council_sha256_hex(sessionToken),
			args.meetingId,
			args.participantId,
			args.role,
			args.actorServiceGrantId,
			await council_sha256_hex(csrfToken),
			args.now + SESSION_TTL_MS,
			args.now,
		)
		.run();
	return { sessionToken, csrfToken };
}

type RoomSessionRow = {
	token_hash: string;
	meeting_id: string;
	participant_id: string;
	role: "host" | "guest";
	actor_service_grant_id: string | null;
	csrf_token_hash: string;
	expires_at: number;
};

/**
 * Authenticate a room API call: a live cookie session plus a CSRF header that hashes to the stored
 * value. `council_handle_room_api` already refused every cross-site `Origin` before this runs, and
 * it is the only way into this module. Every refusal is the same 401 so a probe cannot tell which
 * layer stopped it.
 */
async function room_session_auth(env: Env, request: Request, now: number) {
	const sessionToken = read_cookie(request, SESSION_COOKIE_NAME);
	if (!sessionToken) {
		return Result<never>({ _nay: { message: "Unauthorized" } });
	}
	const session = await env.COUNCIL_DB.prepare("SELECT * FROM room_sessions WHERE token_hash = ? AND expires_at > ?")
		.bind(await council_sha256_hex(sessionToken), now)
		.first<RoomSessionRow>();
	if (!session) {
		return Result<never>({ _nay: { message: "Unauthorized" } });
	}

	const csrfHeader = request.headers.get("X-Council-Csrf");
	if (!csrfHeader || (await council_sha256_hex(csrfHeader)) !== session.csrf_token_hash) {
		return Result<never>({ _nay: { message: "Unauthorized" } });
	}

	const meeting = await council_get_meeting(env.COUNCIL_DB, session.meeting_id);
	if (!meeting) {
		return Result<never>({ _nay: { message: "Unauthorized" } });
	}
	const participant = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_participants WHERE id = ?")
		.bind(session.participant_id)
		.first<council_ParticipantRow>();
	if (!participant) {
		return Result<never>({ _nay: { message: "Unauthorized" } });
	}

	return Result({ _yay: { session, meeting, participant } });
}

function meeting_room_view(env: Env, meeting: council_MeetingRow) {
	return {
		id: meeting.id,
		title: meeting.title,
		status: meeting.status,
		deadlineAt: meeting.deadline_at,
		participantCount: meeting.participant_count,
		maxParticipants: council_max_participants(env),
		// The room page offers Start recording only while this is false. Nothing ever clears
		// `recording_started_at`, and `handle_start_recording` refuses a second start, so this is the
		// durable answer a reload needs; without it the page would re-offer a button that only 409s.
		recordingStarted: meeting.recording_started_at !== null,
	};
}

function session_response(
	env: Env,
	args: { meeting: council_MeetingRow; participant: council_ParticipantRow; csrfToken: string; sessionToken: string },
) {
	return council_json(
		200,
		{
			csrfToken: args.csrfToken,
			meeting: meeting_room_view(env, args.meeting),
			participant: { id: args.participant.id, role: args.participant.role, displayName: args.participant.display_name },
		},
		{ "Set-Cookie": session_cookie(args.sessionToken) },
	);
}

/**
 * The reason a meeting will not take a new participant, in words that are true for it.
 *
 * `recording_start_unknown` is not an ended meeting. That state only stops the recording and stops
 * admitting new people. The call itself keeps running, and the deadline cron still closes it later
 * the same way it closes an open one. A guest whose colleagues are in the room right now must not
 * be told the meeting is over, because then they stop trying.
 *
 * Past the deadline every status here gets the generic wording, including a meeting that is still
 * marked `open`. That is not because the call is already down. Nothing ends the call at the deadline.
 * Only `council_close_meeting` does, and when no host closes by hand that is the cron, which runs
 * every fifteen minutes. So the provider room can still be up while this answers. The real reason is
 * that the deadline ended the meeting this guest was invited to. No status that reaches here has a
 * way back to `open`, so they can never join it, and telling them to stop trying is the true answer.
 * Keep the "still running" wording for the one case where the generic line would surprise them:
 * inside the advertised time, with their colleagues visibly in the call.
 */
function join_refusal_message(meeting: council_MeetingRow | null, now: number) {
	if (meeting?.status === "recording_start_unknown" && meeting.deadline_at !== null && now < meeting.deadline_at) {
		return "This meeting is still running, but it stopped letting new people in. You cannot join it anymore.";
	}
	return "This meeting has ended. It cannot be joined anymore.";
}

// #endregion session plumbing

export async function council_handle_room_api(request: Request, env: Env, now: number): Promise<Response> {
	if (request.method !== "POST") {
		return council_json(405, { message: "Method not allowed" });
	}

	// A browser sends `Origin` on every POST. A value that is not this Worker's own origin is a
	// cross-site call whatever else it carries, so refuse it here, for every route at once, before a
	// handler can do anything.
	//
	// This has to be the whole surface and not the authenticated routes only. `handle_guest_session`
	// spends a `guest_join_ip` token before it reads its body, so a plain cross-site form POST with
	// no cookie, no meeting id and no code would still count against the visitor's address.
	// `Content-Type: text/plain` makes that POST CORS-safelisted, so no preflight refuses it, and the
	// attacker never has to read the answer. Cloudflare fills `CF-Connecting-IP` from the visitor's
	// real address, so fifty such POSTs lock every guest behind that address out of every meeting for
	// the rest of the window.
	//
	// Keep serving a request that sends no `Origin` at all. That is not a browser form; it is curl or
	// another server, and those callers are supported here.
	const url = new URL(request.url);
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== url.origin) {
		return council_json(401, { message: "Unauthorized" });
	}

	switch (url.pathname) {
		case "/room/api/session":
			return await handle_session(request, env, now);
		case "/room/api/guest-session":
			return await handle_guest_session(request, env, now);
		case "/room/api/join":
			return await handle_join(request, env, now);
		case "/room/api/state":
			return await handle_state(request, env, now);
		case "/room/api/host/start-recording":
			return await handle_start_recording(request, env, now);
		case "/room/api/host/close":
			return await handle_host_close(request, env, now);
		default:
			return council_json(404, { message: "Not found" });
	}
}

// #region session creation

async function handle_session(request: Request, env: Env, now: number) {
	const body = await council_read_json_body(request);
	if (body._nay) {
		return council_json(400, { message: body._nay.message });
	}
	const ticket = body._yay.ticket;
	if (typeof ticket !== "string" || ticket.length === 0) {
		// Reload and same-tab return: the httpOnly cookie is still there, but the CSRF token lived
		// only in the previous page's JS. Mint a new CSRF for this document. The body is already
		// consumed here, so hand the requested meeting down instead of reading the stream again.
		return await resume_room_session(request, env, now, body._yay.meetingId);
	}

	// Claim the ticket. The one UPDATE is the whole race arbiter: a second POST — parallel or
	// later — finds `consumed_at` already set and changes zero rows, so two consumes cannot both win.
	const ticketHash = await council_sha256_hex(ticket);
	const claimed = await env.COUNCIL_DB.prepare(
		"UPDATE meeting_tickets SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
	)
		.bind(now, ticketHash, now)
		.run();
	if (claimed.meta.changes !== 1) {
		return council_json(401, { message: "Unauthorized" });
	}
	const ticketRow = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_tickets WHERE token_hash = ?")
		.bind(ticketHash)
		.first<{ meeting_id: string; actor_user_id: string; actor_service_grant_id: string }>();
	if (!ticketRow) {
		return council_json(401, { message: "Unauthorized" });
	}
	const meeting = await council_get_meeting(env.COUNCIL_DB, ticketRow.meeting_id);
	if (!meeting) {
		return council_json(401, { message: "Unauthorized" });
	}

	// The host's durable participant row, created once however many tickets the member consumes.
	// The display name is empty until they type it in the lobby; "Host" is a role, not a name.
	const hostAttemptId = `host-${ticketRow.actor_user_id}`;
	await env.COUNCIL_DB.prepare(
		`INSERT OR IGNORE INTO meeting_participants (id, meeting_id, display_name, role, join_attempt_id, created_at)
		VALUES (?, ?, '', 'host', ?, ?)`,
	)
		.bind(crypto.randomUUID(), meeting.id, hostAttemptId, now)
		.run();
	const participant = await env.COUNCIL_DB.prepare(
		"SELECT * FROM meeting_participants WHERE meeting_id = ? AND join_attempt_id = ?",
	)
		.bind(meeting.id, hostAttemptId)
		.first<council_ParticipantRow>();
	if (!participant) {
		return council_json(500, { message: "Failed to create the host participant" });
	}

	const session = await create_room_session(env, {
		meetingId: meeting.id,
		participantId: participant.id,
		role: "host",
		actorServiceGrantId: ticketRow.actor_service_grant_id,
		now,
	});
	return session_response(env, { meeting, participant, ...session });
}

/**
 * Restore a live cookie session after a reload. No CSRF: the previous token died with the old page.
 * A new CSRF is written onto the existing session row. Only `handle_session` calls this, so
 * `council_handle_room_api` has already refused every cross-site `Origin`.
 *
 * `requestedMeetingId` is the meeting the page was opened for. It is unvalidated body input, so it
 * is typed `unknown` and checked below.
 */
async function resume_room_session(request: Request, env: Env, now: number, requestedMeetingId: unknown) {
	const sessionToken = read_cookie(request, SESSION_COOKIE_NAME);
	if (!sessionToken) {
		return council_json(401, { message: "Unauthorized" });
	}
	const tokenHash = await council_sha256_hex(sessionToken);
	const session = await env.COUNCIL_DB.prepare("SELECT * FROM room_sessions WHERE token_hash = ? AND expires_at > ?")
		.bind(tokenHash, now)
		.first<RoomSessionRow>();
	if (!session) {
		return council_json(401, { message: "Unauthorized" });
	}

	// The session cookie is `__Host-` with `Path=/`, so one cookie covers every meeting on the
	// origin. Someone already in one meeting who opens a guest link to another one would otherwise
	// resume the old session and be put back in the meeting they came from, with camera and
	// microphone live in front of the wrong people. The page sends the meeting it was opened for,
	// so refuse when the session belongs to a different meeting and let the page ask for the join
	// code instead. Refuse before the UPDATE below: a call for another meeting must not rotate the
	// CSRF token the page that owns this session is still using.
	if (typeof requestedMeetingId === "string" && requestedMeetingId !== session.meeting_id) {
		return council_json(401, { message: "Unauthorized" });
	}

	const csrfToken = council_random_token();
	await env.COUNCIL_DB.prepare("UPDATE room_sessions SET csrf_token_hash = ?, expires_at = ? WHERE token_hash = ?")
		.bind(await council_sha256_hex(csrfToken), now + SESSION_TTL_MS, tokenHash)
		.run();

	const meeting = await council_get_meeting(env.COUNCIL_DB, session.meeting_id);
	const participant = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_participants WHERE id = ?")
		.bind(session.participant_id)
		.first<council_ParticipantRow>();
	if (!meeting || !participant) {
		return council_json(401, { message: "Unauthorized" });
	}
	return session_response(env, { meeting, participant, csrfToken, sessionToken });
}

async function handle_guest_session(request: Request, env: Env, now: number) {
	// The IP limit runs before anything else and needs the trusted edge header. Without it, in
	// production, the guest route refuses instead of falling back to a spoofable value.
	let clientIp = request.headers.get("CF-Connecting-IP");
	if (!clientIp) {
		if (env.COUNCIL_ALLOW_MISSING_CLIENT_IP === "true") {
			clientIp = "loopback";
		} else {
			return council_json(400, { message: "Missing client address" });
		}
	}
	const ipVerdict = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_ip", key: clientIp, now });
	if (!ipVerdict.allowed) {
		return council_json(
			429,
			{ message: "Too many join attempts" },
			{ "Retry-After": String(ipVerdict.retryAfterSeconds) },
		);
	}

	const body = await council_read_json_body(request);
	if (body._nay) {
		return council_json(400, { message: body._nay.message });
	}
	const meetingId = body._yay.meetingId;
	const code = body._yay.code;
	if (typeof meetingId !== "string" || typeof code !== "string" || code.length === 0) {
		return council_json(400, { message: "meetingId and code are required" });
	}
	const displayName = council_read_string_field(body._yay, "displayName", { maxBytes: 128 });
	if (displayName._nay || displayName._yay === null) {
		return council_json(400, { message: displayName._nay?.message ?? "displayName is required" });
	}
	const email = council_read_string_field(body._yay, "email", { maxBytes: 254, optional: true });
	if (email._nay) {
		return council_json(400, { message: email._nay.message });
	}
	const joinAttemptId = council_read_string_field(body._yay, "joinAttemptId", { maxBytes: 64 });
	if (joinAttemptId._nay || joinAttemptId._yay === null) {
		return council_json(400, { message: joinAttemptId._nay?.message ?? "joinAttemptId is required" });
	}
	// `host-` is a RESERVED namespace owned by `handle_session`: it writes the host's own row under
	// `host-<actorUserId>`, and `(meeting_id, join_attempt_id)` is unique. Do not delete this check as
	// redundant. Without it a guest can send that exact key and take the host's row: the guest insert
	// below wins the key, the host's later `INSERT OR IGNORE` does nothing, and the host session is
	// handed the guest's row with the host role forced onto it. The opener's user id is not a secret
	// either — the plugin projection publishes it as `createdBy`. This is the only door that writes a
	// caller-supplied attempt id, so refusing here keeps the namespace clean everywhere downstream.
	if (joinAttemptId._yay.startsWith("host-")) {
		return council_json(400, { message: "joinAttemptId must not start with host-" });
	}

	// The code bucket is keyed on the presented value's hash, so hammering a wrong code still
	// counts against that code and never touches another meeting's bucket.
	const codeHash = await council_sha256_hex(code);
	const codeVerdict = await council_rate_limit(env.COUNCIL_DB, { name: "guest_join_code", key: codeHash, now });
	if (!codeVerdict.allowed) {
		return council_json(
			429,
			{ message: "Too many join attempts" },
			{ "Retry-After": String(codeVerdict.retryAfterSeconds) },
		);
	}

	// One neutral answer for a missing meeting and a wrong code, so a guess learns nothing about
	// which meetings exist. The client shows this message to the guest as typed help.
	const meeting = await council_get_meeting(env.COUNCIL_DB, meetingId);
	if (!meeting || meeting.code_hash !== codeHash) {
		return council_json(401, { message: "The meeting code is not right; check it and try again" });
	}
	const installationVerdict = await council_rate_limit(env.COUNCIL_DB, {
		name: "guest_join_installation",
		key: meeting.installation_id,
		now,
	});
	if (!installationVerdict.allowed) {
		return council_json(
			429,
			{ message: "Too many join attempts" },
			{
				"Retry-After": String(installationVerdict.retryAfterSeconds),
			},
		);
	}

	// The guest presented the right code, so they were invited: name the real reason a join is
	// impossible. One generic "not open" reads as "try again later", which is wrong once the
	// meeting can never be joined again.
	if (meeting.status === "created") {
		return council_json(409, { message: "The meeting is not open yet. Ask the host to open it, then try again." });
	}
	// `create_unknown` never becomes open (its only exits are expired and deleting), so for the
	// guest it is the same dead end as expired.
	if (meeting.status === "expired" || meeting.status === "create_unknown") {
		return council_json(409, { message: "This meeting expired before it was opened. It cannot be joined anymore." });
	}
	if (meeting.status !== "open" || meeting.deadline_at === null || now >= meeting.deadline_at) {
		return council_json(409, { message: join_refusal_message(meeting, now) });
	}

	// Idempotency: the same attempt with the same identity is the same person retrying; the same
	// attempt with a different identity is a conflict, never a silent overwrite.
	const emailHmac =
		email._yay === null
			? null
			: await council_email_hmac(env.COUNCIL_ROOM_COOKIE_SECRET, email._yay.trim().toLowerCase());
	const existing = await env.COUNCIL_DB.prepare(
		"SELECT * FROM meeting_participants WHERE meeting_id = ? AND join_attempt_id = ?",
	)
		.bind(meeting.id, joinAttemptId._yay)
		.first<council_ParticipantRow>();
	let participant = existing;
	if (existing) {
		if (existing.display_name !== displayName._yay || existing.email_hmac !== emailHmac) {
			return council_json(409, { message: "This join attempt was already used with different details" });
		}
	} else {
		const participantId = crypto.randomUUID();
		await env.COUNCIL_DB.prepare(
			`INSERT INTO meeting_participants (id, meeting_id, display_name, email_hmac, role, join_attempt_id, created_at)
			VALUES (?, ?, ?, ?, 'guest', ?, ?)`,
		)
			.bind(participantId, meeting.id, displayName._yay, emailHmac, joinAttemptId._yay, now)
			.run();
		participant = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_participants WHERE id = ?")
			.bind(participantId)
			.first<council_ParticipantRow>();
	}
	if (!participant) {
		return council_json(500, { message: "Failed to create the participant" });
	}

	const session = await create_room_session(env, {
		meetingId: meeting.id,
		participantId: participant.id,
		role: "guest",
		actorServiceGrantId: null,
		now,
	});
	return session_response(env, { meeting, participant, ...session });
}

// #endregion session creation

// #region in-room calls

/**
 * Let a retry replace a Worker request that died while its provider call was in flight.
 *
 * Keep this above `JOIN_TIMEOUT_MS` in `room/client.ts`. The client does re-post a join by itself,
 * once, after a 401. The pair still takes at most one lease: the post `room_session_auth` refuses
 * at the top of this handler is the *first* one — it answered 401 long before the claim below —
 * and the re-post, carrying the freshly rotated CSRF token, passes auth and is the pair's one
 * lease-taker. Both posts also share the one 30-second deadline, so the pair still ends there. A
 * second request that can take a lease therefore only appears when the client gives up at that
 * deadline and the person presses Join again. With the two values equal,
 * that second press lands exactly on the lease boundary and takes the lease while the first request
 * is still talking to the provider, so two attempts run on one participant row.
 */
const ADMISSION_ATTEMPT_LEASE_MS = 45_000;

async function handle_join(request: Request, env: Env, now: number) {
	const auth = await room_session_auth(env, request, now);
	if (auth._nay) {
		return council_json(401, { message: auth._nay.message });
	}
	const { session, meeting, participant } = auth._yay;
	// A lobby session only exists for a meeting that was open, so a non-open status here means the
	// meeting is over, not "not yet". `recording_start_unknown` is the one exception: the call is
	// still live there, it only stops recording and stops admitting new people. Someone who already
	// holds a provider token was admitted before that, so let them come back after a reload or a
	// dropped socket. New admissions stay refused: a row with a token always answers from the replay
	// branch below, so this exception never reaches the code that mints one.
	const rejoiningLiveCall =
		meeting.status === "recording_start_unknown" && participant.provider_token_encrypted !== null;
	if ((meeting.status !== "open" && !rejoiningLiveCall) || meeting.deadline_at === null || now >= meeting.deadline_at) {
		return council_json(409, { message: join_refusal_message(meeting, now) });
	}
	if (!meeting.provider_meeting_id) {
		return council_json(409, { message: "The meeting has no provider room" });
	}

	const body = await council_read_json_body(request);
	if (body._nay) {
		return council_json(400, { message: body._nay.message });
	}
	const displayName = council_read_string_field(body._yay, "displayName", { maxBytes: 128, optional: true });
	if (displayName._nay) {
		return council_json(400, { message: displayName._nay.message });
	}
	// The host types their name in the lobby. Store it before Add Participant so the provider
	// label and the transcript match what they typed, not the literal word "Host".
	if (displayName._yay && !participant.provider_token_encrypted) {
		await env.COUNCIL_DB.prepare("UPDATE meeting_participants SET display_name = ? WHERE id = ?")
			.bind(displayName._yay, participant.id)
			.run();
		participant.display_name = displayName._yay;
	}
	if (participant.display_name === "") {
		return council_json(400, { message: "displayName is required" });
	}

	// Bound the outbound work the verifies below buy. The check sits here, immediately before them,
	// because those calls are the thing being limited: one cheap request in, one or two Convex
	// actions out, on every join and every replay. A guest press buys one: the check on the meeting's
	// pinned grant. A host press buys two, because `council_verify_host_actor_grant` also checks the
	// grant this room session pinned. The key is the participant row the session already names, so one
	// person's loop can never spend another's budget, and the two ways in — a guest with a code and a
	// host with a ticket — get the same number of presses, not the same number of actions.
	const joinVerdict = await council_rate_limit(env.COUNCIL_DB, {
		name: "room_join_participant",
		key: participant.id,
		now,
	});
	if (!joinVerdict.allowed) {
		return council_json(
			429,
			{ message: "Too many join attempts" },
			{ "Retry-After": String(joinVerdict.retryAfterSeconds) },
		);
	}

	// Fail closed before every provider-visible effect, replays included: the installation and its
	// capabilities must be live at the moment of the mint, not at some earlier cleanup pass.
	const live = await council_verify_meeting_grant(env, meeting, now);
	if (live._nay) {
		return council_json(409, { message: "The meeting's authority is no longer live" });
	}
	const actorLive = await council_verify_host_actor_grant(env, {
		meeting,
		participant,
		actorServiceGrantId: session.actor_service_grant_id,
		now,
	});
	if (actorLive._nay) {
		return council_json(409, { message: "The meeting's authority is no longer live" });
	}

	// A replayed join returns the same provider result instead of creating a second participant.
	if (participant.provider_token_encrypted) {
		const token = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, participant.provider_token_encrypted);
		return council_json(200, { authToken: token });
	}

	// Own every provider call with a durable generation. An overlapping request cannot release or
	// persist another request's slot, while a lost-answer retry can claim the held slot later.
	const admissionAttemptId = crypto.randomUUID();
	const [claimedNew, reserved] = await env.COUNCIL_DB.batch([
		env.COUNCIL_DB.prepare(
			`UPDATE meeting_participants
			SET accepted_at = ?, admission_attempt_id = ?, admission_attempt_started_at = ?
			WHERE id = ? AND accepted_at IS NULL AND provider_token_encrypted IS NULL
			AND EXISTS (
				SELECT 1 FROM meetings
				WHERE meetings.id = meeting_participants.meeting_id
				AND meetings.status = 'open' AND meetings.deadline_at IS NOT NULL AND meetings.deadline_at > ?
				AND meetings.participant_count < ?
			)`,
		).bind(now, admissionAttemptId, now, participant.id, now, council_max_participants(env)),
		env.COUNCIL_DB.prepare(
			`UPDATE meetings
			SET participant_count = participant_count + 1, updated_at = ?
			WHERE id = ? AND EXISTS (
				SELECT 1 FROM meeting_participants
				WHERE id = ? AND admission_attempt_id = ?
			)`,
		).bind(now, meeting.id, participant.id, admissionAttemptId),
	]);
	if (claimedNew.meta.changes === 1) {
		if (reserved.meta.changes !== 1) {
			throw new Error("Admission batch claimed a participant without recounting the meeting");
		}
	} else {
		const claimedHeld = await env.COUNCIL_DB.prepare(
			`UPDATE meeting_participants
				SET admission_attempt_id = ?, admission_attempt_started_at = ?
				WHERE id = ? AND accepted_at IS NOT NULL AND provider_token_encrypted IS NULL
				AND (
					admission_attempt_id IS NULL OR admission_attempt_started_at IS NULL OR admission_attempt_started_at <= ?
				)`,
		)
			.bind(admissionAttemptId, now, participant.id, now - ADMISSION_ATTEMPT_LEASE_MS)
			.run();
		if (claimedHeld.meta.changes !== 1) {
			const currentParticipant = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_participants WHERE id = ?")
				.bind(participant.id)
				.first<council_ParticipantRow>();
			if (currentParticipant?.provider_token_encrypted) {
				const token = await council_decrypt(
					env.COUNCIL_ROOM_COOKIE_SECRET,
					currentParticipant.provider_token_encrypted,
				);
				return council_json(200, { authToken: token });
			}

			// Both claims above refuse for several different reasons, and retrying only helps for one
			// of them. Re-read the meeting and name the real reason, so a member of a full meeting is
			// not told to keep trying.
			const currentMeeting = await council_get_meeting(env.COUNCIL_DB, meeting.id);
			if (
				!currentMeeting ||
				currentMeeting.status !== "open" ||
				currentMeeting.deadline_at === null ||
				now >= currentMeeting.deadline_at
			) {
				return council_json(409, { message: join_refusal_message(currentMeeting, now) });
			}
			if (currentMeeting.participant_count >= council_max_participants(env)) {
				return council_json(409, {
					message: `This meeting is full. It allows ${council_max_participants(env)} participants.`,
				});
			}
			return council_json(409, { message: "A join is already in progress. Try again." });
		}
	}

	const release_slot = async () => {
		await env.COUNCIL_DB.batch([
			env.COUNCIL_DB.prepare(
				`UPDATE meetings SET participant_count = participant_count - 1, updated_at = ?
				WHERE id = ? AND participant_count > 0 AND EXISTS (
					SELECT 1 FROM meeting_participants
					WHERE id = ? AND admission_attempt_id = ? AND provider_token_encrypted IS NULL
				)`,
			).bind(now, meeting.id, participant.id, admissionAttemptId),
			env.COUNCIL_DB.prepare(
				`UPDATE meeting_participants
				SET accepted_at = NULL, admission_attempt_id = NULL, admission_attempt_started_at = NULL
				WHERE id = ? AND admission_attempt_id = ? AND provider_token_encrypted IS NULL`,
			).bind(participant.id, admissionAttemptId),
		]);
	};

	let preset: Awaited<ReturnType<typeof ensure_preset_cached>>;
	try {
		preset = await ensure_preset_cached(env, participant.role, now);
	} catch (error) {
		await release_slot();
		console.warn("Preset ensure answer was lost; refusing the join", { meetingId: meeting.id, error });
		return council_json(502, { message: "The provider presets are not ready" });
	}
	if (preset._nay) {
		// Name the real refusal in the log: the 502 body stays generic on purpose, and a silent
		// branch here cost a full tail cycle to diagnose once already.
		console.warn("Preset ensure failed; refusing the join", {
			meetingId: meeting.id,
			role: participant.role,
			reason: preset._nay.name,
			message: preset._nay.message,
		});
		await release_slot();
		return council_json(502, { message: "The provider presets are not ready" });
	}

	let added;
	try {
		added = await council_provider_add_participant(env, {
			providerMeetingId: meeting.provider_meeting_id,
			name: participant.display_name,
			presetName: preset._yay,
			customParticipantId: participant.id,
		});
	} catch {
		// The answer was lost: the provider participant may or may not exist. The slot stays
		// reserved so a duplicate can never exceed the cap; the retry replays the same durable
		// `custom_participant_id`.
		await env.COUNCIL_DB.prepare(
			`UPDATE meeting_participants SET admission_attempt_id = NULL, admission_attempt_started_at = NULL
			WHERE id = ? AND admission_attempt_id = ? AND provider_token_encrypted IS NULL`,
		)
			.bind(participant.id, admissionAttemptId)
			.run();
		return council_json(502, { message: "The provider answer was lost; try again" });
	}
	if (added._nay) {
		await release_slot();
		return council_json(502, { message: "The provider refused the participant" });
	}

	const postProviderNow = Date.now();
	const stored = await env.COUNCIL_DB.prepare(
		`UPDATE meeting_participants
		SET provider_participant_id = ?, provider_token_encrypted = ?, accepted_at = ?, admission_attempt_id = NULL,
		admission_attempt_started_at = NULL
		WHERE id = ? AND admission_attempt_id = ? AND provider_token_encrypted IS NULL
		AND EXISTS (
			SELECT 1 FROM meetings
			WHERE meetings.id = meeting_participants.meeting_id
			AND meetings.status = 'open' AND meetings.deadline_at IS NOT NULL AND meetings.deadline_at > ?
		)`,
	)
		.bind(
			added._yay.providerParticipantId,
			await council_encrypt(env.COUNCIL_ROOM_COOKIE_SECRET, added._yay.token),
			postProviderNow,
			participant.id,
			admissionAttemptId,
			postProviderNow,
		)
		.run();
	if (stored.meta.changes !== 1) {
		const currentParticipant = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_participants WHERE id = ?")
			.bind(participant.id)
			.first<council_ParticipantRow>();
		// Every attempt for this participant sends the same durable `custom_participant_id`, so the
		// provider can answer a losing attempt with the id the winning attempt already stored. Deleting
		// that id would remove the winner from the provider room while the row keeps handing out their
		// token, and nobody could rejoin. Only delete an id the row does not hold.
		if (currentParticipant?.provider_participant_id !== added._yay.providerParticipantId) {
			// Never expose a token minted after close. Delete the provider participant best-effort; the
			// token stays unknown to every client even if the provider cleanup itself is unavailable.
			try {
				const deleted = await council_provider_delete_participant(env, {
					providerMeetingId: meeting.provider_meeting_id,
					providerParticipantId: added._yay.providerParticipantId,
				});
				if (deleted._nay) {
					console.warn("Provider participant cleanup was refused after a late join", {
						meetingId: meeting.id,
						providerParticipantId: added._yay.providerParticipantId,
						reason: deleted._nay.name,
					});
				}
			} catch {
				console.warn("Provider participant cleanup answer was lost after a late join", {
					meetingId: meeting.id,
					providerParticipantId: added._yay.providerParticipantId,
				});
			}
		}
		await release_slot();
		const currentMeeting = await council_get_meeting(env.COUNCIL_DB, meeting.id);
		if (
			currentMeeting?.status === "open" &&
			currentMeeting.deadline_at !== null &&
			postProviderNow < currentMeeting.deadline_at &&
			currentParticipant?.provider_token_encrypted
		) {
			return council_json(200, {
				authToken: await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, currentParticipant.provider_token_encrypted),
			});
		}
		// The host can lose a Start recording answer while this join is talking to the provider. That
		// leaves a live call that takes nobody new, so name that instead of announcing an end that
		// did not happen. `join_refusal_message` holds the same rule for the refusals above.
		if (
			currentMeeting?.status === "recording_start_unknown" &&
			currentMeeting.deadline_at !== null &&
			postProviderNow < currentMeeting.deadline_at
		) {
			return council_json(409, { message: "This meeting stopped letting new people in before the join finished." });
		}
		return council_json(409, { message: "This meeting ended before the join finished." });
	}

	return council_json(200, { authToken: added._yay.token });
}

/**
 * The verified preset name for a role, re-read from the provider at most once a day. The detail
 * verification lives in the provider adapter; this only caches its positive answer.
 */
async function ensure_preset_cached(env: Env, role: "host" | "guest", now: number) {
	const cached = await env.COUNCIL_DB.prepare("SELECT * FROM provider_presets WHERE role = ? AND verified_at > ?")
		.bind(role, now - PRESET_VERIFY_TTL_MS)
		.first<{ preset_name: string }>();
	if (cached) {
		return Result({ _yay: cached.preset_name });
	}

	const ensured = await council_provider_ensure_preset(env, role);
	if (ensured._nay) {
		return ensured;
	}
	await env.COUNCIL_DB.prepare(
		`INSERT INTO provider_presets (role, preset_name, preset_id, verified_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (role) DO UPDATE SET preset_name = excluded.preset_name, preset_id = excluded.preset_id, verified_at = excluded.verified_at`,
	)
		.bind(role, ensured._yay.presetName, ensured._yay.presetId, now)
		.run();
	return Result({ _yay: council_PRESET_NAMES[role] });
}

async function handle_state(request: Request, env: Env, now: number) {
	const auth = await room_session_auth(env, request, now);
	if (auth._nay) {
		return council_json(401, { message: auth._nay.message });
	}
	return council_json(200, { meeting: meeting_room_view(env, auth._yay.meeting) });
}

async function handle_start_recording(request: Request, env: Env, now: number) {
	const auth = await room_session_auth(env, request, now);
	if (auth._nay) {
		return council_json(401, { message: auth._nay.message });
	}
	const { session, meeting, participant } = auth._yay;
	if (session.role !== "host") {
		return council_json(403, { message: "Only the host can start the recording" });
	}
	// Two of the states refused here are live calls, so name the real reason the way
	// `join_refusal_message` does for joins instead of calling them not open.
	// `recording_start_unknown` only stops the recording and stops admitting new people; a second
	// host pressing Start there is standing in a running call. An open meeting past its deadline is
	// live too: nothing ends the call at the deadline, the cron closes it up to fifteen minutes
	// later.
	if (meeting.status === "recording_start_unknown") {
		return council_json(409, { message: "This meeting can no longer record." });
	}
	if (meeting.status !== "open") {
		return council_json(409, { message: "The meeting is not open" });
	}
	if (meeting.deadline_at === null || now >= meeting.deadline_at) {
		return council_json(409, { message: "The meeting passed its scheduled end, so recording can no longer start." });
	}
	if (meeting.provider_recording_id) {
		return council_json(409, { message: "The recording is already running" });
	}
	if (!meeting.provider_meeting_id) {
		return council_json(409, { message: "The meeting has no provider room" });
	}

	const live = await council_verify_meeting_grant(env, meeting, now);
	if (live._nay) {
		return council_json(409, { message: "The meeting's authority is no longer live" });
	}
	const actorLive = await council_verify_host_actor_grant(env, {
		meeting,
		participant,
		actorServiceGrantId: session.actor_service_grant_id,
		now,
	});
	if (actorLive._nay) {
		return council_json(409, { message: "The meeting's authority is no longer live" });
	}

	let started;
	try {
		started = await council_provider_start_recording(env, {
			providerMeetingId: meeting.provider_meeting_id,
			maxSeconds: council_max_minutes(env) * 60,
		});
	} catch {
		// The answer was lost. A second Start Recording could run two recordings, so this state
		// never retries automatically. The dead end is only right while no recording id is stored:
		// then closing the meeting settles it with nothing to process. A start from another tab can
		// attach its id while this call is in the air without changing the status, so the transition
		// itself requires that premise — the same guard the attach write below carries.
		const moved = await council_transition_meeting(env.COUNCIL_DB, {
			meetingId: meeting.id,
			from: ["open"],
			to: "recording_start_unknown",
			now,
			requireNoRecording: true,
		});
		// The transition refusing means the meeting moved on while the call was in the air. With a
		// recording attached and the meeting still open, tell the loser what the other tab made true.
		// Close keeps the id after it stops the recording, so an id alone does not mean it is
		// running. A 502 would make the room close the recording control for good and announce that
		// nothing will be saved, while an attached open recording is producing files.
		if (!moved) {
			const current = await council_get_meeting(env.COUNCIL_DB, meeting.id);
			if (current?.provider_recording_id && current.status === "open") {
				return council_json(409, { message: "The recording is already running" });
			}
			if (current?.provider_recording_id) {
				return council_json(409, { message: "The meeting is not open" });
			}
		}
		return council_json(502, { message: "The provider answer was lost" });
	}
	// The provider answered, and it said no. Nothing was written: the meeting is still open, still
	// joinable, and the host can press Start recording again. Do not answer 502 here. On this route
	// the room page reads 502 as the lost answer above, closes the recording control for good, and
	// tells the host that the meeting will not be saved and nobody else can join. None of that is
	// true for a refusal.
	if (started._nay) {
		return council_json(503, { message: "The provider refused to start the recording" });
	}

	// The open check above ran before the provider call, and the meeting can change while that
	// call is in the air: the host can close it (or the deadline cron can), or a second start from
	// another tab can attach its recording first. Close stops only the recording id it finds in
	// the row, so an unguarded write here would attach a recording that nothing ever stops. Attach
	// the id only while the meeting is still open and has no recording.
	const attached = await env.COUNCIL_DB.prepare(
		"UPDATE meetings SET provider_recording_id = ?, recording_started_at = ?, updated_at = ? WHERE id = ? AND status = 'open' AND provider_recording_id IS NULL",
	)
		.bind(started._yay.providerRecordingId, now, now, meeting.id)
		.run()
		// A write that fails outright leaves the same problem as a refused one, so handle both below
		// instead of letting the failure escape with the recording still running.
		.catch(() => null);
	// The id was never stored, so no close or pipeline step can stop this recording later. Stop it
	// now, best-effort: if this stop also fails, the recording still ends at its max_seconds cap.
	if (attached?.meta.changes !== 1) {
		try {
			const stopped = await council_provider_stop_recording(env, started._yay.providerRecordingId);
			if (stopped._nay) {
				console.warn("The provider refused to stop the refused recording; it ends at its max_seconds cap", {
					meetingId: meeting.id,
					reason: stopped._nay.message,
				});
			}
		} catch (error) {
			console.warn("Stopping the refused recording threw; it ends at its max_seconds cap", {
				meetingId: meeting.id,
				error: String(error),
			});
		}
		// The write failed rather than being refused, so the meeting is fine and the host may retry.
		if (!attached) {
			return council_json(500, { message: "Storing the recording failed" });
		}

		// Answer with the same reason the pre-checks above would give now: an attached id, the
		// recording_start_unknown dead end, or a meeting that is not open.
		const after = await council_get_meeting(env.COUNCIL_DB, meeting.id);
		if (after?.provider_recording_id) {
			return council_json(409, { message: "The recording is already running" });
		}
		if (after?.status === "recording_start_unknown") {
			return council_json(409, { message: "This meeting can no longer record." });
		}
		return council_json(409, { message: "The meeting is not open" });
	}
	return council_json(200, { recording: true });
}

async function handle_host_close(request: Request, env: Env, now: number) {
	const auth = await room_session_auth(env, request, now);
	if (auth._nay) {
		return council_json(401, { message: auth._nay.message });
	}
	if (auth._yay.session.role !== "host") {
		return council_json(403, { message: "Only the host can close the meeting" });
	}

	// The host cookie is the proof they were admitted to this call. Do not refuse close when the
	// pin grant is dead: uninstall and revoke both fail verify-live the same way, and leaving the
	// provider room up until the deadline cron would strand everyone already in the call. Page
	// ticket and page close still verify the caller's own grant, so a removed member cannot mint
	// a new host link.
	const closed = await council_close_meeting(env, auth._yay.meeting.id, now);
	if (closed._nay) {
		return council_json(409, { message: closed._nay.message });
	}
	// `recorded` is the server's read of the row after admission closed. The room prefers it over
	// its own recording stage when telling the host whether files are coming.
	return council_json(200, { status: closed._yay.status, recorded: closed._yay.recorded });
}

// #endregion in-room calls
