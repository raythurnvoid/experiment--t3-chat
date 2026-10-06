// Billing receipts for provider requests: admission before each request, usage and picture saves,
// the delivery of each charge, the recovery cron, and the retention cleanup.
//
// Wrap every billed model with `ai_model_call_receipts_create(...).middleware(...)`. The rules are in
// the billing-system skill.

import { vOnCompleteArgs } from "@convex-dev/workpool";
// Import types only, so receipt mutations and crons do not load the AI SDK.
import type { LanguageModelMiddleware } from "ai";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internalAction, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server.js";
import { internalMutation } from "./functions.ts";
import type { RegisteredQuery } from "convex/server";
// Type-only, so this module does not load the Polar SDK (see `billing_db.ts`).
import type { billing_Event } from "../server/billing.ts";
import type { ai_chat_ModelId } from "../shared/ai-chat.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { billing_db_debit_anonymous_snapshot, billing_db_enqueue_signed_in_event } from "./billing_db.ts";
import { ai_chat_model_id_validator, ai_model_call_purpose_validator } from "./schema.ts";
import { ai_chat_runs_db_plan_step } from "./ai_chat_runs.ts";

type ReportedUsage = Omit<Extract<Doc<"ai_model_call_receipts">["usage"], { state: "reported" }>, "state">;

/**
 * What one generated picture costs, in cents. OpenAI charges per image, not per token.
 */
const GENERATED_IMAGE_COST_CENTS = 4;

// Look up missing usage 10 min, 30 min, 1 h, 3 h, 8 h and 24 h after admission. The first lookup
// waits for the 10 minute action limit, so the request that owns the receipt has ended.
const RECOVERY_DELAYS_MS = [10, 30, 60, 180, 480, 1440].map((minutes) => minutes * 60 * 1000);

const RETENTION_MS = 396 * 24 * 60 * 60 * 1000;

const RECOVERY_BATCH_SIZE = 20;
// Stop one slow provider lookup after 10 seconds, so it does not hold up the batch.
const LOOKUP_TIMEOUT_MS = 10_000;
const CLEANUP_BATCH_SIZE = 100;

// Stop waiting for one receipt save after 10 seconds and try again, 3 times in all.
const SAVE_TIMEOUT_MS = 10_000;
const SAVE_ATTEMPTS = 3;

if (!process.env.OPENAI_API_KEY) {
	throw new Error("OPENAI_API_KEY is not set in Convex env");
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function compute_token_usage_cost_cents(args: {
	modelId: ai_chat_ModelId;
	inputTokens: number;
	outputTokens: number;
	reportedCostUsd: number | null;
}) {
	// OpenRouter picks the host for each DeepSeek request, so bill the dollar cost it reports.
	// If that cost is missing, use the DeepSeek host list price: $0.30 input and $1.20 output per 1M tokens.
	if (args.modelId === "deepseek-v4.1-flash") {
		const reportedCostUsd = args.reportedCostUsd;
		if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
			return reportedCostUsd * 100;
		}

		return args.inputTokens * 0.00003 + args.outputTokens * 0.00012;
	}

	// GPT-6 Luna standard price is $0.10 input and $0.50 output per 1M tokens.
	// A prompt over 272k input tokens costs 2x input and 1.5x output for the whole request. Each
	// provider request is priced alone, so a long turn is not summed into one long prompt.
	const longPrompt = args.inputTokens > 272_000;
	return args.inputTokens * (longPrompt ? 0.00002 : 0.00001) + args.outputTokens * (longPrompt ? 0.000075 : 0.00005);
}

/**
 * Read the dollar cost OpenRouter put on one request. A missing or bad value means the caller
 * should use the list price instead.
 */
function openrouter_reported_cost_usd(providerMetadata: unknown): number | null {
	if (providerMetadata === null || typeof providerMetadata !== "object" || !("openrouter" in providerMetadata)) {
		return null;
	}

	const openrouterMetadata = providerMetadata.openrouter;
	if (openrouterMetadata === null || typeof openrouterMetadata !== "object" || !("usage" in openrouterMetadata)) {
		return null;
	}

	const usage = openrouterMetadata.usage;
	if (usage === null || typeof usage !== "object" || !("cost" in usage)) {
		return null;
	}

	const cost = usage.cost;
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
		return null;
	}

	return cost;
}

