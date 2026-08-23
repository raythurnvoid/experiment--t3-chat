/**
 * The members-only page API: `POST /api/meetings/*`, CORS-scoped to the one plugin-asset origin.
 * Every route authenticates a `plu_` page token by exchanging it through Convex; CORS is browser
 * transport policy only and never the gate.
 */

import type { Env } from "./env.ts";
import { council_destination_prefix, council_max_minutes, council_max_participants } from "./env.ts";
import { council_cors_headers } from "./cors.ts";
import {
	council_get_meeting,
	council_get_service_grant,
	council_rate_limit,
	council_transition_meeting,
	type council_ArtifactRow,
	type council_MeetingRow,
} from "./db.ts";
import { council_decrypt, council_random_token, council_sha256_hex } from "./crypto.ts";
import { council_get_bearer, council_json, council_read_json_body, council_read_string_field } from "./http.ts";
import {
	council_page_auth,
	council_verify_grant,
	council_verify_meeting_grant,
	type council_PageActor,
} from "./grants.ts";
import { council_provider_create_meeting } from "./provider.ts";
import { council_convex_data_release_reservation, council_convex_data_reserve } from "./convex-api.ts";
import { council_close_meeting, council_request_meeting_delete, council_seal_meeting_grant } from "./lifecycle.ts";
import { council_project_meeting, council_PROJECTION_COLLECTION } from "./projection.ts";
import { Result } from "./result.ts";

/** How long a member has to open the room page before the one-time ticket dies. */
const TICKET_TTL_MS = 2 * 60 * 1000;

/** The Plan 2 value-size envelope reserved for one meeting document. */
const PROJECTION_MAX_BYTES = 16 * 1024;

function projection_idempotency_key(meetingId: string) {
	return `council-meeting-${meetingId}`;
}

/**
 * The sanitized meeting the page may see. Never the code hash, the grant ids, the provider ids, or
 * the stored `failure_reason`. `failure_sentence` says what the page gets in place of that column.
 */
function meeting_view(env: Env, meeting: council_MeetingRow, artifacts: council_ArtifactRow[] = []) {
	return {
		id: meeting.id,
		title: meeting.title,
		status: meeting.status,
		failureReason: failure_sentence(meeting),
		createdAt: meeting.created_at,
		openedAt: meeting.opened_at,
		closedAt: meeting.closed_at,
		deadlineAt: meeting.deadline_at,
		participantCount: meeting.participant_count,
		maxParticipants: council_max_participants(env),
		destinationPath: meeting.destination_path,
		artifacts: artifacts_view(artifacts),
	};
}

/**
 * What a failed meeting says on the card.
 *
 * `meetings.failure_reason` holds the message the pipeline threw. That text is written for an
 * operator: it names internal Convex routes, HTTP statuses, upload target keys and provider status
 * words. A step message like "the step will retry" is also already false when a member reads it,
 * because only a spent retry budget writes the column at all. So the column stays in D1, where an
 * operator reads it by meeting id, and the page gets a stable product sentence. This is the rule
 * `council_handle_page_api` below already applies to the Convex exchange refusal.
 *
 * One sentence per status is the whole mapping, because the stored text carries no failure code:
 * the pipeline composes a message and drops the `_nay.name` that told a plan refusal apart from a
 * lost provider answer. Each sentence therefore has to be true for every cause of its status, which
 * is why the `failed` one sends a member who keeps seeing it to an admin instead of naming a cause.
 *
 * Only `failed` and `delete_failed` ever store a reason, and nothing clears the column afterwards,
 * so a meeting that failed once and was redriven to `ready` still carries the old text. Every other
 * status answers null.
 */
function failure_sentence(meeting: council_MeetingRow) {
	// Say "finish": a run can fail after some artifacts already finalized, and the card shows a badge
	// for each of those. Council redrives a failed meeting hourly while its sealed grant lives, so
	// waiting is the right first move. Then name no cause. `failed` is where every spent retry budget
	// lands: a plan refusal, a locked file, a revoked grant and a failed transcription all arrive as
	// this one status, and no page route repairs any of them. Naming a cause here would send the
	// admin to check the wrong thing and leave the real one unlooked-at.
	if (meeting.status === "failed") {
		return "Council could not finish saving this meeting's files. It keeps trying on its own for a few days; if the meeting still shows this, ask a workspace admin to look into it.";
	}
	// Promise only that the meeting itself is still here. The delete archives the folder before its
	// last two steps, so a failure after that point leaves the meeting listed with its files already
	// gone from the tree. The two refusals that stop a delete for good are a read-only file in the
	// folder and a dead grant, and pressing Delete again seals fresh authority for the second one.
	if (meeting.status === "delete_failed") {
		return "Council could not finish deleting this meeting, so it is still here. Press Delete again to start a new attempt; if a file in the meeting's folder is read-only, clear that first.";
	}
	return null;
}

