import type { DataUIPart, UIMessage } from "ai";
import type { Doc } from "../convex/_generated/dataModel";
import type {
	ai_chat_tool_create_bash_ToolInput,
	ai_chat_tool_create_bash_ToolOutput,
	ai_chat_tool_create_edit_file_ToolInput,
	ai_chat_tool_create_edit_file_ToolOutput,
	ai_chat_tool_create_set_file_metadata_ToolInput,
	ai_chat_tool_create_set_file_metadata_ToolOutput,
	ai_chat_tool_create_web_search_ToolInput,
	ai_chat_tool_create_web_search_ToolOutput,
	ai_chat_tool_create_execute_code_ToolInput,
	ai_chat_tool_create_execute_code_ToolOutput,
	ai_chat_tool_create_prepare_image_generation_ToolInput,
	ai_chat_tool_create_prepare_image_generation_ToolOutput,
	ai_chat_tool_create_file_stored_ToolInput,
	ai_chat_tool_create_file_stored_ToolOutput,
} from "../server/server-ai-tools.ts";
import type { GeneratedIdPrefix } from "./generated-ids.ts";

export type ai_chat_Message = Doc<"ai_chat_threads_messages_aisdk_5">;

export type ai_chat_Thread = Doc<"ai_chat_threads">;

export const ai_chat_MODEL_IDS = ["gpt-6-luna", "deepseek-v4.1-flash"] as const;
export type ai_chat_ModelId = (typeof ai_chat_MODEL_IDS)[number];

type AiChatModelMetadata = {
	label: string;
	/**
	 * Whether this model can draw a picture with the `image_generation` tool.
	 *
	 * The tool is OpenAI's own and OpenAI runs it on their side, so a model from another provider
	 * cannot call it. The chat route registers the tool only for the models marked `true` here.
	 * The field is required, so adding a model id is a decision instead of a silent default.
	 */
	supportsImageGeneration: boolean;
};

export const ai_chat_DEFAULT_MODEL_ID = "gpt-6-luna" as const satisfies ai_chat_ModelId;

export const ai_chat_MODELS = {
	"gpt-6-luna": {
		label: "GPT-6 Luna",
		supportsImageGeneration: true,
	},
	"deepseek-v4.1-flash": {
		label: "DeepSeek Flash",
		supportsImageGeneration: false,
	},
} as const satisfies Record<ai_chat_ModelId, AiChatModelMetadata>;

/**
 * Media types a chat message image attachment may use. SVG is excluded on
 * purpose: models do not accept it and it can embed scripts.
 */
export const ai_chat_MESSAGE_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ai_chat_MessageImageMediaType = (typeof ai_chat_MESSAGE_IMAGE_MEDIA_TYPES)[number];

export const ai_chat_MESSAGE_IMAGE_MAX_COUNT = 6;

/**
 * Image attachments travel inside the message as base64 data URLs, and the
 * whole message is stored as one Convex document with a ~1 MiB limit. The
 * composer compresses images to fit this budget and the chat route rejects
 * requests over it.
 */
export const ai_chat_MESSAGE_IMAGE_MAX_TOTAL_URL_CHARS = 700 * 1024;

/**
 * The picture format the agent's `image_generation` tool asks OpenAI for.
 *
 * The provider options and the pending Files writer must use the same format.
 */
export const ai_chat_GENERATED_IMAGE_FORMAT = "webp" as const;
export const ai_chat_GENERATED_IMAGE_MEDIA_TYPE = `image/${ai_chat_GENERATED_IMAGE_FORMAT}` as const;

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
		description: "Read, search, create folders with bash, propose file edits for review, and set file metadata.",
	},
	ask: {
		label: "Ask",
		description: "Read and search only. Cannot create folders, propose file edits, or set file metadata.",
	},
} as const satisfies Record<ai_chat_ModeId, AiChatModeMetadata>;

