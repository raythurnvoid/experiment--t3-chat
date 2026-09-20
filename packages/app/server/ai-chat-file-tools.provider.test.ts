import { createOpenAI } from "@ai-sdk/openai";
import { R2 } from "@convex-dev/r2";
import { generateText, stepCountIs } from "ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import z from "zod";
import type { Id } from "../convex/_generated/dataModel.js";
import type { ActionCtx } from "../convex/_generated/server.js";
import { ai_chat_file_result_schema } from "../shared/ai-chat-files.ts";
import { ai_chat_tool_create_view_image, type ai_chat_Observation } from "./ai-chat-file-tools.ts";

const pngBase64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4AWJiYGD4D8IgBpBmYAAAAAD//7vS9wEAAAAGSURBVAMAGDACA6ybwrYAAAAASUVORK5CYII=";
const png = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));

describe("ai_chat_tool_create_view_image", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	test("sends a strict path tool and returns image bytes under the same OpenAI call id", async () => {
		const target = { kind: "private" as const, id: "private-1" };
		const file = {
			target,
			assetId: "asset-1",
			r2Key: "file-key",
			contentType: "application/octet-stream",
			size: png.length,
			path: "/reports/image.bin",
			revision: "revision-1",
		};
		const runQuery = vi.fn().mockResolvedValue({ _yay: file });
		const observations = new Map<string, ai_chat_Observation>();
		const viewer = ai_chat_tool_create_view_image({ runQuery } as unknown as ActionCtx, {
			userId: "user-1" as Id<"users">,
			membershipId: "membership-1" as Id<"organizations_workspaces_users">,
			getThreadId: () => "thread-1" as Id<"ai_chat_threads">,
			observations,
		});
		vi.spyOn(R2.prototype, "getUrl").mockResolvedValue("https://r2.test/file");
		const readBytes = vi.fn().mockImplementation(async () => new Response(png));
		vi.stubGlobal("fetch", readBytes);

		// The SDK and provider run the real tool. Only HTTP and stored file lookup are mocked.
		const requests: unknown[] = [];
		const provider = createOpenAI({
			apiKey: "test",
			fetch: async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				if (requests.length > 2) throw new Error("Unexpected model request");
				return Response.json({
					id: `resp_${requests.length}`,
					created_at: 0,
					model: "gpt-5.4-nano",
					output:
						requests.length === 1
							? [
									{
										type: "function_call",
										id: "fc_view_1",
										call_id: "call_view_1",
										name: "view_image",
										arguments: JSON.stringify({ path: file.path }),
									},
								]
							: [
									{
										type: "message",
										id: "msg_final",
										role: "assistant",
										content: [{ type: "output_text", text: "Image inspected.", annotations: [] }],
									},
								],
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				});
			},
		});
		const result = await generateText({
			model: provider.responses("gpt-5.4-nano"),
			tools: { view_image: viewer },
			prompt: `Inspect ${file.path}.`,
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		});

		expect(result.text).toBe("Image inspected.");
		expect(result.steps).toHaveLength(2);
		expect(requests).toHaveLength(2);
		const first = z.object({ tools: z.array(z.record(z.string(), z.unknown())) }).parse(requests[0]);
		expect(first.tools).toHaveLength(1);
		expect(first.tools[0]).toMatchObject({
			type: "function",
			name: "view_image",
			strict: true,
			parameters: {
				type: "object",
				required: ["path"],
				additionalProperties: false,
				properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
			},
		});
		const parameters = z
			.object({
				properties: z.record(z.string(), z.unknown()),
			})
			.passthrough()
			.parse(first.tools[0]?.parameters);
		expect(Object.keys(parameters.properties)).toEqual(["path"]);
		for (const keyword of ["oneOf", "anyOf", "allOf"]) expect(parameters).not.toHaveProperty(keyword);

		const second = z.object({ input: z.array(z.record(z.string(), z.unknown())) }).parse(requests[1]);
		expect(second.input.filter((item) => item.type === "function_call_output")).toEqual([
			{
				type: "function_call_output",
				call_id: "call_view_1",
				output: [
					{ type: "input_text", text: `Image bytes supplied for inspection: ${file.path}` },
					{ type: "input_image", image_url: `data:image/png;base64,${pngBase64}` },
				],
			},
		]);
		expect(result.steps[0]?.toolResults).toHaveLength(1);
		const toolResult = result.steps[0]?.toolResults[0];
		expect(toolResult).toMatchObject({ toolName: "view_image", toolCallId: "call_view_1", input: { path: file.path } });
		const output = ai_chat_file_result_schema.parse(toolResult?.output);
		expect(output).toEqual({
			title: "View image",
			output: "View image: succeeded.",
			metadata: { status: "succeeded", reason: null, files: [target] },
		});
		expect([...observations.keys()]).toEqual(["call_view_1"]);
		expect(runQuery.mock.calls.map((call) => call[1])).toEqual([
			{ userId: "user-1", membershipId: "membership-1", threadId: "thread-1", path: file.path },
			{ userId: "user-1", membershipId: "membership-1", threadId: "thread-1", path: file.path, target },
		]);

		for (let count = 0; count < 2; count++) {
			expect(await viewer.toModelOutput?.({ toolCallId: "call_view_1", input: { path: file.path }, output })).toBe(
				observations.get("call_view_1")?.output,
			);
		}
		expect(readBytes).toHaveBeenCalledTimes(1);
		expect(runQuery).toHaveBeenCalledTimes(2);
	});
});
