import { describe, expect, test } from "vitest";

import { ai_chat_DEFAULT_MODEL_ID, ai_chat_is_model_id, ai_chat_MODEL_IDS, ai_chat_MODELS } from "./ai-chat.ts";

describe("ai_chat model catalog", () => {
	test("keeps GPT-6 Luna as the only allowed model", () => {
		expect(ai_chat_MODEL_IDS).toEqual(["gpt-6-luna"]);
		expect(ai_chat_DEFAULT_MODEL_ID).toBe("gpt-6-luna");
	});

	test("exposes a friendly label on the allowed model", () => {
		expect(ai_chat_MODELS["gpt-6-luna"].label).toBe("GPT-6 Luna");
	});

	test("treats only the catalog ids as valid models", () => {
		expect(ai_chat_is_model_id("gpt-6-luna")).toBe(true);
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