/** The finished files the page may link, as the room/page client reads them: name plus node id. */
function artifacts_view(artifacts: council_ArtifactRow[]) {
	return artifacts
		.filter((artifact) => artifact.status === "finalized" && artifact.node_id !== null)
		.map((artifact) => ({ kind: artifact.kind, name: artifact.file_name, fileNodeId: artifact.node_id }));
}

type PageContext = {
	env: Env;
	request: Request;
	actor: council_PageActor;
	body: Record<string, unknown>;
	now: number;
	respond: (status: number, payload: unknown, retryAfterSeconds?: number) => Response;
};

/**
 * Load a meeting for a page call and prove it belongs to the caller's installation. A meeting of
 * another installation answers the same as a missing one, so ids cannot be probed across tenants.
 */
async function load_meeting_for_actor(context: PageContext) {
	const meetingId = context.body.meetingId;
	if (typeof meetingId !== "string" || meetingId.length === 0) {
		return Result<never>({ _nay: { name: "bad_request", message: "meetingId is required" } });
	}
	const meeting = await council_get_meeting(context.env.COUNCIL_DB, meetingId);
	if (!meeting || meeting.installation_id !== context.actor.installationId) {
		return Result<never>({ _nay: { name: "not_found", message: "Not found" } });
	}
	return Result({ _yay: meeting });
}

export async function council_handle_page_api(request: Request, env: Env, now: number): Promise<Response> {
	const corsHeaders = council_cors_headers(request.headers.get("Origin"), env.COUNCIL_PLUGIN_ORIGIN);
	const respond = (status: number, payload: unknown, retryAfterSeconds?: number) =>
		council_json(status, payload, {
			...corsHeaders,
			...(retryAfterSeconds !== undefined ? { "Retry-After": String(retryAfterSeconds) } : {}),
		});
	if (request.method !== "POST") {
		return respond(405, { message: "Method not allowed" });
	}

	const bearer = council_get_bearer(request);
	if (!bearer) {
		return respond(401, { message: "Unauthorized" });
	}
	// Page auth limits the Convex exchange per client address, and that needs the trusted edge
	// header. Without it, refuse rather than fall back to a value the caller can set for itself,
	// which would put every caller in one bucket.
	let clientIp = request.headers.get("CF-Connecting-IP");
	if (!clientIp) {
		if (env.COUNCIL_ALLOW_MISSING_CLIENT_IP === "true") {
			clientIp = "loopback";
		} else {
			return respond(400, { message: "Missing client address" });
		}
	}

	const auth = await council_page_auth(env, bearer, clientIp, now);
	if (auth._nay) {
		// The exchange builds this message for an operator: it names the internal Convex route and the
		// status it answered. A member must not read that, so the reason goes to the log and the page
		// gets a stable product sentence.
		console.warn("Page authentication failed; the member sees a stable message instead of this reason", {
			name: auth._nay.name,
			reason: auth._nay.message,
		});
		// The exchange limit is keyed on the client address, so everyone in one office shares it. Tell
		// the member their network is busy, not that they are not allowed in.
		if (auth._nay.name === "rate_limited") {
			return respond(429, { message: "Council is verifying too many pages from this network. Try again shortly." });
		}
		return respond(auth._nay.name === "unauthorized" ? 401 : 502, {
			message:
				auth._nay.name === "unauthorized"
					? "Council is not authorized for this workspace. Ask a workspace admin to review the plugin's access."
					: "Council could not verify this page with the workspace right now. Try again shortly.",
		});
	}

	const body = await council_read_json_body(request);
	if (body._nay) {
		return respond(400, { message: body._nay.message });
	}

	const context: PageContext = { env, request, actor: auth._yay, body: body._yay, now, respond };
	const path = new URL(request.url).pathname;
	switch (path) {
		case "/api/meetings/create":
			return await handle_create(context);
		case "/api/meetings/list":
			return await handle_list(context);
		case "/api/meetings/get":
			return await handle_get(context);
		case "/api/meetings/open":
			return await handle_open(context);
		case "/api/meetings/room-ticket":
			return await handle_room_ticket(context);
		case "/api/meetings/close":
			return await handle_close(context);
		case "/api/meetings/delete":
			return await handle_delete(context);
		default:
			return respond(404, { message: "Not found" });
	}
}

