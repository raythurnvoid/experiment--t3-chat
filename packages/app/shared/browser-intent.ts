import { z } from "zod";

/**
 * The browser policy at send time. It grants no browser or page lease.
 */
export const browser_intent_schema = z
	.object({
		policyRevision: z.number().int().nonnegative(),
	})
	.strict();

export type browser_Intent = z.infer<typeof browser_intent_schema>;