/**
 * The usage of one provider request, or null when the provider did not report token totals.
 */
function reported_usage(
	usage: {
		inputTokens: { total: number | undefined; cacheRead: number | undefined };
		outputTokens: { total: number | undefined; reasoning: number | undefined };
	},
	providerMetadata: unknown,
): ReportedUsage | null {
	if (usage.inputTokens.total === undefined || usage.outputTokens.total === undefined) return null;

	return {
		inputTokens: usage.inputTokens.total,
		outputTokens: usage.outputTokens.total,
		cachedInputTokens: usage.inputTokens.cacheRead ?? null,
		reasoningTokens: usage.outputTokens.reasoning ?? null,
		reportedCostUsd: openrouter_reported_cost_usd(providerMetadata),
	};
}

/**
 * The OpenAI Responses object, as the retrieve endpoint returns it and as a `response.failed`
 * event carries it. Only the fields billing reads.
 */
const openai_response_schema = z.object({
	usage: z
		.object({
			input_tokens: z.number(),
			output_tokens: z.number(),
			input_tokens_details: z.object({ cached_tokens: z.number() }).nullish(),
			output_tokens_details: z.object({ reasoning_tokens: z.number() }).nullish(),
		})
		.nullish(),
});

function openai_reported_usage(response: z.infer<typeof openai_response_schema>): ReportedUsage | null {
	if (!response.usage) return null;

	return {
		inputTokens: response.usage.input_tokens,
		outputTokens: response.usage.output_tokens,
		cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? null,
		reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? null,
		reportedCostUsd: null,
	};
}

/**
 * Read the usage from a request that failed before any output. `@ai-sdk/openai` throws an
 * `APICallError` whose `data` is the `response.failed` event after its own schema parsed it.
 * That schema keeps `response.usage` but drops `response.id`.
 */
function failed_request_usage(error: unknown) {
	const parsed = z.object({ data: z.object({ response: openai_response_schema }) }).safeParse(error);
	if (!parsed.success) return null;

	return openai_reported_usage(parsed.data.data.response);
}

// #region middleware

/**
 * The input of a tool call from the provider stream. It is JSON text; keep the raw text when it
 * does not parse, so the step still records what the model sent.
 */
function parse_tool_input(input: string) {
	try {
		return JSON.parse(input) as unknown;
	} catch {
		return input;
	}
}

/**
 * Save with a timeout and retries. A timed out save may still commit, so every receipt mutation is
 * safe to repeat.
 */
async function save_with_retries<T>(args: { modelCallId: string; logLoss: boolean; save: () => Promise<T> }) {
	for (let attempt = 1; ; attempt++) {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			args.save().then((value) => ({ ok: true as const, value })),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("Receipt save timed out")), SAVE_TIMEOUT_MS);
			}),
		]).catch((error: unknown) => ({ ok: false as const, error }));
		clearTimeout(timeout);
		if (result.ok) return result.value;

		// The provider may already have charged us for this request. The recovery cron can still find
		// token usage later through the response id, but not a picture charge.
		if (attempt === SAVE_ATTEMPTS) {
			if (args.logLoss) {
				console.error("Chat data not saved", {
					reason: "usage_save_failed",
					modelCallId: args.modelCallId,
					errorName: result.error instanceof Error ? result.error.name : "Error",
				});
			}
			throw new Error("Failed to save the model call receipt", { cause: result.error });
		}
	}
}

/**
 * Bill every provider request of one caller through receipts. Wrap each model with
 * `middleware(...)`, and await `settle()` before the action ends, so the response id saves that
 * do not block the stream still finish.
 *
 * `modelCallIds` receives the provider request of each tool call, keyed by tool call id. A tool
 * that stores output builds its operation key from it. Callers without tools pass null.
 *
 * `run` is set for the steps of an agent run. The usage save of each step also plans the step's
 * doc, before any of its tools start. When Stop won that race, the step's tool call ids go into
 * `stoppedToolCallIds`, and the tool start guard refuses them.
 */