async function handle_create(context: PageContext) {
	const { env, actor, now, respond } = context;
	// Keep every new meeting out of D1 while a coordinated release changes the host contract.
	if (env.COUNCIL_MAINTENANCE === "true") {
		return respond(503, { message: "Council is being upgraded. Try again shortly." }, 300);
	}
	const title = council_read_string_field(context.body, "title", { maxBytes: 200 });
	if (title._nay || title._yay === null) {
		return respond(400, { message: title._nay?.message ?? "title is required" });
	}

	const limited = await council_rate_limit(env.COUNCIL_DB, {
		name: "meeting_create",
		key: `${actor.installationId}:${actor.actorUserId}`,
		now,
	});
	if (!limited.allowed) {
		return respond(429, { message: "Too many meetings created; try again later" }, limited.retryAfterSeconds);
	}

	// The D1 intent row exists before any provider effect, so a lost provider answer always has a
	// durable row to land in.
	const meetingId = crypto.randomUUID();
	const code = council_random_token();
	const codeHash = await council_sha256_hex(code);
	// Canonical lowercase absolute path — the seal-processing prefix contract refuses anything else.
	const destinationPath = `${council_destination_prefix(env)}/${meetingId}`;
	await env.COUNCIL_DB.prepare(
		`INSERT INTO meetings (id, code_hash, organization_id, workspace_id, installation_id, plugin_name, title, created_by_user_id, service_grant_id, destination_path, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 'council', ?, ?, ?, ?, 'created', ?, ?)`,
	)
		.bind(
			meetingId,
			codeHash,
			actor.organizationId,
			actor.workspaceId,
			actor.installationId,
			title._yay,
			actor.actorUserId,
			actor.serviceGrantId,
			destinationPath,
			now,
			now,
		)
		.run();

	// Reserve the projection's full Plan 2 envelope before the provider call. A store that cannot
	// hold the document refuses the meeting before any provider effect exists.
	const grant = await council_get_service_grant(env.COUNCIL_DB, actor.serviceGrantId);
	if (!grant) {
		return respond(500, { message: "Failed to create the meeting" });
	}
	// `council_page_auth` serves the first minute after a check from `page_token_cache` without
	// asking Convex, so on that fast path nothing has touched this grant's token yet and this is the
	// first read. If the operator rotated `COUNCIL_ROOM_COOKIE_SECRET` inside that minute, the token
	// was sealed under the old key and cannot be read. Answer 503 instead of throwing: once the
	// cached minute is over, page auth exchanges again and seals a grant under the new key, so the
	// next try succeeds by itself.
	let psgToken: string;
	try {
		psgToken = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);
	} catch {
		// Take the intent row back out, the same way the reservation refusal below does. The member
		// is told to try again, and a `created` row nothing can finish would otherwise sit in their
		// list offering an Open button.
		await env.COUNCIL_DB.prepare("DELETE FROM meetings WHERE id = ? AND status = 'created'").bind(meetingId).run();
		return respond(503, { message: "Council is reloading its credentials. Try again shortly." }, 60);
	}
	const reserved = await council_convex_data_reserve(env, psgToken, {
		collection: council_PROJECTION_COLLECTION,
		key: meetingId,
		maximumBytes: PROJECTION_MAX_BYTES,
		idempotencyKey: projection_idempotency_key(meetingId),
		// Seven days: inside the host's eight-day reservation ceiling, and past the provider's
		// seven-day recording retention, so the reservation outlives every supported recovery path.
		expiresAt: now + 7 * 24 * 60 * 60 * 1000,
	});
	if (reserved._nay) {
		await env.COUNCIL_DB.prepare("DELETE FROM meetings WHERE id = ? AND status = 'created'").bind(meetingId).run();
		// Create is the one privileged page action that verifies no grant of its own. It spends the
		// member's write permission through this host door instead, so this refusal is where a member
		// an admin moved to `viewer` mid-session first finds out. Page auth claims only the read scope
		// now, so they still hold a working page and reach this line.
		//
		// Name the permission. The upload refusals `convex-api.ts` names (`storage_full`,
		// `plan_required`) never land here: it mints them only from the file-upload routes' exact 403
		// texts, and this is the plugin-data reserve route, which sends neither. The store's own
		// ceilings answer 403 too, but `convex-api.ts` names those `data_store_full`, so the branch
		// below keeps a store Council has filled out of this permission sentence.
		if (reserved._nay.name === "unauthorized") {
			return respond(403, {
				message:
					"You do not have permission to create meetings in this workspace. Ask a workspace admin to review your access.",
			});
		}
		// A full store is Council's own data, not the member's access, and deleting meetings is the
		// member's real repair: the store gives a deleted document's bytes back at once. The slot a
		// deleted meeting held stays occupied by a retry tombstone for a day, so promise the space
		// back within a day rather than immediately.
		if (reserved._nay.name === "data_store_full") {
			return respond(403, {
				message:
					"Council's storage in this workspace is full, so it cannot save a new meeting. Delete meetings you no longer need and try again; freed space can take up to a day to come back.",
			});
		}
		return respond(502, { message: "Failed to reserve storage for the meeting" });
	}

	// The provider offers no idempotency key on create, so a lost answer lands in `create_unknown`
	// and is never retried automatically. Only an explicit provider refusal rolls the intent back.
	let created;
	try {
		created = await council_provider_create_meeting(env, title._yay);
	} catch (error) {
		await council_transition_meeting(env.COUNCIL_DB, {
			meetingId,
			from: ["created"],
			to: "create_unknown",
			now,
		});
		// Whatever threw here is internal: a dropped connection, or the origin guard in `provider.ts`
		// refusing a misconfigured base URL. A member can act on neither, and no operator can repair
		// a `create_unknown` meeting anyway — `db.ts` lets that status move only to `expired` or
		// `deleting`. So the reason goes to the log, and the member reads the same sentence the card
		// in `app.tsx` shows for this status. One event must not tell the member two different things.
		console.warn("The provider answer to create was lost; the member sees a stable message instead", {
			meetingId,
			error: String(error),
		});
		return respond(502, {
			message:
				"Council did not get an answer when it created the room, so this meeting cannot be opened. Delete it and create a new meeting.",
			meetingId,
		});
	}
	if (created._nay) {
		await council_convex_data_release_reservation(env, psgToken, {
			collection: council_PROJECTION_COLLECTION,
			key: meetingId,
			idempotencyKey: projection_idempotency_key(meetingId),
		});
		await env.COUNCIL_DB.prepare("DELETE FROM meetings WHERE id = ? AND status = 'created'").bind(meetingId).run();
		return respond(502, { message: "The provider refused to create the meeting" });
	}

	await env.COUNCIL_DB.prepare("UPDATE meetings SET provider_meeting_id = ?, updated_at = ? WHERE id = ?")
		.bind(created._yay.providerMeetingId, now, meetingId)
		.run();
	await council_project_meeting(env, meetingId, now);

	const meeting = await council_get_meeting(env.COUNCIL_DB, meetingId);
	const origin = new URL(context.request.url).origin;
	return respond(200, {
		meeting: meeting ? meeting_view(env, meeting) : null,
		// The one moment the plaintext code exists. Only its hash is stored. The guest link carries
		// only the meeting id, in the `?m=` shape the room client reads; the code stays out of every
		// URL so a shared or logged link cannot admit anyone. Guests type the code by hand.
		joinCode: code,
		guestUrl: `${origin}/room?m=${meetingId}`,
	});
}

