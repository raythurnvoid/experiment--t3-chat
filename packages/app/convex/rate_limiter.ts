import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api.js";

export const rate_limiter = new RateLimiter(components.rate_limiter, {
	// Intentionally strict for rollout testing. Tune these here when relaxing.
	pages_yjs_push_update: {
		kind: "token bucket",
		rate: 12,
		period: MINUTE,
		capacity: 2,
	},
} as const);
