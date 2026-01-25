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

export type ai_chat_Message = Doc<"messages">;

export type ai_chat_Thread = Doc<"threads">;

/**
 * Assistant UI compatible thread meta.
 *
 * Assistant UI format: aui/v0.
 */
export interface ai_chat_AuiThread {
	// aui/v0 fields
	title: string;
	last_message_at: Date;
	external_id: string | null;
	id: string;
	project_id: string;
	/** ISO 8601 UTC string */
	created_at: string;
	/** ISO 8601 UTC string */
	updated_at: string;
	workspace_id: string;
	is_archived: boolean;

	// custom metadata fields
	metadata: {
		starred?: boolean;
	};
}

/**
 * Assistant UI compatible message metadata.
 *
 * Assistant UI format: aui/v0.
 */
export interface ai_chat_AuiMessage {
	// aui/v0 fields
	id: string;
	parent_id: string | null;
	thread_id: string;
	created_by: string;
	/** ISO 8601 UTC string */
	created_at: string;
	updated_by: string;
	/** ISO 8601 UTC string */
	updated_at: string;
	// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
	format: "aui/v0" | string;
	content: ai_chat_MessageContent;
	height: number;
}

export interface ai_chat_MessageAssistantMetadata {
	unstable_state: unknown;
	unstable_annotations: unknown[];
	unstable_data: unknown[];
	steps: ai_chat_MessageAssistantMetadataStep[];
	custom: Record<string, unknown>;
}

export interface ai_chat_MessageUserMetadata {
	custom: Record<string, unknown>;
}

export interface ai_chat_MessageSystemMetadata {
	custom: Record<string, unknown>;
}

export type ai_chat_LanguageModelV1FinishReason =
	| "stop"
	| "length"
	| "content-filter"
	| "tool-calls"
	| "error"
	| "other"
	| "unknown";

export type ai_chat_LanguageModelV1Usage = {
	promptTokens: number;
	completionTokens: number;
};

export type ai_chat_MessageAssistantMetadataStartStep = {
	state: "started";
	messageId: string;
};

export type ai_chat_MessageAssistantMetadataFinishStep = {
	state: "finished";
	messageId: string;
	finishReason: ai_chat_LanguageModelV1FinishReason;
	usage?: ai_chat_LanguageModelV1Usage;
	isContinued: boolean;
};

export type ai_chat_MessageAssistantMetadataStep =
	| ai_chat_MessageAssistantMetadataStartStep
	| ai_chat_MessageAssistantMetadataFinishStep;

export type ai_chat_MessageAssistantContent = {
	role: "assistant";
	content: Array<
		| ai_chat_MessageContentPartText
		| ai_chat_MessageContentPartReasoning
		| ai_chat_MessageContentPartSource
		| ai_chat_MessageContentPartToolCall
		| ai_chat_MessageContentPartFile
	>;
	metadata: ai_chat_MessageAssistantMetadata;
	status?: {
		type: "running" | "requires-action" | "complete" | "incomplete";
		reason?: string;
	};
};

export type ai_chat_MessageUserContent = {
	role: "user";
	content: Array<ai_chat_MessageContentPartText | ai_chat_MessageContentPartImage | ai_chat_MessageContentPartFile>;
	metadata: ai_chat_MessageUserMetadata;
	status?: {
		type: "running" | "requires-action" | "complete" | "incomplete";
		reason?: string;
	};
};

export type ai_chat_MessageSystemContent = {
	role: "system";
	content: Array<ai_chat_MessageContentPartText>;
	metadata: ai_chat_MessageSystemMetadata;
	status?: {
		type: "running" | "requires-action" | "complete" | "incomplete";
		reason?: string;
	};
};

export type ai_chat_MessageContent =
	| ai_chat_MessageAssistantContent
	| ai_chat_MessageUserContent
	| ai_chat_MessageSystemContent;

export type ai_chat_MessageContentPartText = {
	type: "text";
	text: string;
};

export type ai_chat_MessageContentPartReasoning = {
	type: "reasoning";
	text: string;
};

export type ai_chat_MessageContentPartSource = {
	type: "source";
	sourceType: "url";
	id: string;
	url: string;
	title?: string;
};

export type ai_chat_MessageContentPartToolCall = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: unknown;
	argsText?: string;
	result?: unknown;
	isError?: true;
};

export type ai_chat_MessageContentPartImage = {
	type: "image";
	image: string;
};

export type ai_chat_MessageContentPartFile = {
	type: "file";
	data: string;
	mimeType: string;
};

export type ai_chat_AiSdkUiTools = {
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

export type ai_chat_AiSdkUiDataParts = {
	"thread-id": {
		threadId: string;
	};
	"chat-title": {
		title: string;
	};
};

export type ai_chat_AiSdkUiDataPart = DataUIPart<ai_chat_AiSdkUiDataParts>;

export type ai_chat_AiSdkUiMessage = UIMessage<
	Record<string, unknown> & {
		convexId?: string | undefined;
		convexParentId?: string | null | undefined;
	},
	ai_chat_AiSdkUiDataParts,
	ai_chat_AiSdkUiTools
>;