async function handle_list(context: PageContext) {
	const { env, actor, respond } = context;
	const meetings = await env.COUNCIL_DB.prepare(
		"SELECT * FROM meetings WHERE installation_id = ? AND status != 'deleted_tombstone' ORDER BY created_at DESC LIMIT 100",
	)
		.bind(actor.installationId)
		.all<council_MeetingRow>();
	// One bounded companion query avoids one details request per card on every page poll.
	const artifacts = await env.COUNCIL_DB.prepare(
		`SELECT a.* FROM meeting_artifacts a
		WHERE a.meeting_id IN (
			SELECT id FROM meetings
			WHERE installation_id = ? AND status != 'deleted_tombstone'
			ORDER BY created_at DESC LIMIT 100
		) AND a.status = 'finalized'
		ORDER BY a.meeting_id, a.kind, a.file_name`,
	)
		.bind(actor.installationId)
		.all<council_ArtifactRow>();
	const artifactsByMeeting = new Map<string, council_ArtifactRow[]>();
	for (const artifact of artifacts.results) {
		const group = artifactsByMeeting.get(artifact.meeting_id) ?? [];
		group.push(artifact);
		artifactsByMeeting.set(artifact.meeting_id, group);
	}
	return respond(200, {
		meetings: meetings.results.map((meeting) => meeting_view(env, meeting, artifactsByMeeting.get(meeting.id))),
	});
}