export function ai_model_call_receipts_create(args: {
	ctx: ActionCtx;
	payer: {
		threadId: Id<"ai_chat_threads"> | null;
		billedUserId: Id<"users">;
		actorUserId: Id<"users">;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
	};
	modelCallIds: Map<string, string> | null;
	run: {
		runId: Id<"ai_chat_runs">;
		generation: number;
		getStepIndex: () => number;
		stoppedToolCallIds: Set<string>;
	} | null;
}) {
	const { ctx, payer, modelCallIds, run } = args;

	const pending = new Set<Promise<unknown>>();

	const track = <T>(promise: Promise<T>) => {
		pending.add(promise);
		// The awaiting caller handles the error. This copy only drops the promise from the set.
		promise.then(
			() => pending.delete(promise),
			() => pending.delete(promise),
		);
		return promise;
	};

	const admit = async (args: { purpose: Doc<"ai_model_call_receipts">["purpose"]; modelId: ai_chat_ModelId }) => {
		// A new provider request gets a new id, including an SDK retry.
		const modelCallId = crypto.randomUUID();
		await save_with_retries({
			modelCallId,
			logLoss: false,
			save: () =>
				ctx.runMutation(internal.ai_model_call_receipts.admit, {
					modelCallId,
					...args,
					...payer,
					runId: run?.runId ?? null,
				}),
		});
		return modelCallId;
	};

	const save_usage_with_retries = (args: {
		modelCallId: string;
		responseId: string | null;
		providerModelId: string | null;
		usage: ReportedUsage | null;
		missingReason: "no_usage" | "provider_error";
		step: { stepIndex: number; toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> } | null;
	}) =>
		track(
			save_with_retries({
				modelCallId: args.modelCallId,
				logLoss: args.usage !== null,
				save: () =>
					ctx.runMutation(internal.ai_model_call_receipts.save_usage, {
						modelCallId: args.modelCallId,
						responseId: args.responseId,
						providerModelId: args.providerModelId,
						usage: args.usage ? { state: "reported", ...args.usage } : { state: "missing", reason: args.missingReason },
						step: run && args.step ? { runId: run.runId, generation: run.generation, ...args.step } : null,
					}),
			}),
		);

	// Read the usage of a request that failed before its stream or result. With no usage, the
	// receipt is `missing` and nothing is billed. The failed request has no response id, so the
	// recovery cron cannot look it up either.
	const save_failed_usage = async (modelCallId: string, error: unknown) => {
		await save_usage_with_retries({
			modelCallId,
			responseId: null,
			providerModelId: null,
			usage: failed_request_usage(error),
			missingReason: "provider_error",
			step: null,
		});
	};

	return {
		middleware(args: {
			purpose: Doc<"ai_model_call_receipts">["purpose"];
			modelId: ai_chat_ModelId;
		}): LanguageModelMiddleware {
			return {
				specificationVersion: "v3",
				wrapGenerate: async ({ doGenerate }) => {
					const modelCallId = await admit(args);

					const result = await Promise.resolve(doGenerate()).catch(async (error: unknown) => {
						await save_failed_usage(modelCallId, error);
						throw error;
					});
					await save_usage_with_retries({
						modelCallId,
						responseId: result.response?.id ?? null,
						providerModelId: result.response?.modelId ?? null,
						usage: reported_usage(result.usage, result.providerMetadata),
						missingReason: "no_usage",
						step: null,
					});
					return result;
				},
				wrapStream: async ({ doStream }) => {
					const modelCallId = await admit(args);
					// Only agent steps have a step doc. A title call has none.
					const stepIndex = args.purpose === "chat_step" && run ? run.getStepIndex() : null;
					const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];

					const { stream, ...rest } = await Promise.resolve(doStream()).catch(async (error: unknown) => {
						await save_failed_usage(modelCallId, error);
						throw error;
					});

					let responseId: string | null = null;
					let providerModelId: string | null = null;
					const imageSaves: Promise<unknown>[] = [];
					return {
						...rest,
						stream: stream.pipeThrough(
							new TransformStream({
								transform: async (part, controller) => {
									// OpenRouter sends the model name in its own part, without the response id.
									if (part.type === "response-metadata" && part.modelId) {
										providerModelId = part.modelId;
									}

									// Save the response id once, at once, so the recovery cron can find the usage
									// even if this action dies before the finish. OpenRouter repeats the id on
									// every chunk, so skip the later copies.
									if (part.type === "response-metadata" && part.id && responseId === null) {
										responseId = part.id;
										const responseIdToSave = part.id;
										const providerModelIdToSave = providerModelId;
										track(
											save_with_retries({
												modelCallId,
												logLoss: false,
												save: () =>
													ctx.runMutation(internal.ai_model_call_receipts.save_response, {
														modelCallId,
														responseId: responseIdToSave,
														providerModelId: providerModelIdToSave,
													}),
											}),
										).catch(() => {});
									}

									// The SDK starts a local tool only after this request's finish, so the entry is
									// always there before the tool reads it.
									if (part.type === "tool-call") {
										modelCallIds?.set(part.toolCallId, modelCallId);
										// Provider tools run at the provider, so the step plans only local calls.
										if (!part.providerExecuted) {
											toolCalls.push({
												toolCallId: part.toolCallId,
												toolName: part.toolName,
												input: parse_tool_input(part.input),
											});
										}
									}

									// Charge each finished picture from the provider stream, not from the Files
									// save. Stop, a full quota or a storage error while saving cannot hide it.
									if (part.type === "tool-result" && part.toolName === "image_generation" && !part.preliminary) {
										const imageCallId = part.toolCallId;
										imageSaves.push(
											track(
												save_with_retries({
													modelCallId,
													logLoss: true,
													save: () =>
														ctx.runMutation(internal.ai_model_call_receipts.save_image, { modelCallId, imageCallId }),
												}),
											),
										);
									}

									// Hold the finish until usage is saved. The SDK starts local tools only after the
									// finish, so a tool never runs for a request whose usage is not saved. A failed
									// save errors the stream, so no more provider requests run.
									if (part.type === "finish") {
										await Promise.all(imageSaves);
										const saved = await save_usage_with_retries({
											modelCallId,
											responseId,
											providerModelId,
											usage: reported_usage(part.usage, part.providerMetadata),
											missingReason: "no_usage",
											step: stepIndex === null ? null : { stepIndex, toolCalls },
										});
										if (run && !saved.toolsAllowed) {
											for (const call of toolCalls) run.stoppedToolCallIds.add(call.toolCallId);
										}
									}

									controller.enqueue(part);
								},
							}),
						),
					};
				},
			};
		},
		settle: () => Promise.allSettled([...pending]),
	};
}

