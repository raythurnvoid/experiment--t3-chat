/**
 * Service-grant handling on the Worker side: authenticate a page call by exchanging its `plu_`
 * token, keep grant tokens encrypted at rest, and recheck liveness before privileged actions.
 */

import { Result } from "./result.ts";
import type { Env } from "./env.ts";
import type { council_MeetingRow, council_ParticipantRow } from "./db.ts";
import { council_get_service_grant, council_rate_limit } from "./db.ts";
import { council_decrypt, council_encrypt, council_sha256_hex } from "./crypto.ts";
import type { council_VerifyLiveClaims } from "./convex-api.ts";
import { council_convex_exchange, council_convex_verify_live } from "./convex-api.ts";

/**
 * How long one Convex answer about a grant may stand for the same presented page token. One minute
 * keeps a burst of page calls on one grant while a revoked member's cached list/get access dies
 * fast; the privileged routes re-verify through Convex on every call regardless (open, join, start
 * recording, seal, close, and minting a host room ticket).
 */
const PAGE_TOKEN_CACHE_MS = 60 * 1000;

/**
 * The longest one exchange result may keep answering for the same presented page token.
 *
 * The host gives a plugin page a 30-minute session and rotates the plaintext `plu_` token on every
 * refresh, so the old plaintext stops resolving at the host straight away. Only the exchange
 * presents the token to the host, so only a fresh exchange can notice that rotation: re-checking
 * the grant asks about the grant, never about the token that bought it. This service must therefore
 * stop reusing a mapping once the session that produced it could be over.
 *
 * The exchange answer carries the grant's expiry but not the session's, so this ceiling stands in
 * for it. It is the longest a host page session can live, which makes it an upper bound: a stolen
 * or rotated token is honoured for at most one session instead of the grant's full 24 hours.
 */
const HOST_PAGE_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * The exact shape of a plugin page token. Checking the whole shape, not just the prefix, keeps a
 * malformed bearer inside this Worker instead of letting it buy an outbound Convex call.
 *
 * `public_api_PLUGIN_UI_TOKEN_REGEX` in `packages/app/shared/public-api.ts` is the source of truth
 * and this pattern must stay equal to it. It is written out again rather than imported because this
 * package is dependency-free on purpose and must not import across package roots, the same reason
 * `result.ts` restates the repo's Result shape.
 */
const PAGE_TOKEN_REGEX = /^plu_[0-9a-f]{64}$/u;

export type council_PageActor = {
	organizationId: string;
	workspaceId: string;
	installationId: string;
	actorUserId: string;
	serviceGrantId: string;
};

/**
 * Authenticate a members-page request. The bearer must have the full shape of a `plu_` page token;
 * Convex resolves it through the exchange route, which is the only way this service can turn a page
 * identity into authority.
 *
 * The exchange is what creates a grant, so it runs once per page token instead of once per minute.
 * A plugin page polls every few seconds and keeps polling for as long as the member leaves the tab
 * open, so one exchange a minute would leave one live grant per minute per tab, each of them alive
 * for its full 24 hours. `page_token_cache` therefore keeps the token hash pointing at the grant it
 * already produced, and a later call re-checks that same grant instead of minting another one.
 *
 * Two deadlines decide what one call does:
 *
 * - `page_token_cache.expires_at` is one page-session lifetime from the exchange, or the grant's own
 *   expiry when that comes first. Past it the call exchanges again, which is the only step that
 *   presents the page token to the host, so a token the host has rotated away stops working here.
 * - `service_grants.updated_at` is the last time Convex answered about that grant. Inside
 *   `PAGE_TOKEN_CACHE_MS` of it the answer still stands. Past it the call asks Convex again through
 *   `council_verify_grant`, which fails closed, so a member whose access was taken away still loses
 *   page access on the next minute boundary.
 *
 * Reuse never renews anything. The grant keeps the 24 hours it was minted with, and the mapping
 * keeps the ceiling it was written with, so a page token stops buying authority within half an hour
 * of the exchange rather than a day after it.
 *
 * `clientIp` is the caller's address, and it only bounds the exchange below. The caller resolves it
 * from the trusted edge header before calling.
 */
