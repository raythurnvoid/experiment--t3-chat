/**
 * D1 state for the meeting machine and the fixed-window rate limits.
 *
 * D1 is authoritative for every service decision. The Plan 2 projection is a display-safe copy,
 * but the current Council page still reads this Worker. Module memory owns none of this state.
 */

import type { D1Database } from "./cf.ts";

export type council_MeetingStatus =
	| "created"
	| "create_unknown"
	| "open"
	| "recording_start_unknown"
	| "closed"
	| "processing"
	| "ready"
	| "failed"
	| "expired"
	| "deleting"
	| "delete_failed"
	| "deleted_tombstone";

/**
 * Every transition the machine allows. `create_unknown` and `recording_start_unknown` never retry
 * their provider call automatically because the provider has no idempotency key; their only exits
 * are the ones listed here. `failed -> processing` exists for the operator redrive path.
 * `processing` has no delete exit on purpose: a delete would race the running pipeline over the
 * same grant and files, and processing always reaches `ready` or `failed`, where delete is allowed.
 */
const MEETING_TRANSITIONS: Record<council_MeetingStatus, readonly council_MeetingStatus[]> = {
	created: ["open", "create_unknown", "expired", "deleting"],
	create_unknown: ["expired", "deleting"],
	open: ["recording_start_unknown", "closed", "deleting"],
	recording_start_unknown: ["closed", "deleting"],
	// `closed -> ready` is the no-recording settle: with nothing to process, close finishes the
	// meeting directly so the plugin page stops treating it as transitional.
	closed: ["processing", "ready", "deleting"],
	processing: ["ready", "failed"],
	ready: ["deleting"],
	failed: ["processing", "deleting"],
	expired: ["deleting"],
	deleting: ["deleted_tombstone", "delete_failed"],
	delete_failed: ["deleting"],
	deleted_tombstone: [],
};

export type council_MeetingRow = {
	id: string;
	code_hash: string;
	organization_id: string;
	workspace_id: string;
	installation_id: string;
	plugin_name: string;
	title: string;
	created_by_user_id: string;
	service_grant_id: string | null;
	processing_grant_id: string | null;
	destination_path: string;
	provider_meeting_id: string | null;
	provider_session_id: string | null;
	provider_recording_id: string | null;
	status: council_MeetingStatus;
	failure_reason: string | null;
	deadline_at: number | null;
	opened_at: number | null;
	closed_at: number | null;
	recording_started_at: number | null;
	participant_count: number;
	projection_revision: number;
	processing_generation: number;
	processing_workflow_id: string | null;
	tombstone_expires_at: number | null;
	created_at: number;
	updated_at: number;
};

export type council_ParticipantRow = {
	id: string;
	meeting_id: string;
	display_name: string;
	email_hmac: string | null;
	role: "host" | "guest";
	join_attempt_id: string;
	provider_participant_id: string | null;
	provider_token_encrypted: string | null;
	accepted_at: number | null;
	admission_attempt_id: string | null;
	admission_attempt_started_at: number | null;
	created_at: number;
};

export async function council_get_meeting(db: D1Database, meetingId: string) {
	return await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(meetingId).first<council_MeetingRow>();
}

/**
 * Move a meeting between states with the transition table enforced twice: statically against the
 * map (a disallowed pair is a programmer error and throws), and atomically in SQL (the UPDATE only
 * applies while the row still is in one of the expected states, so two racing transitions cannot
 * both win). Returns whether this call was the one that moved the row.
 *
 * A workflow run passes its own `expectedProcessingGeneration`. A redrive can start generation
 * N+1 while generation N is still running (the transport relabel described at
 * `workflow_instance_is_missing` in `lifecycle.ts`), and the row then belongs to the new
 * generation. The condition keeps the stale run's terminal write from landing on it.
 *
 * `requireNoRecording` makes the write apply only while no `provider_recording_id` is stored.
 * The lost-answer catch in `handle_start_recording` passes it: a concurrent successful start
 * attaches its recording id without changing the status, so a status-only guard would move a
 * meeting that is recording fine into the dead end.
 */
