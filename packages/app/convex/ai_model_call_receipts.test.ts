import { Workpool } from "@convex-dev/workpool";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import { ai_model_call_receipts_create } from "./ai_model_call_receipts.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

let enqueueActionSpy: MockInstance;

beforeEach(() => {
	enqueueActionSpy = vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("receipts-test-work" as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const USAGE = {
	inputTokens: { total: 100_000, noCache: 100_000, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 100_000, text: 100_000, reasoning: undefined },
};

// GPT-6 Luna: 100k input and 100k output tokens cost 6 cents.
const USAGE_CENTS = 6;

const REPORTED = {
	state: "reported",
	inputTokens: 100_000,
	outputTokens: 100_000,
	cachedInputTokens: null,
	reasoningTokens: null,
	reportedCostUsd: null,
} as const;

async function setup() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const payer = {
		threadId: null,
		billedUserId: db.userId,
		actorUserId: db.userId,
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
	};
	const admit = (modelCallId: string) =>
		t.mutation(internal.ai_model_call_receipts.admit, {
			modelCallId,
			purpose: "chat_step",
			modelId: "gpt-6-luna",
			...payer,
			runId: null,
		});
	const receipt = (modelCallId: string) =>
		t.run((ctx) =>
			ctx.db
				.query("ai_model_call_receipts")
				.withIndex("by_modelCallId", (q) => q.eq("modelCallId", modelCallId))
				.unique(),
		);
	const balance = () =>
		t.run(
			async (ctx) =>
				(await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.unique())!.meter!.balance,
		);
	return { t, db, payer, admit, receipt, balance };
}

describe("save_usage", () => {
	test("debits an anonymous payer once, even when the usage save repeats", async () => {
		const { t, admit, receipt, balance } = await setup();
		const before = await balance();
		await admit("call_1");

		for (let i = 0; i < 2; i++) {
			await t.mutation(internal.ai_model_call_receipts.save_usage, {
				modelCallId: "call_1",
				responseId: "resp_1",
				providerModelId: null,
				usage: REPORTED,
				step: null,
			});
		}

		expect(await receipt("call_1")).toMatchObject({
			responseId: "resp_1",
			usage: REPORTED,
			nextRecoveryAt: null,
			tokens: { state: "debited" },
		});
		expect((await receipt("call_1"))!.tokens!.amountCents).toBeCloseTo(USAGE_CENTS);
		expect(before - (await balance())).toBeCloseTo(USAGE_CENTS);
		expect(enqueueActionSpy).not.toHaveBeenCalled();
	});

	test("queues a Polar event for a signed-in payer and records the pool result", async () => {
		const { t, db, admit, receipt } = await setup();
		await t.run((ctx) => ctx.db.patch("users", db.userId, { clerkUserId: "clerk-receipts-user" }));
		await admit("call_1");

		await t.mutation(internal.ai_model_call_receipts.save_usage, {
			modelCallId: "call_1",
			responseId: "resp_1",
			providerModelId: null,
			usage: REPORTED,
			step: null,
		});

		expect(enqueueActionSpy).toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			{
				events: [
					expect.objectContaining({
						name: "ai_usage",
						externalId: `ai_model_call::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::call_1`,
						metadata: expect.objectContaining({ modelCallId: "call_1", component: "tokens", responseId: "resp_1" }),
					}),
				],
			},
			expect.objectContaining({
				onComplete: internal.ai_model_call_receipts.on_delivery_complete,
				context: { modelCallId: "call_1", imageCallId: null },
			}),
		);
		expect(await receipt("call_1")).toMatchObject({ tokens: { state: "queued" } });

		await t.mutation(internal.ai_model_call_receipts.on_delivery_complete, {
			workId: "receipts-test-work" as never,
			context: { modelCallId: "call_1", imageCallId: null },
			result: { kind: "success", returnValue: null },
		});
		expect(await receipt("call_1")).toMatchObject({ tokens: { state: "delivered" } });
	});

	test("keeps the charge as target_gone when an admin purge deleted the payer", async () => {
		const { t, db, admit, receipt } = await setup();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		await admit("call_1");
		await t.run((ctx) => ctx.db.delete("users", db.userId));

		await t.mutation(internal.ai_model_call_receipts.save_usage, {
			modelCallId: "call_1",
			responseId: null,
			providerModelId: null,
			usage: REPORTED,
			step: null,
		});

		expect(await receipt("call_1")).toMatchObject({ tokens: { state: "target_gone" } });
		expect(consoleError).toHaveBeenCalledWith(
			"AI usage not billed",
			expect.objectContaining({ reason: "no_user", modelCallId: "call_1" }),
		);
	});

	test("never replaces reported usage with a later missing save", async () => {
		const { t, admit, receipt } = await setup();
		await admit("call_1");
		await t.mutation(internal.ai_model_call_receipts.save_usage, {
			modelCallId: "call_1",
			responseId: null,
			providerModelId: null,
			usage: REPORTED,
			step: null,
		});

		await t.mutation(internal.ai_model_call_receipts.save_usage, {
			modelCallId: "call_1",
			responseId: null,
			providerModelId: null,
			usage: { state: "missing", reason: "no_usage" },
			step: null,
		});

		expect(await receipt("call_1")).toMatchObject({ usage: REPORTED, tokens: { state: "debited" } });
	});

	test("still bills usage that arrives after the lookups ended", async () => {
		const { t, admit, receipt, balance } = await setup();
		const before = await balance();
		await admit("call_1");
		// With no response id, the first miss ends the lookups at once.
		await t.mutation(internal.ai_model_call_receipts.record_recovery_miss, { modelCallId: "call_1" });
		expect(await receipt("call_1")).toMatchObject({
			usage: { state: "missing_final", reason: "no_finish" },
			nextRecoveryAt: null,
		});

		await t.mutation(internal.ai_model_call_receipts.save_usage, {
			modelCallId: "call_1",
			responseId: null,
			providerModelId: null,
			usage: REPORTED,
			step: null,
		});

		expect(await receipt("call_1")).toMatchObject({ usage: REPORTED, tokens: { state: "debited" } });
		expect(before - (await balance())).toBeCloseTo(USAGE_CENTS);
	});
});

describe("save_image", () => {
	test("charges each picture once", async () => {
		const { t, admit, receipt, balance } = await setup();
		const before = await balance();
		await admit("call_1");

		for (const imageCallId of ["ig_1", "ig_1", "ig_2"]) {
			await t.mutation(internal.ai_model_call_receipts.save_image, { modelCallId: "call_1", imageCallId });
		}

		expect((await receipt("call_1"))!.images).toEqual([
			{ imageCallId: "ig_1", charge: expect.objectContaining({ amountCents: 4, state: "debited" }) },
			{ imageCallId: "ig_2", charge: expect.objectContaining({ amountCents: 4, state: "debited" }) },
		]);
		expect(before - (await balance())).toBe(8);
	});
});

describe("ai_model_call_receipts_create", () => {
	// The middleware only needs `runMutation`, so drive the real mutations through convex-test.
	const middlewareFor = (t: ReturnType<typeof test_convex>, payer: Awaited<ReturnType<typeof setup>>["payer"]) =>
		ai_model_call_receipts_create({
			ctx: { runMutation: t.mutation } as unknown as ActionCtx,
			payer,
			modelCallIds: null,
			run: null,
		});

	const modelCallIds = (t: ReturnType<typeof test_convex>) =>
		t.run(async (ctx) =>
			(await ctx.db.query("ai_model_call_receipts").collect()).map((receipt) => receipt.modelCallId),
		);

	test("saves the response id and pictures, and holds the finish until the usage is saved", async () => {
		const { t, payer, receipt } = await setup();
		const receipts = middlewareFor(t, payer);
		const model = wrapLanguageModel({
			model: new MockLanguageModelV3({
				doStream: async () => ({
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({ type: "response-metadata", id: "resp_1", modelId: "gpt-6-luna-2026-09-01" });
							controller.enqueue({
								type: "tool-result",
								toolCallId: "ig_1",
								toolName: "image_generation",
								result: { result: "preview" },
								preliminary: true,
							});
							controller.enqueue({
								type: "tool-result",
								toolCallId: "ig_1",
								toolName: "image_generation",
								result: { result: "final" },
							});
							controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE });
							controller.close();
						},
					}),
				}),
			}),
			middleware: receipts.middleware({ purpose: "chat_step", modelId: "gpt-6-luna" }),
		});

		const { stream } = await model.doStream({ prompt: [] });
		const reader = stream.getReader();
		let receiptAtFinish: Awaited<ReturnType<typeof receipt>> = null;
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value.type === "finish") {
				const [modelCallId] = await modelCallIds(t);
				receiptAtFinish = await receipt(modelCallId!);
			}
		}
		await receipts.settle();

		// The finish reaches the SDK only after the usage and the picture are saved.
		expect(receiptAtFinish).toMatchObject({
			responseId: "resp_1",
			providerModelId: "gpt-6-luna-2026-09-01",
			usage: { state: "reported", inputTokens: 100_000, outputTokens: 100_000 },
			tokens: { state: "debited" },
			images: [{ imageCallId: "ig_1", charge: expect.objectContaining({ amountCents: 4 }) }],
		});
	});

	test("saves the response id once when the provider repeats it on every chunk", async () => {
		const { t, payer, receipt } = await setup();
		const savedResponses: unknown[] = [];
		const receipts = ai_model_call_receipts_create({
			ctx: {
				runMutation: (reference: FunctionReference<"mutation", "internal">, args: Record<string, unknown>) => {
					if (getFunctionName(reference) === getFunctionName(internal.ai_model_call_receipts.save_response)) {
						savedResponses.push(args);
					}
					return t.mutation(reference, args);
				},
			} as unknown as ActionCtx,
			payer,
			modelCallIds: null,
			run: null,
		});
		// OpenRouter sends the id on every chunk and the model name in a part of its own.
		const model = wrapLanguageModel({
			model: new MockLanguageModelV3({
				doStream: async () => ({
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							controller.enqueue({ type: "response-metadata", id: "gen_1" });
							controller.enqueue({ type: "response-metadata", modelId: "deepseek/deepseek-v4.1-flash" });
							controller.enqueue({ type: "text-start", id: "text" });
							for (let i = 0; i < 5; i++) {
								controller.enqueue({ type: "response-metadata", id: "gen_1" });
								controller.enqueue({ type: "text-delta", id: "text", delta: "word " });
							}
							controller.enqueue({ type: "text-end", id: "text" });
							controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE });
							controller.close();
						},
					}),
				}),
			}),
			middleware: receipts.middleware({ purpose: "chat_step", modelId: "deepseek-v4.1-flash" }),
		});

		const { stream } = await model.doStream({ prompt: [] });
		await Array.fromAsync(stream);
		await receipts.settle();

		expect(savedResponses).toHaveLength(1);
		const [modelCallId] = await modelCallIds(t);
		expect(await receipt(modelCallId!)).toMatchObject({
			responseId: "gen_1",
			providerModelId: "deepseek/deepseek-v4.1-flash",
			usage: { state: "reported" },
		});
	});

	test("bills the usage of a request that failed before any output", async () => {
		const { t, payer, receipt } = await setup();
		const receipts = middlewareFor(t, payer);
		const failedStream = (usage: unknown) =>
			new Response(
				[
					{
						type: "response.created",
						response: { id: "resp_failed", created_at: 0, model: "gpt-6-luna", service_tier: null },
					},
					{
						type: "response.failed",
						sequence_number: 1,
						response: { error: { code: "server_error", message: "Server error" }, usage },
					},
				]
					.map(
						(event) => `data: ${JSON.stringify(event)}

`,
					)
					.join(""),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		const responses = [
			() => failedStream({ input_tokens: 100_000, output_tokens: 100_000 }),
			() => failedStream(null),
			() => {
				throw new TypeError("fetch failed");
			},
		];
		// Run the real OpenAI provider, so the error has the shape the provider really throws.
		const model = wrapLanguageModel({
			model: createOpenAI({ apiKey: "test", fetch: async () => responses.shift()!() })("gpt-6-luna"),
			middleware: receipts.middleware({ purpose: "chat_step", modelId: "gpt-6-luna" }),
		});

		for (let i = 0; i < 3; i++) {
			await expect(model.doStream({ prompt: [] })).rejects.toThrow();
		}

		const [withUsage, withoutUsage, network] = await Promise.all((await modelCallIds(t)).map((id) => receipt(id)));
		expect(withUsage).toMatchObject({
			usage: { state: "reported", inputTokens: 100_000, outputTokens: 100_000 },
			tokens: { state: "debited", amountCents: USAGE_CENTS },
		});
		// No usage means no bill. The provider drops the response id, so no lookup can find it later.
		for (const unbilled of [withoutUsage, network]) {
			expect(unbilled).toMatchObject({
				responseId: null,
				usage: { state: "missing", reason: "provider_error" },
				tokens: null,
			});
		}
	});
});

