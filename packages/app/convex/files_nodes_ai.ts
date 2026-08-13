// Inline AI writing assistance for /files: the heavy /api/files/contextual-prompt implementation
// and its private billing helpers.
//
// Lives in its own module so the hot file-tree module `files_nodes.ts` never pays the AI SDK
// ("ai", "@ai-sdk/openai", "zod") module evaluation cost.
//
// No `export const experimental_reuseContext = true;` here: the flag does not work for http
// actions (see http.ts), and the thin route module loads this implementation only on demand.

import { type ActionCtx, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { generateText, streamText, smoothStream } from "ai";
import { openai } from "@ai-sdk/openai";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { type files_InlineAiModelId } from "../server/files.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { api, internal } from "./_generated/api.js";
import { z } from "zod";
import { billing_event } from "../server/billing.ts";
import { billing_ingest_events } from "./billing_db.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";

function files_compute_token_usage_cost_cents(args: { modelId: string; inputTokens: number; outputTokens: number }) {
	switch (args.modelId) {
		case "gpt-5.4-nano":
		case "gpt-4.1-nano":
			return args.inputTokens * 0.00001 + args.outputTokens * 0.00004;
		case "gpt-5.4-mini":
		case "gpt-5-mini" satisfies files_InlineAiModelId:
		default:
			return args.inputTokens * 0.00003 + args.outputTokens * 0.00015;
	}
}

async function files_ingest_inline_ai_usage_event(
	ctx: ActionCtx | MutationCtx,
	args: {
		actorUserId: Id<"users">;
		billedUser: Doc<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		requestId: string;
		usageEventId: string;
		inputTokens: number;
		outputTokens: number;
	},
) {
	if (args.inputTokens + args.outputTokens === 0) {
		return;
	}

	await billing_ingest_events(ctx, {
		billedUserEvents: [
			{
				billedUser: args.billedUser,
				event: billing_event({
					name: "ai_usage",
					externalCustomerId: args.billedUser._id,
					externalMemberId: args.actorUserId,
					externalId: composite_id(
						"billing",
						"ai_usage",
						args.billedUser._id,
						args.actorUserId,
						args.organizationId,
						args.workspaceId,
						"inline_ai",
						args.usageEventId,
					),
					metadata: {
						amount: files_compute_token_usage_cost_cents({
							modelId: "gpt-5-mini" satisfies files_InlineAiModelId,
							inputTokens: args.inputTokens,
							outputTokens: args.outputTokens,
						}),
						actorUserId: args.actorUserId,
						billedUserId: args.billedUser._id,
						organizationId: args.organizationId,
						workspaceId: args.workspaceId,
						modelId: "gpt-5-mini" satisfies files_InlineAiModelId,
						inputTokens: args.inputTokens,
						outputTokens: args.outputTokens,
						threadId: "inline_ai",
						messageId: args.requestId,
					},
				}),
			},
		],
	});
}

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
	requestId: z.string(),
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

		const { prompt, option, command, context, previous, membershipId, requestId } = body._yay;

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

		const usageEventId = crypto.randomUUID();
		if (context) {
			const result = await generateText({
				model: openai("gpt-5-mini" satisfies files_InlineAiModelId),
				system: systemPrompt,
				messages: [
					{
						role: "user",
						content: userPrompt,
					},
				],
				temperature: 0.7,
				maxOutputTokens: 500,
				abortSignal: request.signal,
			});

			await files_ingest_inline_ai_usage_event(ctx, {
				actorUserId: user._id,
				billedUser,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				requestId,
				usageEventId,
				inputTokens: result.totalUsage.inputTokens ?? 0,
				outputTokens: result.totalUsage.outputTokens ?? 0,
			});

			return {
				status: 200,
				body: {
					type: context.selection.trim() ? "replace" : "insert",
					text: result.text,
				},
			} as const;
		}

		const result = streamText({
			model: openai("gpt-5-mini" satisfies files_InlineAiModelId),
			system: systemPrompt,
			messages: [
				{
					role: "user",
					content: userPrompt,
				},
			],
			temperature: 0.7,
			maxOutputTokens: 500,
			experimental_transform: smoothStream({
				delayInMs: 100,
			}),
			abortSignal: request.signal,
			onFinish: async ({ totalUsage }) => {
				await files_ingest_inline_ai_usage_event(ctx, {
					actorUserId: user._id,
					billedUser,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					requestId,
					usageEventId,
					inputTokens: totalUsage.inputTokens ?? 0,
					outputTokens: totalUsage.outputTokens ?? 0,
				});
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
