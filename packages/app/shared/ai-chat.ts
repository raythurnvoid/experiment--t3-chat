import type { DataUIPart, UIMessage } from "ai";
import type { Doc } from "../convex/_generated/dataModel";
import type {
	ai_chat_tool_create_read_page_ToolInput,
	ai_chat_tool_create_read_page_ToolOutput,
	ai_chat_tool_create_list_pages_ToolInput,
	ai_chat_tool_create_list_pages_ToolOutput,
	ai_chat_tool_create_glob_pages_ToolInput,
	ai_chat_tool_create_glob_pages_ToolOutput,
	ai_chat_tool_create_grep_pages_ToolInput,
	ai_chat_tool_create_grep_pages_ToolOutput,
	ai_chat_tool_create_text_search_pages_ToolInput,
	ai_chat_tool_create_text_search_pages_ToolOutput,
	ai_chat_tool_create_write_page_ToolInput,
	ai_chat_tool_create_write_page_ToolOutput,
	ai_chat_tool_create_edit_page_ToolInput,
	ai_chat_tool_create_edit_page_ToolOutput,
} from "../server/server-ai-tools.ts";

export type ai_chat_Message = Doc<"ai_chat_threads_messages_aisdk_5">;

export type ai_chat_Thread = Doc<"ai_chat_threads">;

export const ai_chat_MAIN_MODEL_IDS = ["gpt-5-nano", "gpt-4.1-mini"] as const;
export type ai_chat_MainModelId = (typeof ai_chat_MAIN_MODEL_IDS)[number];

export const ai_chat_DEFAULT_MAIN_MODEL_ID = "gpt-5-nano" as const satisfies ai_chat_MainModelId;

export type ai_chat_AiSdk5UiTools = {
	weather: {
		input: {
			location: string;
		};
		output: {
			location: string;
			temperature: string;
		};
	};
	read_page: {
		input: ai_chat_tool_create_read_page_ToolInput;
		output: ai_chat_tool_create_read_page_ToolOutput;
	};
	list_pages: {
		input: ai_chat_tool_create_list_pages_ToolInput;
		output: ai_chat_tool_create_list_pages_ToolOutput;
	};
	glob_pages: {
		input: ai_chat_tool_create_glob_pages_ToolInput;
		output: ai_chat_tool_create_glob_pages_ToolOutput;
	};
	grep_pages: {
		input: ai_chat_tool_create_grep_pages_ToolInput;
		output: ai_chat_tool_create_grep_pages_ToolOutput;
	};
	text_search_pages: {
		input: ai_chat_tool_create_text_search_pages_ToolInput;
		output: ai_chat_tool_create_text_search_pages_ToolOutput;
	};
	write_page: {
		input: ai_chat_tool_create_write_page_ToolInput;
		output: ai_chat_tool_create_write_page_ToolOutput;
	};
	edit_page: {
		input: ai_chat_tool_create_edit_page_ToolInput;
		output: ai_chat_tool_create_edit_page_ToolOutput;
	};
};

export type ai_chat_AiSdk5UiDataParts = {
	"thread-id": {
		threadId: string;
	};
	"chat-title": {
		title: string;
	};
};

export type ai_chat_AiSdk5UiDataPart = DataUIPart<ai_chat_AiSdk5UiDataParts>;

export type ai_chat_AiSdk5UiMessage = UIMessage<
	Record<string, unknown> & {
		status?: "aborted" | "errored" | undefined;
		convexId?: string | undefined;
		convexParentId?: string | null | undefined;
		parentClientGeneratedId: string | null;
		selectedModelId?: ai_chat_MainModelId | undefined;
	},
	ai_chat_AiSdk5UiDataParts,
	ai_chat_AiSdk5UiTools
>;

export function ai_chat_is_main_model_id(value: string): value is ai_chat_MainModelId {
	return ai_chat_MAIN_MODEL_IDS.includes(value as ai_chat_MainModelId);
}

export function ai_chat_get_message_text(message: UIMessage) {
	const parts = message.parts ?? [];

	const textFromParts = parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	return textFromParts;
}
