import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { APICallError, type streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_nodes_db_create_private_node_by_path } from "./files_nodes.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { r2_create_asset_key } from "./r2_client.ts";

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: model.streamText,
}));

beforeEach(() => {
	model.streamText.mockReset();
	model.streamText.mockImplementation(() => ({
		toUIMessageStream: () =>
			new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "start", messageId: "answer" });
					controller.enqueue({ type: "text-start", id: "text" });
					controller.enqueue({ type: "text-delta", id: "text", delta: "Done" });
					controller.enqueue({ type: "text-end", id: "text" });
					controller.enqueue({ type: "finish" });
					controller.close();
				},
			}),
		response: Promise.resolve({ messages: [] }),
		consumeStream: async () => {},
	}));
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_skill_route_test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test",
		url: `https://r2.test/upload?key=${encodeURIComponent(key ?? "test")}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	const objects = new Map<string, BodyInit>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return new Response(body ?? null, { status: body === undefined ? 404 : 200 });
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function setup() {
	const t = test_convex();
	const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		subject: "skill-route",
		external_id: membership.userId,
	});
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: membership.membershipId,
		clientGeneratedId: "skill-route-thread",
		title: "Skill check",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	return { t, asUser, membership, threadId: thread._yay.threadId };
}

describe("/api/chat tool call repair", () => {
	// The model sometimes answers with a tool name in the wrong case. The route repairs the case and
	// nothing else. The extra `length` field in the first row is a real input error, so that call
	// must fail instead of being repaired.
	test.each([
		{ toolName: "view_image", extraInput: { length: 1 }, valid: false },
		{ toolName: "View_Image", extraInput: {}, valid: true },
	])("keeps validation errors and repairs only the case of $toolName", async ({ toolName, extraInput, valid }) => {
		const { asUser, membership, threadId } = await setup();
		const actualAi = await vi.importActual<typeof import("ai")>("ai");
		const input = { path: "/image.png", ...extraInput };
		const execute = vi.fn();

		// The fake model answers twice: the first step calls the tool, the second one writes text and
		// ends the run.
		let step = 0;
		const languageModel = new MockLanguageModelV3({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						const firstStep = step++ === 0;
						controller.enqueue({ type: "stream-start", warnings: [] });
						if (firstStep) {
							controller.enqueue({
								type: "tool-call",
								toolCallId: "read-image",
								toolName,
								input: JSON.stringify(input),
							});
						} else {
							controller.enqueue({ type: "text-start", id: "answer" });
							controller.enqueue({ type: "text-delta", id: "answer", delta: "Done" });
							controller.enqueue({ type: "text-end", id: "answer" });
						}
						controller.enqueue({
							type: "finish",
							finishReason: { unified: firstStep ? "tool-calls" : "stop", raw: undefined },
							usage: {
								inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
								outputTokens: { total: 1, text: 1, reasoning: undefined },
							},
						});
						controller.close();
					},
				}),
			}),
		});
		// Keep the real streamText, but point it at the fake model and wrap the route's own view_image.
		// The spy then shows whether the repaired call reached the tool.
		model.streamText.mockImplementation((options: Parameters<typeof streamText>[0]) => {
			const viewImage = options.tools?.view_image;
			if (!viewImage?.execute) throw new Error("Expected view_image");
			execute.mockImplementation(viewImage.execute);
			viewImage.execute = execute;
			return actualAi.streamText({ ...options, model: languageModel });
		});

		const response = await asUser.fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ id: "read-request", role: "user", parts: [{ type: "text", text: "Read the image." }] }],
				parentId: null,
				mode: "ask",
				model: "gpt-5.4-nano",
				trigger: "submit-message",
				threadId,
				membershipId: membership.membershipId,
			}),
		});
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(languageModel.doStreamCalls).toHaveLength(2);

		// The second request carries the tool result the model reads back.
		const results = languageModel.doStreamCalls[1]!.prompt.flatMap((message) =>
			message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ type: "tool-result", toolCallId: "read-image", toolName: "view_image" });
		expect(JSON.stringify(results)).not.toContain('tool "invalid"');

		// A repaired call runs the real tool with the input the model sent. An input error is kept and
		// handed back instead, so the model can fix its next call.
		if (valid) {
			expect(execute).toHaveBeenCalledTimes(1);
			expect(execute.mock.calls[0]![0]).toEqual(input);
			expect(results[0]!.output.type).not.toBe("error-text");
		} else {
			expect(execute).not.toHaveBeenCalled();
			expect(results[0]!.output).toMatchObject({
				type: "error-text",
				value: expect.stringContaining("Invalid input for tool view_image"),
			});
			expect(JSON.stringify(results[0]!.output)).toContain("length");
		}
	});
});

describe("/api/chat private observations", () => {
	test("does not retry a provider request after its image becomes unavailable", async () => {
		const { t, asUser, membership, threadId } = await setup();
		const actualAi = await vi.importActual<typeof import("ai")>("ai");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4AWJiYGD4D8IgBpBmYAAAAAD//7vS9wEAAAAGSURBVAMAGDACA6ybwrYAAAAASUVORK5CYII=";
		const png = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
		const { organizationId, workspaceId, userId } = membership;
		const scope = { organizationId, workspaceId, userId };
		const file = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId,
				workspaceId,
				createdBy: userId,
				kind: "content",
				r2Bucket: "test",
				size: png.length,
				updatedAt: Date.now(),
			});
			const r2Key = r2_create_asset_key({ ...scope, assetId });
			await ctx.db.patch("files_r2_assets", assetId, { r2Key });
			const reserved = await files_private_storage_db_reserve(ctx, {
				...scope,
				resource: { kind: "asset", id: assetId, r2Key },
				byteCount: png.length,
			});
			if (reserved._nay) throw new Error(reserved._nay.message);
			const created = await files_nodes_db_create_private_node_by_path(ctx, {
				...scope,
				path: "/private-image.png",
				kind: "file",
				content: { kind: "stored", assetId, size: png.length, contentType: "image/png" },
			});
			if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private image");
			const pending = await ctx.db.get("files_pending_updates", created._yay.pendingUpdateId);
			return { ...created._yay, pendingUpdateId: created._yay.pendingUpdateId, revision: pending!.revision, r2Key };
		});
		await fetch(`https://r2.test/upload?key=${encodeURIComponent(file.r2Key)}`, { method: "PUT", body: png });

		let requestCount = 0;
		const languageModel = new MockLanguageModelV3({
			doStream: async (options) => {
				const firstStep = ++requestCount === 1;
				if (requestCount === 2) {
					// Discard after prepareStep checked the image. A hidden SDK retry would reuse its bytes.
					const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
						membershipId: membership.membershipId,
						target: file.target,
						pendingUpdateId: file.pendingUpdateId,
						reviewedRevision: file.revision,
					});
					expect(discarded._nay).toBeUndefined();
					throw new APICallError({
						message: "Rate limited",
						url: "https://model.test/responses",
						requestBodyValues: { input: options.prompt, browserText: "PRIVATE_BROWSER_TEXT" },
						responseBody: "PRIVATE_PROVIDER_RESPONSE",
						statusCode: 429,
						responseHeaders: { "retry-after-ms": "1" },
						isRetryable: true,
					});
				}
				return {
					stream: new ReadableStream({
						start(controller) {
							controller.enqueue({ type: "stream-start", warnings: [] });
							if (firstStep) {
								controller.enqueue({
									type: "tool-call",
									toolCallId: "private-view",
									toolName: "view_image",
									input: JSON.stringify({ path: "/private-image.png" }),
								});
							}
							controller.enqueue({
								type: "finish",
								finishReason: { unified: firstStep ? "tool-calls" : "stop", raw: undefined },
								usage: {
									inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
									outputTokens: { total: 1, text: 1, reasoning: undefined },
								},
							});
							controller.close();
						},
					}),
				};
			},
		});
		model.streamText.mockImplementation((options: Parameters<typeof streamText>[0]) =>
			actualAi.streamText({ ...options, model: languageModel }),
		);

		const response = await asUser.fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ id: "private-request", role: "user", parts: [{ type: "text", text: "Inspect my image." }] }],
				parentId: null,
				mode: "ask",
				model: "gpt-5.4-nano",
				trigger: "submit-message",
				threadId,
				membershipId: membership.membershipId,
			}),
		});
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(JSON.stringify(languageModel.doStreamCalls[1]!.prompt)).toContain(pngBase64);
		expect(languageModel.doStreamCalls).toHaveLength(2);
		expect(body).toContain("Rate limited");
		expect(body).not.toContain(pngBase64);
		expect(consoleError).toHaveBeenCalled();
		const logged = JSON.stringify(consoleError.mock.calls);
		expect(logged.includes(pngBase64)).toBe(false);
		expect(logged).not.toContain("PRIVATE_BROWSER_TEXT");
		expect(logged).not.toContain("PRIVATE_PROVIDER_RESPONSE");
		const messages = await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
		expect(JSON.stringify(messages)).not.toContain(pngBase64);
		// A failed stream keeps the request, but does not save a partial assistant reply.
		expect(messages.map((message) => message.content.role)).toEqual(["user"]);
		expect(
			(await t.query(internal.files_nodes_content.get_file_read_source, {
				userId,
				membershipId: membership.membershipId,
				threadId,
				path: "/private-image.png",
			}))._nay,
		).toBeDefined();
	});
});