// #endregion middleware

// #region receipts

async function db_get_receipt(ctx: MutationCtx, modelCallId: string) {
	const receipt = await ctx.db
		.query("ai_model_call_receipts")
		.withIndex("by_modelCallId", (q) => q.eq("modelCallId", modelCallId))
		.unique();
	// Admission always saves the receipt before the provider request that later saves use.
	if (!receipt) throw should_never_happen("Model call receipt not found", { modelCallId });
	return receipt;
}

/**
 * Charge one component of a receipt, in the caller's transaction.
 *
 * Pick the channel now, not at admission. Sign-in upgrades the same user doc, so usage from
 * before sign-in goes to the new account. The provider already charged us, so this checks no run,
 * Stop, membership, thread or credits.
 */
async function db_deliver_charge(args: {
	ctx: MutationCtx;
	receipt: Doc<"ai_model_call_receipts">;
	component: { kind: "tokens"; usage: ReportedUsage } | { kind: "image"; imageCallId: string };
}) {
	const { ctx, receipt, component } = args;

	const amountCents =
		component.kind === "tokens"
			? compute_token_usage_cost_cents({ modelId: receipt.modelId, ...component.usage })
			: GENERATED_IMAGE_COST_CENTS;
	const imageCallId = component.kind === "image" ? component.imageCallId : null;
	const externalId =
		imageCallId === null
			? composite_id(
					"billing",
					"ai_model_call",
					receipt.billedUserId,
					receipt.actorUserId,
					receipt.organizationId,
					receipt.workspaceId,
					receipt.modelCallId,
				)
			: composite_id(
					"billing",
					"ai_model_call_image",
					receipt.billedUserId,
					receipt.actorUserId,
					receipt.organizationId,
					receipt.workspaceId,
					receipt.modelCallId,
					imageCallId,
				);
	if (amountCents === 0) return { amountCents, externalId, state: "skipped_zero" as const };

	const payer = await ctx.db.get("users", receipt.billedUserId);
	if (payer?.clerkUserId == null) {
		const debited = payer
			? await billing_db_debit_anonymous_snapshot(ctx, { userId: payer._id, amount: amountCents })
			: false;
		if (debited) return { amountCents, externalId, state: "debited" as const };

		// An admin full purge deleted the user or its billing state. The late charge is lost.
		console.error("AI usage not billed", {
			reason: payer ? "no_snapshot" : "no_user",
			modelCallId: receipt.modelCallId,
			billedUserId: receipt.billedUserId,
			amountCents,
		});
		return { amountCents, externalId, state: "target_gone" as const };
	}

	const event: billing_Event = {
		name: "ai_usage",
		externalCustomerId: receipt.billedUserId,
		externalMemberId: receipt.actorUserId,
		externalId,
		metadata: {
			amount: amountCents,
			actorUserId: receipt.actorUserId,
			billedUserId: receipt.billedUserId,
			organizationId: receipt.organizationId,
			workspaceId: receipt.workspaceId,
			modelId: receipt.modelId,
			modelCallId: receipt.modelCallId,
			purpose: receipt.purpose,
			component: component.kind,
			imageCallId,
			responseId: receipt.responseId,
			providerModelId: receipt.providerModelId,
			inputTokens: component.kind === "tokens" ? component.usage.inputTokens : null,
			outputTokens: component.kind === "tokens" ? component.usage.outputTokens : null,
			generatedImages: component.kind === "image" ? 1 : 0,
			threadId: receipt.threadId,
		},
	};
	await billing_db_enqueue_signed_in_event(ctx, {
		event,
		options: {
			onComplete: internal.ai_model_call_receipts.on_delivery_complete,
			context: { modelCallId: receipt.modelCallId, imageCallId },
		},
	});
	return { amountCents, externalId, state: "queued" as const };
}

