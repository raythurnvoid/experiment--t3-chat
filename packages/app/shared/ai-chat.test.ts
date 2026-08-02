import { describe, expect, test } from "vitest";

import {
	ai_chat_DEFAULT_MODEL_ID,
	ai_chat_is_model_id,
	ai_chat_MODEL_IDS,
	ai_chat_MODELS,
} from "./ai-chat.ts";

describe("ai_chat model catalog", () => {
	test("keeps GPT-5.4 nano as the default allowed model", () => {
		expect(ai_chat_MODEL_IDS).toEqual(["gpt-5.4-nano", "gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra"]);
		expect(ai_chat_DEFAULT_MODEL_ID).toBe("gpt-5.4-nano");
	});

	test("exposes friendly labels on the allowed models metadata", () => {
		expect(ai_chat_MODELS["gpt-5.4-nano"].label).toBe("GPT-5.4 Nano");
		expect(ai_chat_MODELS["gpt-5.4-mini"].label).toBe("GPT-5.4 Mini");
		expect(ai_chat_MODELS["gpt-5.6-luna"].label).toBe("GPT-5.6 Luna");
		expect(ai_chat_MODELS["gpt-5.6-terra"].label).toBe("GPT-5.6 Terra");
	});

	test("treats only the catalog ids as valid models", () => {
		expect(ai_chat_is_model_id("gpt-5.4-nano")).toBe(true);
		expect(ai_chat_is_model_id("gpt-5.4-mini")).toBe(true);
		expect(ai_chat_is_model_id("gpt-5.6-luna")).toBe(true);
		expect(ai_chat_is_model_id("gpt-5.6-terra")).toBe(true);
		expect(ai_chat_is_model_id("gpt-5.6-sol")).toBe(false);
		expect(ai_chat_is_model_id("gpt-5-nano")).toBe(false);
		expect(ai_chat_is_model_id("gpt-4.1-mini")).toBe(false);
		expect(ai_chat_is_model_id("not-a-real-model")).toBe(false);
	});
});