describe("/api/v1/runs/stream provider errors", () => {
	test.each(["setup", "provider"])("keeps request and response bodies out of %s error logs", async (failure) => {
		const { asUser, membership, threadId } = await setup();
		const actualAi = await vi.importActual<typeof import("ai")>("ai");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const error = new APICallError({
			message: "Provider unavailable",
			url: "https://model.test/responses",
			requestBodyValues: { input: "PRIVATE_TITLE_INPUT" },
			responseBody: "PRIVATE_PROVIDER_RESPONSE",
			statusCode: 400,
			isRetryable: false,
		});
		const languageModel = new MockLanguageModelV3({
			doStream: async () => {
				throw error;
			},
		});
		model.streamText.mockImplementation((options: Parameters<typeof streamText>[0]) => {
			if (failure === "setup") throw error;
			return actualAi.streamText({ ...options, model: languageModel });
		});

		const response = await asUser.fetch("/api/v1/runs/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				membershipId: membership.membershipId,
				thread_id: threadId,
				assistant_id: "system/thread_title",
				messages: [{ role: "user", content: "PRIVATE_TITLE_INPUT" }],
			}),
		});
		const body = await response.text();
		expect(response.status, body).toBe(failure === "setup" ? 500 : 200);
		expect(model.streamText).toHaveBeenCalledTimes(1);
		expect(languageModel.doStreamCalls).toHaveLength(failure === "setup" ? 0 : 1);
		expect(consoleError).toHaveBeenCalled();
		const logged = JSON.stringify(consoleError.mock.calls);
		expect(logged).not.toContain("PRIVATE_TITLE_INPUT");
		expect(logged).not.toContain("PRIVATE_PROVIDER_RESPONSE");
	});
});

