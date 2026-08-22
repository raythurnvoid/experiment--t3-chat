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
	council_rate_limit,
	council_transition_meeting,
	type council_ArtifactRow,
	type council_MeetingRow,
} from "./db.ts";
import { council_random_token, council_sha256_hex } from "./crypto.ts";
import { council_get_bearer, council_json, council_read_json_body, council_read_string_field } from "./http.ts";
import {
	council_page_auth,
	council_verify_grant,
	council_verify_meeting_grant,
	type council_PageActor,
} from "./grants.ts";
import { council_provider_create_meeting } from "./provider.ts";
import { council_convex_data_release_reservation, council_convex_data_reserve } from "./convex-api.ts";
import { council_decrypt } from "./crypto.ts";
import { council_get_service_grant } from "./db.ts";
import { council_close_meeting, council_request_meeting_delete, council_seal_meeting_grant } from "./lifecycle.ts";
import { council_project_meeting, council_PROJECTION_COLLECTION } from "./projection.ts";
import { Result } from "./result.ts";

/** How long a member has to open the room page before the one-time ticket dies. */
const TICKET_TTL_MS = 2 * 60 * 1000;

/** The Plan 2 value-size envelope reserved for one meeting document. */
const PROJECTION_MAX_BYTES = 16 * 1024;

/** A created meeting that is never opened expires after a day. */
export const council_UNOPENED_MEETING_TTL_MS = 24 * 60 * 60 * 1000;

function projection_idempotency_key(meetingId: string) {
	return `council-meeting-${meetingId}`;
}

/** The sanitized meeting the page may see. Never the code hash, grant ids, or provider URLs. */
function meeting_view(env: Env, meeting: council_MeetingRow, artifacts: council_ArtifactRow[] = []) {
	return {
		id: meeting.id,
		title: meeting.title,
		status: meeting.status,
		failureReason: meeting.failure_reason,
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
	const auth = await council_page_auth(env, bearer, now);
	if (auth._nay) {
		return respond(auth._nay.name === "unauthorized" ? 401 : 502, { message: auth._nay.message });
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
	const psgToken = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);
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
		return respond(reserved._nay.name === "unauthorized" ? 403 : 502, {
			message: "Failed to reserve storage for the meeting",
		});
	}

	// The provider offers no idempotency key on create, so a lost answer lands in `create_unknown`
	// and is never retried automatically. Only an explicit provider refusal rolls the intent back.
	let created;
	try {
		created = await council_provider_create_meeting(env, title._yay);
	} catch {
		await council_transition_meeting(env.COUNCIL_DB, {
			meetingId,
			from: ["created"],
			to: "create_unknown",
			now,
		});
		return respond(502, { message: "The provider answer was lost; the meeting needs operator repair", meetingId });
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
	let processingGrantId = meeting._yay.processing_grant_id;
	if (!processingGrantId) {
		// Seal from the caller's live interactive grant, not the create-time pin. The pin lives 24
		// hours; open can happen near the end of that window, and join still verifies the pin.
		await env.COUNCIL_DB.prepare("UPDATE meetings SET service_grant_id = ?, updated_at = ? WHERE id = ?")
			.bind(actor.serviceGrantId, now, meeting._yay.id)
			.run();
		meeting._yay.service_grant_id = actor.serviceGrantId;

		// Sealing verifies the interactive grant live first, so this is also the fail-closed check.
		const sealed = await council_seal_meeting_grant(env, meeting._yay, now, actor.serviceGrantId);
		if (sealed._nay) {
			return respond(sealed._nay.name === "network" ? 502 : 409, {
				message: "The meeting's authority is no longer live",
			});
		}
		processingGrantId = sealed._yay.processingGrantId;
		await env.COUNCIL_DB.prepare("UPDATE meetings SET processing_grant_id = ?, updated_at = ? WHERE id = ?")
			.bind(processingGrantId, now, meeting._yay.id)
			.run();
	} else {
		// A retry after a crash between sealing and opening admission: reuse the stored grant, but
		// still recheck liveness first.
		const live = await council_verify_meeting_grant(env, meeting._yay, now);
		if (live._nay) {
			return respond(409, { message: "The meeting's authority is no longer live" });
		}
	}

	const deadline = now + council_max_minutes(env) * 60 * 1000;
	const moved = await council_transition_meeting(env.COUNCIL_DB, {
		meetingId: meeting._yay.id,
		from: ["created"],
		to: "open",
		now,
		set: { opened_at: now, deadline_at: deadline },
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
	if (meeting._yay.status !== "created" && meeting._yay.status !== "open") {
		return respond(409, { message: "Meeting is not joinable" });
	}

	const live = await council_verify_grant(env, actor.serviceGrantId, now);
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

	const live = await council_verify_grant(env, actor.serviceGrantId, now);
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
