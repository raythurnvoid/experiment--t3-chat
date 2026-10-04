import { describe, expect, test } from "vitest";

import {
	ai_chat_DEFAULT_MODEL_ID,
	ai_chat_get_message_draft,
	ai_chat_get_message_text,
	ai_chat_is_model_id,
	ai_chat_MODEL_IDS,
	ai_chat_MODELS,
} from "./ai-chat.ts";
import { file_quotes_parse_draft } from "./file-quotes.ts";

describe("ai_chat model catalog", () => {
	test("keeps GPT-6 Luna as the default and allows DeepSeek V4.1 Flash", () => {
		expect(ai_chat_MODEL_IDS).toEqual(["gpt-6-luna", "deepseek-v4.1-flash"]);
		expect(ai_chat_DEFAULT_MODEL_ID).toBe("gpt-6-luna");
	});

	test("exposes a friendly label on each allowed model", () => {
		expect(ai_chat_MODELS["gpt-6-luna"].label).toBe("GPT-6 Luna");
		expect(ai_chat_MODELS["deepseek-v4.1-flash"].label).toBe("DeepSeek V4.1 Flash");
		expect(ai_chat_MODELS["gpt-6-luna"].supportsImageGeneration).toBe(true);
		expect(ai_chat_MODELS["deepseek-v4.1-flash"].supportsImageGeneration).toBe(false);
	});

	test("treats only the catalog ids as valid models", () => {
		expect(ai_chat_is_model_id("gpt-6-luna")).toBe(true);
		expect(ai_chat_is_model_id("deepseek-v4.1-flash")).toBe(true);
		expect(ai_chat_is_model_id("gpt-5.4-nano")).toBe(false);
		expect(ai_chat_is_model_id("gpt-5.4-mini")).toBe(false);
		expect(ai_chat_is_model_id("gpt-5.6-luna")).toBe(false);
		expect(ai_chat_is_model_id("gpt-5.6-terra")).toBe(false);
		expect(ai_chat_is_model_id("gpt-5.6-sol")).toBe(false);
		expect(ai_chat_is_model_id("gpt-5-nano")).toBe(false);
		expect(ai_chat_is_model_id("gpt-4.1-mini")).toBe(false);
		expect(ai_chat_is_model_id("not-a-real-model")).toBe(false);
	});
});

describe("ai_chat_get_message_draft", () => {
	test("copy uses selected text and editing restores the same ordered quote parts", () => {
		const parts = [
			{ type: "text" as const, text: "Before " },
			{ type: "data-file-quote" as const, data: { fileNodeId: null, text: "Chosen\ntext" } },
			{ type: "text" as const, text: " after" },
		];
		const message = { id: "quote", role: "user" as const, parts };
		expect(ai_chat_get_message_text(message)).toBe("Before \nChosen\ntext\n after");
		expect(file_quotes_parse_draft(ai_chat_get_message_draft(message))).toEqual(parts);
	});
});