export const admit = internalMutation({
	args: {
		modelCallId: v.string(),
		purpose: ai_model_call_purpose_validator,
		modelId: ai_chat_model_id_validator,
		threadId: v.union(v.id("ai_chat_threads"), v.null()),
		billedUserId: v.id("users"),
		actorUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		runId: v.union(v.id("ai_chat_runs"), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// A retried admission after a timeout finds its own receipt.
		const existing = await ctx.db
			.query("ai_model_call_receipts")
			.withIndex("by_modelCallId", (q) => q.eq("modelCallId", args.modelCallId))
			.unique();
		if (existing) return null;

		const now = Date.now();
		await ctx.db.insert("ai_model_call_receipts", {
			...args,
			providerModelId: null,
			responseId: null,
			admittedAt: now,
			usage: { state: "pending" },
			recoveryAttempts: 0,
			nextRecoveryAt: now + RECOVERY_DELAYS_MS[0]!,
			tokens: null,
			images: [],
		});
		return null;
	},
});

export const save_response = internalMutation({
	args: {
		modelCallId: v.string(),
		responseId: v.string(),
		providerModelId: v.union(v.string(), v.null()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const receipt = await db_get_receipt(ctx, args.modelCallId);
		if (receipt.responseId !== null) return null;

		await ctx.db.patch("ai_model_call_receipts", receipt._id, {
			responseId: args.responseId,
			providerModelId: args.providerModelId,
		});
		return null;
	},
});

export const save_usage = internalMutation({
	args: {
		modelCallId: v.string(),
		responseId: v.union(v.string(), v.null()),
		providerModelId: v.union(v.string(), v.null()),
		usage: v.union(
			v.object({
				state: v.literal("reported"),
				inputTokens: v.number(),
				outputTokens: v.number(),
				cachedInputTokens: v.union(v.number(), v.null()),
				reasoningTokens: v.union(v.number(), v.null()),
				reportedCostUsd: v.union(v.number(), v.null()),
			}),
			v.object({
				state: v.literal("missing"),
				reason: v.union(v.literal("no_usage"), v.literal("provider_error")),
			}),
		),
		/**
		 * The agent step this provider request made. Its doc is planned in this transaction, so the
		 * step's tools start only when the doc exists and Stop did not win.
		 */
		step: v.union(
			v.object({
				runId: v.id("ai_chat_runs"),
				generation: v.number(),
				stepIndex: v.number(),
				toolCalls: v.array(v.object({ toolCallId: v.string(), toolName: v.string(), input: v.any() })),
			}),
			v.null(),
		),
	},
	returns: v.object({ toolsAllowed: v.boolean() }),
	handler: async (ctx, args) => {
		const receipt = await db_get_receipt(ctx, args.modelCallId);
		const responseId = receipt.responseId ?? args.responseId;
		const providerModelId = receipt.providerModelId ?? args.providerModelId;

		// Plan the step whatever the usage state below. Billing never waits for Stop.
		const { toolsAllowed } = args.step
			? await ai_chat_runs_db_plan_step(ctx, { ...args.step, modelCallId: args.modelCallId })
			: { toolsAllowed: true };

		// Usage only moves forward. Reported usage is billed once, and a missing save never replaces
		// a later state. Reported usage after `missing_final` is still billed.
		if (receipt.usage.state === "reported") return { toolsAllowed };
		if (args.usage.state === "missing") {
			if (receipt.usage.state === "pending") {
				await ctx.db.patch("ai_model_call_receipts", receipt._id, { usage: args.usage, responseId, providerModelId });
			}
			return { toolsAllowed };
		}

		const { state: _state, ...usage } = args.usage;
		const tokens = await db_deliver_charge({
			ctx,
			receipt: { ...receipt, responseId, providerModelId },
			component: { kind: "tokens", usage },
		});
		await ctx.db.patch("ai_model_call_receipts", receipt._id, {
			usage: args.usage,
			responseId,
			providerModelId,
			nextRecoveryAt: null,
			tokens,
		});
		return { toolsAllowed };
	},
});

export const save_image = internalMutation({
	args: {
		modelCallId: v.string(),
		imageCallId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const receipt = await db_get_receipt(ctx, args.modelCallId);
		if (receipt.images.some((image) => image.imageCallId === args.imageCallId)) return null;

		const charge = await db_deliver_charge({
			ctx,
			receipt,
			component: { kind: "image", imageCallId: args.imageCallId },
		});
		await ctx.db.patch("ai_model_call_receipts", receipt._id, {
			images: [...receipt.images, { imageCallId: args.imageCallId, charge }],
		});
		return null;
	},
});

export const on_delivery_complete = internalMutation({
	args: vOnCompleteArgs(v.object({ modelCallId: v.string(), imageCallId: v.union(v.string(), v.null()) })),
	returns: v.null(),
	handler: async (ctx, args) => {
		const receipt = await db_get_receipt(ctx, args.context.modelCallId);
		// The usage pool retries without limit, so a failure here means the pool gave up or the
		// work was canceled. Keep the charge as `delivery_failed` for the admin readback.
		const state = args.result.kind === "success" ? "delivered" : "delivery_failed";
		if (state === "delivery_failed") {
			console.error("AI usage delivery failed", {
				modelCallId: receipt.modelCallId,
				imageCallId: args.context.imageCallId,
				resultKind: args.result.kind,
			});
		}

		if (args.context.imageCallId === null) {
			if (!receipt.tokens) throw should_never_happen("Delivered tokens charge not found", args.context);
			await ctx.db.patch("ai_model_call_receipts", receipt._id, { tokens: { ...receipt.tokens, state } });
			return null;
		}

		await ctx.db.patch("ai_model_call_receipts", receipt._id, {
			images: receipt.images.map((image) =>
				image.imageCallId === args.context.imageCallId ? { ...image, charge: { ...image.charge, state } } : image,
			),
		});
		return null;
	},
});

// #endregion receipts

// #region recovery

export const list_due_recoveries = internalQuery({
	args: { now: v.number() },
	returns: v.array(
		v.object({
			modelCallId: v.string(),
			modelId: ai_chat_model_id_validator,
			responseId: v.union(v.string(), v.null()),
		}),
	),
	handler: async (ctx, args) => {
		const receipts = await ctx.db
			.query("ai_model_call_receipts")
			.withIndex("by_nextRecoveryAt", (q) => q.gt("nextRecoveryAt", null).lte("nextRecoveryAt", args.now))
			.take(RECOVERY_BATCH_SIZE);
		return receipts.map((receipt) => ({
			modelCallId: receipt.modelCallId,
			modelId: receipt.modelId,
			responseId: receipt.responseId,
		}));
	},
});

type list_due_recoveries_Result =
	typeof list_due_recoveries extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Schedule the next lookup of a receipt whose usage is still unknown, or end the lookups.
 */
export const record_recovery_miss = internalMutation({
	args: { modelCallId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const receipt = await db_get_receipt(ctx, args.modelCallId);
		// A live save or an earlier lookup already reported the usage.
		if (receipt.usage.state === "reported") return null;

		const recoveryAttempts = receipt.recoveryAttempts + 1;
		// The request's action has ended by now, so a pending receipt never got its finish.
		const reason = receipt.usage.state === "pending" ? "no_finish" : receipt.usage.reason;
		// A receipt without a response id can never be looked up.
		const isFinal = receipt.responseId === null || recoveryAttempts >= RECOVERY_DELAYS_MS.length;
		await ctx.db.patch("ai_model_call_receipts", receipt._id, {
			usage: { state: isFinal ? "missing_final" : "missing", reason },
			recoveryAttempts,
			nextRecoveryAt: isFinal ? null : receipt.admittedAt + RECOVERY_DELAYS_MS[recoveryAttempts]!,
		});
		return null;
	},
});

/**
 * Ask the provider for the usage of one request. Returns null when it has none yet or the call
 * fails. OpenAI keeps responses because the app does not set `store: false`.
 */
async function fetch_provider_usage(args: { modelId: ai_chat_ModelId; responseId: string }) {
	if (args.modelId === "deepseek-v4.1-flash") {
		// Read the key here, not at module load: the dev deployment has no OpenRouter key, and a
		// root throw would break every push. Without it the lookup fails and counts as a miss.
		const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(args.responseId)}`, {
			headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
		if (!response.ok) return null;

		const parsed = z
			.object({
				data: z.object({
					native_tokens_prompt: z.number(),
					native_tokens_completion: z.number(),
					native_tokens_reasoning: z.number().nullish(),
					native_tokens_cached: z.number().nullish(),
					total_cost: z.number(),
				}),
			})
			.safeParse(await response.json());
		if (!parsed.success) return null;

		return {
			inputTokens: parsed.data.data.native_tokens_prompt,
			outputTokens: parsed.data.data.native_tokens_completion,
			cachedInputTokens: parsed.data.data.native_tokens_cached ?? null,
			reasoningTokens: parsed.data.data.native_tokens_reasoning ?? null,
			reportedCostUsd: parsed.data.data.total_cost,
		};
	}

	const response = await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(args.responseId)}`, {
		headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
		signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
	});
	if (!response.ok) return null;

	const parsed = openai_response_schema.safeParse(await response.json());
	if (!parsed.success) return null;

	return openai_reported_usage(parsed.data);
}

/**
 * Look up the usage of receipts whose request ended without a usage save. Runs from the cron.
 */
export const recover_due = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const due = (await ctx.runQuery(internal.ai_model_call_receipts.list_due_recoveries, {
			now: Date.now(),
		})) as list_due_recoveries_Result;
		await Promise.all(
			due.map(async (receipt) => {
				const usage = receipt.responseId
					? await fetch_provider_usage({ modelId: receipt.modelId, responseId: receipt.responseId }).catch(
							(error: unknown) => {
								console.error("AI usage lookup failed", {
									modelCallId: receipt.modelCallId,
									errorName: error instanceof Error ? error.name : "Error",
								});
								return null;
							},
						)
					: null;

				if (usage) {
					await ctx.runMutation(internal.ai_model_call_receipts.save_usage, {
						modelCallId: receipt.modelCallId,
						responseId: receipt.responseId,
						providerModelId: null,
						usage: { state: "reported", ...usage },
						step: null,
					});
				} else {
					await ctx.runMutation(internal.ai_model_call_receipts.record_recovery_miss, {
						modelCallId: receipt.modelCallId,
					});
				}
			}),
		);

		// Every receipt above left the due range. A full batch means more may still be due.
		if (due.length === RECOVERY_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.ai_model_call_receipts.recover_due, {});
		}
		return null;
	},
});

