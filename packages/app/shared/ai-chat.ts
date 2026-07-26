import type { DataUIPart, UIMessage } from "ai";
import type { Doc } from "../convex/_generated/dataModel";
import type {
	ai_chat_tool_create_bash_ToolInput,
	ai_chat_tool_create_bash_ToolOutput,
	ai_chat_tool_create_edit_file_ToolInput,
	ai_chat_tool_create_edit_file_ToolOutput,
	ai_chat_tool_create_web_search_ToolInput,
	ai_chat_tool_create_web_search_ToolOutput,
	ai_chat_tool_create_execute_code_ToolInput,
	ai_chat_tool_create_execute_code_ToolOutput,
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
	edit_file: {
		input: ai_chat_tool_create_edit_file_ToolInput;
		output: ai_chat_tool_create_edit_file_ToolOutput;
	};
	web_search: {
		input: ai_chat_tool_create_web_search_ToolInput;
		output: ai_chat_tool_create_web_search_ToolOutput;
	};
	execute_code: {
		input: ai_chat_tool_create_execute_code_ToolInput;
		output: ai_chat_tool_create_execute_code_ToolOutput;
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

/**
 * A thread is unread while its newest message is newer than the read cursor.
 * Nothing writes "unread": a new message makes it true on its own.
 */
export function ai_chat_thread_is_unread(thread: { lastMessageAt?: number; readAt?: number }) {
	return (thread.lastMessageAt ?? 0) > (thread.readAt ?? 0);
}

/**
 * A just-finished answer stays unread for the moment it takes the read-cursor mutation
 * to land, so the dot waits this long before fading in and a watched chat never blinks.
 */
export const ai_chat_UNREAD_DOT_GRACE_MS = 10_000;

/**
 * Remaining grace for an unread dot, used as a CSS `animation-delay`.
 * Threads that went unread long ago get `0` and show immediately.
 */
export function ai_chat_get_unread_dot_delay_ms(lastMessageAt?: number, now = Date.now()) {
	return Math.max(0, ai_chat_UNREAD_DOT_GRACE_MS - (now - (lastMessageAt ?? 0)));
}

export function ai_chat_get_message_text(message: UIMessage) {
	const parts = message.parts ?? [];

	const textFromParts = parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");

	return textFromParts;
}
