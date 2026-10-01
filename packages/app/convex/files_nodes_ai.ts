// Inline AI writing assistance for /files: the heavy /api/files/contextual-prompt implementation.
//
// Lives in its own module so the hot file-tree module `files_nodes.ts` never pays the AI SDK
// ("ai", "@ai-sdk/openai", "zod") module evaluation cost.
//
// No `export const experimental_reuseContext = true;` here: the flag does not work for http
// actions (see http.ts), and the thin route module loads this implementation only on demand.

import { type ActionCtx } from "./_generated/server.js";
import { generateText, streamText, smoothStream, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import type { ai_chat_ModelId } from "../shared/ai-chat.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { api, internal } from "./_generated/api.js";
import { z } from "zod";
import { ai_model_call_receipts_create } from "./ai_model_call_receipts.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

/**
 * Every billed model must come from the chat model list, which is priced.
 */
const INLINE_AI_MODEL_ID = "gpt-6-luna" as const satisfies ai_chat_ModelId;

/**
 * Inline AI writes short text, so skip reasoning: it would spend the small output limit.
 */
const INLINE_AI_PROVIDER_OPTIONS = { openai: { reasoningEffort: "none" } } as const;

const contextual_prompt_body_validator = z.object({
	prompt: z.string(),
	option: z.string().optional(),
	command: z.string().optional(),
	context: z
		.object({
			beforeSelection: z.string(),
			selection: z.string(),
			afterSelection: z.string(),
		})
		.optional(),
	previous: z
		.object({
			prompt: z.string(),
			response: z.object({
				type: z.enum(["insert", "replace", "other"]).optional(),
				text: z.string(),
			}),
		})
		.optional(),
	membershipId: z.string(),
});

export type files_nodes_ai_http_contextual_prompt_Body = z.infer<typeof contextual_prompt_body_validator>;

export async function files_nodes_ai_http_contextual_prompt(ctx: ActionCtx, request: Request) {
	try {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return {
				status: 401,
				body: {
					message: "Unauthenticated",
				},
			} as const;
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, {
			name: "ai_inline_http",
			key: userAuth.id,
		});
		if (rateLimit) {
			return {
				status: 429,
				body: {
					message: rateLimit.message,
					retryAfterMs: rateLimit.retryAfterMs,
				},
			} as const;
		}

		const body = await server_request_json_parse_and_validate(request, contextual_prompt_body_validator);
		if (body._nay) {
			return {
				status: 400,
				body: body._nay,
			} as const;
		}

		const { prompt, option, command, context, previous, membershipId } = body._yay;

		if (!prompt || typeof prompt !== "string") {
			return {
				status: 400,
				body: {
					message: "Invalid prompt",
				},
			} as const;
		}

		const user = await ctx.runQuery(internal.users.get, { userId: userAuth.id });
		if (!user) {
			return {
				status: 401,
				body: {
					message: "Unauthenticated",
				},
			} as const;
		}

		const membership = await ctx.runQuery(api.organizations.get_membership, { membershipId });
		if (!membership || membership.userId !== user._id) {
			return {
				status: 403,
				body: {
					message: "Unauthorized",
				},
			} as const;
		}

		// The assistant writes text back into a document, so a read-only user has no use for it.
		// Checked before the credit check so a denied call never bills the organization.
		//
		// We ask for `content.write` only. `/api/chat` also asks for `content.read`, but this
		// route never reads the file: the client sends all the text it needs in the request
		// body. So a role with write but no read learns nothing new here.
		const allowed = await ctx.runQuery(api.access_control.get_current_user_workspace_permission, {
			membershipId: membership._id,
			permission: "content.write",
		});
		if (!allowed) {
			return {
				status: 403,
				body: {
					message: "Permission denied",
				},
			} as const;
		}

		const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
			userId: user._id,
			organizationId: membership.organizationId,
			minimumRequiredCents: 1,
		});
		if (!creditCheck.hasCredits) {
			return {
				status: 402,
				body: {
					message: "Insufficient funds",
				},
			} as const;
		}
		const billedUser = creditCheck.billedUser;
		if (!billedUser) {
			const errorMessage = "Organization credit check did not return billed user";
			const errorData = {
				userId: user._id,
				organizationId: membership.organizationId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// Use the Liveblocks contextual shape when editor context is present; the inline popover path
		// omits context and consumes the streaming response below.
		let systemPrompt = "";
		let userPrompt = "";

		if (context) {
			systemPrompt =
				"You are an AI writing assistant for a rich text editor. " +
				"Return only the text that should be inserted or used as the replacement. " +
				"Use Markdown formatting when appropriate.";
			userPrompt = [
				`Instruction: ${prompt}`,
				`Before selection:\n${context.beforeSelection || "(empty)"}`,
				`Selected text:\n${context.selection || "(empty)"}`,
				`After selection:\n${context.afterSelection || "(empty)"}`,
				previous ? `Previous instruction:\n${previous.prompt}\n\nPrevious response:\n${previous.response.text}` : null,
			]
				.filter((value) => value !== null)
				.join("\n\n");
		} else {
			switch (option) {
				case "continue":
					systemPrompt =
						"You are an AI writing assistant that continues existing text based on context from prior text. " +
						"Give more weight/priority to the later characters than the beginning ones. " +
						"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
						"Use Markdown formatting when appropriate.";
					userPrompt = prompt;
					break;
				case "improve":
					systemPrompt =
						"You are an AI writing assistant that improves existing text. " +
						"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
						"Use Markdown formatting when appropriate.";
					userPrompt = `The existing text is: ${prompt}`;
					break;
				case "shorter":
					systemPrompt =
						"You are an AI writing assistant that shortens existing text. " +
						"Use Markdown formatting when appropriate.";
					userPrompt = `The existing text is: ${prompt}`;
					break;
				case "longer":
					systemPrompt =
						"You are an AI writing assistant that lengthens existing text. " +
						"Use Markdown formatting when appropriate.";
					userPrompt = `The existing text is: ${prompt}`;
					break;
				case "fix":
					systemPrompt =
						"You are an AI writing assistant that fixes grammar and spelling errors in existing text. " +
						"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
						"Use Markdown formatting when appropriate.";
					userPrompt = `The existing text is: ${prompt}`;
					break;
				case "zap":
					systemPrompt =
						"You are an AI writing assistant that generates text based on a prompt. " +
						"You take an input from the user and a command for manipulating the text. " +
						"Use Markdown formatting when appropriate.";
					userPrompt = `For this text: ${prompt}. You have to respect the command: ${command}`;
					break;
				default:
					systemPrompt = "You are an AI writing assistant. Help with the given text based on the user's needs.";
					userPrompt = command ? `${command}\n\nText: ${prompt}` : `Continue this text:\n\n${prompt}`;
			}
		}

		const receipts = ai_model_call_receipts_create({
			ctx,
			payer: {
				threadId: null,
				billedUserId: billedUser._id,
				actorUserId: user._id,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
			},
			modelCallIds: null,
			run: null,
		});
		const model = wrapLanguageModel({
			model: openai(INLINE_AI_MODEL_ID),
			middleware: receipts.middleware({ purpose: "inline_ai", modelId: INLINE_AI_MODEL_ID }),
		});

		if (context) {
			const result = await generateText({
				model,
				providerOptions: INLINE_AI_PROVIDER_OPTIONS,
				system: systemPrompt,
				messages: [
					{
						role: "user",
						content: userPrompt,
					},
				],
				maxOutputTokens: 500,
				abortSignal: request.signal,
			});
			await receipts.settle();

			return {
				status: 200,
				body: {
					type: context.selection.trim() ? "replace" : "insert",
					text: result.text,
				},
			} as const;
		}

		const result = streamText({
			model,
			providerOptions: INLINE_AI_PROVIDER_OPTIONS,
			system: systemPrompt,
			messages: [
				{
					role: "user",
					content: userPrompt,
				},
			],
			maxOutputTokens: 500,
			experimental_transform: smoothStream({
				delayInMs: 100,
			}),
			abortSignal: request.signal,
			// A Stop before the finish leaves the receipt without usage. The recovery cron looks it up.
			onFinish: async () => {
				await receipts.settle();
			},
		});

		return {
			status: 200,
			body: result,
		} as const;
	} catch (error: unknown) {
		console.error("AI generation error:", error);
		return {
			status: 500,
			body: {
				message: error instanceof Error ? error.message : "Internal server error",
			},
		} as const;
	}
}