// #endregion recovery

// #region retention

/**
 * Delete receipts older than 396 days once nothing can change them: usage is final and no charge
 * waits for the Polar pool.
 */
export const cleanup_old_receipts = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const receipts = await ctx.db
			.query("ai_model_call_receipts")
			.withIndex("by_admittedAt", (q) => q.lt("admittedAt", Date.now() - RETENTION_MS))
			.take(CLEANUP_BATCH_SIZE);
		let deletedCount = 0;
		for (const receipt of receipts) {
			const charges = [receipt.tokens, ...receipt.images.map((image) => image.charge)];
			if (
				(receipt.usage.state === "reported" || receipt.usage.state === "missing_final") &&
				charges.every((charge) => charge?.state !== "queued")
			) {
				await ctx.db.delete("ai_model_call_receipts", receipt._id);
				deletedCount++;
			}
		}

		// Continue only while this pass made progress. Receipts that still wait stay for the next day.
		if (receipts.length === CLEANUP_BATCH_SIZE && deletedCount > 0) {
			await ctx.scheduler.runAfter(0, internal.ai_model_call_receipts.cleanup_old_receipts, {});
		}
		return null;
	},
});

// #endregion retention

// #region tests
// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest;

	describe("compute_token_usage_cost_cents", () => {
		test("bills GPT-6 Luna at $0.10 input and $0.50 output per 1M tokens", () => {
			expect(
				compute_token_usage_cost_cents({
					modelId: "gpt-6-luna",
					inputTokens: 100_000,
					outputTokens: 100_000,
					reportedCostUsd: null,
				}),
			).toBeCloseTo(6);
		});

		test("keeps the standard GPT-6 Luna rate at exactly 272k input tokens", () => {
			expect(
				compute_token_usage_cost_cents({
					modelId: "gpt-6-luna",
					inputTokens: 272_000,
					outputTokens: 0,
					reportedCostUsd: null,
				}),
			).toBeCloseTo(2.72);
		});

		test("bills a GPT-6 Luna prompt over 272k input tokens at the higher rate", () => {
			expect(
				compute_token_usage_cost_cents({
					modelId: "gpt-6-luna",
					inputTokens: 272_001,
					outputTokens: 1_000_000,
					reportedCostUsd: null,
				}),
			).toBeCloseTo(272_001 * 0.00002 + 75);
		});

		test("bills DeepSeek V4.1 Flash at the dollar cost OpenRouter reports", () => {
			expect(
				compute_token_usage_cost_cents({
					modelId: "deepseek-v4.1-flash",
					inputTokens: 100_000,
					outputTokens: 100_000,
					reportedCostUsd: 0.15,
				}),
			).toBe(15);
		});

		test("bills DeepSeek V4.1 Flash at $0.30 input and $1.20 output when OpenRouter omits the cost", () => {
			expect(
				compute_token_usage_cost_cents({
					modelId: "deepseek-v4.1-flash",
					inputTokens: 100_000,
					outputTokens: 100_000,
					reportedCostUsd: null,
				}),
			).toBeCloseTo(15);
		});
	});

	describe("openrouter_reported_cost_usd", () => {
		test("reads a non-negative OpenRouter cost and ignores anything else", () => {
			expect(openrouter_reported_cost_usd({ openrouter: { usage: { cost: 0.15 } } })).toBe(0.15);
			expect(openrouter_reported_cost_usd({ openrouter: { usage: { cost: 0 } } })).toBe(0);
			expect(openrouter_reported_cost_usd({ openrouter: { usage: {} } })).toBeNull();
			expect(openrouter_reported_cost_usd({ openrouter: { usage: { cost: -1 } } })).toBeNull();
			expect(openrouter_reported_cost_usd(undefined)).toBeNull();
		});
	});

	describe("failed_request_usage", () => {
		// Copy the shape of the provider's APICallError. The receipts test file throws the real one.
		const failed = (response: unknown) =>
			Object.assign(new Error("Server error"), { data: { type: "response.failed", response } });

		// The provider parsed the event with its own schema first, which keeps usage and drops the id.
		test("reads the usage of a response that failed before any output", () => {
			expect(
				failed_request_usage(
					failed({
						usage: {
							input_tokens: 120,
							output_tokens: 0,
							input_tokens_details: { cached_tokens: 20 },
							output_tokens_details: { reasoning_tokens: 0 },
						},
					}),
				),
			).toEqual({
				inputTokens: 120,
				outputTokens: 0,
				cachedInputTokens: 20,
				reasoningTokens: 0,
				reportedCostUsd: null,
			});
		});

		test("bills nothing when the failed response has no usage", () => {
			expect(failed_request_usage(failed({ usage: null }))).toBeNull();
		});

		test("ignores errors that carry no response", () => {
			expect(failed_request_usage(new Error("network down"))).toBeNull();
			expect(failed_request_usage(failed(undefined))).toBeNull();
		});
	});
}
// #endregion tests
