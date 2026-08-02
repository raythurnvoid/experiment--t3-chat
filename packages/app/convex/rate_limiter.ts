import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api.js";
import type { ActionCtx, MutationCtx } from "./_generated/server.js";

export const rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE = "Rate limit exceeded";

const STRICT_WRITE = {
	kind: "token bucket",
	rate: 12,
	period: MINUTE,
	capacity: 2,
} as const;

const BULK_FILES_WRITE = {
	kind: "token bucket",
	rate: 50,
	period: MINUTE,
	capacity: 50,
} as const;

const STRICT_AI_HTTP = {
	kind: "token bucket",
	rate: 4,
	period: MINUTE,
	capacity: 1,
} as const;

const STRICT_AUTH_OR_BILLING = {
	kind: "token bucket",
	rate: 6,
	period: MINUTE,
	capacity: 2,
} as const;

const rate_limiter_CONFIG = {
	account_delete: STRICT_AUTH_OR_BILLING,
	api_credentials_write: STRICT_AUTH_OR_BILLING,
	public_api_auth: {
		kind: "token bucket",
		rate: 60,
		period: MINUTE,
		capacity: 10,
	},
	public_api_principal: {
		kind: "token bucket",
		rate: 120,
		period: MINUTE,
		capacity: 20,
	},
	ai_chat_http: STRICT_AI_HTTP,
	ai_chat_message_write: {
		kind: "token bucket",
		rate: 24,
		period: MINUTE,
		capacity: 4,
	},
	ai_chat_thread_write: STRICT_WRITE,
	ai_inline_http: STRICT_AI_HTTP,
	auth_http: STRICT_AUTH_OR_BILLING,
	// Validating a cached anonymous token is a read, and every page load does it at least twice.
	// Keep the ceiling well above ordinary reloads so a replayed token still cannot flood the route.
	auth_http_refresh: {
		kind: "token bucket",
		rate: 60,
		period: MINUTE,
		capacity: 10,
	},
	billing_action: STRICT_AUTH_OR_BILLING,
	comments_write: STRICT_WRITE,
	// Folder import charges one token per file, so one mutation call can consume many tokens at
	// once. Capacity covers one typical import in a single burst; a bigger import drains the
	// refill and the client waits `retryAfterMs` between chunks. Keep the burst modest: every
	// skipped item doubles as a bounded existence probe for restricted paths, so raising the
	// capacity widens that probe budget too (see the access-control skill).
	files_bulk_import: {
		kind: "token bucket",
		rate: 100,
		period: MINUTE,
		capacity: 300,
	},
	files_pending_update_write: BULK_FILES_WRITE,
	// Sharing is bursty in the same way as `roles_write`: somebody restricts a folder and then adds
	// three people to it in a few seconds. It gets its own bucket so that sharing several files does
	// not eat the budget for managing organization roles, and the other way round.
	files_sharing_write: {
		kind: "token bucket",
		rate: 30,
		period: MINUTE,
		capacity: 8,
	},
	files_snapshot_write: STRICT_WRITE,
	files_tree_write: BULK_FILES_WRITE,
	files_yjs_push_update: STRICT_WRITE,
	plugins_manage: STRICT_AUTH_OR_BILLING,
	// Initial mint plus occasional refresh per open plugin page; token TTL is 30 minutes.
	plugins_ui_session_mint: STRICT_WRITE,
	// File views mint on every file switch and every details/view toggle, so browsing a few videos
	// in quick succession must not read as a broken page. Refresh stays on the stricter page bucket.
	plugins_ui_file_view_session_mint: {
		kind: "token bucket",
		rate: 30,
		period: MINUTE,
		capacity: 8,
	},
	// Each fresh plugin artifact review is a system-billed model call; cached artifact hashes bypass this.
	plugins_publish_review: {
		kind: "token bucket",
		rate: 20,
		period: HOUR,
		capacity: 5,
	},
	presence_heartbeat: {
		kind: "token bucket",
		rate: 30,
		period: MINUTE,
		capacity: 3,
	},
	presence_write: STRICT_WRITE,
	// Setting up roles is bursty: an admin assigns a role to several people, or edits a role and
	// assigns it, in a few seconds. `STRICT_WRITE` only allows two in a row, which would read as a
	// broken page rather than as a limit.
	roles_write: {
		kind: "token bucket",
		rate: 30,
		period: MINUTE,
		capacity: 8,
	},
	save_file_pending_update: BULK_FILES_WRITE,
	organizations_write: STRICT_WRITE,
} as const;

const rate_limiter = new RateLimiter(components.rate_limiter, rate_limiter_CONFIG);

/**
 * Turns a rate limit key into a short number, so a log line can name the caller without printing
 * the key. This is only a label. It hides the key from someone reading the logs, but it is not
 * secure: anyone who guesses the key can compute the same number.
 */
function key_digest(key: string) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function rate_limiter_limit_by_key(
	ctx: MutationCtx | ActionCtx,
	args: {
		name: keyof typeof rate_limiter_CONFIG;
		key: string;
		count?: number;
	},
) {
	const limit = await rate_limiter.limit(ctx, args.name, {
		key: args.key,
		count: args.count,
	});

	if (limit.ok) {
		return null;
	}

	// Never log the key itself. Some callers pass a real token as the key: the presence writes pass a
	// `sessionToken`, and `removeSessionData` passes a room token. Printing them would leave working
	// tokens in the logs for anyone who can read them.
	// We hash instead of cutting the string short, because many keys end with the same text (a route
	// or a path). Their last characters look the same for every caller, so a cut string could not tell
	// two callers apart.
	console.warn("Rate limit exceeded", {
		name: args.name,
		keyDigest: key_digest(args.key),
		retryAfterMs: limit.retryAfter,
	});

	return {
		message: rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE,
		retryAfterMs: limit.retryAfter,
	} as const;
}

/**
 * Ask whether a charge would pass, without consuming tokens. A mutation that charges two
 * buckets uses this on the second bucket first: a successful first charge commits even when
 * the mutation then returns a normal `_nay`, so checking before consuming keeps a refused
 * call from burning tokens in the other bucket.
 */
export async function rate_limiter_check_by_key(
	ctx: MutationCtx | ActionCtx,
	args: {
		name: keyof typeof rate_limiter_CONFIG;
		key: string;
		count?: number;
	},
) {
	const limit = await rate_limiter.check(ctx, args.name, {
		key: args.key,
		count: args.count,
	});

	if (limit.ok) {
		return null;
	}

	// No refusal log here, unlike `rate_limiter_limit_by_key`. A refused check means the caller
	// waits and retries the same charge, and that later `limit` call logs when it really refuses.
	return {
		message: rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE,
		retryAfterMs: limit.retryAfter,
	} as const;
}

export function rate_limiter_http_client_key(request: Request) {
	const forwardedFor = request.headers.get("x-forwarded-for");
	const forwardedIp = forwardedFor?.split(",")[0]?.trim();

	return (
		forwardedIp ||
		request.headers.get("cf-connecting-ip") ||
		request.headers.get("x-real-ip") ||
		request.headers.get("origin") ||
		"unknown"
	);
}
