/**
 * Service-grant handling on the Worker side: authenticate a page call by exchanging its `plu_`
 * token, keep grant tokens encrypted at rest, and recheck liveness before privileged actions.
 */

import { Result } from "./result.ts";
import type { Env } from "./env.ts";
import type { council_MeetingRow, council_ParticipantRow } from "./db.ts";
import { council_get_service_grant } from "./db.ts";
import { council_decrypt, council_encrypt, council_sha256_hex } from "./crypto.ts";
import { council_convex_exchange, council_convex_verify_live } from "./convex-api.ts";

/**
 * How long one exchange result may answer for the same presented page token. One minute keeps a
 * burst of page calls on one grant while a revoked member's cached list/get access dies fast; the
 * privileged routes re-verify through Convex on every call regardless (open, join, start
 * recording, seal, close, and minting a host room ticket).
 */
const PAGE_TOKEN_CACHE_MS = 60 * 1000;

export type council_PageActor = {
	organizationId: string;
	workspaceId: string;
	installationId: string;
	actorUserId: string;
	serviceGrantId: string;
};

/**
 * Authenticate a members-page request. The bearer must be a `plu_` page token; Convex resolves it
 * through the exchange route, which is the only way this service can turn a page identity into
 * authority. The result is cached briefly by token hash so repeated page calls do not mint one
 * grant each.
 */
export async function council_page_auth(env: Env, pluToken: string, now: number) {
	if (!pluToken.startsWith("plu_")) {
		return Result<never>({ _nay: { name: "unauthorized", message: "Unauthorized" } });
	}
	const db = env.COUNCIL_DB;
	const tokenHash = await council_sha256_hex(pluToken);

	const cached = await db
		.prepare("SELECT * FROM page_token_cache WHERE token_hash = ? AND expires_at > ?")
		.bind(tokenHash, now)
		.first<{
			organization_id: string;
			workspace_id: string;
			installation_id: string;
			actor_user_id: string;
			service_grant_id: string;
		}>();
	if (cached) {
		return Result({
			_yay: {
				organizationId: cached.organization_id,
				workspaceId: cached.workspace_id,
				installationId: cached.installation_id,
				actorUserId: cached.actor_user_id,
				serviceGrantId: cached.service_grant_id,
			} satisfies council_PageActor,
		});
	}

	const exchanged = await council_convex_exchange(env, pluToken);
	if (exchanged._nay) {
		return exchanged;
	}

	const grantId = crypto.randomUUID();
	const encrypted = await council_encrypt(env.COUNCIL_ROOM_COOKIE_SECRET, exchanged._yay.token);
	await db.batch([
		db
			.prepare(
				`INSERT INTO service_grants (id, organization_id, workspace_id, installation_id, actor_user_id, principal_key, phase, destination_path_prefix, token_encrypted, scopes, expires_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 'interactive', NULL, ?, ?, ?, ?, ?)`,
			)
			.bind(
				grantId,
				exchanged._yay.organizationId,
				exchanged._yay.workspaceId,
				exchanged._yay.installationId,
				exchanged._yay.actorUserId,
				exchanged._yay.principalKey,
				encrypted,
				JSON.stringify(exchanged._yay.scopes),
				exchanged._yay.expiresAt,
				now,
				now,
			),
		db
			.prepare(
				`INSERT OR REPLACE INTO page_token_cache (token_hash, organization_id, workspace_id, installation_id, actor_user_id, service_grant_id, expires_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				tokenHash,
				exchanged._yay.organizationId,
				exchanged._yay.workspaceId,
				exchanged._yay.installationId,
				exchanged._yay.actorUserId,
				grantId,
				Math.min(exchanged._yay.expiresAt, now + PAGE_TOKEN_CACHE_MS),
				now,
			),
	]);

	return Result({
		_yay: {
			organizationId: exchanged._yay.organizationId,
			workspaceId: exchanged._yay.workspaceId,
			installationId: exchanged._yay.installationId,
			actorUserId: exchanged._yay.actorUserId,
			serviceGrantId: grantId,
		} satisfies council_PageActor,
	});
}

/**
 * Recheck a stored interactive grant live against Convex immediately before a privileged action.
 * Any mismatch or a dead grant fails closed — admission never relies on delayed D1 cleanup.
 */
export async function council_verify_grant(env: Env, grantId: string, now: number) {
	const grant = await council_get_service_grant(env.COUNCIL_DB, grantId);
	if (!grant || grant.expires_at <= now) {
		return Result<never>({ _nay: { name: "grant_dead", message: "The meeting's grant has expired" } });
	}

	const token = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);
	const live = await council_convex_verify_live(env, token, {
		installationId: grant.installation_id,
		phase: "interactive",
		destinationPathPrefix: grant.destination_path_prefix,
		scopes: ["plugin_data:read", "plugin_data:write"],
	});
	if (live._nay) {
		return live;
	}
	return Result({ _yay: { grant, token } });
}

/**
 * Recheck the meeting's pinned interactive grant immediately before a privileged action: open,
 * guest token mint, start recording, seal, close, and minting a host room ticket.
 */
export async function council_verify_meeting_grant(env: Env, meeting: council_MeetingRow, now: number) {
	if (!meeting.service_grant_id) {
		return Result<never>({ _nay: { name: "no_grant", message: "Meeting has no pinned grant" } });
	}
	return await council_verify_grant(env, meeting.service_grant_id, now);
}

/**
 * Recheck the host cookie's actor grant. The pin can still be live after membership removal if the
 * opener remains a member, so join and start-recording must not trust the pin alone.
 */
export async function council_verify_host_actor_grant(
	env: Env,
	args: {
		meeting: council_MeetingRow;
		participant: council_ParticipantRow;
		actorServiceGrantId: string | null;
		now: number;
	},
) {
	if (args.participant.role !== "host") {
		return Result({ _yay: null });
	}

	const prefix = "host-";
	if (!args.participant.join_attempt_id.startsWith(prefix)) {
		return Result<never>({ _nay: { name: "grant_dead", message: "The meeting's authority is no longer live" } });
	}

	if (!args.actorServiceGrantId) {
		return Result<never>({ _nay: { name: "grant_dead", message: "The meeting's authority is no longer live" } });
	}

	const actorUserId = args.participant.join_attempt_id.slice(prefix.length);
	const grant = await env.COUNCIL_DB.prepare(
		"SELECT id FROM service_grants WHERE id = ? AND installation_id = ? AND actor_user_id = ? AND phase = 'interactive'",
	)
		.bind(args.actorServiceGrantId, args.meeting.installation_id, actorUserId)
		.first<{ id: string }>();
	if (!grant) {
		return Result<never>({ _nay: { name: "grant_dead", message: "The meeting's authority is no longer live" } });
	}

	return await council_verify_grant(env, grant.id, args.now);
}
