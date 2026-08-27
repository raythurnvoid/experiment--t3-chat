import type { AiBinding, D1Database, Queue, WorkflowBinding } from "./cf.ts";

/** What the Queue carries: a pointer to a durable outbox row, never the work itself. */
export type council_QueueMessageBody = {
	outboxId: string;
};

/**
 * Bindings and settings the Worker receives. Types are declared in `cf.ts` rather than pulled from
 * `@cloudflare/workers-types`, matching `packages/r2-upload-finalizer`, so the package stays
 * dependency-free.
 */
export type Env = {
	CF_VERSION_METADATA: {
		id: string;
		tag: string;
		timestamp: string;
	};
	COUNCIL_DB: D1Database;
	COUNCIL_EVENTS: Queue<council_QueueMessageBody>;
	COUNCIL_WORKFLOW: WorkflowBinding;
	AI: AiBinding;
	COUNCIL_PLUGIN_ORIGIN: string;
	CONVEX_HTTP_URL: string;
	COUNCIL_MEETING_MAX_MINUTES: string;
	COUNCIL_MEETING_MAX_PARTICIPANTS: string;
	COUNCIL_DESTINATION_PATH_PREFIX: string;
	/** "true" only during a coordinated release that must block new meeting work. */
	COUNCIL_MAINTENANCE: string;
	/** "true" only for local development, where no Cloudflare edge adds `CF-Connecting-IP`. */
	COUNCIL_ALLOW_MISSING_CLIENT_IP: string;
	/** PEM SPKI public key for webhook signatures. Empty refuses every webhook, fail closed. */
	REALTIMEKIT_WEBHOOK_PUBLIC_KEY: string;
	COUNCIL_SERVICE_EXCHANGE_SECRET: string;
	REALTIMEKIT_API_TOKEN: string;
	REALTIMEKIT_ACCOUNT_ID: string;
	REALTIMEKIT_APP_ID: string;
	COUNCIL_ROOM_COOKIE_SECRET: string;
};

export function council_max_minutes(env: Env) {
	return Number(env.COUNCIL_MEETING_MAX_MINUTES) || 60;
}

/**
 * How many bytes one minute of 720p composite video can take in the worst case.
 *
 * The 2026-08-27 provider probe measured 2.4–3.1 MB/min on low-motion 720p (about
 * two-minute samples). That is the floor, not the bound. Cloudflare's Realtime
 * live-stream bandwidth table lists 720p at 675 MB–2.7 GB per hour. High-motion
 * content (a video playing in a shared tab) is unmeasured, so this constant uses
 * the published 2.7 GB/hour worst case: 2.7e9 / 60 bytes per minute.
 *
 * That table is live-stream bandwidth, not a measured recording file. Use it only
 * to refuse a configured meeting length that cannot fit the host upload cap.
 */
export const council_RECORDING_WORST_CASE_BYTES_PER_MINUTE = Math.floor((2.7 * 1000 * 1000 * 1000) / 60);

/**
 * The host create-target cap. Keep this equal to `files_MAX_UPLOADS_BYTES` in
 * `packages/app/shared/files.ts`. 2 GiB stays under the R2 single-PUT limit (5 GiB).
 */
export const council_HOST_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function council_worst_case_recording_bytes(minutes: number) {
	return minutes * council_RECORDING_WORST_CASE_BYTES_PER_MINUTE;
}

export function council_meeting_length_exceeds_host_upload_cap(minutes: number) {
	return council_worst_case_recording_bytes(minutes) > council_HOST_UPLOAD_MAX_BYTES;
}

/**
 * The largest whole-minute setting that still fits the host upload cap at the
 * 720p worst-case rate. 2 GiB / 45_000_000 bytes per minute is 47 minutes.
 */
export function council_max_minutes_within_host_upload_cap() {
	return Math.floor(council_HOST_UPLOAD_MAX_BYTES / council_RECORDING_WORST_CASE_BYTES_PER_MINUTE);
}

export function council_recording_over_cap_reason(sizeBytes: number) {
	const overflowMiB = Math.max(1, Math.ceil((sizeBytes - council_HOST_UPLOAD_MAX_BYTES) / (1024 * 1024)));
	return `recording too large to store: ${overflowMiB} MiB over the limit`;
}

/**
 * What a member may read when a recording file was refused as over the host cap.
 * The artifact row keeps the precise MiB overflow for an operator. This sentence
 * is the page and meeting.md copy: it names the lost video and the files that
 * still landed, and it does not name routes or HTTP statuses.
 */
export const council_RECORDING_OVER_CAP_MEMBER_SENTENCE =
	"Council could not store the video recording. The file was larger than the workspace can accept. Audio, transcript, and summary were still saved.";

export function council_recording_over_cap_member_sentence(
	meetingStatus: string,
	artifacts: { status: string; failure_reason: string | null }[],
) {
	// The sentence says the other files were saved. That is only true after the run
	// reaches ready. A processing meeting can already have a failed video row.
	if (meetingStatus !== "ready") {
		return null;
	}

	const refused = artifacts.some(
		(artifact) =>
			artifact.status === "failed" &&
			typeof artifact.failure_reason === "string" &&
			artifact.failure_reason.startsWith("recording too large to store:"),
	);
	return refused ? council_RECORDING_OVER_CAP_MEMBER_SENTENCE : null;
}

export function council_max_participants(env: Env) {
	return Number(env.COUNCIL_MEETING_MAX_PARTICIPANTS) || 25;
}

/**
 * The configured destination prefix in the canonical shape the host requires: an absolute path
 * whose every segment is a lowercase folder name, no trailing slash. `/Meetings/` becomes
 * `/meetings`.
 */
export function council_destination_prefix(env: Env) {
	const trimmed = env.COUNCIL_DESTINATION_PATH_PREFIX.trim().toLowerCase().replace(/\/+$/u, "");
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