export async function council_transition_meeting(
	db: D1Database,
	args: {
		meetingId: string;
		from: readonly council_MeetingStatus[];
		to: council_MeetingStatus;
		now: number;
		set?: Record<string, string | number | null>;
		expectedProcessingGeneration?: number;
		requireNoRecording?: boolean;
	},
) {
	for (const from of args.from) {
		if (!MEETING_TRANSITIONS[from].includes(args.to)) {
			throw new Error(`Meeting transition ${from} -> ${args.to} is not allowed`);
		}
	}

	const extra = Object.entries(args.set ?? {});
	const setSql = ["status = ?", "updated_at = ?", ...extra.map(([column]) => `${column} = ?`)].join(", ");
	const placeholders = args.from.map(() => "?").join(", ");
	const generationSql = args.expectedProcessingGeneration === undefined ? "" : " AND processing_generation = ?";
	const recordingSql = args.requireNoRecording ? " AND provider_recording_id IS NULL" : "";
	const result = await db
		.prepare(`UPDATE meetings SET ${setSql} WHERE id = ? AND status IN (${placeholders})${generationSql}${recordingSql}`)
		.bind(
			args.to,
			args.now,
			...extra.map(([, value]) => value),
			args.meetingId,
			...args.from,
			...(args.expectedProcessingGeneration === undefined ? [] : [args.expectedProcessingGeneration]),
		)
		.run();
	return result.meta.changes === 1;
}

/**
 * Every rate bucket in this service. Each one is a fixed window in milliseconds and the number of
 * attempts allowed inside that window.
 */
export const council_RATE_LIMITS = {
	meeting_create: { windowMs: 60 * 60 * 1000, limit: 5 },
	meeting_open: { windowMs: 60 * 60 * 1000, limit: 5 },
	// Everyone behind one office or conference-room NAT reaches us from the same egress IP, so this
	// bucket has to fit a whole meeting, not one person. The worst legitimate case is a meeting at
	// the participant cap joining from one address: `COUNCIL_MEETING_MAX_PARTICIPANTS` defaults to
	// 25. A seat can also spend more than one attempt, because this limit runs before the code is
	// checked, so a mistyped code or a reload costs one each. Fifty is that case with one retry per
	// seat. Raising `COUNCIL_MEETING_MAX_PARTICIPANTS` means raising this number with it.
	// This is also the bucket that fires in a local run: with `COUNCIL_ALLOW_MISSING_CLIENT_IP`
	// every guest counts against the single key `loopback`.
	guest_join_ip: { windowMs: 10 * 60 * 1000, limit: 50 },
	// This bucket is keyed on the hash of the code that was presented, so it only ever counts
	// attempts against one code. It does not slow somebody who is guessing codes: every wrong guess
	// hashes to a different key and lands in its own bucket. `guest_join_ip` is the only bucket that
	// can stop a guessing loop. `guest_join_installation` never sees one: the guest route spends that
	// bucket after the presented code matched, so a wrong guess is refused before it gets there. Keep
	// that order. `guest_join_installation` is keyed on the installation, which is one workspace's
	// Council, so a wrong guess that could spend it would lock every legitimate guest of every meeting
	// in that workspace out for the rest of the window. Raising this number is safe because a join
	// code is a 256-bit random token, which nobody guesses at any limit.
	// The number itself comes from ordinary join churn on a code somebody already has: 25 seats at
	// the `COUNCIL_MEETING_MAX_PARTICIPANTS` default, each able to spend a second attempt because a
	// reload presents the same code again. A mistype does not add to it: it hashes to a different
	// key, so it lands in that key's bucket and not in this one. Raising
	// `COUNCIL_MEETING_MAX_PARTICIPANTS` means raising this number with it.
	guest_join_code: { windowMs: 10 * 60 * 1000, limit: 50 },
	guest_join_installation: { windowMs: 10 * 60 * 1000, limit: 100 },
	// Every join spends one or two Convex verify calls, replays included, and the Convex budget
	// belongs to the whole deployment, so an unbounded join loop degrades the workspace's app and not
	// only Council. The room client does re-post a join by itself, once, after a 401. That refused post
	// never reaches this bucket: the room API checks the session cookie and the CSRF token first,
	// and counts the attempt only after that. So only a press spends one, and the client gives up
	// after 30 seconds before the person can press again. Twenty in ten minutes is exactly that
	// worst legitimate case — somebody pressing Join the moment each timeout fires, for the whole
	// window — and no more presses than that.
	//
	// This number counts presses, not Convex calls, and the two doors do not cost the same. A guest
	// press buys one call: the meeting's pinned grant. A host press buys two, because the host's own
	// grant is checked next to that pin. So the outbound ceiling this bucket sets is 20 actions for a
	// guest and 40 for a host, per participant row, per window. Both numbers are pinned in
	// `routes-room.test.ts`, so a change to either door's verify count fails there.
	room_join_participant: { windowMs: 10 * 60 * 1000, limit: 20 },
	// The page token exchange is the one Convex call an unauthenticated caller can reach. Any POST to
	// an `/api/meetings/*` path carrying a well-formed `plu_` bearer buys one outbound action,
	// because a token this service has never seen misses `page_token_cache` every time. Only those
	// misses are counted here, so a member's ordinary polling, which hits the cache, never touches
	// this bucket.
	//
	// The number is one legitimate tab's miss rate scaled to an office. A tab misses once when it
	// opens, and once more each time the host rotates the page token. A rotation lands about 29
	// minutes after the last one, not 30. The host session lives 30 minutes (`SESSION_TTL_MS` in the
	// app's `plugins_ui.ts`) and the SDK refreshes a minute before it expires
	// (`TOKEN_EXPIRY_MARGIN_MS` in `bonobo-plugin-sdk/frontend.js`). That gap is shorter than this
	// window, so two token changes can fall inside one window, and a healthy tab spends at most two
	// misses there. Everyone in one office reaches us from the same egress IP, so size this for a
	// whole workspace on one address: 25 tabs, the number `COUNCIL_MEETING_MAX_PARTICIPANTS` defaults
	// to, is 50. Sixty is that case with room for reloads. It is sized with headroom, not derived
	// exactly. A refused call costs two instead of one, because the plugin page asks the host for a
	// fresh token and retries once after a 401. So this number does not cover an office whose calls
	// are all being refused. The window is one page session long, which is about one rotation gap. It
	// is not aligned to those rotations: `windowStart` below is floored to the epoch, so one tab's
	// misses can fall either side of a boundary.
	page_exchange_ip: { windowMs: 30 * 60 * 1000, limit: 60 },
} as const;