describe("recover_due", () => {
	const makeDue = (t: ReturnType<typeof test_convex>, modelCallId: string) =>
		t.run(async (ctx) => {
			const receipt = await ctx.db
				.query("ai_model_call_receipts")
				.withIndex("by_modelCallId", (q) => q.eq("modelCallId", modelCallId))
				.unique();
			await ctx.db.patch("ai_model_call_receipts", receipt!._id, { nextRecoveryAt: Date.now() - 1 });
		});

	test("bills the usage the provider reports for a request that lost its finish", async () => {
		const { t, admit, receipt } = await setup();
		const fetchMock = vi.fn(async (_input: string | URL | Request) =>
			Response.json({ id: "resp_1", usage: { input_tokens: 100_000, output_tokens: 100_000 } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await admit("call_1");
		await t.mutation(internal.ai_model_call_receipts.save_response, {
			modelCallId: "call_1",
			responseId: "resp_1",
			providerModelId: null,
		});
		await makeDue(t, "call_1");

		await t.action(internal.ai_model_call_receipts.recover_due, {});

		expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/responses/resp_1", expect.anything());
		expect(await receipt("call_1")).toMatchObject({
			usage: { state: "reported", inputTokens: 100_000, outputTokens: 100_000 },
			nextRecoveryAt: null,
			tokens: { state: "debited", amountCents: USAGE_CENTS },
		});
	});

	test("schedules the next lookup when the provider has no usage yet", async () => {
		const { t, admit, receipt } = await setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);
		await admit("call_1");
		await t.mutation(internal.ai_model_call_receipts.save_response, {
			modelCallId: "call_1",
			responseId: "resp_1",
			providerModelId: null,
		});
		await makeDue(t, "call_1");

		await t.action(internal.ai_model_call_receipts.recover_due, {});

		const after = await receipt("call_1");
		expect(after).toMatchObject({
			usage: { state: "missing", reason: "no_finish" },
			recoveryAttempts: 1,
			tokens: null,
		});
		expect(after!.nextRecoveryAt).toBe(after!.admittedAt + 30 * 60 * 1000);
	});
});

describe("cleanup_old_receipts", () => {
	test("deletes old receipts only when nothing can change them", async () => {
		const { t, admit, receipt } = await setup();
		const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
		for (const modelCallId of ["final", "queued", "pending", "recent"]) {
			await admit(modelCallId);
		}
		const charge = (state: "delivered" | "queued") => ({ amountCents: 1, externalId: "x", state });
		await t.run(async (ctx) => {
			for (const receipt of await ctx.db.query("ai_model_call_receipts").collect()) {
				await ctx.db.patch("ai_model_call_receipts", receipt._id, {
					admittedAt: receipt.modelCallId === "recent" ? Date.now() : old,
					usage: receipt.modelCallId === "pending" ? { state: "pending" } : REPORTED,
					tokens: charge(receipt.modelCallId === "queued" ? "queued" : "delivered"),
				});
			}
		});

		await t.mutation(internal.ai_model_call_receipts.cleanup_old_receipts, {});

		expect(await receipt("final")).toBeNull();
		expect(await receipt("queued")).not.toBeNull();
		expect(await receipt("pending")).not.toBeNull();
		expect(await receipt("recent")).not.toBeNull();
	});
});