async function handle_get(context: PageContext) {
	const { env, respond } = context;
	const meeting = await load_meeting_for_actor(context);
	if (meeting._nay) {
		return respond(meeting._nay.name === "bad_request" ? 400 : 404, { message: meeting._nay.message });
	}
	const artifacts = await env.COUNCIL_DB.prepare("SELECT * FROM meeting_artifacts WHERE meeting_id = ?")
		.bind(meeting._yay.id)
		.all<council_ArtifactRow>();
	return respond(200, {
		meeting: meeting_view(env, meeting._yay, artifacts.results),
		artifacts: artifacts_view(artifacts.results),
	});
}

async function handle_open(context: PageContext) {
	const { env, actor, now, respond } = context;
	const meeting = await load_meeting_for_actor(context);
	if (meeting._nay) {
		return respond(meeting._nay.name === "bad_request" ? 400 : 404, { message: meeting._nay.message });
	}
	if (meeting._yay.status !== "created") {
		return respond(409, { message: "Meeting is not in a state that can be opened" });
	}

	const limited = await council_rate_limit(env.COUNCIL_DB, {
		name: "meeting_open",
		key: `${actor.installationId}:${actor.actorUserId}`,
		now,
	});
	if (!limited.allowed) {
		return respond(429, { message: "Too many opens; try again later" }, limited.retryAfterSeconds);
	}

	// Plan-3 E8: processing authority is claimed HERE, before any admission exists, so the pipeline
	// never depends on the member's page session.
	const deadline = now + council_max_minutes(env) * 60 * 1000;
	let openSet: Record<string, string | number | null>;
	if (!meeting._yay.processing_grant_id) {
		// Seal from the caller's live interactive grant, not the create-time pin. The pin lives 24
		// hours; open can happen near the end of that window, and join still verifies the pin.
		// Sealing verifies the interactive grant live first, so this is also the fail-closed check.
		const sealed = await council_seal_meeting_grant(env, meeting._yay, now, actor.serviceGrantId);
		if (sealed._nay) {
			return respond(sealed._nay.name === "network" ? 502 : 409, {
				message: "The meeting's authority is no longer live",
			});
		}
		// Write the pin and the sealed grant only inside the guarded `created -> open` UPDATE below.
		// The seal is a round trip to Convex, so a second open can win the transition meanwhile. A
		// plain `WHERE id = ?` write here would let this loser repoint the open meeting's grants to
		// itself while its own open answers 409: joins would verify the loser's pin and the pipeline
		// would upload as the loser. The loser's sealed grant row stays behind unreferenced, the same
		// as after a crash between sealing and opening; the expired-grant sweep in `cleanup.ts`
		// deletes it once it expires.
		openSet = {
			opened_at: now,
			deadline_at: deadline,
			service_grant_id: actor.serviceGrantId,
			processing_grant_id: sealed._yay.processingGrantId,
		};
	} else {
		// A meeting can store a sealed grant while still `created`: a delete attempt seals and stores
		// its grant before the `deleting` transition, so a delete that crashed between those two
		// writes leaves this state behind. Reuse the stored grant, but still recheck liveness first.
		const live = await council_verify_meeting_grant(env, meeting._yay, now);
		if (live._nay) {
			return respond(409, { message: "The meeting's authority is no longer live" });
		}
		openSet = { opened_at: now, deadline_at: deadline };
	}

	const moved = await council_transition_meeting(env.COUNCIL_DB, {
		meetingId: meeting._yay.id,
		from: ["created"],
		to: "open",
		now,
		set: openSet,
	});
	if (!moved) {
		return respond(409, { message: "Meeting is not in a state that can be opened" });
	}
	await council_project_meeting(env, meeting._yay.id, now);
	const after = await council_get_meeting(env.COUNCIL_DB, meeting._yay.id);
	return respond(200, { meeting: after ? meeting_view(env, after) : null });
}