export async function council_page_auth(env: Env, pluToken: string, clientIp: string, now: number) {
	if (!PAGE_TOKEN_REGEX.test(pluToken)) {
		return Result<never>({ _nay: { name: "unauthorized", message: "Unauthorized" } });
	}
	const db = env.COUNCIL_DB;
	const tokenHash = await council_sha256_hex(pluToken);

	// One row per page token, joined to the grant it named. The join also proves the grant row is
	// still there: deleting a grant cascades to this row, so a mapping never outlives its authority.
	const mapped = await db
		.prepare(
			`SELECT c.organization_id, c.workspace_id, c.installation_id, c.actor_user_id, c.service_grant_id, g.updated_at AS verified_at
			FROM page_token_cache c JOIN service_grants g ON g.id = c.service_grant_id
			WHERE c.token_hash = ? AND c.expires_at > ?`,
		)
		.bind(tokenHash, now)
		.first<{
			organization_id: string;
			workspace_id: string;
			installation_id: string;
			actor_user_id: string;
			service_grant_id: string;
			verified_at: number;
		}>();
	if (mapped) {
		const actor = {
			organizationId: mapped.organization_id,
			workspaceId: mapped.workspace_id,
			installationId: mapped.installation_id,
			actorUserId: mapped.actor_user_id,
			serviceGrantId: mapped.service_grant_id,
		} satisfies council_PageActor;

		if (mapped.verified_at + PAGE_TOKEN_CACHE_MS > now) {
			return Result({ _yay: actor });
		}

		// Past the window, ask Convex about the grant this service already holds. The check is the
		// same fail-closed one the privileged routes use: a revoked member, a disabled installation,
		// or a lost capability refuses here.
		//
		// Claim the read scope only. This check decides whether the member may still open the page, and
		// reading is all the page itself does. An admin can move a member to the `viewer` role while a
		// meeting runs: that member keeps `content.read` and loses `content.write`, so the host refuses
		// every claim that carries `plugin_data:write`. Claiming that scope here would take the whole
		// page away from them a minute later, their own meeting list included. Asking for less loses no
		// check, because every route that writes verifies the write claim again for itself, and `create`
		// spends its write through a host door that asks for the same permission.
		const live = await council_verify_grant(env, mapped.service_grant_id, now, ["plugin_data:read"]);
		if (live._yay) {
			// Record when Convex last answered, so the next minute of polling is served from this row.
			await db
				.prepare("UPDATE service_grants SET updated_at = ? WHERE id = ?")
				.bind(now, mapped.service_grant_id)
				.run();
			return Result({ _yay: actor });
		}
		// `grant_dead` is this Worker's own answer: the row is gone or past its 24 hours, so there is
		// nothing to verify and the page may exchange for a new grant. Every other answer came from
		// Convex about this grant, and a fresh exchange would be refused for the same reason, so it is
		// the answer.
		if (live._nay.name !== "grant_dead") {
			return Result<never>({ _nay: live._nay });
		}
	}

	// Everything above answered from D1. Past this line the call spends one Convex action, and it is
	// the only Convex call somebody with no account can reach: a well-formed token this service has
	// never seen misses the cache every time, so a loop of random tokens would spend the deployment's
	// budget without ever holding a session. Limit by client address, and only here, so a member's
	// ordinary polling — which is served from the cache — never counts against it.
	const exchangeVerdict = await council_rate_limit(db, { name: "page_exchange_ip", key: clientIp, now });
	if (!exchangeVerdict.allowed) {
		return Result<never>({ _nay: { name: "rate_limited", message: "Too many page token exchanges" } });
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
				// The mapping dies at whichever comes first: one page-session lifetime, or the grant it
				// names. The session part is what stops a token the host has rotated away; the grant part
				// keeps the promise that a mapping never outlives its authority, which the scheduled sweep
				// of this table and the liveness re-check above both rely on.
				//
				// The ceiling also bounds how old a grant can be when a room session pins it: half an
				// hour, plus the two minutes a room ticket lives. That does not keep the pinned grant
				// alive, though. `resume_room_session` moves a session's expiry five hours forward on
				// every room page load, with no ceiling and no look at the grant, so a room tab loaded
				// again every few hours outlives the grant it pinned. The scheduled sweep therefore
				// skips pinned grants itself instead of trusting this ceiling.
				Math.min(exchanged._yay.expiresAt, now + HOST_PAGE_SESSION_TTL_MS),
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
 *
 * `scopes` says what the caller is about to spend, and every caller has to say it. The host checks
 * that claim twice: it refuses a scope the grant itself no longer holds, and it refuses a scope the
 * member behind the grant may no longer use, because `plugin_data:write` needs `content.write` from
 * that member. So a claim is not free. Asking for more than the action spends can refuse a call the
 * action would have been allowed to make.
 *
 * There is deliberately no default value. A default would have to be the wide read-and-write pair,
 * and that is the over-claim which once took the whole page away from a member an admin had moved to
 * the `viewer` role. The page only reads, so it claims only `plugin_data:read` now. A caller that
 * forgot the argument would get that defect back in silence, and no test would see it. Leaving the
 * argument out is a compile error instead.
 */
export async function council_verify_grant(
	env: Env,
	grantId: string,
	now: number,
	scopes: council_VerifyLiveClaims["scopes"],
) {
	const grant = await council_get_service_grant(env.COUNCIL_DB, grantId);
	if (!grant || grant.expires_at <= now) {
		return Result<never>({ _nay: { name: "grant_dead", message: "The meeting's grant has expired" } });
	}

	// A rotated COUNCIL_ROOM_COOKIE_SECRET or a corrupted grant row makes the stored token
	// undecryptable, and WebCrypto rejects instead of answering. Nothing catches that above this
	// function, so every privileged route would answer 500 to a routine secret rotation.
	//
	// Answer `grant_dead` rather than a new name. `council_page_auth` treats exactly that name as
	// "there is nothing left to verify, so exchange the page token for a new grant", and that
	// exchange re-seals under the current secret, which is the whole recovery from a rotation. The
	// caller still has to present a live `plu_` token to the host for it, so the re-exchange grants
	// no authority the page did not already prove.
	let token: string;
	try {
		token = await council_decrypt(env.COUNCIL_ROOM_COOKIE_SECRET, grant.token_encrypted);
	} catch {
		return Result<never>({ _nay: { name: "grant_dead", message: "The meeting's grant cannot be read" } });
	}

	const live = await council_convex_verify_live(env, token, {
		installationId: grant.installation_id,
		phase: "interactive",
		destinationPathPrefix: grant.destination_path_prefix,
		scopes,
	});
	if (live._nay) {
		return live;
	}
	return Result({ _yay: { grant, token } });
}

/**
 * Recheck the meeting's pinned interactive grant immediately before a privileged action. Three
 * actions use it: the open retry that reuses an already-sealed processing grant, the room join that
 * mints a provider token, and start recording.
 *
 * The other privileged actions verify a different grant. The host room ticket mint and the page
 * close verify the caller's own grant through `council_verify_grant`. The seal verifies the grant it
 * seals from, which both of its callers set to the caller's own grant. The room host close verifies
 * no grant at all, on purpose: the host cookie is the proof, and refusing there would strand
 * everyone already in the call.
 *
 * All three callers write, so the claim below is the full pair and takes no argument from them. The
 * open retry seals processing authority, the join mints a provider token for a call that gets
 * recorded, and start recording begins that recording. A member who lost `content.write` may do none
 * of them, and the host refuses `plugin_data:write` for exactly that member.
 */
export async function council_verify_meeting_grant(env: Env, meeting: council_MeetingRow, now: number) {
	if (!meeting.service_grant_id) {
		return Result<never>({ _nay: { name: "no_grant", message: "Meeting has no pinned grant" } });
	}
	return await council_verify_grant(env, meeting.service_grant_id, now, ["plugin_data:read", "plugin_data:write"]);
}

/**
 * Recheck the host cookie's actor grant. The pin can still be live after membership removal if the
 * opener remains a member, so join and start-recording must not trust the pin alone.
 *
 * Both callers write, so the claim below is the full pair and takes no argument from them. Join and
 * start recording end in a recording this host must still be allowed to write, so the narrow claim
 * `council_page_auth` makes must not spread here.
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

	return await council_verify_grant(env, grant.id, args.now, ["plugin_data:read", "plugin_data:write"]);
}
