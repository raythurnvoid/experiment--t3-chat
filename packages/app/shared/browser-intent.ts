import { z } from "zod";

const browser_choice_schema = z.discriminatedUnion("provider", [
	z.object({ provider: z.literal("none") }).strict(),
	z.object({ provider: z.literal("cloud") }).strict(),
	z
		.object({
			provider: z.literal("playwriter"),
			connectionId: z.string().min(1).max(256),
			confirmedTargetHandle: z.string().min(1).max(256),
		})
		.strict(),
]);

/**
 * The user's choice at send time. It grants no browser or page lease.
 */
export const browser_intent_schema = z
	.object({
		webChoice: browser_choice_schema,
		selectionRevision: z.number().int().nonnegative(),
		policyRevision: z.number().int().nonnegative(),
	})
	.strict();

export type browser_Intent = z.infer<typeof browser_intent_schema>;
