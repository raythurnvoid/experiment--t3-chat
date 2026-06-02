import type { DataUIPart, UIMessage } from "ai";
import type { Doc } from "../convex/_generated/dataModel";
import type {
	ai_chat_tool_create_bash_ToolInput,
	ai_chat_tool_create_bash_ToolOutput,
	ai_chat_tool_create_read_file_ToolInput,
	ai_chat_tool_create_read_file_ToolOutput,
	ai_chat_tool_create_list_files_ToolInput,
	ai_chat_tool_create_list_files_ToolOutput,
	ai_chat_tool_create_glob_files_ToolInput,
	ai_chat_tool_create_glob_files_ToolOutput,
	ai_chat_tool_create_grep_files_ToolInput,
	ai_chat_tool_create_grep_files_ToolOutput,
	ai_chat_tool_create_write_file_ToolInput,
	ai_chat_tool_create_write_file_ToolOutput,
	ai_chat_tool_create_edit_file_ToolInput,
	ai_chat_tool_create_edit_file_ToolOutput,
	ai_chat_tool_create_web_search_ToolInput,
	ai_chat_tool_create_web_search_ToolOutput,
} from "../server/server-ai-tools.ts";

export type ai_chat_Message = Doc<"ai_chat_threads_messages_aisdk_5">;

export type ai_chat_Thread = Doc<"ai_chat_threads">;

export const ai_chat_MODEL_IDS = ["gpt-5.4-nano", "gpt-5.4-mini"] as const;
export type ai_chat_ModelId = (typeof ai_chat_MODEL_IDS)[number];

type AiChatModelMetadata = {
	label: string;
};

export const ai_chat_DEFAULT_MODEL_ID = "gpt-5.4-nano" as const satisfies ai_chat_ModelId;

export const ai_chat_MODELS = {
	"gpt-5.4-nano": {
		label: "GPT-5.4 Nano",
	},
	"gpt-5.4-mini": {
		label: "GPT-5.4 Mini",
	},
} as const satisfies Record<ai_chat_ModelId, AiChatModelMetadata>;

export const ai_chat_MODE_IDS = ["agent", "ask"] as const;
export type ai_chat_ModeId = (typeof ai_chat_MODE_IDS)[number];

export const ai_chat_DEFAULT_MODE_ID = "agent" as const satisfies ai_chat_ModeId;

type AiChatModeMetadata = {
	label: string;
	description: string;
};

export const ai_chat_MODE_METADATA = {
	agent: {
		label: "Agent",
		description: "Read, search, create folders with bash, and propose file edits for review.",
	},
	ask: {
		label: "Ask",
		description: "Read and search only. Cannot create folders or propose file edits.",
	},
} as const satisfies Record<ai_chat_ModeId, AiChatModeMetadata>;

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
	bash: {
		input: ai_chat_tool_create_bash_ToolInput;
		output: ai_chat_tool_create_bash_ToolOutput;
	};
	read_file: {
		input: ai_chat_tool_create_read_file_ToolInput;
		output: ai_chat_tool_create_read_file_ToolOutput;
	};
	list_files: {
		input: ai_chat_tool_create_list_files_ToolInput;
		output: ai_chat_tool_create_list_files_ToolOutput;
	};
	glob_files: {
		input: ai_chat_tool_create_glob_files_ToolInput;
		output: ai_chat_tool_create_glob_files_ToolOutput;
	};
	grep_files: {
		input: ai_chat_tool_create_grep_files_ToolInput;
		output: ai_chat_tool_create_grep_files_ToolOutput;
	};
	write_file: {
		input: ai_chat_tool_create_write_file_ToolInput;
		output: ai_chat_tool_create_write_file_ToolOutput;
	};
	edit_file: {
		input: ai_chat_tool_create_edit_file_ToolInput;
		output: ai_chat_tool_create_edit_file_ToolOutput;
	};
	web_search: {
		input: ai_chat_tool_create_web_search_ToolInput;
		output: ai_chat_tool_create_web_search_ToolOutput;
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
		selectedModelId?: ai_chat_ModelId | undefined;
		selectedModeId?: ai_chat_ModeId | undefined;
	},
	ai_chat_AiSdk5UiDataParts,
	ai_chat_AiSdk5UiTools
>;

export function ai_chat_is_model_id(value: string): value is ai_chat_ModelId {
	return ai_chat_MODEL_IDS.includes(value as ai_chat_ModelId);
}

export function ai_chat_is_mode_id(value: string): value is ai_chat_ModeId {
	return ai_chat_MODE_IDS.includes(value as ai_chat_ModeId);
}

export function ai_chat_is_optimistic_thread(thread?: ai_chat_Thread | null) {
	const clientGeneratedId = thread?.clientGeneratedId;
	if (!clientGeneratedId) {
		return false;
	}
	return thread._id === clientGeneratedId;
}

export function ai_chat_get_message_text(message: UIMessage) {
	const parts = message.parts ?? [];

	const textFromParts = parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	return textFromParts;
}
