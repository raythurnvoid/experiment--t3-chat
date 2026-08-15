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
	reservation_id: string | null;
	reserve_body: string | null;
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
 */
export async function council_transition_meeting(
	db: D1Database,
	args: {
		meetingId: string;
		from: readonly council_MeetingStatus[];
		to: council_MeetingStatus;
		now: number;
		set?: Record<string, string | number | null>;
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
	const result = await db
		.prepare(`UPDATE meetings SET ${setSql} WHERE id = ? AND status IN (${placeholders})`)
		.bind(args.to, args.now, ...extra.map(([, value]) => value), args.meetingId, ...args.from)
		.run();
	return result.meta.changes === 1;
}

/** The exact fixed-window limits from the plan. */
export const council_RATE_LIMITS = {
	meeting_create: { windowMs: 60 * 60 * 1000, limit: 5 },
	meeting_open: { windowMs: 60 * 60 * 1000, limit: 5 },
	guest_join_ip: { windowMs: 10 * 60 * 1000, limit: 10 },
	guest_join_code: { windowMs: 10 * 60 * 1000, limit: 30 },
	guest_join_installation: { windowMs: 10 * 60 * 1000, limit: 100 },
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
	kind: "track_audio" | "provider_transcript" | "transcript_markdown";
	target_key: string;
	file_name: string;
	node_id: string | null;
	upload_body: string | null;
	bytes: number | null;
	status: "pending" | "finalized" | "failed" | "deleted";
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