describe("/api/chat workspace instructions", () => {
	test("starts with pending root rules and a catalog, then reads skills and ancestor rules through Bash", async () => {
		const { t, asUser, membership, threadId } = await setup();
		const { organizationId, workspaceId, userId } = membership;
		const scope = { organizationId, workspaceId, userId };
		const rootId = await test_create_saved_text_file(t, {
			membershipId: membership.membershipId,
			path: "/AGENTS.md",
			textContent: "ROOT_GUIDANCE_271",
		});
		await test_create_saved_text_file(t, {
			membershipId: membership.membershipId,
			path: "/invoices/AGENTS.md",
			textContent: "NESTED_GUIDANCE_272",
		});
		await test_create_saved_text_file(t, {
			membershipId: membership.membershipId,
			path: "/.agents/skills/summarize-invoices/SKILL.md",
			textContent: "---\nname: summarize-invoices\ndescription: CATALOG_DESCRIPTION_273\n---\n\nSECRET_SKILL_BODY_274",
		});

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			...scope,
			target: { kind: "saved", id: rootId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "UNSAVED_GUIDANCE_275",
		});
		if (staged._nay) throw new Error(staged._nay.message);
		const pending = await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			...scope,
			target: { kind: "saved", id: rootId },
			operationBatchId: batch._yay.operationBatchId,
		});
		if (pending._nay) throw new Error(pending._nay.message);
		const proposals = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", rootId))
				.collect(),
		);
		expect(proposals).toHaveLength(1);

		const response = await asUser.fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ id: "user-message", role: "user", parts: [{ type: "text", text: "Summarize invoices." }] }],
				parentId: null,
				mode: "ask",
				model: "gpt-5.4-nano",
				trigger: "submit-message",
				threadId,
				membershipId: membership.membershipId,
			}),
		});
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(model.streamText).toHaveBeenCalledTimes(1);

		const call = model.streamText.mock.calls[0][0] as Parameters<typeof streamText>[0];
		expect(call.system).toContain("UNSAVED_GUIDANCE_275");
		expect(call.system).not.toContain("ROOT_GUIDANCE_271");
		expect(call.system).not.toContain("NESTED_GUIDANCE_272");
		expect(call.system).toContain("CATALOG_DESCRIPTION_273");
		expect(call.system).not.toContain("SECRET_SKILL_BODY_274");
		expect(call.tools).not.toHaveProperty("load_skill");
		expect(call.tools).not.toHaveProperty("read_skill_resource");
		expect(call.tools).not.toHaveProperty("run_skill_script");
		if (!call.prepareStep || !call.tools?.bash?.execute) throw new Error("Expected Bash and prepareStep");

		await t.run(async () => {
			const first = await call.prepareStep!({
				model: call.model,
				messages: call.messages ?? [],
				steps: [],
				stepNumber: 0,
				experimental_context: call.experimental_context,
			});
			expect(first).toEqual({ messages: call.messages });

			const output = await call.tools!.bash.execute!(
				{ command: "cat .agents/skills/summarize-invoices/SKILL.md" },
				{ toolCallId: "read-skill", messages: [] },
			);
			expect(output).toMatchObject({ output: expect.stringContaining("SECRET_SKILL_BODY_274") });
			expect(JSON.stringify(output)).not.toContain("NESTED_GUIDANCE_272");

			const listing = await call.tools!.bash.execute!(
				{ command: "ls invoices" },
				{ toolCallId: "inspect-folder", messages: [] },
			);
			expect(listing).toMatchObject({ instructions: expect.stringContaining("NESTED_GUIDANCE_272") });
			expect(JSON.stringify(listing)).not.toContain("UNSAVED_GUIDANCE_275");

			const second = await call.prepareStep!({
				model: call.model,
				messages: call.messages ?? [],
				steps: [],
				stepNumber: 1,
				experimental_context: call.experimental_context,
			});
			expect(second).toEqual({ messages: call.messages });

			const final = await call.prepareStep!({
				model: call.model,
				messages: call.messages ?? [],
				steps: [],
				stepNumber: 9,
				experimental_context: call.experimental_context,
			});
			expect(final?.activeTools).toEqual([]);
			expect(final?.system).toContain("last step");
		});
	});

	test("discovers skill metadata without loading its body or storing a selection", async () => {
		const { t, asUser, membership, threadId } = await setup();
		await test_create_saved_text_file(t, {
			membershipId: membership.membershipId,
			path: "/.agents/skills/check-list/SKILL.md",
			textContent: "---\nname: check-list\ndescription: Check a list\n---\n\nEXPLICIT_BODY_276",
		});

		const response = await asUser.fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ id: "selected-message", role: "user", parts: [{ type: "text", text: "Use this skill." }] }],
				parentId: null,
				mode: "ask",
				model: "gpt-5.4-nano",
				trigger: "submit-message",
				threadId,
				membershipId: membership.membershipId,
			}),
		});
		const body = await response.text();
		expect(response.status, body).toBe(200);
		expect(model.streamText.mock.calls[0][0].system).toContain("/.agents/skills/check-list/SKILL.md");
		expect(model.streamText.mock.calls[0][0].system).not.toContain("EXPLICIT_BODY_276");

		const messages = await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
		const stored = messages.find((message) => message.clientGeneratedMessageId === "selected-message")!;
		expect(stored.content.metadata ?? {}).not.toHaveProperty("skillIds");
		expect(JSON.stringify(messages)).not.toContain("EXPLICIT_BODY_276");
	});

	test("refuses removed skill tools before storage or model replay", async () => {
		const { t, asUser, membership, threadId } = await setup();

		// `load_skill` is not a tool any more. A client can still send an old result for it, so the
		// stored-history check and the chat route must both refuse it.
		const safe = {
			id: "stored-skill",
			role: "assistant",
			parts: [
				{
					type: "tool-load_skill",
					toolCallId: "load",
					state: "output-available",
					input: { skillId: "a".repeat(32) },
					output: { skillId: "a".repeat(32), version: "b".repeat(64), status: "loaded" },
				},
			],
		};

		const refused = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: membership.membershipId,
			threadId,
			parentId: null,
			messages: [{ clientGeneratedMessageId: "safe", content: safe }],
		});
		expect(refused._nay?.message).toBe("Invalid file tool result parts");

		const withBody = await asUser.mutation(api.ai_chat.thread_messages_add, {
			membershipId: membership.membershipId,
			threadId,
			parentId: null,
			messages: [
				{
					clientGeneratedMessageId: "with-body",
					content: {
						...safe,
						parts: [{ ...safe.parts[0], output: { ...safe.parts[0].output, body: "HISTORICAL_SKILL_BODY" } }],
					},
				},
			],
		});
		expect(withBody._nay?.message).toBe("Invalid file tool result parts");

		const docs = await t.run((ctx) => ctx.db.query("ai_chat_threads_messages_aisdk_5").collect());
		expect(docs).toEqual([]);

		const response = await asUser.fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [safe],
				parentId: null,
				mode: "ask",
				model: "gpt-5.4-nano",
				trigger: "submit-message",
				threadId,
				membershipId: membership.membershipId,
			}),
		});
		const body = await response.text();
		expect(response.status, body).toBe(400);
		expect(body).toContain("Invalid file tool result parts");

		// The route stops before it calls the model, so the old result never reaches it.
		expect(model.streamText).not.toHaveBeenCalled();
	});
});
