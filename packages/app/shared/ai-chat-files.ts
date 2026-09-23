import z from "zod";

/**
 * One file a tool produced. `private` points at a pending file only this user sees. `saved`
 * points at an ordinary workspace file.
 *
 * These ids are references, not access grants. Files queries check access before resolving them.
 * The ids stay plain strings, because this schema also parses stored chat JSON in the browser.
 * `files_pending_target_validator` in `convex/schema.ts` is the Convex twin, and Convex refuses a
 * string that is not a real id before a handler runs.
 */
export const ai_chat_file_target_schema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("private"), id: z.string().min(1).max(128) }).strict(),
	z.object({ kind: z.literal("saved"), id: z.string().min(1).max(128) }).strict(),
]);

/**
 * Capped display text a browser run may store for the human card. Raw live
 * observations stay live-only. Only these fields may persist, and the chat card
 * reads only these fields. Never put lease JSON, provider or session ids,
 * screenshot bytes, or inline image data here.
 */
export const ai_chat_file_debug_schema = z
	.object({
		code: z.string().max(4000).optional(),
		resultText: z.string().max(8000).optional(),
		consoleText: z.string().max(2000).optional(),
		pageErrorsText: z.string().max(1000).optional(),
		errorText: z.string().max(1000).optional(),
	})
	.strict();

/**
 * The one stored shape every file tool writes. Shared chat stores status and targets only, plus
 * optional capped browser display text. File bytes stay behind the Files read APIs.
 *
 * `.strict()` makes a result with any extra field fail the check, so a tool cannot put anything
 * else into the stored thread.
 */
export const ai_chat_file_result_schema = z
	.object({
		title: z.string().max(200),
		output: z.string().max(500),
		metadata: z
			.object({
				// Every file tool shares this one stored shape, so the list holds all of their statuses:
				// image_generation, browser_run, browser_reload, browser_close, and view_image.
				status: z.enum(["succeeded", "partial", "errored", "cancelled", "timed_out"]),
				reason: z
					.enum([
						"unavailable",
						"unsupported_image",
						"limit",
						"agent_required",
						"invalid_result",
						"storage",
						"stale",
						"needs_capture",
						"execution",
						"busy",
						"agent_access_off",
						"agent_blocked_site",
					])
					.nullable(),
				// Both runners and the shared writer stop at eight files per call.
				files: z.array(ai_chat_file_target_schema).max(8),
				// Display-only browser text. Old results without it stay valid.
				debug: ai_chat_file_debug_schema.optional(),
			})
			.strict(),
	})
	.strict();

/**
 * Build the same safe result for live tools, the chat stream, and stored history.
 *
 * Callers pass fixed reason codes. Private observations never become chat text.
 */
export function ai_chat_file_result(
	title: string,
	status: z.infer<typeof ai_chat_file_result_schema>["metadata"]["status"],
	files: Array<z.infer<typeof ai_chat_file_target_schema>> = [],
	reason: z.infer<typeof ai_chat_file_result_schema>["metadata"]["reason"] = null,
	debug?: z.infer<typeof ai_chat_file_debug_schema>,
) {
	return {
		title,
		output: `${title}: ${status}.`,
		metadata: debug === undefined ? { status, reason, files } : { status, reason, files, debug },
	};
}

/**
 * `execute_code` keeps its own shape. Its card also shows the run id, how long the run took, and
 * whether the result or the logs were cut short. The runner already bounds the text it returns, so
 * `output` needs no cap here.
 */
export const ai_chat_execute_code_result_schema = z
	.object({
		title: z.literal("Execute code"),
		output: z.string(),
		metadata: z
			.object({
				executionId: z.string(),
				fileResult: ai_chat_file_result_schema.nullable(),
				status: z.enum(["succeeded", "errored", "timed_out"]),
				elapsedMs: z.number().nonnegative(),
				resultTruncated: z.boolean(),
				logsTruncated: z.boolean(),
				files: z.array(ai_chat_file_target_schema).max(8),
			})
			.strict(),
	})
	.strict();