export type council_RateLimitName = keyof typeof council_RATE_LIMITS;

export type council_RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Count one attempt in a fixed window and say whether it is allowed. The window start is part of
 * the row key, so an expired window is a different row and cleanup deletes it rather than
 * resetting it. Attempts past the limit still count nothing extra: the row is only incremented
 * while under the limit, so a hammering client cannot stretch its own window.
 */
export async function council_rate_limit(
	db: D1Database,
	args: { name: council_RateLimitName; key: string; now: number },
): Promise<council_RateLimitVerdict> {
	const { windowMs, limit } = council_RATE_LIMITS[args.name];
	const windowStart = Math.floor(args.now / windowMs) * windowMs;
	const bucketKey = `${args.name}:${args.key}`;

	const result = await db
		.prepare(
			`INSERT INTO rate_limit_windows (bucket_key, window_start, count) VALUES (?, ?, 1)
			ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = count + 1 WHERE count < ?`,
		)
		.bind(bucketKey, windowStart, limit)
		.run();
	if (result.meta.changes === 1) {
		return { allowed: true };
	}

	return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - args.now) / 1000)) };
}

export type council_ArtifactRow = {
	id: string;
	meeting_id: string;
	kind: "track_audio" | "provider_transcript" | "transcript_markdown" | "summary_markdown";
	target_key: string;
	file_name: string;
	node_id: string | null;
	upload_body: string | null;
	bytes: number | null;
	status: "pending" | "finalized" | "failed" | "deleted";
	failure_reason: string | null;
	created_at: number;
	updated_at: number;
};

export type council_ServiceGrantRow = {
	id: string;
	organization_id: string;
	workspace_id: string;
	installation_id: string;
	actor_user_id: string;
	principal_key: string;
	phase: "interactive" | "processing";
	destination_path_prefix: string | null;
	token_encrypted: string;
	scopes: string;
	expires_at: number;
	created_at: number;
	updated_at: number;
};

export async function council_get_service_grant(db: D1Database, grantId: string) {
	return await db.prepare("SELECT * FROM service_grants WHERE id = ?").bind(grantId).first<council_ServiceGrantRow>();
}
