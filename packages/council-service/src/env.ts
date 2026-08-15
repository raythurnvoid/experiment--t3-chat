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
	COUNCIL_TRACK_FILE_PREFIX: string;
	COUNCIL_MEETING_MAX_MINUTES: string;
	COUNCIL_MEETING_MAX_PARTICIPANTS: string;
	COUNCIL_DESTINATION_PATH_PREFIX: string;
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
