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
	billing_action: STRICT_AUTH_OR_BILLING,
	comments_write: STRICT_WRITE,
	files_pending_update_write: BULK_FILES_WRITE,
	files_snapshot_write: STRICT_WRITE,
	files_tree_write: BULK_FILES_WRITE,
	files_yjs_push_update: STRICT_WRITE,
	plugins_manage: STRICT_AUTH_OR_BILLING,
	// Initial mint plus occasional refresh per open plugin page; token TTL is 30 minutes.
	plugins_ui_session_mint: STRICT_WRITE,
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
	save_file_pending_update: BULK_FILES_WRITE,
	organizations_write: STRICT_WRITE,
} as const;

const rate_limiter = new RateLimiter(components.rate_limiter, rate_limiter_CONFIG);

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

	console.warn("Rate limit exceeded", {
		name: args.name,
		key: args.key,
		retryAfterMs: limit.retryAfter,
	});

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
