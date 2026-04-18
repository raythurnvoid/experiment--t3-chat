import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api.js";

// Intentionally strict for rollout testing. Tune these here when relaxing.
export const rate_limiter_config = {
	pagesYjsPushUpdate: {
		kind: "token bucket",
		rate: 12,
		period: MINUTE,
		capacity: 2,
	},
} as const;

export const rate_limiter = new RateLimiter(components.rateLimiter, rate_limiter_config);