export type ai_chat_UiTools = {
	bash: {
		input: ai_chat_tool_create_bash_ToolInput;
		output: ai_chat_tool_create_bash_ToolOutput;
	};
	edit_file: {
		input: ai_chat_tool_create_edit_file_ToolInput;
		output: ai_chat_tool_create_edit_file_ToolOutput;
	};
	set_file_metadata: {
		input: ai_chat_tool_create_set_file_metadata_ToolInput;
		output: ai_chat_tool_create_set_file_metadata_ToolOutput;
	};
	web_search: {
		input: ai_chat_tool_create_web_search_ToolInput;
		output: ai_chat_tool_create_web_search_ToolOutput;
	};
	execute_code: {
		input: ai_chat_tool_create_execute_code_ToolInput;
		output: ai_chat_tool_create_execute_code_ToolOutput;
	};
	/**
	 * The output holds a pending Files target. Image bytes never enter chat storage.
	 */
	image_generation: {
		input: ai_chat_tool_create_file_stored_ToolInput;
		output: ai_chat_tool_create_file_stored_ToolOutput;
	};
	prepare_image_generation: {
		input: ai_chat_tool_create_prepare_image_generation_ToolInput;
		output: ai_chat_tool_create_prepare_image_generation_ToolOutput;
	};
	/**
	 * The stored part keeps a safe status and ordinary Files references. Raw browser observations
	 * and image bytes never reach stored tool parts.
	 */
	browser_run: {
		input: ai_chat_tool_create_file_stored_ToolInput;
		output: ai_chat_tool_create_file_stored_ToolOutput;
	};
	/**
	 * The stored part keeps the Files targets the model read, never the bytes. Replaying the thread
	 * hands the model those targets again. Resolve their paths with Bash before a fresh read.
	 */
	view_image: {
		input: ai_chat_tool_create_file_stored_ToolInput;
		output: ai_chat_tool_create_file_stored_ToolOutput;
	};
	browser_reload: {
		input: ai_chat_tool_create_file_stored_ToolInput;
		output: ai_chat_tool_create_file_stored_ToolOutput;
	};
	browser_close: {
		input: ai_chat_tool_create_file_stored_ToolInput;
		output: ai_chat_tool_create_file_stored_ToolOutput;
	};
};

export type ai_chat_UiDataParts = {
	"thread-id": {
		threadId: string;
	};
	"chat-title": {
		title: string;
	};
};

export type ai_chat_UiDataPart = DataUIPart<ai_chat_UiDataParts>;

export type ai_chat_UiMessage = UIMessage<
	Record<string, unknown> & {
		status?: "aborted" | "errored" | undefined;
		convexId?: string | undefined;
		convexParentId?: string | null | undefined;
		/**
		 * The message's own client-generated id. `AiChatController` sets it on every rendered
		 * message: persisted rows copy `clientGeneratedMessageId`, live messages copy their own id.
		 */
		clientGeneratedId?: string | undefined;
		parentClientGeneratedId: string | null;
		selectedModelId?: ai_chat_ModelId | undefined;
		selectedModeId?: ai_chat_ModeId | undefined;
		/**
		 * Frozen shared-browser session for this request. Stamped at queue time from the Files
		 * selection; the server re-checks the live session, so an ended file degrades instead of
		 * rebinding to whatever is selected now.
		 */
		browserSessionId?: string | undefined;
	},
	ai_chat_UiDataParts,
	ai_chat_UiTools
>;

export function ai_chat_is_model_id(value: string): value is ai_chat_ModelId {
	return ai_chat_MODEL_IDS.includes(value as ai_chat_ModelId);
}

export function ai_chat_is_mode_id(value: string): value is ai_chat_ModeId {
	return ai_chat_MODE_IDS.includes(value as ai_chat_ModeId);
}

export type ai_chat_OptimisticThreadId = `ai_thread-${string}`;

export function ai_chat_is_optimistic_thread_id(
	threadId: string | null | undefined,
): threadId is ai_chat_OptimisticThreadId {
	return Boolean(threadId?.startsWith("ai_thread-" satisfies GeneratedIdPrefix));
}

export function ai_chat_is_message_image_media_type(value: string): value is ai_chat_MessageImageMediaType {
	return ai_chat_MESSAGE_IMAGE_MEDIA_TYPES.includes(value as ai_chat_MessageImageMediaType);
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