async function handle_room_ticket(context: PageContext) {
	const { env, actor, now, respond } = context;
	const meeting = await load_meeting_for_actor(context);
	if (meeting._nay) {
		return respond(meeting._nay.name === "bad_request" ? 400 : 404, { message: meeting._nay.message });
	}
	// Only `handle_open` moves a meeting to `open`, and the same transition is what sets
	// `deadline_at`. So a `created` meeting has no deadline, and the room's `handle_join` refuses
	// every join without one — it would tell the member that a meeting which never started "has
	// ended". Mint a host ticket only for a meeting that is really open. The dashboard already offers
	// the host room link only then, so nothing reaches this route earlier.
	if (meeting._yay.status !== "open") {
		return respond(409, { message: "Meeting is not joinable" });
	}

	// The ticket is this member's way into the call, and the call is recorded and written to their
	// workspace. Claim the write scope so a member who lost `content.write` is refused here, before
	// they are in a room everyone else joined.
	const live = await council_verify_grant(env, actor.serviceGrantId, now, ["plugin_data:read", "plugin_data:write"]);
	if (live._nay) {
		return respond(409, { message: "The meeting's authority is no longer live" });
	}

	const ticket = council_random_token();
	await env.COUNCIL_DB.prepare(
		"INSERT INTO meeting_tickets (token_hash, meeting_id, actor_user_id, actor_service_grant_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(
			await council_sha256_hex(ticket),
			meeting._yay.id,
			actor.actorUserId,
			actor.serviceGrantId,
			now + TICKET_TTL_MS,
			now,
		)
		.run();

	// The ticket rides the URL FRAGMENT: fragments are not sent to servers, so no access log or
	// Referer header can capture it. The room script consumes and clears it before anything loads.
	const origin = new URL(context.request.url).origin;
	return respond(200, { roomUrl: `${origin}/room?m=${encodeURIComponent(meeting._yay.id)}#ticket=${ticket}` });
}

async function handle_close(context: PageContext) {
	const { env, actor, now, respond } = context;
	const meeting = await load_meeting_for_actor(context);
	if (meeting._nay) {
		return respond(meeting._nay.name === "bad_request" ? 400 : 404, { message: meeting._nay.message });
	}

	// Closing writes: a closed meeting that has a recording is handed straight to the pipeline, and
	// the pipeline uploads the transcript into this workspace. So claim the write scope.
	//
	// Keep it that way on purpose. This is the fail-closed half of the read-only claim page auth
	// makes. A member an admin moved to `viewer` mid-meeting keeps the page but can no longer close
	// their own meeting, and the scheduled sweep closes it at its deadline instead. Do not narrow
	// this to read to give the button back: the close is what starts the upload, and a member who
	// may not write must not start one.
	const live = await council_verify_grant(env, actor.serviceGrantId, now, ["plugin_data:read", "plugin_data:write"]);
	if (live._nay) {
		return respond(409, { message: "The meeting's authority is no longer live" });
	}

	const closed = await council_close_meeting(env, meeting._yay.id, now);
	if (closed._nay) {
		return respond(closed._nay.name === "not_found" ? 404 : 409, { message: closed._nay.message });
	}
	return respond(200, { status: closed._yay.status });
}

async function handle_delete(context: PageContext) {
	const { env, actor, now, respond } = context;
	const meeting = await load_meeting_for_actor(context);
	if (meeting._nay) {
		return respond(meeting._nay.name === "bad_request" ? 400 : 404, { message: meeting._nay.message });
	}
	// A delete while the pipeline runs would repoint the pipeline's grant and race its uploads
	// against the workflow's file deletes. Processing always reaches `ready` or `failed`, and both
	// accept a delete.
	if (meeting._yay.status === "processing") {
		return respond(409, { message: "The meeting is still processing; delete it when that finishes" });
	}

	// Seal a FRESH processing grant for the delete workflow, from the requesting member's own live
	// grant — the meeting's pinned grant lives 24 hours and a delete can come weeks later. The
	// workflow's file archive needs live authority over the same `/meetings/<id>` prefix.
	if (meeting._yay.status !== "deleting" && meeting._yay.status !== "deleted_tombstone") {
		const sealed = await council_seal_meeting_grant(env, meeting._yay, now, actor.serviceGrantId);
		if (sealed._nay) {
			return respond(409, { message: "The meeting's authority is no longer live" });
		}
		await env.COUNCIL_DB.prepare("UPDATE meetings SET processing_grant_id = ?, updated_at = ? WHERE id = ?")
			.bind(sealed._yay.processingGrantId, now, meeting._yay.id)
			.run();
		meeting._yay.processing_grant_id = sealed._yay.processingGrantId;
	}

	const requested = await council_request_meeting_delete(env, meeting._yay, now);
	if (requested._nay) {
		return respond(409, { message: requested._nay.message });
	}
	return respond(200, { status: requested._yay.status });
}
