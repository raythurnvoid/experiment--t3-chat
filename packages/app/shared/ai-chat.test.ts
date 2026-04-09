import { describe, expect, test } from "vitest";

import {
	ai_chat_DEFAULT_MAIN_MODEL_ID,
	ai_chat_is_main_model_id,
	ai_chat_MAIN_MODEL_IDS,
	ai_chat_MAIN_MODEL_METADATA,
} from "./ai-chat.ts";

describe("ai_chat model catalog", () => {
	test("keeps GPT-5.4 nano as the default allowed model", () => {
		expect(ai_chat_MAIN_MODEL_IDS).toEqual(["gpt-5.4-nano", "gpt-5.4-mini"]);
		expect(ai_chat_DEFAULT_MAIN_MODEL_ID).toBe("gpt-5.4-nano");
	});

	test("exposes friendly labels on the allowed models metadata", () => {
		expect(ai_chat_MAIN_MODEL_METADATA["gpt-5.4-nano"].label).toBe("GPT-5.4 Nano");
		expect(ai_chat_MAIN_MODEL_METADATA["gpt-5.4-mini"].label).toBe("GPT-5.4 Mini");
	});

	test("treats only the two GPT-5.4 ids as valid models", () => {
		expect(ai_chat_is_main_model_id("gpt-5.4-nano")).toBe(true);
		expect(ai_chat_is_main_model_id("gpt-5.4-mini")).toBe(true);
		expect(ai_chat_is_main_model_id("gpt-5-nano")).toBe(false);
		expect(ai_chat_is_main_model_id("gpt-4.1-mini")).toBe(false);
		expect(ai_chat_is_main_model_id("not-a-real-model")).toBe(false);
	});
});
